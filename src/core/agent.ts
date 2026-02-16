// =============================================================================
// Agent Management — Registration, Key Setup, Wallet Funding
// =============================================================================

import { v4 as uuid } from "uuid";
import { createHash, randomBytes } from "crypto";
import { agentQueries, apiKeyQueries, db } from "../db";
import { generateMPCKeyPair } from "../mpc";
import { performKYA } from "../compliance";
import { config } from "../config";
import { getChain } from "../chains";
import { reserveLiquidity } from "../vault";
import { logger } from "../utils/logger";
import type { Agent } from "../types";

// ---------------------------------------------------------------------------
// Agent Registration
// ---------------------------------------------------------------------------

export interface RegisterAgentResult {
  agent: Agent;
  apiKey: string;
  mpcAgentShard: string;
  walletFunded: boolean;
  fundingTxHash?: string;
  gasTxHash?: string;
}

/**
 * Register a new AI agent:
 * 1. Generate real MPC key pair (2-of-2 ECDSA)
 * 2. Derive real Ethereum address from combined public key
 * 3. Create API key
 * 4. Fund agent's MPC wallet with USDC (credit allocation) + ETH (gas)
 * 5. Initiate KYA
 */
export async function registerAgent(
  name: string,
  ownerAddress: string,
  requestedCreditLimit?: number
): Promise<RegisterAgentResult> {
  // 1. Generate MPC key pair — real ECDSA with additive shards
  const mpcKeys = await generateMPCKeyPair(config.MPC_ENCRYPTION_KEY);

  // 2. Use the real Ethereum address derived from keccak256
  const walletAddress = mpcKeys._ethAddress;

  // 3. Check for duplicate
  const existing = agentQueries.getByWallet.get(walletAddress) as any;
  if (existing) {
    throw new Error(`Agent with wallet ${walletAddress} already exists`);
  }

  // 4. Determine credit limit
  const creditLimit = Math.min(
    requestedCreditLimit || config.DEFAULT_CREDIT_LIMIT_USDC,
    config.MAX_CREDIT_LIMIT_USDC
  );

  // 5. Create agent record
  const agentId = uuid();
  agentQueries.create.run(
    agentId,
    walletAddress,
    name,
    ownerAddress.toLowerCase(),
    creditLimit,
    mpcKeys.publicKey,
    mpcKeys.serverShard
  );

  // 6. Generate API key
  const rawApiKey = `acp_${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawApiKey).digest("hex");
  const apiKeyId = uuid();
  apiKeyQueries.create.run(
    apiKeyId,
    agentId,
    keyHash,
    "default",
    JSON.stringify(["payment:create", "payment:read", "credit:read", "agent:read"])
  );

  // 7. Fund agent's MPC wallet with USDC + gas ETH
  let walletFunded = false;
  let fundingTxHash: string | undefined;
  let gasTxHash: string | undefined;

  try {
    const chain = getChain("base") as any;

    // Check if chain provider supports funding (BaseChainLive)
    if (chain.sendGasEth && chain.transferUsdc) {
      // Reserve liquidity from vault for this agent's credit
      reserveLiquidity(creditLimit);

      // Send gas ETH first (agent needs it to sign USDC transfers)
      gasTxHash = await chain.sendGasEth(walletAddress, 0.0005); // ~$1.25 of ETH covers thousands of Base txs
      logger.info(`Gas funded for agent ${agentId}`, { gasTxHash, wallet: walletAddress });

      // Send USDC credit allocation from vault to agent's MPC wallet
      const fundResult = await chain.transferUsdc({
        fromAddress: "vault",
        toAddress: walletAddress,
        amountUsdc: creditLimit,
        signature: "vault-funding",
        memo: `Credit allocation for agent ${agentId}`,
      });

      fundingTxHash = fundResult.txHash;
      walletFunded = fundResult.confirmed;

      logger.info(`Agent wallet funded`, {
        agentId, wallet: walletAddress,
        usdc: creditLimit, txHash: fundingTxHash,
      });
    } else {
      logger.info(`Simulation mode — wallet not funded onchain`, { agentId });
    }
  } catch (error: any) {
    logger.error(`Failed to fund agent wallet`, { agentId, error: error.message });
    // Don't fail registration — agent can be funded later
  }

  // 8. Initiate KYA
  performKYA(agentId, ownerAddress, walletAddress).catch((err) => {
    logger.error("KYA failed for agent", { agentId, error: err.message });
  });

  const agent: Agent = {
    id: agentId,
    walletAddress,
    name,
    ownerAddress: ownerAddress.toLowerCase(),
    creditLimitUsdc: creditLimit,
    usedCreditUsdc: 0,
    availableCreditUsdc: creditLimit,
    status: "active",
    kyaStatus: "pending",
    riskScore: 50,
    mpcPublicKey: mpcKeys.publicKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  logger.info("Agent registered", {
    agentId, name, wallet: walletAddress,
    creditLimit, walletFunded,
  });

  return {
    agent,
    apiKey: rawApiKey,
    mpcAgentShard: mpcKeys.agentShard,
    walletFunded,
    fundingTxHash,
    gasTxHash,
  };
}

// ---------------------------------------------------------------------------
// Agent Queries
// ---------------------------------------------------------------------------

export function getAgent(agentId: string): Agent | null {
  const raw = agentQueries.getById.get(agentId) as any;
  if (!raw) return null;
  return mapAgent(raw);
}

export function getAgentByWallet(walletAddress: string): Agent | null {
  const raw = agentQueries.getByWallet.get(walletAddress.toLowerCase()) as any;
  if (!raw) return null;
  return mapAgent(raw);
}

export function listAgents(page = 1, pageSize = 20): { agents: Agent[]; total: number } {
  const offset = (page - 1) * pageSize;
  const rows = agentQueries.getAll.all(pageSize, offset) as any[];
  return { agents: rows.map(mapAgent), total: rows.length };
}

// ---------------------------------------------------------------------------
// Credit Limit Adjustment
// ---------------------------------------------------------------------------

export function adjustCreditLimit(agentId: string, newLimitUsdc: number): Agent {
  const agent = agentQueries.getById.get(agentId) as any;
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  if (newLimitUsdc < agent.used_credit_usdc) {
    throw new Error(`Cannot set limit below current usage ($${agent.used_credit_usdc})`);
  }

  if (newLimitUsdc > config.MAX_CREDIT_LIMIT_USDC) {
    throw new Error(`Limit cannot exceed $${config.MAX_CREDIT_LIMIT_USDC}`);
  }

  db.prepare(
    "UPDATE agents SET credit_limit_usdc = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(newLimitUsdc, agentId);

  return getAgent(agentId)!;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapAgent(raw: any): Agent {
  return {
    id: raw.id,
    walletAddress: raw.wallet_address,
    name: raw.name,
    ownerAddress: raw.owner_address,
    creditLimitUsdc: raw.credit_limit_usdc,
    usedCreditUsdc: raw.used_credit_usdc,
    availableCreditUsdc: raw.credit_limit_usdc - raw.used_credit_usdc,
    status: raw.status,
    kyaStatus: raw.kya_status,
    riskScore: raw.risk_score,
    mpcPublicKey: raw.mpc_public_key,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}
