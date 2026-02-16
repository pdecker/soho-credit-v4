// =============================================================================
// Database Layer - SQLite with Drizzle ORM
// =============================================================================

import Database from "better-sqlite3";
import { config } from "../config";
import { logger } from "../utils/logger";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";

// Ensure data directory exists
const dbDir = path.dirname(config.DATABASE_URL);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.DATABASE_URL);

// Enable WAL mode for better concurrent read/write performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// ---------------------------------------------------------------------------
// Schema Migration
// ---------------------------------------------------------------------------

export function migrate(): void {
  logger.info("Running database migrations...");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      wallet_address TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      owner_address TEXT NOT NULL,
      credit_limit_usdc REAL NOT NULL DEFAULT 1000,
      used_credit_usdc REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      kya_status TEXT NOT NULL DEFAULT 'pending',
      risk_score INTEGER NOT NULL DEFAULT 50,
      mpc_public_key TEXT NOT NULL,
      mpc_server_shard_enc TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      wallet_address TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      fee_bps INTEGER NOT NULL DEFAULT 150,
      sanctions_clean INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      merchant_id TEXT REFERENCES merchants(id),
      recipient_agent_id TEXT REFERENCES agents(id),
      amount_usdc REAL NOT NULL,
      fee_usdc REAL NOT NULL DEFAULT 0,
      net_amount_usdc REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_approval',
      type TEXT NOT NULL,
      tx_hash TEXT,
      recipient_address TEXT NOT NULL,
      memo TEXT,
      permission_checks TEXT NOT NULL DEFAULT '{}',
      mpc_signature_id TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS repayments (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      amount_usdc REAL NOT NULL,
      tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vault (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_deposits_usdc REAL NOT NULL DEFAULT 0,
      total_lent_usdc REAL NOT NULL DEFAULT 0,
      total_fees_earned_usdc REAL NOT NULL DEFAULT 0,
      total_shares REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lender_positions (
      id TEXT PRIMARY KEY,
      lender_address TEXT NOT NULL,
      deposited_usdc REAL NOT NULL,
      shares_owned REAL NOT NULL,
      earned_yield_usdc REAL NOT NULL DEFAULT 0,
      deposit_tx_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mpc_signatures (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL REFERENCES transactions(id),
      message_hash TEXT NOT NULL,
      server_partial_sig TEXT,
      agent_partial_sig TEXT,
      combined_signature TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sanctioned_addresses (
      address TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      key_hash TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '["payment:create","payment:read"]',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_repayments_agent ON repayments(agent_id);
    CREATE INDEX IF NOT EXISTS idx_lender_positions_address ON lender_positions(lender_address);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

    -- Initialize vault singleton
    INSERT OR IGNORE INTO vault (id, total_deposits_usdc, total_lent_usdc, total_fees_earned_usdc, total_shares)
    VALUES (1, 0, 0, 0, 0);
  `);

  logger.info("Database migrations complete.");
}

// ---------------------------------------------------------------------------
// Agent Queries
// ---------------------------------------------------------------------------

export const agentQueries = {
  create: db.prepare(`
    INSERT INTO agents (id, wallet_address, name, owner_address, credit_limit_usdc, mpc_public_key, mpc_server_shard_enc, kya_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `),

  getById: db.prepare(`SELECT * FROM agents WHERE id = ?`),
  getByWallet: db.prepare(`SELECT * FROM agents WHERE wallet_address = ?`),
  getAll: db.prepare(`SELECT * FROM agents ORDER BY created_at DESC LIMIT ? OFFSET ?`),

  updateCredit: db.prepare(`
    UPDATE agents SET used_credit_usdc = ?, updated_at = datetime('now') WHERE id = ?
  `),

  updateStatus: db.prepare(`
    UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?
  `),

  updateKYA: db.prepare(`
    UPDATE agents SET kya_status = ?, updated_at = datetime('now') WHERE id = ?
  `),

  updateRiskScore: db.prepare(`
    UPDATE agents SET risk_score = ?, updated_at = datetime('now') WHERE id = ?
  `),
};

// ---------------------------------------------------------------------------
// Merchant Queries
// ---------------------------------------------------------------------------

export const merchantQueries = {
  create: db.prepare(`
    INSERT INTO merchants (id, wallet_address, name, category, fee_bps)
    VALUES (?, ?, ?, ?, ?)
  `),

  getById: db.prepare(`SELECT * FROM merchants WHERE id = ?`),
  getByWallet: db.prepare(`SELECT * FROM merchants WHERE wallet_address = ?`),
  getAll: db.prepare(`SELECT * FROM merchants ORDER BY created_at DESC LIMIT ? OFFSET ?`),

  updateStatus: db.prepare(`
    UPDATE merchants SET status = ? WHERE id = ?
  `),

  updateSanctions: db.prepare(`
    UPDATE merchants SET sanctions_clean = ? WHERE id = ?
  `),
};

// ---------------------------------------------------------------------------
// Transaction Queries
// ---------------------------------------------------------------------------

export const txQueries = {
  create: db.prepare(`
    INSERT INTO transactions (id, agent_id, merchant_id, recipient_agent_id, amount_usdc, fee_usdc, net_amount_usdc, status, type, recipient_address, memo, permission_checks, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getById: db.prepare(`SELECT * FROM transactions WHERE id = ?`),
  getByIdempotencyKey: db.prepare(`SELECT * FROM transactions WHERE idempotency_key = ?`),

  getByAgent: db.prepare(`
    SELECT * FROM transactions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `),

  updateStatus: db.prepare(`
    UPDATE transactions SET status = ?, settled_at = CASE WHEN ? = 'confirmed' THEN datetime('now') ELSE settled_at END WHERE id = ?
  `),

  updateTxHash: db.prepare(`
    UPDATE transactions SET tx_hash = ? WHERE id = ?
  `),

  updateMpcSigId: db.prepare(`
    UPDATE transactions SET mpc_signature_id = ? WHERE id = ?
  `),

  getPendingForAgent: db.prepare(`
    SELECT COALESCE(SUM(amount_usdc), 0) as pending_total
    FROM transactions
    WHERE agent_id = ? AND status IN ('pending_approval', 'approved', 'signing', 'broadcasting')
  `),
};

// ---------------------------------------------------------------------------
// Repayment Queries
// ---------------------------------------------------------------------------

export const repaymentQueries = {
  create: db.prepare(`
    INSERT INTO repayments (id, agent_id, amount_usdc, tx_hash, status, period_start, period_end)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),

  getByAgent: db.prepare(`
    SELECT * FROM repayments WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `),

  updateStatus: db.prepare(`
    UPDATE repayments SET status = ? WHERE id = ?
  `),
};

// ---------------------------------------------------------------------------
// Vault Queries
// ---------------------------------------------------------------------------

export const vaultQueries = {
  get: db.prepare(`SELECT * FROM vault WHERE id = 1`),

  updateDeposit: db.prepare(`
    UPDATE vault SET
      total_deposits_usdc = total_deposits_usdc + ?,
      total_shares = total_shares + ?,
      updated_at = datetime('now')
    WHERE id = 1
  `),

  updateLent: db.prepare(`
    UPDATE vault SET
      total_lent_usdc = total_lent_usdc + ?,
      updated_at = datetime('now')
    WHERE id = 1
  `),

  addFees: db.prepare(`
    UPDATE vault SET
      total_fees_earned_usdc = total_fees_earned_usdc + ?,
      total_deposits_usdc = total_deposits_usdc + ?,
      updated_at = datetime('now')
    WHERE id = 1
  `),

  updateWithdraw: db.prepare(`
    UPDATE vault SET
      total_deposits_usdc = total_deposits_usdc - ?,
      total_shares = total_shares - ?,
      updated_at = datetime('now')
    WHERE id = 1
  `),

  returnLent: db.prepare(`
    UPDATE vault SET
      total_lent_usdc = total_lent_usdc - ?,
      updated_at = datetime('now')
    WHERE id = 1
  `),
};

// ---------------------------------------------------------------------------
// Lender Position Queries
// ---------------------------------------------------------------------------

export const lenderQueries = {
  create: db.prepare(`
    INSERT INTO lender_positions (id, lender_address, deposited_usdc, shares_owned, deposit_tx_hash)
    VALUES (?, ?, ?, ?, ?)
  `),

  getByAddress: db.prepare(`
    SELECT * FROM lender_positions WHERE lender_address = ? ORDER BY created_at DESC
  `),

  updateShares: db.prepare(`
    UPDATE lender_positions SET shares_owned = shares_owned - ?, earned_yield_usdc = earned_yield_usdc + ? WHERE id = ?
  `),
};

// ---------------------------------------------------------------------------
// MPC Signature Queries
// ---------------------------------------------------------------------------

export const mpcQueries = {
  create: db.prepare(`
    INSERT INTO mpc_signatures (id, transaction_id, message_hash, status)
    VALUES (?, ?, ?, 'pending')
  `),

  getById: db.prepare(`SELECT * FROM mpc_signatures WHERE id = ?`),

  updateServerSig: db.prepare(`
    UPDATE mpc_signatures SET server_partial_sig = ?, status = 'server_signed' WHERE id = ?
  `),

  updateCombinedSig: db.prepare(`
    UPDATE mpc_signatures SET agent_partial_sig = ?, combined_signature = ?, status = 'complete' WHERE id = ?
  `),

  updateFailed: db.prepare(`
    UPDATE mpc_signatures SET status = 'failed' WHERE id = ?
  `),
};

// ---------------------------------------------------------------------------
// Sanctions Queries
// ---------------------------------------------------------------------------

export const sanctionsQueries = {
  check: db.prepare(`SELECT * FROM sanctioned_addresses WHERE address = ?`),
  add: db.prepare(`INSERT OR IGNORE INTO sanctioned_addresses (address, source) VALUES (?, ?)`),
};

// ---------------------------------------------------------------------------
// API Key Queries
// ---------------------------------------------------------------------------

export const apiKeyQueries = {
  create: db.prepare(`
    INSERT INTO api_keys (id, agent_id, key_hash, name, permissions) VALUES (?, ?, ?, ?, ?)
  `),
  getByHash: db.prepare(`SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1`),
  updateLastUsed: db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`),
};

// ---------------------------------------------------------------------------
// Transaction helper (for atomic operations)
// ---------------------------------------------------------------------------

export const dbTransaction = db.transaction;
export { db };
export default db;
