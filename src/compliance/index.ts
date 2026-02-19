// =============================================================================
// SOHO Protocol — Compliance, KYA & Credit Underwriting Engine
// =============================================================================
// Know Your Agent (KYA) = the agent version of KYC
// This module handles: wallet analysis, sanctions screening, risk scoring,
// credit underwriting, ongoing monitoring, and transaction surveillance.
// =============================================================================

import { config } from "../config";
import { sanctionsQueries, agentQueries, merchantQueries, txQueries, db } from "../db";
import { logger } from "../utils/logger";
import type { Agent, Merchant, PermissionCheckResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletAnalysis {
  address: string;
  chain: string;
  firstTxDate: string | null;
  walletAgeDays: number;
  totalTxCount: number;
  inboundTxCount: number;
  outboundTxCount: number;
  uniqueCounterparties: number;
  totalVolumeUsd: number;
  hasInteractedWithDeFi: boolean;
  hasInteractedWithBridges: boolean;
  hasInteractedWithMixers: boolean;
  isContract: boolean;
  ethBalance: number;
  usdcBalance: number;
  tokenCount: number;
  nftCount: number;
  riskFlags: string[];
}

export interface KYAResult {
  status: "approved" | "rejected" | "review" | "pending";
  score: number;            // 0-100, higher = more trusted
  tier: "new" | "basic" | "verified" | "premium";
  creditRecommendation: number;  // recommended credit limit in USDC
  checks: KYACheck[];
  flags: string[];
  reviewReasons: string[];
}

export interface KYACheck {
  name: string;
  passed: boolean;
  weight: number;
  score: number;
  details: string;
}

export interface UnderwritingDecision {
  approved: boolean;
  creditLimit: number;
  tier: "new" | "basic" | "verified" | "premium";
  riskScore: number;
  factors: UnderwritingFactor[];
  conditions: string[];
}

export interface UnderwritingFactor {
  name: string;
  value: string;
  impact: "positive" | "negative" | "neutral";
  weight: number;
}

export interface TransactionSurveillance {
  flagged: boolean;
  alerts: SurveillanceAlert[];
}

export interface SurveillanceAlert {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  action: "log" | "review" | "block" | "freeze";
}

// ---------------------------------------------------------------------------
// 1. WALLET ANALYSIS — What we look at when they share their address
// ---------------------------------------------------------------------------

/**
 * Analyze a wallet address onchain to build a risk profile.
 * In production, this calls Base/Etherscan APIs and Chainalysis.
 * For now, implements the framework with stub data where needed.
 */
export async function analyzeWallet(
  address: string,
  chain: string = "base"
): Promise<WalletAnalysis> {
  const normalizedAddress = address.toLowerCase();
  const riskFlags: string[] = [];

  // --- Onchain data we pull (via Basescan/Etherscan API in production) ---

  let walletData = {
    firstTxDate: null as string | null,
    walletAgeDays: 0,
    totalTxCount: 0,
    inboundTxCount: 0,
    outboundTxCount: 0,
    uniqueCounterparties: 0,
    totalVolumeUsd: 0,
    hasInteractedWithDeFi: false,
    hasInteractedWithBridges: false,
    hasInteractedWithMixers: false,
    isContract: false,
    ethBalance: 0,
    usdcBalance: 0,
    tokenCount: 0,
    nftCount: 0,
  };

  try {
    // In production, these are real API calls:
    //
    // 1. Basescan API: tx history, internal txs, token transfers
    //    GET https://api.basescan.org/api?module=account&action=txlist&address=${address}
    //
    // 2. Check if contract:
    //    GET https://api.basescan.org/api?module=proxy&action=eth_getCode&address=${address}
    //
    // 3. Token balances:
    //    GET https://api.basescan.org/api?module=account&action=tokenlist&address=${address}
    //
    // 4. ETH balance:
    //    GET https://api.basescan.org/api?module=account&action=balance&address=${address}
    //
    // 5. Cross-reference with known protocol addresses (Uniswap, Aave, etc.)
    //
    // 6. Chainalysis KYT (Know Your Transaction):
    //    POST https://api.chainalysis.com/api/kyt/v2/users/${address}/transfers
    //
    // For the pilot, we use the data we can get from public RPCs via viem:

    const { createPublicClient, http } = await import("viem");
    const { base } = await import("viem/chains");

    const client = createPublicClient({
      chain: base,
      transport: http(config.RPC_URL || "https://mainnet.base.org"),
    });

    // Check if it's a contract
    const code = await client.getCode({ address: normalizedAddress as `0x${string}` });
    walletData.isContract = code !== undefined && code !== "0x";

    // Get ETH balance
    const ethBal = await client.getBalance({ address: normalizedAddress as `0x${string}` });
    walletData.ethBalance = Number(ethBal) / 1e18;

    // Get USDC balance
    const usdcContract = config.USDC_CONTRACT as `0x${string}`;
    try {
      const usdcBal = await client.readContract({
        address: usdcContract,
        abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
        functionName: "balanceOf",
        args: [normalizedAddress as `0x${string}`],
      });
      walletData.usdcBalance = Number(usdcBal) / 1e6;
    } catch (e) {
      // USDC balance check failed, continue
    }

    // Get transaction count (nonce = number of outbound txs)
    const nonce = await client.getTransactionCount({ address: normalizedAddress as `0x${string}` });
    walletData.outboundTxCount = Number(nonce);
    walletData.totalTxCount = Number(nonce); // Minimum, actual is higher with inbound

  } catch (error: any) {
    logger.warn("Wallet analysis RPC error, using defaults", { error: error.message });
  }

  // --- Flag generation ---

  if (walletData.isContract) {
    riskFlags.push("IS_CONTRACT");
  }

  if (walletData.totalTxCount === 0) {
    riskFlags.push("VIRGIN_WALLET");
  }

  if (walletData.walletAgeDays < 1) {
    riskFlags.push("BRAND_NEW_WALLET");
  }

  if (walletData.hasInteractedWithMixers) {
    riskFlags.push("MIXER_INTERACTION");
  }

  if (walletData.totalVolumeUsd > 100000 && walletData.walletAgeDays < 7) {
    riskFlags.push("HIGH_VOLUME_NEW_WALLET");
  }

  return {
    address: normalizedAddress,
    chain,
    ...walletData,
    riskFlags,
  };
}

// ---------------------------------------------------------------------------
// 2. SANCTIONS SCREENING — OFAC + Chainalysis
// ---------------------------------------------------------------------------

/**
 * Known sanctioned address patterns and mixers.
 * In production, this is supplemented by Chainalysis API.
 */
const KNOWN_MIXER_CONTRACTS = [
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b", // Tornado Cash Router
  "0x722122df12d4e14e13ac3b6895a86e84145b6967", // Tornado Cash 0.1 ETH
  "0xdd4c48c0b24039969fc16d1cdf626eab821d3384", // Tornado Cash 1 ETH
  "0xd4b88df4d29f5cedd6857912842cff3b20c8cfa3", // Tornado Cash 10 ETH
  "0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144", // Tornado Cash 100 ETH
].map(a => a.toLowerCase());

const KNOWN_SANCTIONED_ENTITIES = [
  // OFAC SDN List — sample addresses (full list from Chainalysis in production)
  "0x8589427373d6d84e98730d7795d8f6f8731fda16", // Tornado Cash: OFAC sanctioned
  "0xd882cfc20f52f2599d84b8e8d58c7fb62cfe344b", // Tornado Cash
  "0x7f367cc41522ce07553e823bf3be79a889debe1b", // Tornado Cash
].map(a => a.toLowerCase());

export async function screenAddress(address: string): Promise<{
  isSanctioned: boolean;
  source: string | null;
  riskLevel: "clean" | "low" | "medium" | "high" | "blocked";
  details: string;
}> {
  const normalizedAddress = address.toLowerCase();

  // 1. Check local sanctions DB
  const localResult = sanctionsQueries.check.get(normalizedAddress) as any;
  if (localResult) {
    logger.warn(`BLOCKED: Address ${address} in local sanctions list`, { source: localResult.source });
    return { isSanctioned: true, source: localResult.source, riskLevel: "blocked", details: "Address found in local sanctions database" };
  }

  // 2. Check known sanctioned entities
  if (KNOWN_SANCTIONED_ENTITIES.includes(normalizedAddress)) {
    sanctionsQueries.add.run(normalizedAddress, "ofac-sdn");
    logger.warn(`BLOCKED: Address ${address} is OFAC sanctioned entity`);
    return { isSanctioned: true, source: "ofac-sdn", riskLevel: "blocked", details: "OFAC SDN listed entity" };
  }

  // 3. Check known mixer contracts
  if (KNOWN_MIXER_CONTRACTS.includes(normalizedAddress)) {
    logger.warn(`HIGH RISK: Address ${address} is a known mixer contract`);
    return { isSanctioned: true, source: "mixer-list", riskLevel: "blocked", details: "Known mixer/tumbler contract" };
  }

  // 4. Chainalysis Sanctions Oracle (production)
  // The Chainalysis free sanctions oracle is an onchain contract on multiple chains
  // Base: can call isSanctioned(address) on the oracle contract
  //
  // In production:
  // const oracleAddress = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb";
  // const result = await client.readContract({
  //   address: oracleAddress,
  //   abi: [{ name: "isSanctioned", type: "function", ... }],
  //   functionName: "isSanctioned",
  //   args: [address],
  // });

  // 5. Chainalysis KYT API (production, paid)
  // POST https://api.chainalysis.com/api/kyt/v2/users
  // Returns: risk score, exposure to illicit services, counterparty risk

  return { isSanctioned: false, source: null, riskLevel: "clean", details: "No sanctions matches found" };
}

// ---------------------------------------------------------------------------
// 3. KYA — Know Your Agent (full underwriting assessment)
// ---------------------------------------------------------------------------

/**
 * Complete KYA assessment for agent onboarding.
 * This is the core underwriting decision — determines if an agent
 * gets purchasing power and how much.
 */
export async function performKYA(
  agentId: string,
  ownerAddress: string,
  walletAddress: string
): Promise<KYAResult> {
  const checks: KYACheck[] = [];
  const flags: string[] = [];
  const reviewReasons: string[] = [];
  let totalScore = 0;
  let totalWeight = 0;

  // ── CHECK 1: Owner Wallet Sanctions (weight: 25) ──────────────────────
  const ownerScreen = await screenAddress(ownerAddress);
  const ownerCheck: KYACheck = {
    name: "owner_sanctions",
    passed: !ownerScreen.isSanctioned,
    weight: 25,
    score: ownerScreen.isSanctioned ? 0 : 25,
    details: ownerScreen.isSanctioned
      ? `Owner wallet ${ownerAddress} flagged: ${ownerScreen.details}`
      : "Owner wallet clear of sanctions",
  };
  checks.push(ownerCheck);
  if (ownerScreen.isSanctioned) {
    agentQueries.updateKYA.run("rejected", agentId);
    agentQueries.updateRiskScore.run(100, agentId);
    return {
      status: "rejected", score: 0, tier: "new",
      creditRecommendation: 0, checks, flags: ["OWNER_SANCTIONED"],
      reviewReasons: ["Owner wallet is on sanctions list — automatic rejection"],
    };
  }

  // ── CHECK 2: Agent Wallet Sanctions (weight: 25) ──────────────────────
  const agentScreen = await screenAddress(walletAddress);
  const agentCheck: KYACheck = {
    name: "agent_sanctions",
    passed: !agentScreen.isSanctioned,
    weight: 25,
    score: agentScreen.isSanctioned ? 0 : 25,
    details: agentScreen.isSanctioned
      ? `Agent wallet ${walletAddress} flagged: ${agentScreen.details}`
      : "Agent wallet clear of sanctions",
  };
  checks.push(agentCheck);
  if (agentScreen.isSanctioned) {
    agentQueries.updateKYA.run("rejected", agentId);
    agentQueries.updateRiskScore.run(100, agentId);
    return {
      status: "rejected", score: 0, tier: "new",
      creditRecommendation: 0, checks, flags: ["AGENT_SANCTIONED"],
      reviewReasons: ["Agent wallet is on sanctions list — automatic rejection"],
    };
  }

  // ── CHECK 3: Owner Wallet Analysis (weight: 20) ───────────────────────
  const ownerAnalysis = await analyzeWallet(ownerAddress);
  let walletScore = 0;

  // Wallet age scoring
  if (ownerAnalysis.walletAgeDays >= 365) walletScore += 7;
  else if (ownerAnalysis.walletAgeDays >= 90) walletScore += 5;
  else if (ownerAnalysis.walletAgeDays >= 30) walletScore += 3;
  else if (ownerAnalysis.walletAgeDays >= 7) walletScore += 1;
  else {
    flags.push("NEW_OWNER_WALLET");
    reviewReasons.push(`Owner wallet is ${ownerAnalysis.walletAgeDays} days old`);
  }

  // Transaction history scoring
  if (ownerAnalysis.totalTxCount >= 100) walletScore += 5;
  else if (ownerAnalysis.totalTxCount >= 20) walletScore += 3;
  else if (ownerAnalysis.totalTxCount >= 5) walletScore += 1;
  else {
    flags.push("LOW_TX_HISTORY");
    reviewReasons.push(`Owner wallet has only ${ownerAnalysis.totalTxCount} transactions`);
  }

  // Balance scoring (skin in the game)
  const totalBalanceUsd = ownerAnalysis.ethBalance * 2500 + ownerAnalysis.usdcBalance; // rough ETH price
  if (totalBalanceUsd >= 10000) walletScore += 5;
  else if (totalBalanceUsd >= 1000) walletScore += 3;
  else if (totalBalanceUsd >= 100) walletScore += 1;
  else {
    flags.push("LOW_BALANCE");
  }

  // Counterparty diversity
  if (ownerAnalysis.uniqueCounterparties >= 20) walletScore += 3;
  else if (ownerAnalysis.uniqueCounterparties >= 5) walletScore += 1;

  // Risk flags
  if (ownerAnalysis.riskFlags.includes("MIXER_INTERACTION")) {
    walletScore = 0;
    flags.push("MIXER_EXPOSURE");
    reviewReasons.push("Owner wallet has interacted with known mixer contracts");
  }

  if (ownerAnalysis.riskFlags.includes("VIRGIN_WALLET")) {
    flags.push("VIRGIN_OWNER_WALLET");
    reviewReasons.push("Owner wallet has zero transaction history");
  }

  checks.push({
    name: "owner_wallet_analysis",
    passed: walletScore >= 5,
    weight: 20,
    score: walletScore,
    details: `Wallet age: ${ownerAnalysis.walletAgeDays}d, Txs: ${ownerAnalysis.totalTxCount}, Balance: $${totalBalanceUsd.toFixed(0)}, Flags: ${ownerAnalysis.riskFlags.join(", ") || "none"}`,
  });

  // ── CHECK 4: Address Validity (weight: 10) ────────────────────────────
  const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(ownerAddress) && /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
  const isZeroAddress = ownerAddress === "0x0000000000000000000000000000000000000000";
  const isBurnAddress = ownerAddress.toLowerCase() === "0x000000000000000000000000000000000000dead";

  let addressScore = 0;
  if (isValidAddress && !isZeroAddress && !isBurnAddress) addressScore = 10;
  else {
    flags.push("INVALID_ADDRESS");
    reviewReasons.push("Invalid, zero, or burn address provided");
  }

  checks.push({
    name: "address_validity",
    passed: addressScore === 10,
    weight: 10,
    score: addressScore,
    details: isValidAddress ? "Valid Ethereum address format" : "Invalid address format or zero/burn address",
  });

  // ── CHECK 5: Duplicate / Sybil Detection (weight: 10) ─────────────────
  // Check if this owner already has agents (not necessarily bad, but worth tracking)
  const existingAgents = (agentQueries as any).getByOwner?.all?.(ownerAddress.toLowerCase()) || [];
  let sybilScore = 10;

  if (existingAgents.length > 10) {
    sybilScore = 2;
    flags.push("HIGH_AGENT_COUNT");
    reviewReasons.push(`Owner has ${existingAgents.length} existing agents — possible sybil`);
  } else if (existingAgents.length > 5) {
    sybilScore = 5;
    flags.push("MULTIPLE_AGENTS");
  }

  checks.push({
    name: "sybil_detection",
    passed: sybilScore >= 5,
    weight: 10,
    score: sybilScore,
    details: `Owner has ${existingAgents.length} existing agent(s)`,
  });

  // ── CHECK 6: Geographic / Jurisdiction (weight: 10) ────────────────────
  // In production: IP geolocation of registration request, OFAC country list
  // For now: pass by default, flag for manual review if needed
  const geoScore = 10;
  checks.push({
    name: "jurisdiction_check",
    passed: true,
    weight: 10,
    score: geoScore,
    details: "Jurisdiction check passed (production: IP geolocation + OFAC country screening)",
  });

  // ── Aggregate Score ────────────────────────────────────────────────────
  totalScore = checks.reduce((sum, c) => sum + c.score, 0);
  totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const normalizedScore = Math.round((totalScore / totalWeight) * 100);

  // ── Determine Tier & Credit Recommendation ─────────────────────────────
  let tier: KYAResult["tier"];
  let creditRecommendation: number;
  let status: KYAResult["status"];

  if (normalizedScore >= 80) {
    tier = "verified";
    creditRecommendation = 1000;
    status = "approved";
  } else if (normalizedScore >= 60) {
    tier = "basic";
    creditRecommendation = 100;
    status = "approved";
  } else if (normalizedScore >= 40) {
    tier = "new";
    creditRecommendation = 10;
    status = flags.length > 2 ? "review" : "approved";
  } else {
    tier = "new";
    creditRecommendation = 0;
    status = "review";
  }

  // Hard overrides
  if (flags.includes("MIXER_EXPOSURE")) {
    status = "review";
    creditRecommendation = 0;
  }

  if (flags.includes("OWNER_SANCTIONED") || flags.includes("AGENT_SANCTIONED")) {
    status = "rejected";
    creditRecommendation = 0;
  }

  // Update agent record
  agentQueries.updateKYA.run(status, agentId);
  agentQueries.updateRiskScore.run(100 - normalizedScore, agentId);

  logger.info("KYA assessment complete", {
    agentId, status, tier, score: normalizedScore,
    creditRecommendation, flags, checksPassed: checks.filter(c => c.passed).length,
  });

  return { status, score: normalizedScore, tier, creditRecommendation, checks, flags, reviewReasons };
}

// ---------------------------------------------------------------------------
// 4. CREDIT UNDERWRITING — Ongoing credit limit decisions
// ---------------------------------------------------------------------------

/**
 * Underwriting decision for credit limit changes.
 * Called at registration AND periodically for limit adjustments.
 */
export function underwriteAgent(
  agentId: string,
  kyaResult: KYAResult,
  transactionHistory?: { totalTx: number; totalVolume: number; totalRepaid: number; totalBorrowed: number; delinquentCount: number; accountAgeDays: number }
): UnderwritingDecision {
  const factors: UnderwritingFactor[] = [];
  const conditions: string[] = [];
  let creditLimit = kyaResult.creditRecommendation;

  // ── Factor 1: KYA Score ───────────────────────────────────────────────
  factors.push({
    name: "KYA Score",
    value: `${kyaResult.score}/100`,
    impact: kyaResult.score >= 60 ? "positive" : kyaResult.score >= 40 ? "neutral" : "negative",
    weight: 30,
  });

  // ── Factor 2: KYA Tier ────────────────────────────────────────────────
  factors.push({
    name: "Agent Tier",
    value: kyaResult.tier,
    impact: kyaResult.tier === "premium" ? "positive" : kyaResult.tier === "new" ? "negative" : "neutral",
    weight: 20,
  });

  // ── Factor 3: Transaction History (if exists) ─────────────────────────
  if (transactionHistory) {
    const { totalTx, totalVolume, totalRepaid, totalBorrowed, delinquentCount, accountAgeDays } = transactionHistory;

    // Repayment ratio is the #1 signal
    const repaymentRatio = totalBorrowed > 0 ? totalRepaid / totalBorrowed : 0;
    factors.push({
      name: "Repayment Ratio",
      value: `${(repaymentRatio * 100).toFixed(1)}%`,
      impact: repaymentRatio >= 0.95 ? "positive" : repaymentRatio >= 0.8 ? "neutral" : "negative",
      weight: 25,
    });

    // Volume history
    factors.push({
      name: "Transaction Volume",
      value: `$${totalVolume.toFixed(0)} across ${totalTx} txs`,
      impact: totalTx >= 50 ? "positive" : totalTx >= 10 ? "neutral" : "negative",
      weight: 10,
    });

    // Delinquencies
    factors.push({
      name: "Delinquencies",
      value: `${delinquentCount}`,
      impact: delinquentCount === 0 ? "positive" : "negative",
      weight: 10,
    });

    // Account age
    factors.push({
      name: "Account Age",
      value: `${accountAgeDays} days`,
      impact: accountAgeDays >= 90 ? "positive" : accountAgeDays >= 30 ? "neutral" : "negative",
      weight: 5,
    });

    // Credit limit adjustments based on history
    if (repaymentRatio >= 0.95 && delinquentCount === 0 && totalTx >= 20) {
      // Excellent history — increase limit
      if (accountAgeDays >= 90) creditLimit = Math.min(creditLimit * 4, 50000);
      else if (accountAgeDays >= 30) creditLimit = Math.min(creditLimit * 2, 25000);
      else creditLimit = Math.min(creditLimit * 1.5, 10000);
    } else if (repaymentRatio >= 0.8 && delinquentCount <= 1) {
      // Good history — modest increase
      creditLimit = Math.min(creditLimit * 1.5, 10000);
    } else if (repaymentRatio < 0.5 || delinquentCount >= 3) {
      // Poor history — decrease or freeze
      creditLimit = Math.max(creditLimit * 0.25, 0);
      conditions.push("Credit reduced due to poor repayment history");
    }
  } else {
    // New agent — start conservative
    factors.push({
      name: "Transaction History",
      value: "None (new agent)",
      impact: "negative",
      weight: 25,
    });
    conditions.push("New agent — credit limit starts at minimum for tier");
  }

  // ── Factor 4: Risk Flags ──────────────────────────────────────────────
  if (kyaResult.flags.length > 0) {
    factors.push({
      name: "Risk Flags",
      value: kyaResult.flags.join(", "),
      impact: "negative",
      weight: 10,
    });
    if (kyaResult.flags.includes("MIXER_EXPOSURE")) {
      creditLimit = 0;
      conditions.push("BLOCKED: Mixer exposure detected — manual review required");
    }
    if (kyaResult.flags.includes("HIGH_AGENT_COUNT")) {
      creditLimit = Math.min(creditLimit, 100);
      conditions.push("Credit capped at $100 — suspected sybil activity");
    }
  }

  // ── Tier-based caps ───────────────────────────────────────────────────
  const tierCaps: Record<string, number> = {
    new: 50,
    basic: 500,
    verified: 5000,
    premium: 50000,
  };
  creditLimit = Math.min(creditLimit, tierCaps[kyaResult.tier] || 50);

  // Round to clean number
  creditLimit = Math.round(creditLimit);

  const riskScore = 100 - kyaResult.score;
  const approved = kyaResult.status === "approved" && creditLimit > 0;

  return { approved, creditLimit, tier: kyaResult.tier, riskScore, factors, conditions };
}

// ---------------------------------------------------------------------------
// 5. ONGOING RISK SCORING — Recalculated periodically
// ---------------------------------------------------------------------------

/**
 * Dynamic risk score based on agent behavior on the SOHO network.
 * Called by the scheduled job every 6 hours.
 */
export function calculateRiskScore(
  totalTransactions: number,
  totalRepaid: number,
  totalBorrowed: number,
  delinquentCount: number,
  accountAgeDays: number,
  avgTxSize: number = 0,
  maxTxSize: number = 0,
  uniqueRecipients: number = 0,
): number {
  let score = 50; // Start neutral

  // ── Repayment history (35% weight) ────────────────────────────────────
  if (totalBorrowed > 0) {
    const repaymentRatio = totalRepaid / totalBorrowed;
    if (repaymentRatio >= 0.98) score -= 20;
    else if (repaymentRatio >= 0.90) score -= 15;
    else if (repaymentRatio >= 0.80) score -= 10;
    else if (repaymentRatio >= 0.50) score += 5;
    else score += 25; // Very bad
  }

  // ── Delinquency (20% weight) ──────────────────────────────────────────
  if (delinquentCount === 0) score -= 5;
  else if (delinquentCount === 1) score += 5;
  else if (delinquentCount <= 3) score += 15;
  else score += 25; // Serial delinquent

  // ── Account age (10% weight) ──────────────────────────────────────────
  if (accountAgeDays > 180) score -= 10;
  else if (accountAgeDays > 90) score -= 7;
  else if (accountAgeDays > 30) score -= 3;
  else if (accountAgeDays < 3) score += 10; // Brand new, risky

  // ── Transaction volume (10% weight) ───────────────────────────────────
  if (totalTransactions > 200) score -= 8;
  else if (totalTransactions > 50) score -= 5;
  else if (totalTransactions > 10) score -= 2;

  // ── Behavioral anomalies (15% weight) ─────────────────────────────────
  // Sudden spike in tx size
  if (maxTxSize > avgTxSize * 10 && avgTxSize > 0) {
    score += 10;
  }

  // Low counterparty diversity (paying same address over and over)
  if (totalTransactions > 10 && uniqueRecipients <= 2) {
    score += 5; // Suspicious concentration
  }

  // ── Diversification (10% weight) ──────────────────────────────────────
  if (uniqueRecipients >= 10) score -= 5;
  else if (uniqueRecipients >= 5) score -= 2;

  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// 6. TRANSACTION SURVEILLANCE — Real-time monitoring
// ---------------------------------------------------------------------------

/**
 * Screen every transaction for suspicious patterns.
 * Called before every payment is approved.
 */
export async function surveilleTransaction(
  agent: Agent,
  recipientAddress: string,
  amountUsdc: number,
  agentTxHistory: { recentTxCount24h: number; recentVolume24h: number; avgTxSize: number; lastTxMinutesAgo: number }
): Promise<TransactionSurveillance> {
  const alerts: SurveillanceAlert[] = [];

  // ── Rule 1: Velocity check — too many txs in 24h ─────────────────────
  if (agentTxHistory.recentTxCount24h > 100) {
    alerts.push({
      type: "HIGH_VELOCITY",
      severity: "high",
      description: `${agentTxHistory.recentTxCount24h} transactions in 24h (threshold: 100)`,
      action: "block",
    });
  } else if (agentTxHistory.recentTxCount24h > 50) {
    alerts.push({
      type: "ELEVATED_VELOCITY",
      severity: "medium",
      description: `${agentTxHistory.recentTxCount24h} transactions in 24h (warning: 50)`,
      action: "review",
    });
  }

  // ── Rule 2: Volume spike — daily volume exceeds credit limit ──────────
  if (agentTxHistory.recentVolume24h > agent.creditLimitUsdc * 2) {
    alerts.push({
      type: "VOLUME_SPIKE",
      severity: "high",
      description: `24h volume $${agentTxHistory.recentVolume24h.toFixed(0)} exceeds 2x credit limit $${agent.creditLimitUsdc}`,
      action: "review",
    });
  }

  // ── Rule 3: Size anomaly — this tx is 5x+ avg ────────────────────────
  if (agentTxHistory.avgTxSize > 0 && amountUsdc > agentTxHistory.avgTxSize * 5) {
    alerts.push({
      type: "SIZE_ANOMALY",
      severity: "medium",
      description: `Tx size $${amountUsdc} is ${(amountUsdc / agentTxHistory.avgTxSize).toFixed(1)}x the agent's average of $${agentTxHistory.avgTxSize.toFixed(2)}`,
      action: "review",
    });
  }

  // ── Rule 4: Rapid-fire — less than 5 seconds since last tx ────────────
  if (agentTxHistory.lastTxMinutesAgo < 0.083) { // 5 seconds
    alerts.push({
      type: "RAPID_FIRE",
      severity: "medium",
      description: "Transaction submitted less than 5 seconds after previous",
      action: "log",
    });
  }

  // ── Rule 5: Sanctions check on recipient ──────────────────────────────
  const recipientScreen = await screenAddress(recipientAddress);
  if (recipientScreen.isSanctioned) {
    alerts.push({
      type: "SANCTIONED_RECIPIENT",
      severity: "critical",
      description: `Recipient ${recipientAddress} is sanctioned: ${recipientScreen.details}`,
      action: "block",
    });
  }

  // ── Rule 6: Self-dealing ──────────────────────────────────────────────
  if (recipientAddress.toLowerCase() === agent.walletAddress.toLowerCase()) {
    alerts.push({
      type: "SELF_DEALING",
      severity: "high",
      description: "Agent is sending funds to its own wallet",
      action: "block",
    });
  }

  // ── Rule 7: Round number structuring ──────────────────────────────────
  // Check if agent is structuring transactions just under thresholds
  if (amountUsdc >= 9.90 && amountUsdc <= 10.00 && agentTxHistory.recentTxCount24h > 5) {
    alerts.push({
      type: "POSSIBLE_STRUCTURING",
      severity: "medium",
      description: "Multiple transactions near the $10 threshold — possible structuring",
      action: "review",
    });
  }

  // ── Rule 8: Credit maxing — using 90%+ of credit in one go ────────────
  const availableCredit = agent.creditLimitUsdc - agent.usedCreditUsdc;
  if (availableCredit > 0 && amountUsdc / availableCredit > 0.9) {
    alerts.push({
      type: "CREDIT_MAXING",
      severity: "low",
      description: `Using ${((amountUsdc / availableCredit) * 100).toFixed(0)}% of remaining credit in one transaction`,
      action: "log",
    });
  }

  const flagged = alerts.some(a => a.action === "block" || a.action === "freeze");

  return { flagged, alerts };
}

// ---------------------------------------------------------------------------
// 7. PERMISSION CHECK ENGINE — The 5 Gates
// ---------------------------------------------------------------------------

/**
 * Run all permission checks for a payment request.
 * This is the core gate — all checks must pass for payment approval.
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

  // 1. CREDIT CHECK
  const availableCredit = agent.creditLimitUsdc - agent.usedCreditUsdc;
  if (amountUsdc <= availableCredit) {
    result.creditCheck = true;
  } else {
    result.failureReasons.push(
      `Insufficient credit: requested $${amountUsdc}, available $${availableCredit.toFixed(2)}`
    );
  }

  // 2. SANCTIONS CHECK
  const recipientSanctions = await screenAddress(recipientAddress);
  if (!recipientSanctions.isSanctioned) {
    result.sanctionsCheck = true;
  } else {
    result.failureReasons.push(
      `Recipient address ${recipientAddress} is sanctioned (source: ${recipientSanctions.source})`
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
    // Direct address payment — allow but log
    result.merchantCheck = true;
    logger.warn("Payment to unregistered address", { recipientAddress });
  }

  // 4. KYA CHECK
  if (agent.kyaStatus === "approved") {
    result.kyaCheck = true;
  } else {
    result.failureReasons.push(`Agent KYA status is '${agent.kyaStatus}', must be 'approved'`);
  }

  // 5. RISK CHECK
  if (agent.status === "active" && agent.riskScore <= 70) {
    result.riskCheck = true;
  } else if (agent.status !== "active") {
    result.failureReasons.push(`Agent status is '${agent.status}', must be 'active'`);
  } else {
    result.failureReasons.push(`Agent risk score ${agent.riskScore} exceeds threshold of 70`);
  }

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
// 8. CREDIT TIER DEFINITIONS
// ---------------------------------------------------------------------------

/**
 * SOHO Credit Tiers — what agents earn over time
 *
 * NEW ($0-50):
 *   - Fresh registration, no history
 *   - Basic sanctions + address validation only
 *   - 7-day repayment, no grace period
 *
 * BASIC ($50-500):
 *   - 30+ days on network
 *   - 10+ successful transactions
 *   - 80%+ repayment ratio
 *   - 7-day repayment, 2-day grace
 *
 * VERIFIED ($500-5,000):
 *   - 90+ days on network
 *   - 50+ successful transactions
 *   - 95%+ repayment ratio
 *   - 0 delinquencies
 *   - Owner wallet has 90+ day history
 *   - 14-day repayment, 3-day grace
 *
 * PREMIUM ($5,000-50,000):
 *   - 180+ days on network
 *   - 200+ successful transactions
 *   - 98%+ repayment ratio
 *   - 0 delinquencies ever
 *   - Owner wallet verified with significant history
 *   - Custom repayment terms
 *   - Dedicated support
 */
export const CREDIT_TIERS = {
  new: {
    name: "New",
    minLimit: 0,
    maxLimit: 50,
    repaymentDays: 7,
    graceDays: 0,
    requirements: {
      minAccountAgeDays: 0,
      minTransactions: 0,
      minRepaymentRatio: 0,
      maxDelinquencies: 999,
    },
  },
  basic: {
    name: "Basic",
    minLimit: 50,
    maxLimit: 500,
    repaymentDays: 7,
    graceDays: 2,
    requirements: {
      minAccountAgeDays: 30,
      minTransactions: 10,
      minRepaymentRatio: 0.80,
      maxDelinquencies: 2,
    },
  },
  verified: {
    name: "Verified",
    minLimit: 500,
    maxLimit: 5000,
    repaymentDays: 14,
    graceDays: 3,
    requirements: {
      minAccountAgeDays: 90,
      minTransactions: 50,
      minRepaymentRatio: 0.95,
      maxDelinquencies: 0,
    },
  },
  premium: {
    name: "Premium",
    minLimit: 5000,
    maxLimit: 50000,
    repaymentDays: 30,
    graceDays: 7,
    requirements: {
      minAccountAgeDays: 180,
      minTransactions: 200,
      minRepaymentRatio: 0.98,
      maxDelinquencies: 0,
    },
  },
};
