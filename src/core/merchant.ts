// =============================================================================
// Merchant Management
// =============================================================================

import { v4 as uuid } from "uuid";
import { merchantQueries } from "../db";
import { screenAddress } from "../compliance";
import { config } from "../config";
import { logger } from "../utils/logger";
import type { Merchant } from "../types";

export async function registerMerchant(
  name: string,
  walletAddress: string,
  category: string,
  feeBps?: number
): Promise<Merchant> {
  const normalizedAddress = walletAddress.toLowerCase();

  const existing = merchantQueries.getByWallet.get(normalizedAddress) as any;
  if (existing) throw new Error(`Merchant with wallet ${walletAddress} already exists`);

  // Sanctions screening
  const sanctions = await screenAddress(normalizedAddress);
  if (sanctions.isSanctioned) {
    throw new Error(`Wallet ${walletAddress} is on sanctions list`);
  }

  const merchantId = uuid();
  const fee = feeBps ?? config.MERCHANT_FEE_BPS;

  merchantQueries.create.run(merchantId, normalizedAddress, name, category, fee);

  logger.info(`Merchant registered`, { merchantId, name, wallet: normalizedAddress });

  return {
    id: merchantId,
    walletAddress: normalizedAddress,
    name,
    category,
    status: "active",
    feeBps: fee,
    sanctionsClean: true,
    createdAt: new Date().toISOString(),
  };
}

export function getMerchant(merchantId: string): Merchant | null {
  const raw = merchantQueries.getById.get(merchantId) as any;
  if (!raw) return null;
  return {
    id: raw.id,
    walletAddress: raw.wallet_address,
    name: raw.name,
    category: raw.category,
    status: raw.status,
    feeBps: raw.fee_bps,
    sanctionsClean: !!raw.sanctions_clean,
    createdAt: raw.created_at,
  };
}

export function listMerchants(page = 1, pageSize = 20) {
  const offset = (page - 1) * pageSize;
  const rows = merchantQueries.getAll.all(pageSize, offset) as any[];
  return rows.map((raw: any) => ({
    id: raw.id,
    walletAddress: raw.wallet_address,
    name: raw.name,
    category: raw.category,
    status: raw.status,
    feeBps: raw.fee_bps,
    sanctionsClean: !!raw.sanctions_clean,
    createdAt: raw.created_at,
  }));
}
