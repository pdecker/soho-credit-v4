// =============================================================================
// Payment Engine - Core Transaction Processing
// =============================================================================
// Orchestrates: permission checks → vault reserve → MPC signing → settlement
// =============================================================================

import { v4 as uuid } from "uuid";
import { createHash } from "crypto";
import {
  agentQueries,
  merchantQueries,
  txQueries,
  repaymentQueries,
  db,
} from "../db";
import { runPermissionChecks } from "../compliance";
import { signTransaction, signWithMPC } from "../mpc";
import { reserveLiquidity, processFeeIntoVault, returnLiquidity, getVaultState } from "../vault";
import { getChain } from "../chains";
import { config } from "../config";
import { logger } from "../utils/logger";
import type { Transaction, PermissionCheckResult, Agent } from "../types";

// ---------------------------------------------------------------------------
// Payment Processing
// ---------------------------------------------------------------------------

export interface PaymentRequest {
  agentId: string;
  recipientAddress: string;
  amountUsdc: number;
  memo?: string;
  merchantId?: string;
  recipientAgentId?: string;
  agentPartialSignature?: string;
  idempotencyKey: string;
}

export interface PaymentResult {
  transactionId: string;
  status: Transaction["status"];
  permissionChecks: PermissionCheckResult;
  feeUsdc: number;
  netAmountUsdc: number;
  mpcSignatureId?: string;
  txHash?: string;
  awaitingAgentSignature?: boolean;
}

/**
 * Process a payment request from an agent.
 * This is the main entry point for all payments.
 */
export async function processPayment(req: PaymentRequest): Promise<PaymentResult> {
  // 1. Idempotency check
  const existing = txQueries.getByIdempotencyKey.get(req.idempotencyKey) as any;
  if (existing) {
    logger.info(`Idempotent request detected: ${req.idempotencyKey}`);
    return {
      transactionId: existing.id,
      status: existing.status,
      permissionChecks: JSON.parse(existing.permission_checks),
      feeUsdc: existing.fee_usdc,
      netAmountUsdc: existing.net_amount_usdc,
      txHash: existing.tx_hash,
    };
  }

  // 2. Load agent
  const agentRaw = agentQueries.getById.get(req.agentId) as any;
  if (!agentRaw) throw new Error(`Agent ${req.agentId} not found`);

  const agent: Agent = {
    id: agentRaw.id,
    walletAddress: agentRaw.wallet_address,
    name: agentRaw.name,
    ownerAddress: agentRaw.owner_address,
    creditLimitUsdc: agentRaw.credit_limit_usdc,
    usedCreditUsdc: agentRaw.used_credit_usdc,
    availableCreditUsdc: agentRaw.credit_limit_usdc - agentRaw.used_credit_usdc,
    status: agentRaw.status,
    kyaStatus: agentRaw.kya_status,
    riskScore: agentRaw.risk_score,
    mpcPublicKey: agentRaw.mpc_public_key,
    createdAt: agentRaw.created_at,
    updatedAt: agentRaw.updated_at,
  };

  // 3. Calculate fees
  let feeBps = config.MERCHANT_FEE_BPS;
  if (req.merchantId) {
    const merchant = merchantQueries.getById.get(req.merchantId) as any;
    if (merchant) feeBps = merchant.fee_bps;
  }
  const feeUsdc = (req.amountUsdc * feeBps) / 10000;
  const netAmountUsdc = req.amountUsdc - feeUsdc;
  const totalFromVault = req.amountUsdc; // We send full amount, fee is deducted from what merchant gets... 
  // Actually: vault sends netAmount to merchant, fee stays in vault.
  // Agent owes full amountUsdc back to vault.

  // 4. Run permission checks
  const permChecks = await runPermissionChecks(
    agent,
    req.recipientAddress,
    req.amountUsdc,
    req.merchantId,
    req.recipientAgentId
  );

  // 5. Create transaction record
  const txId = uuid();
  const txType = req.recipientAgentId ? "agent_to_agent" : "agent_to_merchant";

  txQueries.create.run(
    txId,
    req.agentId,
    req.merchantId || null,
    req.recipientAgentId || null,
    req.amountUsdc,
    feeUsdc,
    netAmountUsdc,
    permChecks.allPassed ? "approved" : "rejected",
    txType,
    req.recipientAddress,
    req.memo || null,
    JSON.stringify(permChecks),
    req.idempotencyKey
  );

  // 6. If checks failed, return rejection
  if (!permChecks.allPassed) {
    logger.warn(`Payment rejected for agent ${req.agentId}`, {
      txId,
      reasons: permChecks.failureReasons,
    });
    return {
      transactionId: txId,
      status: "rejected",
      permissionChecks: permChecks,
      feeUsdc,
      netAmountUsdc,
    };
  }

  // 7. Reserve liquidity from vault
  try {
    reserveLiquidity(netAmountUsdc);
  } catch (error: any) {
    txQueries.updateStatus.run("failed", "failed", txId);
    throw new Error(`Vault liquidity error: ${error.message}`);
  }

  // 8. Update agent's used credit
  const newUsedCredit = agent.usedCreditUsdc + req.amountUsdc;
  agentQueries.updateCredit.run(newUsedCredit, req.agentId);

  // 9. MPC Signing
  txQueries.updateStatus.run("signing", "signing", txId);

  try {
    // Create the message to sign (EIP-712 style transaction data)
    const messageHash = createTransactionHash(
      req.recipientAddress,
      netAmountUsdc,
      txId,
      config.CHAIN_ID
    );

    if (!req.agentPartialSignature) {
      // Agent hasn't provided their shard — can't sign yet
      txQueries.updateStatus.run("signing", "signing", txId);
      return {
        transactionId: txId,
        status: "signing",
        permissionChecks: permChecks,
        feeUsdc,
        netAmountUsdc,
        awaitingAgentSignature: true,
      };
    }

    // 9. MPC co-sign: reconstruct key from both shards and execute real transfer
    txQueries.updateStatus.run("signing", "signing", txId);

    // Reconstruct private key from server shard + agent shard
    const n = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    const { createHash: cryptoHash, createDecipheriv } = await import("crypto");

    // Decrypt server shard
    const [ivHex, encHex] = agentRaw.mpc_server_shard_enc.split(":");
    const keyHash = cryptoHash("sha256").update(config.MPC_ENCRYPTION_KEY).digest();
    const iv = Buffer.from(ivHex, "hex");
    const decipher = createDecipheriv("aes-256-cbc", keyHash, iv);
    let serverShardHex = decipher.update(encHex, "hex", "utf8");
    serverShardHex += decipher.final("utf8");

    const serverBig = BigInt("0x" + serverShardHex);
    const agentBig = BigInt("0x" + req.agentPartialSignature);
    const fullKeyBig = ((serverBig + agentBig) % n + n) % n;
    const fullKeyHex = fullKeyBig.toString(16).padStart(64, "0");

    // 10. Execute real USDC transfer from agent's MPC wallet
    txQueries.updateStatus.run("broadcasting", "broadcasting", txId);

    const chain = getChain("base") as any;
    let txHash: string;

    if (chain.transferUsdcMPC) {
      // Live mode: real onchain transfer from agent's MPC wallet
      const result = await chain.transferUsdcMPC(
        fullKeyHex,
        req.recipientAddress,
        netAmountUsdc
      );
      txHash = result.txHash;

      if (!result.confirmed) {
        throw new Error(`Transaction failed onchain: ${txHash}`);
      }
    } else {
      // Simulation mode
      txHash = "0x" + cryptoHash("sha256")
        .update(`${req.recipientAddress}:${netAmountUsdc}:${Date.now()}`)
        .digest("hex");
    }

    txQueries.updateTxHash.run(txHash, txId);
    txQueries.updateStatus.run("confirmed", "confirmed", txId);

    // 11. Process fee into vault (increases yield for lenders)
    processFeeIntoVault(feeUsdc);

    logger.info(`Payment confirmed`, {
      txId,
      txHash,
      agent: req.agentId,
      recipient: req.recipientAddress,
      amount: req.amountUsdc,
      fee: feeUsdc,
    });

    return {
      transactionId: txId,
      status: "confirmed",
      permissionChecks: permChecks,
      feeUsdc,
      netAmountUsdc,
      mpcSignatureId: signResult.signatureId,
      txHash,
    };
  } catch (error: any) {
    logger.error(`Payment signing/broadcast failed`, { txId, error: error.message });
    txQueries.updateStatus.run("failed", "failed", txId);

    // Return reserved liquidity
    returnLiquidity(netAmountUsdc);
    // Reverse credit usage
    agentQueries.updateCredit.run(agent.usedCreditUsdc, req.agentId);

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Repayment Processing
// ---------------------------------------------------------------------------

export interface RepaymentResult {
  repaymentId: string;
  amountUsdc: number;
  newBalance: number;
  status: string;
}

/**
 * Process a repayment from an agent.
 * Agent sends USDC back to the vault to pay down their credit balance.
 */
export async function processRepayment(
  agentId: string,
  amountUsdc: number,
  txHash: string
): Promise<RepaymentResult> {
  const agent = agentQueries.getById.get(agentId) as any;
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  // Don't allow overpayment
  const actualRepayment = Math.min(amountUsdc, agent.used_credit_usdc);
  if (actualRepayment <= 0) {
    throw new Error("No outstanding balance to repay");
  }

  const repaymentId = uuid();
  const now = new Date();
  const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const periodEnd = now.toISOString();

  const tx = db.transaction(() => {
    // Create repayment record
    repaymentQueries.create.run(
      repaymentId,
      agentId,
      actualRepayment,
      txHash,
      "confirmed",
      periodStart,
      periodEnd
    );

    // Update agent credit
    const newUsedCredit = agent.used_credit_usdc - actualRepayment;
    agentQueries.updateCredit.run(newUsedCredit, agentId);

    // Return liquidity to vault
    returnLiquidity(actualRepayment);

    // If agent was delinquent and now paid, restore status
    if (agent.status === "delinquent" && newUsedCredit === 0) {
      agentQueries.updateStatus.run("active", agentId);
    }
  });
  tx();

  const newBalance = agent.used_credit_usdc - actualRepayment;

  logger.info(`Repayment processed`, {
    repaymentId,
    agentId,
    amount: actualRepayment,
    newBalance,
    txHash,
  });

  return {
    repaymentId,
    amountUsdc: actualRepayment,
    newBalance,
    status: "confirmed",
  };
}

// ---------------------------------------------------------------------------
// Credit Management
// ---------------------------------------------------------------------------

export function getCreditLine(agentId: string) {
  const agent = agentQueries.getById.get(agentId) as any;
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const repayments = repaymentQueries.getByAgent.all(agentId, 100, 0) as any[];
  const totalRepaid = repayments.reduce((sum: number, r: any) => sum + r.amount_usdc, 0);

  const transactions = txQueries.getByAgent.all(agentId, 1000, 0) as any[];
  const totalBorrowed = transactions
    .filter((t: any) => t.status === "confirmed" && t.type !== "repayment")
    .reduce((sum: number, t: any) => sum + t.amount_usdc, 0);

  // Calculate next repayment due date
  const now = new Date();
  const daysSinceEpoch = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  const nextRepaymentDay = Math.ceil(daysSinceEpoch / config.REPAYMENT_PERIOD_DAYS) * config.REPAYMENT_PERIOD_DAYS;
  const repaymentDueDate = new Date(nextRepaymentDay * 24 * 60 * 60 * 1000);

  return {
    agentId,
    creditLimitUsdc: agent.credit_limit_usdc,
    usedCreditUsdc: agent.used_credit_usdc,
    availableCreditUsdc: agent.credit_limit_usdc - agent.used_credit_usdc,
    repaymentDueDate: repaymentDueDate.toISOString(),
    isDelinquent: agent.status === "delinquent",
    totalRepaid,
    totalBorrowed,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTransactionHash(
  recipient: string,
  amount: number,
  txId: string,
  chainId: number
): string {
  // EIP-712 style structured data hash
  const data = JSON.stringify({
    types: {
      Payment: [
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "txId", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
    },
    primaryType: "Payment",
    domain: { name: "AgentCredit", version: "1", chainId },
    message: {
      recipient,
      amount: Math.round(amount * 1e6).toString(), // USDC 6 decimals
      txId,
      chainId,
    },
  });

  return createHash("sha256").update(data).digest("hex");
}

/**
 * Broadcast is now handled inline via chain.transferUsdcMPC() in processPayment.
 */
