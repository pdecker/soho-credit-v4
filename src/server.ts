// =============================================================================
// AgentCredit Protocol - API Server
// =============================================================================

import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { migrate } from "./db";
import { requestId } from "./middleware/auth";
import { initializeChains } from "./chains";
import { startScheduledJobs } from "./core/scheduler";
import { logger } from "./utils/logger";

import agentRoutes from "./api/agents";
import paymentRoutes from "./api/payments";
import merchantRoutes from "./api/merchants";
import vaultRoutes from "./api/vault";
import waitlistRoutes from "./api/waitlist";

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

// Run DB migrations
migrate();

// Initialize blockchain providers
initializeChains();

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------

const app = express();

// Security
app.use(helmet());
app.use(cors({ origin: "*" })); // Open for pilot — lock down later
app.use(express.json({ limit: "1mb" }));

// Rate limiting
app.use(rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.NODE_ENV === "production" ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMITED", message: "Too many requests" } },
}));

// Request ID tracking
app.use(requestId);

// Request logging
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`, { requestId: req.requestId });
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/", (_req, res) => {
  res.json({
    name: "SOHO Protocol",
    version: "1.0.0",
    description: "Purchasing power for AI agents — Spend Onchain, Hodl Onchain",
    chain: "base",
    mode: process.env.HOT_WALLET_KEY ? "live" : "simulation",
    docs: "/api/v1",
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/v1/agents", agentRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1/merchants", merchantRoutes);
app.use("/api/v1/vault", vaultRoutes);
app.use("/api/v1/waitlist", waitlistRoutes);

// x402 compatibility endpoint
app.post("/api/v1/x402/pay", async (req, res) => {
  // x402 payment protocol handler
  // Accepts x402 payment headers and processes them through our credit system
  const { paymentHeader, agentId, apiKey } = req.body;
  res.json({ success: true, message: "x402 payments route - integrate with payment engine" });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Endpoint not found" } });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

const PORT = config.PORT;

app.listen(PORT, () => {
  logger.info(`AgentCredit Protocol API running on port ${PORT}`);
  logger.info(`Environment: ${config.NODE_ENV}`);
  logger.info(`Chains: Base (primary), Solana (secondary)`);

  // Start cron jobs in production
  if (config.NODE_ENV === "production") {
    startScheduledJobs();
  }
});

export default app;
