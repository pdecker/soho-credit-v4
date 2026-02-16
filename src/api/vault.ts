import { Router, Request, Response } from "express";
import { getVaultState, processDeposit, processWithdrawal, getLenderPositions, getSharePrice } from "../vault";
import { LendRequestSchema, WithdrawRequestSchema } from "../types";

const router = Router();

// GET /api/v1/vault - Public vault stats
router.get("/", (_req: Request, res: Response) => {
  try {
    const vault = getVaultState();
    return res.json({ success: true, data: { ...vault, sharePriceUsdc: getSharePrice() } });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: { code: "VAULT_ERROR", message: error.message } });
  }
});

// POST /api/v1/vault/deposit - Lender deposits USDC
router.post("/deposit", async (req: Request, res: Response) => {
  try {
    const parsed = LendRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid request", details: parsed.error.flatten() } });
    const position = processDeposit(parsed.data.lenderAddress, parsed.data.amountUsdc, parsed.data.txHash);
    return res.status(201).json({ success: true, data: position });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: { code: "DEPOSIT_FAILED", message: error.message } });
  }
});

// POST /api/v1/vault/withdraw - Lender withdraws
router.post("/withdraw", async (req: Request, res: Response) => {
  try {
    const parsed = WithdrawRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid request", details: parsed.error.flatten() } });
    const result = processWithdrawal(parsed.data.lenderAddress, parsed.data.sharesAmount);
    return res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: { code: "WITHDRAW_FAILED", message: error.message } });
  }
});

// GET /api/v1/vault/positions/:address - Lender positions
router.get("/positions/:address", (req: Request, res: Response) => {
  try {
    const positions = getLenderPositions(req.params.address);
    return res.json({ success: true, data: positions });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: { code: "POSITION_ERROR", message: error.message } });
  }
});

export default router;
