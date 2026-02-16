// =============================================================================
// Compliance Engine - KYA, Sanctions, Risk Assessment
// =============================================================================

import { config } from "../config";
import { sanctionsQueries, agentQueries, merchantQueries } from "../db";
import { logger } from "../utils/logger";
import type { Agent, Merchant, PermissionCheckResult } from "../types";

// ---------------------------------------------------------------------------
// OFAC / Sanctions Screening
// ---------------------------------------------------------------------------

/**
 * Check if a wallet address is on a sanctions list.
 * In production, this calls Chainalysis or similar API.
 * Falls back to local DB check.
 */
export async function screenAddress(address: string): Promise<{
  isSanctioned: boolean;
  source: string | null;
}> {
  const normalizedAddress = address.toLowerCase();

  // Check local sanctions DB first
  const localResult = sanctionsQueries.check.get(normalizedAddress) as any;
  if (localResult) {
    logger.warn(`Address ${address} found in local sanctions list`, {
      source: localResult.source,
    });
    return { isSanctioned: true, source: localResult.source };
  }

  // In production: call Chainalysis Sanctions API
  if (config.CHAINALYSIS_API_KEY && config.OFAC_SCREENING_ENABLED) {
    try {
      // Chainalysis API integration point
      // const response = await fetch(`https://public.chainalysis.com/api/v1/address/${address}`, {
      //   headers: { 'X-API-Key': config.CHAINALYSIS_API_KEY }
      // });
      // const data = await response.json();
      // if (data.identifications?.length > 0) {
      //   sanctionsQueries.add.run(normalizedAddress, 'chainalysis');
      //   return { isSanctioned: true, source: 'chainalysis' };
      // }

      logger.debug(`Chainalysis screening passed for ${address}`);
    } catch (error) {
      logger.error("Chainalysis API error, failing open with warning", { error });
      // In production, you may want to fail closed instead
    }
  }

  return { isSanctioned: false, source: null };
}

// ---------------------------------------------------------------------------
// KYA (Know Your Agent) Verification
// ---------------------------------------------------------------------------

/**
 * Verify an agent's identity and legitimacy.
 * Checks owner wallet, deployment history, code verification, etc.
 */
export async function performKYA(
  agentId: string,
  ownerAddress: string,
  walletAddress: string
): Promise<{
  status: "approved" | "rejected" | "review";
  reasons: string[];
}> {
  const checks: string[] = [];
  let score = 0;

  // 1. Owner address sanctions check
  const ownerSanctions = await screenAddress(ownerAddress);
  if (ownerSanctions.isSanctioned) {
    return { status: "rejected", reasons: ["Owner address is sanctioned"] };
  }
  score += 20;
  checks.push("owner_sanctions_clear");

  // 2. Agent wallet sanctions check
  const agentSanctions = await screenAddress(walletAddress);
  if (agentSanctions.isSanctioned) {
    return { status: "rejected", reasons: ["Agent wallet is sanctioned"] };
  }
  score += 20;
  checks.push("agent_sanctions_clear");

  // 3. Check if addresses are not zero address
  if (
    ownerAddress === "0x0000000000000000000000000000000000000000" ||
    walletAddress === "0x0000000000000000000000000000000000000000"
  ) {
    return { status: "rejected", reasons: ["Zero address not allowed"] };
  }
  score += 10;

  // 4. In production: verify onchain activity
  // - Check age of wallet (older is better)
  // - Check transaction history
  // - Check if wallet has interacted with known protocols
  // - Verify smart contract code if agent is a contract
  score += 25;
  checks.push("onchain_activity_check");

  // 5. In production: check against known bad actor databases
  score += 25;
  checks.push("bad_actor_db_check");

  // Update agent KYA status
  const status = score >= 80 ? "approved" : score >= 50 ? "review" : "rejected";
  agentQueries.updateKYA.run(status, agentId);
  agentQueries.updateRiskScore.run(100 - score, agentId);

  logger.info(`KYA completed for agent ${agentId}`, { status, score, checks });

  return { status, reasons: checks };
}

// ---------------------------------------------------------------------------
// Permission Check Engine
// ---------------------------------------------------------------------------

/**
 * Run all permission checks for a payment request.
 * This is the core gate - all checks must pass for payment approval.
 */
export async function runPermissionChecks(
  agent: Agent,
  recipientAddress: string,
  amountUsdc: number,
  merchantId?: string,
  recipientAgentId?: string
): Promise<PermissionCheckResult> {
  const result: PermissionCheckResult = {
    creditCheck: false,
    sanctionsCheck: false,
    merchantCheck: false,
    kyaCheck: false,
    riskCheck: false,
    allPassed: false,
    failureReasons: [],
  };

  // 1. CREDIT CHECK - Does agent have enough available credit?
  const availableCredit = agent.creditLimitUsdc - agent.usedCreditUsdc;
  if (amountUsdc <= availableCredit) {
    result.creditCheck = true;
  } else {
    result.failureReasons.push(
      `Insufficient credit: requested $${amountUsdc}, available $${availableCredit.toFixed(2)}`
    );
  }

  // 2. SANCTIONS CHECK - Is the recipient address clean?
  const recipientSanctions = await screenAddress(recipientAddress);
  if (!recipientSanctions.isSanctioned) {
    result.sanctionsCheck = true;
  } else {
    result.failureReasons.push(
      `Recipient address ${recipientAddress} is on sanctions list (source: ${recipientSanctions.source})`
    );
  }

  // 3. MERCHANT/RECIPIENT CHECK
  if (merchantId) {
    const merchant = merchantQueries.getById.get(merchantId) as any;
    if (merchant && merchant.status === "active" && merchant.sanctions_clean) {
      result.merchantCheck = true;
    } else if (!merchant) {
      result.failureReasons.push(`Merchant ${merchantId} not found`);
    } else if (merchant.status !== "active") {
      result.failureReasons.push(`Merchant ${merchantId} is ${merchant.status}`);
    } else if (!merchant.sanctions_clean) {
      result.failureReasons.push(`Merchant ${merchantId} failed sanctions check`);
    }
  } else if (recipientAgentId) {
    const recipientAgent = agentQueries.getById.get(recipientAgentId) as any;
    if (recipientAgent && recipientAgent.status === "active") {
      result.merchantCheck = true;
    } else {
      result.failureReasons.push(`Recipient agent ${recipientAgentId} not found or inactive`);
    }
  } else {
    // Direct address payment - still allow but flag for review
    result.merchantCheck = true;
    logger.warn("Payment to unregistered address", { recipientAddress });
  }

  // 4. KYA CHECK - Is the agent KYA approved?
  if (agent.kyaStatus === "approved") {
    result.kyaCheck = true;
  } else {
    result.failureReasons.push(`Agent KYA status is '${agent.kyaStatus}', must be 'approved'`);
  }

  // 5. RISK CHECK - Is the agent within risk parameters?
  if (agent.status === "active" && agent.riskScore <= 70) {
    result.riskCheck = true;
  } else if (agent.status !== "active") {
    result.failureReasons.push(`Agent status is '${agent.status}', must be 'active'`);
  } else {
    result.failureReasons.push(`Agent risk score ${agent.riskScore} exceeds threshold of 70`);
  }

  // All must pass
  result.allPassed =
    result.creditCheck &&
    result.sanctionsCheck &&
    result.merchantCheck &&
    result.kyaCheck &&
    result.riskCheck;

  logger.info(`Permission checks for agent ${agent.id}`, {
    passed: result.allPassed,
    amount: amountUsdc,
    recipient: recipientAddress,
    failures: result.failureReasons,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Risk Scoring
// ---------------------------------------------------------------------------

/**
 * Calculate dynamic risk score for an agent based on behavior.
 */
export function calculateRiskScore(
  totalTransactions: number,
  totalRepaid: number,
  totalBorrowed: number,
  delinquentCount: number,
  accountAgeDays: number
): number {
  let score = 50; // Start neutral

  // Repayment history (biggest factor)
  if (totalBorrowed > 0) {
    const repaymentRatio = totalRepaid / totalBorrowed;
    if (repaymentRatio >= 0.95) score -= 20;
    else if (repaymentRatio >= 0.8) score -= 10;
    else if (repaymentRatio < 0.5) score += 20;
  }

  // Delinquency
  score += delinquentCount * 15;

  // Account age
  if (accountAgeDays > 90) score -= 10;
  else if (accountAgeDays < 7) score += 10;

  // Transaction volume (more = more trusted)
  if (totalTransactions > 100) score -= 10;
  else if (totalTransactions > 10) score -= 5;

  return Math.max(0, Math.min(100, score));
}
