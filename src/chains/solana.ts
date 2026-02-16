// =============================================================================
// Solana Chain Provider
// =============================================================================
// Solana: ~$0.00025 per tx, native USDC via SPL token
// USDC on Solana: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
// =============================================================================

import { createHash } from "crypto";
import { logger } from "../utils/logger";
import type { ChainProvider, ChainId, ChainTransferParams, ChainTransferResult } from "./index";

const USDC_MINT: Record<string, string> = {
  "solana": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "solana-devnet": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

export class SolanaChain implements ChainProvider {
  chain: ChainId;
  private rpcUrl: string;
  private usdcMint: string;

  constructor(rpcUrl: string, chain: ChainId = "solana") {
    this.rpcUrl = rpcUrl;
    this.chain = chain;
    this.usdcMint = USDC_MINT[chain] || USDC_MINT["solana"];
  }

  /**
   * Transfer USDC on Solana as SPL token transfer.
   *
   * Production implementation:
   *
   * import { Connection, PublicKey, Transaction } from '@solana/web3.js';
   * import { createTransferInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
   *
   * const connection = new Connection(this.rpcUrl);
   * const usdcMint = new PublicKey(this.usdcMint);
   *
   * // Get associated token accounts
   * const fromATA = await getAssociatedTokenAddress(usdcMint, vaultPublicKey);
   * const toATA = await getAssociatedTokenAddress(usdcMint, new PublicKey(params.toAddress));
   *
   * // Create transfer instruction (USDC has 6 decimals on Solana too)
   * const amountLamports = Math.round(params.amountUsdc * 1e6);
   * const ix = createTransferInstruction(fromATA, toATA, vaultPublicKey, amountLamports);
   *
   * // Build and sign transaction with MPC
   * const tx = new Transaction().add(ix);
   * tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
   * tx.feePayer = vaultPublicKey;
   *
   * // Sign with MPC (Ed25519 for Solana, not secp256k1)
   * // Note: Solana uses Ed25519, so MPC implementation differs from EVM
   * tx.addSignature(vaultPublicKey, mpcSignature);
   *
   * const sig = await connection.sendRawTransaction(tx.serialize());
   * await connection.confirmTransaction(sig, 'confirmed');
   */
  async transferUsdc(params: ChainTransferParams): Promise<ChainTransferResult> {
    logger.info(`[Solana] Transferring ${params.amountUsdc} USDC to ${params.toAddress}`);

    // Simulated for dev
    const txHash = createHash("sha256")
      .update(`sol:${params.toAddress}:${params.amountUsdc}:${Date.now()}`)
      .digest("base64url")
      .substring(0, 88);

    return {
      txHash,
      chain: this.chain,
      blockNumber: Math.floor(Date.now() / 400), // ~400ms slot time
      fee: 0.00025, // Solana txs cost ~$0.00025
      confirmed: true,
    };
  }

  async getUsdcBalance(address: string): Promise<number> {
    // Production:
    // const connection = new Connection(this.rpcUrl);
    // const pubkey = new PublicKey(address);
    // const usdcMint = new PublicKey(this.usdcMint);
    // const ata = await getAssociatedTokenAddress(usdcMint, pubkey);
    // const balance = await connection.getTokenAccountBalance(ata);
    // return balance.value.uiAmount || 0;

    logger.debug(`[Solana] Balance check for ${address}`);
    return 0;
  }

  async verifyTransaction(txHash: string): Promise<{ confirmed: boolean; blockNumber: number }> {
    // Production:
    // const connection = new Connection(this.rpcUrl);
    // const status = await connection.getSignatureStatus(txHash);
    // return { confirmed: status?.value?.confirmationStatus === 'confirmed', blockNumber: status?.value?.slot || 0 };

    return { confirmed: true, blockNumber: Math.floor(Date.now() / 400) };
  }

  async estimateFee(_toAddress: string, _amountUsdc: number): Promise<number> {
    // Solana priority fees are very low
    return 0.00025;
  }
}
