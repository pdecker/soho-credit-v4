// =============================================================================
// Authentication & Authorization Middleware
// =============================================================================

import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import { apiKeyQueries, agentQueries } from "../db";
import { config } from "../config";
import { logger } from "../utils/logger";

// Extend Express Request to include auth context
declare global {
  namespace Express {
    interface Request {
      agentId?: string;
      agentWallet?: string;
      permissions?: string[];
      requestId?: string;
    }
  }
}

/**
 * Authenticate requests via API key or JWT bearer token.
 * API Key: `Authorization: Bearer acp_xxx`
 * JWT: `Authorization: Bearer eyJhbG...`
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Missing or invalid Authorization header" },
    });
    return;
  }

  const token = authHeader.substring(7);

  // API Key auth
  if (token.startsWith("acp_")) {
    const keyHash = createHash("sha256").update(token).digest("hex");
    const apiKey = apiKeyQueries.getByHash.get(keyHash) as any;

    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: { code: "INVALID_API_KEY", message: "Invalid API key" },
      });
      return;
    }

    // Update last used
    apiKeyQueries.updateLastUsed.run(apiKey.id);

    // Load agent
    const agent = agentQueries.getById.get(apiKey.agent_id) as any;
    if (!agent || agent.status === "closed") {
      res.status(403).json({
        success: false,
        error: { code: "AGENT_INACTIVE", message: "Agent account is not active" },
      });
      return;
    }

    req.agentId = apiKey.agent_id;
    req.agentWallet = agent.wallet_address;
    req.permissions = JSON.parse(apiKey.permissions);
    next();
    return;
  }

  // JWT auth
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as any;
    req.agentId = payload.agentId;
    req.agentWallet = payload.wallet;
    req.permissions = payload.permissions || [];
    next();
  } catch {
    res.status(401).json({
      success: false,
      error: { code: "INVALID_TOKEN", message: "Invalid or expired token" },
    });
  }
}

/**
 * Check if the authenticated agent has the required permission.
 */
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.permissions?.includes(permission)) {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `Missing required permission: ${permission}`,
        },
      });
      return;
    }
    next();
  };
}

/**
 * Add request ID to all requests for traceability.
 */
export function requestId(req: Request, _res: Response, next: NextFunction): void {
  req.requestId = req.headers["x-request-id"] as string || crypto.randomUUID();
  next();
}
