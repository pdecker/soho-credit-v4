// =============================================================================
// AgentCredit Protocol - Core Type Definitions
// =============================================================================

import { z } from "zod";

// ---------------------------------------------------------------------------
// Agent / Account Types
// ---------------------------------------------------------------------------

export interface Agent {
  id: string;
  walletAddress: string; // Agent's onchain address (MPC co-signer)
  name: string;
  ownerAddress: string; // Human/org that controls this agent
  creditLimitUsdc: number; // Max credit in USDC (6 decimals)
  usedCreditUsdc: number; // Current outstanding balance
  availableCreditUsdc: number; // creditLimit - usedCredit
  status: AgentStatus;
  kyaStatus: KYAStatus;
  riskScore: number; // 0-100, lower is better
  mpcPublicKey: string; // Combined MPC public key
  createdAt: string;
  updatedAt: string;
}

export type AgentStatus = "active" | "suspended" | "delinquent" | "closed";
export type KYAStatus = "pending" | "approved" | "rejected" | "review";

// ---------------------------------------------------------------------------
// Merchant Types
// ---------------------------------------------------------------------------

export interface Merchant {
  id: string;
  walletAddress: string;
  name: string;
  category: string;
  status: MerchantStatus;
  feeBps: number; // Fee in basis points (150 = 1.5%)
  sanctionsClean: boolean;
  createdAt: string;
}

export type MerchantStatus = "active" | "suspended" | "blocked";

// ---------------------------------------------------------------------------
// Transaction Types
// ---------------------------------------------------------------------------

export interface Transaction {
  id: string;
  agentId: string;
  merchantId: string | null; // null for agent-to-agent
  recipientAgentId: string | null; // non-null for agent-to-agent
  amountUsdc: number;
  feeUsdc: number;
  netAmountUsdc: number; // amount - fee (what merchant receives)
  status: TransactionStatus;
  type: TransactionType;
  txHash: string | null; // Onchain tx hash once settled
  recipientAddress: string;
  memo: string | null;
  permissionChecks: PermissionCheckResult;
  mpcSignatureId: string | null;
  createdAt: string;
  settledAt: string | null;
}

export type TransactionStatus =
  | "pending_approval"
  | "approved"
  | "signing"
  | "broadcasting"
  | "confirmed"
  | "failed"
  | "rejected";

export type TransactionType = "agent_to_merchant" | "agent_to_agent" | "repayment";

export interface PermissionCheckResult {
  creditCheck: boolean;
  sanctionsCheck: boolean;
  merchantCheck: boolean;
  kyaCheck: boolean;
  riskCheck: boolean;
  allPassed: boolean;
  failureReasons: string[];
}

// ---------------------------------------------------------------------------
// Credit / Repayment Types
// ---------------------------------------------------------------------------

export interface CreditLine {
  agentId: string;
  creditLimitUsdc: number;
  usedCreditUsdc: number;
  availableCreditUsdc: number;
  repaymentDueDate: string;
  isDelinquent: boolean;
  totalRepaid: number;
  totalBorrowed: number;
}

export interface Repayment {
  id: string;
  agentId: string;
  amountUsdc: number;
  txHash: string | null;
  status: "pending" | "confirmed" | "failed";
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Vault / Lender Types
// ---------------------------------------------------------------------------

export interface Vault {
  totalDepositsUsdc: number;
  totalLentUsdc: number;
  availableLiquidityUsdc: number;
  totalFeesEarnedUsdc: number;
  currentApyBps: number; // Annual yield in bps
  totalShares: number;
}

export interface LenderPosition {
  id: string;
  lenderAddress: string;
  depositedUsdc: number;
  sharesOwned: number;
  earnedYieldUsdc: number;
  depositTxHash: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// MPC Types
// ---------------------------------------------------------------------------

export interface MPCSignatureRequest {
  id: string;
  transactionId: string;
  messageHash: string;
  serverPartialSig: string | null;
  agentPartialSig: string | null;
  combinedSignature: string | null;
  status: "pending" | "server_signed" | "complete" | "failed";
  createdAt: string;
}

export interface MPCKeyPair {
  publicKey: string;
  serverShard: string; // Encrypted
  agentShard: string; // Returned to agent on registration, never stored
}

// ---------------------------------------------------------------------------
// API Request/Response Schemas (Zod)
// ---------------------------------------------------------------------------

export const RegisterAgentSchema = z.object({
  name: z.string().min(1).max(100),
  ownerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  requestedCreditLimitUsdc: z.number().positive().max(100000).optional(),
});

export const RegisterMerchantSchema = z.object({
  name: z.string().min(1).max(100),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  category: z.string().min(1).max(50),
});

export const PaymentRequestSchema = z.object({
  recipientAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amountUsdc: z.number().positive(),
  memo: z.string().max(256).optional(),
  merchantId: z.string().uuid().optional(),
  recipientAgentId: z.string().uuid().optional(),
  agentPartialSignature: z.string().optional(), // For MPC co-signing
  idempotencyKey: z.string().uuid(),
});

export const RepaymentRequestSchema = z.object({
  amountUsdc: z.number().positive(),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export const LendRequestSchema = z.object({
  lenderAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amountUsdc: z.number().positive(),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export const WithdrawRequestSchema = z.object({
  lenderAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  sharesAmount: z.number().positive(),
});

export const CreditCheckSchema = z.object({
  agentId: z.string().uuid(),
  amountUsdc: z.number().positive(),
});

// ---------------------------------------------------------------------------
// API Response Wrappers
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    requestId: string;
    timestamp: string;
  };
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  };
}

// ---------------------------------------------------------------------------
// x402 Protocol Compatibility
// ---------------------------------------------------------------------------

export interface X402PaymentHeader {
  version: "1";
  scheme: "exact";
  network: "base" | "base-sepolia";
  token: string; // USDC contract address
  amount: string; // In smallest unit (6 decimals for USDC)
  recipient: string; // Merchant wallet
  maxTimeoutSeconds: number;
}

export interface X402PaymentPayload {
  paymentHeader: X402PaymentHeader;
  signature: string; // Combined MPC signature
  agentId: string;
  transactionId: string;
}
