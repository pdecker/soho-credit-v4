import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { registerMerchant, getMerchant, listMerchants } from "../core/merchant";
import { RegisterMerchantSchema } from "../types";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = RegisterMerchantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid request", details: parsed.error.flatten() } });
    const merchant = await registerMerchant(parsed.data.name, parsed.data.walletAddress, parsed.data.category);
    return res.status(201).json({ success: true, data: merchant });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: { code: "REGISTRATION_FAILED", message: error.message } });
  }
});

router.get("/:id", (req: Request, res: Response) => {
  const merchant = getMerchant(req.params.id);
  if (!merchant) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Merchant not found" } });
  return res.json({ success: true, data: merchant });
});

router.get("/", (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const merchants = listMerchants(page);
  return res.json({ success: true, data: merchants });
});

export default router;
