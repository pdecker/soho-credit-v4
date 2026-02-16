// =============================================================================
// Chain Abstraction Layer
// =============================================================================
// Supports Base (EVM/L2) as primary chain, Solana as secondary.
// All settlement happens onchain via USDC native to each chain.
// =============================================================================

import { BaseChain } from "./base";
import { BaseChainLive } from "./base-live";
import { SolanaChain } from "./solana";
import { logger } from "../utils/logger";

export type ChainId = "base" | "base-sepolia" | "solana" | "solana-devnet";

export interface ChainTransferParams {
  fromAddress: string;
  toAddress: string;
  amountUsdc: number; // Human-readable (e.g. 10.50)
  signature: string;
  memo?: string;
}

export interface ChainTransferResult {
  txHash: string;
  chain: ChainId;
  blockNumber?: number;
  fee: number; // Gas/priority fee in USD
  confirmed: boolean;
}

export interface ChainProvider {
  chain: ChainId;
  transferUsdc(params: ChainTransferParams): Promise<ChainTransferResult>;
  getUsdcBalance(address: string): Promise<number>;
  verifyTransaction(txHash: string): Promise<{ confirmed: boolean; blockNumber: number }>;
  estimateFee(toAddress: string, amountUsdc: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Chain Registry
// ---------------------------------------------------------------------------

const chains = new Map<ChainId, ChainProvider>();

export function registerChain(provider: ChainProvider): void {
  chains.set(provider.chain, provider);
  logger.info(`Chain registered: ${provider.chain}`);
}

export function getChain(chainId: ChainId): ChainProvider {
  const chain = chains.get(chainId);
  if (!chain) throw new Error(`Chain ${chainId} not registered. Available: ${Array.from(chains.keys()).join(", ")}`);
  return chain;
}

export function getAllChains(): ChainId[] {
  return Array.from(chains.keys());
}

// ---------------------------------------------------------------------------
// Initialize default chains
// ---------------------------------------------------------------------------

export function initializeChains(rpcUrls?: Partial<Record<ChainId, string>>): void {
  const hotWalletKey = process.env.HOT_WALLET_KEY;

  if (hotWalletKey) {
    // LIVE MODE: real USDC transfers
    logger.info("🟢 LIVE MODE — Hot wallet key detected, using real chain providers");

    registerChain(new BaseChainLive(
      rpcUrls?.["base"] || process.env.RPC_URL || "https://mainnet.base.org",
      "base",
      hotWalletKey
    ));

    registerChain(new BaseChainLive(
      rpcUrls?.["base-sepolia"] || "https://sepolia.base.org",
      "base-sepolia",
      hotWalletKey
    ));
  } else {
    // SIMULATION MODE: fake transactions
    logger.info("🟡 SIMULATION MODE — No hot wallet key, using simulated chain providers");

    registerChain(new BaseChain(
      rpcUrls?.["base"] || "https://mainnet.base.org",
      "base"
    ));

    registerChain(new BaseChain(
      rpcUrls?.["base-sepolia"] || "https://sepolia.base.org",
      "base-sepolia"
    ));
  }

  // Solana (secondary)
  registerChain(new SolanaChain(
    rpcUrls?.["solana"] || "https://api.mainnet-beta.solana.com",
    "solana"
  ));

  // Solana Devnet
  registerChain(new SolanaChain(
    rpcUrls?.["solana-devnet"] || "https://api.devnet.solana.com",
    "solana-devnet"
  ));

  logger.info(`Initialized ${chains.size} chain providers`);
}
