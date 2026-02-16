import { Router, Request, Response } from "express";
import { authenticate, requirePermission } from "../middleware/auth";
import { processPayment, processRepayment, getCreditLine } from "../core/payment";
import { PaymentRequestSchema, RepaymentRequestSchema } from "../types";
import { txQueries } from "../db";
import { logger } from "../utils/logger";

const router = Router();

router.post("/", authenticate, requirePermission("payment:create"), async (req: Request, res: Response) => {
  try {
    const parsed = PaymentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid request", details: parsed.error.flatten() } });
    }
    const result = await processPayment({
      agentId: req.agentId!,
      recipientAddress: parsed.data.recipientAddress,
      amountUsdc: parsed.data.amountUsdc,
      memo: parsed.data.memo,
      merchantId: parsed.data.merchantId,
      recipientAgentId: parsed.data.recipientAgentId,
      agentPartialSignature: parsed.data.agentPartialSignature,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    const statusCode = result.status === "rejected" ? 403 : result.status === "confirmed" ? 201 : 202;
    return res.status(statusCode).json({ success: result.status !== "rejected", data: result, meta: { requestId: req.requestId, timestamp: new Date().toISOString() } });
  } catch (error: any) {
    logger.error("Payment error", { error: error.message, agentId: req.agentId });
    return res.status(500).json({ success: false, error: { code: "PAYMENT_FAILED", message: error.message } });
  }
});

router.get("/:id", authenticate, requirePermission("payment:read"), (req: Request, res: Response) => {
  const tx = txQueries.getById.get(req.params.id) as any;
  if (!tx) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Transaction not found" } });
  if (tx.agent_id !== req.agentId) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Not your transaction" } });
  return res.json({
    success: true,
    data: { id: tx.id, agentId: tx.agent_id, merchantId: tx.merchant_id, amountUsdc: tx.amount_usdc, feeUsdc: tx.fee_usdc, netAmountUsdc: tx.net_amount_usdc, status: tx.status, type: tx.type, txHash: tx.tx_hash, recipientAddress: tx.recipient_address, memo: tx.memo, permissionChecks: JSON.parse(tx.permission_checks), createdAt: tx.created_at, settledAt: tx.settled_at },
  });
});

router.get("/", authenticate, requirePermission("payment:read"), (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100);
  const rows = txQueries.getByAgent.all(req.agentId!, pageSize, (page - 1) * pageSize) as any[];
  return res.json({ success: true, data: rows.map((tx: any) => ({ id: tx.id, amountUsdc: tx.amount_usdc, feeUsdc: tx.fee_usdc, status: tx.status, type: tx.type, txHash: tx.tx_hash, recipientAddress: tx.recipient_address, createdAt: tx.created_at, settledAt: tx.settled_at })), pagination: { page, pageSize, hasMore: rows.length === pageSize } });
});

router.post("/repay", authenticate, requirePermission("payment:create"), async (req: Request, res: Response) => {
  try {
    const parsed = RepaymentRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid request", details: parsed.error.flatten() } });
    const result = await processRepayment(req.agentId!, parsed.data.amountUsdc, parsed.data.txHash);
    return res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: { code: "REPAYMENT_FAILED", message: error.message } });
  }
});

router.get("/credit/summary", authenticate, requirePermission("credit:read"), (req: Request, res: Response) => {
  try {
    const credit = getCreditLine(req.agentId!);
    return res.json({ success: true, data: credit });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: { code: "CREDIT_ERROR", message: error.message } });
  }
});

export default router;
