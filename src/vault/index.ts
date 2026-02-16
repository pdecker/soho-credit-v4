// =============================================================================
// Vault Engine - Liquidity Pool, Yield Distribution
// =============================================================================
// Lenders deposit USDC → receive vault shares.
// Merchant fees flow back into the vault → increase share price.
// Lenders earn yield proportional to their share ownership.
// =============================================================================

import { v4 as uuid } from "uuid";
import { vaultQueries, lenderQueries, db } from "../db";
import { logger } from "../utils/logger";
import type { Vault, LenderPosition } from "../types";

// ---------------------------------------------------------------------------
// Vault State
// ---------------------------------------------------------------------------

export function getVaultState(): Vault {
  const raw = vaultQueries.get.get() as any;
  if (!raw) throw new Error("Vault not initialized");

  const totalDeposits = raw.total_deposits_usdc;
  const totalLent = raw.total_lent_usdc;

  return {
    totalDepositsUsdc: totalDeposits,
    totalLentUsdc: totalLent,
    availableLiquidityUsdc: totalDeposits - totalLent,
    totalFeesEarnedUsdc: raw.total_fees_earned_usdc,
    currentApyBps: calculateAPY(raw.total_fees_earned_usdc, totalDeposits),
    totalShares: raw.total_shares,
  };
}

/**
 * Get the current price per vault share.
 * Share price = totalDeposits / totalShares
 * As fees accumulate, share price increases → lenders earn yield.
 */
export function getSharePrice(): number {
  const vault = getVaultState();
  if (vault.totalShares === 0) return 1.0; // Initial price
  return vault.totalDepositsUsdc / vault.totalShares;
}

// ---------------------------------------------------------------------------
// Lender Operations
// ---------------------------------------------------------------------------

/**
 * Process a lender deposit into the vault.
 * Mints vault shares proportional to current share price.
 */
export function processDeposit(
  lenderAddress: string,
  amountUsdc: number,
  depositTxHash: string
): LenderPosition {
  const sharePrice = getSharePrice();
  const sharesIssued = amountUsdc / sharePrice;
  const positionId = uuid();

  // Atomic: create position + update vault
  const tx = db.transaction(() => {
    lenderQueries.create.run(
      positionId,
      lenderAddress.toLowerCase(),
      amountUsdc,
      sharesIssued,
      depositTxHash
    );
    vaultQueries.updateDeposit.run(amountUsdc, sharesIssued);
  });
  tx();

  logger.info(`Lender deposit processed`, {
    lender: lenderAddress,
    amount: amountUsdc,
    shares: sharesIssued,
    sharePrice,
  });

  return {
    id: positionId,
    lenderAddress: lenderAddress.toLowerCase(),
    depositedUsdc: amountUsdc,
    sharesOwned: sharesIssued,
    earnedYieldUsdc: 0,
    depositTxHash,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Process a lender withdrawal from the vault.
 * Burns shares and returns USDC at current share price (which includes yield).
 */
export function processWithdrawal(
  lenderAddress: string,
  sharesToBurn: number
): { amountUsdc: number; yieldEarned: number } {
  const vault = getVaultState();
  const sharePrice = getSharePrice();
  const amountUsdc = sharesToBurn * sharePrice;

  // Check available liquidity
  if (amountUsdc > vault.availableLiquidityUsdc) {
    throw new Error(
      `Insufficient vault liquidity: requested $${amountUsdc.toFixed(2)}, available $${vault.availableLiquidityUsdc.toFixed(2)}`
    );
  }

  // Find lender positions
  const positions = lenderQueries.getByAddress.all(lenderAddress.toLowerCase()) as any[];
  let remainingShares = sharesToBurn;
  let totalOriginalValue = 0;

  const tx = db.transaction(() => {
    for (const pos of positions) {
      if (remainingShares <= 0) break;
      const burnFromThis = Math.min(pos.shares_owned, remainingShares);
      const originalValue = (burnFromThis / pos.shares_owned) * pos.deposited_usdc;
      totalOriginalValue += originalValue;

      const yieldForThis = burnFromThis * sharePrice - originalValue;
      lenderQueries.updateShares.run(burnFromThis, yieldForThis, pos.id);
      remainingShares -= burnFromThis;
    }

    if (remainingShares > 0.001) {
      throw new Error(`Insufficient shares: could not burn ${sharesToBurn} shares`);
    }

    vaultQueries.updateWithdraw.run(amountUsdc, sharesToBurn);
  });
  tx();

  const yieldEarned = amountUsdc - totalOriginalValue;

  logger.info(`Lender withdrawal processed`, {
    lender: lenderAddress,
    sharesBurned: sharesToBurn,
    amountUsdc,
    yieldEarned,
  });

  return { amountUsdc, yieldEarned };
}

// ---------------------------------------------------------------------------
// Fee Processing
// ---------------------------------------------------------------------------

/**
 * Process merchant fee into the vault.
 * This is called after each transaction settles.
 * The fee goes back into the vault, increasing share price for all lenders.
 */
export function processFeeIntoVault(feeUsdc: number): void {
  if (feeUsdc <= 0) return;

  // Fee goes into total deposits (increases share price) and into fees earned
  vaultQueries.addFees.run(feeUsdc, feeUsdc);

  logger.info(`Fee of $${feeUsdc.toFixed(4)} added to vault`);
}

/**
 * Reserve liquidity for an outgoing payment.
 */
export function reserveLiquidity(amountUsdc: number): void {
  const vault = getVaultState();
  if (amountUsdc > vault.availableLiquidityUsdc) {
    throw new Error(
      `Insufficient vault liquidity: need $${amountUsdc.toFixed(2)}, available $${vault.availableLiquidityUsdc.toFixed(2)}`
    );
  }
  vaultQueries.updateLent.run(amountUsdc);
}

/**
 * Return liquidity when a repayment is received.
 */
export function returnLiquidity(amountUsdc: number): void {
  vaultQueries.returnLent.run(amountUsdc);
}

// ---------------------------------------------------------------------------
// Yield Calculation
// ---------------------------------------------------------------------------

/**
 * Calculate annualized yield in basis points.
 * Based on trailing fee revenue extrapolated to annual rate.
 */
function calculateAPY(totalFeesEarned: number, totalDeposits: number): number {
  if (totalDeposits === 0) return 0;

  // Simple annualization: (fees / deposits) * 10000 for bps
  // In production, use time-weighted calculation over rolling 30-day window
  const rawYield = totalFeesEarned / totalDeposits;
  return Math.round(rawYield * 10000); // Convert to bps
}

/**
 * Get lender positions with current market value.
 */
export function getLenderPositions(lenderAddress: string): Array<LenderPosition & { currentValueUsdc: number; unrealizedYield: number }> {
  const positions = lenderQueries.getByAddress.all(lenderAddress.toLowerCase()) as any[];
  const sharePrice = getSharePrice();

  return positions.map((p: any) => ({
    id: p.id,
    lenderAddress: p.lender_address,
    depositedUsdc: p.deposited_usdc,
    sharesOwned: p.shares_owned,
    earnedYieldUsdc: p.earned_yield_usdc,
    depositTxHash: p.deposit_tx_hash,
    createdAt: p.created_at,
    currentValueUsdc: p.shares_owned * sharePrice,
    unrealizedYield: p.shares_owned * sharePrice - p.deposited_usdc + p.earned_yield_usdc,
  }));
}
