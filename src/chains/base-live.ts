// =============================================================================
// Base Chain Provider — LIVE (viem)
// =============================================================================
// Two modes:
//   1. HOT WALLET: Server holds single key, signs directly (simpler)
//   2. MPC WALLET: Agent + server each hold a shard, reconstruct to sign
//
// For both modes, real USDC transfers on Base L2.
// =============================================================================

import { logger } from "../utils/logger";
import type { ChainProvider, ChainId, ChainTransferParams, ChainTransferResult } from "./index";

const USDC_ADDRESSES: Record<string, `0x${string}`> = {
  "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Safety limits
const MAX_SINGLE_TX_USDC = 10;

export class BaseChainLive implements ChainProvider {
  chain: ChainId;
  private rpcUrl: string;
  private usdcAddress: `0x${string}`;
  private hotWalletKey: `0x${string}` | null;
  private isLive: boolean;

  constructor(rpcUrl: string, chain: ChainId = "base", hotWalletKey?: string) {
    this.rpcUrl = rpcUrl;
    this.chain = chain;
    this.usdcAddress = USDC_ADDRESSES[chain] || USDC_ADDRESSES["base"];
    this.hotWalletKey = hotWalletKey
      ? (hotWalletKey.startsWith("0x") ? hotWalletKey : `0x${hotWalletKey}`) as `0x${string}`
      : null;
    this.isLive = !!hotWalletKey && hotWalletKey.length > 10;

    logger.info(`[Base] ${this.isLive ? "LIVE" : "SIMULATION"} MODE on ${chain}`);
  }

  /**
   * Transfer USDC using a raw private key (for hot wallet or reconstructed MPC key).
   * This is the core transfer function used by both modes.
   */
  async transferUsdcWithKey(
    privateKey: `0x${string}`,
    toAddress: string,
    amountUsdc: number
  ): Promise<ChainTransferResult> {
    if (amountUsdc > MAX_SINGLE_TX_USDC) {
      throw new Error(`Safety limit: max $${MAX_SINGLE_TX_USDC} per tx (requested $${amountUsdc})`);
    }

    const { createPublicClient, createWalletClient, http, parseUnits } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { base, baseSepolia } = await import("viem/chains");

    const chain = this.chain === "base-sepolia" ? baseSepolia : base;
    const account = privateKeyToAccount(privateKey);

    const publicClient = createPublicClient({ chain, transport: http(this.rpcUrl) });
    const walletClient = createWalletClient({ chain, transport: http(this.rpcUrl), account });

    // Check balance
    const balance = await publicClient.readContract({
      address: this.usdcAddress, abi: ERC20_ABI,
      functionName: "balanceOf", args: [account.address],
    });
    const balanceUsdc = Number(balance) / 1e6;
    if (balanceUsdc < amountUsdc) {
      throw new Error(`Insufficient USDC: have $${balanceUsdc.toFixed(2)}, need $${amountUsdc}`);
    }

    logger.info(`[Base] Transferring $${amountUsdc} USDC from ${account.address} to ${toAddress}`);

    const amountRaw = parseUnits(amountUsdc.toString(), 6);
    const hash = await walletClient.writeContract({
      address: this.usdcAddress, abi: ERC20_ABI,
      functionName: "transfer",
      args: [toAddress as `0x${string}`, amountRaw],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    const confirmed = receipt.status === "success";

    logger.info(`[Base] Tx ${confirmed ? "CONFIRMED" : "FAILED"}: ${hash} (block ${receipt.blockNumber})`);

    return {
      txHash: hash, chain: this.chain,
      blockNumber: Number(receipt.blockNumber),
      fee: 0.001, confirmed,
    };
  }

  /**
   * Standard transfer using the hot wallet (vault → agent, or vault → merchant).
   */
  async transferUsdc(params: ChainTransferParams): Promise<ChainTransferResult> {
    if (!this.isLive || !this.hotWalletKey) {
      logger.info(`[Base] SIMULATED: $${params.amountUsdc} to ${params.toAddress}`);
      const { createHash } = await import("crypto");
      const txHash = "0x" + createHash("sha256")
        .update(`sim:${params.toAddress}:${params.amountUsdc}:${Date.now()}`)
        .digest("hex");
      return { txHash, chain: this.chain, blockNumber: 0, fee: 0.001, confirmed: true };
    }

    return this.transferUsdcWithKey(this.hotWalletKey, params.toAddress, params.amountUsdc);
  }

  /**
   * Transfer USDC from an MPC wallet using reconstructed private key.
   * Called when agent co-signs a transaction.
   */
  async transferUsdcMPC(
    reconstructedKeyHex: string,
    toAddress: string,
    amountUsdc: number
  ): Promise<ChainTransferResult> {
    const key = (reconstructedKeyHex.startsWith("0x")
      ? reconstructedKeyHex
      : "0x" + reconstructedKeyHex) as `0x${string}`;

    return this.transferUsdcWithKey(key, toAddress, amountUsdc);
  }

  /**
   * Send ETH for gas to an address (used to fund agent MPC wallets).
   */
  async sendGasEth(toAddress: string, amountEth: number = 0.0001): Promise<string> {
    if (!this.isLive || !this.hotWalletKey) {
      return "0x_simulated_gas_tx";
    }

    const { createPublicClient, createWalletClient, http, parseEther } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { base, baseSepolia } = await import("viem/chains");

    const chain = this.chain === "base-sepolia" ? baseSepolia : base;
    const account = privateKeyToAccount(this.hotWalletKey);
    const walletClient = createWalletClient({ chain, transport: http(this.rpcUrl), account });
    const publicClient = createPublicClient({ chain, transport: http(this.rpcUrl) });

    const hash = await walletClient.sendTransaction({
      to: toAddress as `0x${string}`,
      value: parseEther(amountEth.toString()),
    });

    await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    logger.info(`[Base] Sent ${amountEth} ETH for gas to ${toAddress}: ${hash}`);
    return hash;
  }

  async getUsdcBalance(address: string): Promise<number> {
    if (!this.isLive) return 0;
    try {
      const { createPublicClient, http } = await import("viem");
      const { base, baseSepolia } = await import("viem/chains");
      const chain = this.chain === "base-sepolia" ? baseSepolia : base;
      const client = createPublicClient({ chain, transport: http(this.rpcUrl) });
      const balance = await client.readContract({
        address: this.usdcAddress, abi: ERC20_ABI,
        functionName: "balanceOf", args: [address as `0x${string}`],
      });
      return Number(balance) / 1e6;
    } catch (error: any) {
      logger.error(`[Base] Balance check failed: ${error.message}`);
      return 0;
    }
  }

  async verifyTransaction(txHash: string): Promise<{ confirmed: boolean; blockNumber: number }> {
    if (!this.isLive) return { confirmed: true, blockNumber: 0 };
    try {
      const { createPublicClient, http } = await import("viem");
      const { base, baseSepolia } = await import("viem/chains");
      const chain = this.chain === "base-sepolia" ? baseSepolia : base;
      const client = createPublicClient({ chain, transport: http(this.rpcUrl) });
      const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
      return { confirmed: receipt.status === "success", blockNumber: Number(receipt.blockNumber) };
    } catch {
      return { confirmed: false, blockNumber: 0 };
    }
  }

  async estimateFee(): Promise<number> { return 0.001; }

  async getHotWalletAddress(): Promise<string | null> {
    if (!this.hotWalletKey) return null;
    const { privateKeyToAccount } = await import("viem/accounts");
    return privateKeyToAccount(this.hotWalletKey).address;
  }

  async getHotWalletBalance(): Promise<number> {
    const addr = await this.getHotWalletAddress();
    return addr ? this.getUsdcBalance(addr) : 0;
  }
}
