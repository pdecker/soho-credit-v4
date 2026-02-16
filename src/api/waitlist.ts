import { Router, Request, Response } from "express";
import db from "../db";
import { logger } from "../utils/logger";

const router = Router();

// Ensure waitlist table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    wallet_address TEXT,
    type TEXT NOT NULL DEFAULT 'human',
    source TEXT DEFAULT 'website',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(email),
    UNIQUE(wallet_address)
  );
  CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
  CREATE INDEX IF NOT EXISTS idx_waitlist_wallet ON waitlist(wallet_address);
`);

const insertWaitlist = db.prepare(`
  INSERT INTO waitlist (email, wallet_address, type, source) VALUES (?, ?, ?, ?)
`);
const getCount = db.prepare(`SELECT COUNT(*) as count FROM waitlist`);
const getByEmail = db.prepare(`SELECT * FROM waitlist WHERE email = ?`);
const getByWallet = db.prepare(`SELECT * FROM waitlist WHERE wallet_address = ?`);

// POST /api/v1/waitlist - Join the waitlist
router.post("/", (req: Request, res: Response) => {
  try {
    const { email, walletAddress, source } = req.body;

    if (!email && !walletAddress) {
      return res.status(400).json({
        success: false,
        error: { message: "Provide either email or walletAddress" },
      });
    }

    // Validate email format
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        error: { message: "Invalid email format" },
      });
    }

    // Validate wallet address format (0x + 40 hex chars)
    if (walletAddress && !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        success: false,
        error: { message: "Invalid wallet address format" },
      });
    }

    // Check for duplicates
    if (email) {
      const existing = getByEmail.get(email.toLowerCase());
      if (existing) {
        return res.status(409).json({
          success: false,
          error: { message: "This email is already on the waitlist" },
        });
      }
    }
    if (walletAddress) {
      const existing = getByWallet.get(walletAddress.toLowerCase());
      if (existing) {
        return res.status(409).json({
          success: false,
          error: { message: "This wallet is already on the waitlist" },
        });
      }
    }

    const type = walletAddress ? "agent" : "human";

    insertWaitlist.run(
      email ? email.toLowerCase() : null,
      walletAddress ? walletAddress.toLowerCase() : null,
      type,
      source || "website"
    );

    const { count } = getCount.get() as any;

    logger.info("Waitlist signup", { email, walletAddress, type });

    return res.status(201).json({
      success: true,
      data: {
        type,
        position: count,
        message: type === "agent"
          ? "Your agent is on the waitlist. We'll reach out when the next cohort opens."
          : "You're on the list. We'll be in touch.",
      },
    });
  } catch (err: any) {
    logger.error("Waitlist error", { error: err.message });
    return res.status(500).json({
      success: false,
      error: { message: "Failed to join waitlist" },
    });
  }
});

// GET /api/v1/waitlist/count - Public count
router.get("/count", (_req: Request, res: Response) => {
  try {
    const { count } = getCount.get() as any;
    const agents = (db.prepare(`SELECT COUNT(*) as c FROM waitlist WHERE type = 'agent'`).get() as any).c;
    const humans = (db.prepare(`SELECT COUNT(*) as c FROM waitlist WHERE type = 'human'`).get() as any).c;

    return res.json({
      success: true,
      data: { total: count, agents, humans },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: { message: "Failed to get count" } });
  }
});

export default router;
