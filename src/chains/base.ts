// =============================================================================
// Base Chain Provider (EVM L2)
// =============================================================================
// Base: Coinbase's L2, ~$0.001 per tx, native USDC support
// USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
// =============================================================================

import { createHash } from "crypto";
import { logger } from "../utils/logger";
import type { ChainProvider, ChainId, ChainTransferParams, ChainTransferResult } from "./index";

// USDC contract addresses per network
const USDC_ADDRESSES: Record<string, string> = {
  "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

// Standard ERC-20 ABI for USDC transfer
const ERC20_TRANSFER_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

export class BaseChain implements ChainProvider {
  chain: ChainId;
  private rpcUrl: string;
  private usdcAddress: string;

  constructor(rpcUrl: string, chain: ChainId = "base") {
    this.rpcUrl = rpcUrl;
    this.chain = chain;
    this.usdcAddress = USDC_ADDRESSES[chain] || USDC_ADDRESSES["base"];
  }

  /**
   * Transfer USDC on Base via the vault contract.
   * In production, this uses ethers.js/viem to call the vault's disburse() function.
   */
  async transferUsdc(params: ChainTransferParams): Promise<ChainTransferResult> {
    logger.info(`[Base] Transferring ${params.amountUsdc} USDC to ${params.toAddress}`);

    // Production implementation with viem:
    //
    // import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
    // import { base } from 'viem/chains';
    //
    // const client = createPublicClient({ chain: base, transport: http(this.rpcUrl) });
    // const walletClient = createWalletClient({ chain: base, transport: http(this.rpcUrl) });
    //
    // // Encode USDC transfer calldata
    // const amountRaw = parseUnits(params.amountUsdc.toString(), 6); // USDC has 6 decimals
    //
    // // Option A: Direct vault contract call
    // const hash = await walletClient.writeContract({
    //   address: VAULT_CONTRACT_ADDRESS,
    //   abi: VAULT_ABI,
    //   functionName: 'disburse',
    //   args: [params.toAddress, amountRaw, params.memo || ''],
    //   account: vaultSignerAccount, // MPC-derived account
    // });
    //
    // // Option B: Raw ERC-20 transfer from vault
    // const hash = await walletClient.writeContract({
    //   address: this.usdcAddress,
    //   abi: ERC20_TRANSFER_ABI,
    //   functionName: 'transfer',
    //   args: [params.toAddress, amountRaw],
    //   account: vaultSignerAccount,
    // });
    //
    // const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });

    // Simulated for dev
    const txHash = "0x" + createHash("sha256")
      .update(`base:${params.toAddress}:${params.amountUsdc}:${Date.now()}`)
      .digest("hex");

    return {
      txHash,
      chain: this.chain,
      blockNumber: Math.floor(Date.now() / 2000), // ~2s block time on Base
      fee: 0.001, // Base txs cost ~$0.001
      confirmed: true,
    };
  }

  async getUsdcBalance(address: string): Promise<number> {
    // Production:
    // const client = createPublicClient({ chain: base, transport: http(this.rpcUrl) });
    // const balance = await client.readContract({
    //   address: this.usdcAddress, abi: ERC20_TRANSFER_ABI,
    //   functionName: 'balanceOf', args: [address],
    // });
    // return Number(balance) / 1e6;

    logger.debug(`[Base] Balance check for ${address}`);
    return 0; // Placeholder
  }

  async verifyTransaction(txHash: string): Promise<{ confirmed: boolean; blockNumber: number }> {
    // Production:
    // const receipt = await client.getTransactionReceipt({ hash: txHash });
    // return { confirmed: receipt.status === 'success', blockNumber: Number(receipt.blockNumber) };

    return { confirmed: true, blockNumber: Math.floor(Date.now() / 2000) };
  }

  async estimateFee(_toAddress: string, _amountUsdc: number): Promise<number> {
    // Base L2 fees are extremely low (~$0.001 per tx)
    // Production: estimate gas * gas price
    return 0.001;
  }
}
