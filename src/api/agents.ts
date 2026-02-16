import { Router, Request, Response } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { registerAgent, getAgent, listAgents, adjustCreditLimit } from "../core/agent";
import { RegisterAgentSchema } from "../types";
import { logger } from "../utils/logger";

const router = Router();

// POST /api/v1/agents - Register a new agent (public endpoint)
router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = RegisterAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid request", details: parsed.error.flatten() } });
    }
    const result = await registerAgent(parsed.data.name, parsed.data.ownerAddress, parsed.data.requestedCreditLimitUsdc);
    return res.status(201).json({
      success: true,
      data: {
        agent: result.agent,
        apiKey: result.apiKey,
        mpcAgentShard: result.mpcAgentShard,
        walletFunded: result.walletFunded,
        fundingTxHash: result.fundingTxHash,
        gasTxHash: result.gasTxHash,
      },
      _warning: "Store your API key and MPC shard securely. They will NOT be shown again. Your shard is required to co-sign every transaction.",
    });
  } catch (error: any) {
    logger.error("Agent registration error", { error: error.message });
    return res.status(500).json({ success: false, error: { code: "REGISTRATION_FAILED", message: error.message } });
  }
});

// GET /api/v1/agents/me - Get current agent profile
router.get("/me", authenticate, requirePermission("agent:read"), (req: Request, res: Response) => {
  const agent = getAgent(req.agentId!);
  if (!agent) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Agent not found" } });
  return res.json({ success: true, data: agent });
});

// GET /api/v1/agents/:id - Get agent by ID (admin)
router.get("/:id", authenticate, (req: Request, res: Response) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Agent not found" } });
  return res.json({ success: true, data: agent });
});

export default router;
