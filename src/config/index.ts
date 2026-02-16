import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().default("./data/agentcredit.db"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  CHAIN_ID: z.coerce.number().default(8453),
  RPC_URL: z.string().default("https://mainnet.base.org"),
  USDC_CONTRACT: z.string().default("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  VAULT_CONTRACT: z.string().default("0x0000000000000000000000000000000000000000"),
  HOT_WALLET_KEY: z.string().default(""),
  MPC_SERVER_SHARD_ENCRYPTED: z.string().default(""),
  MPC_ENCRYPTION_KEY: z.string().default(""),
  MPC_THRESHOLD: z.coerce.number().default(2),
  MPC_TOTAL_PARTIES: z.coerce.number().default(2),
  CHAINALYSIS_API_KEY: z.string().default(""),
  OFAC_SCREENING_ENABLED: z.coerce.boolean().default(true),
  JWT_SECRET: z.string().default("dev-secret-change-in-production"),
  JWT_EXPIRY: z.string().default("24h"),
  DEFAULT_CREDIT_LIMIT_USDC: z.coerce.number().default(1000),
  MAX_CREDIT_LIMIT_USDC: z.coerce.number().default(100000),
  MERCHANT_FEE_BPS: z.coerce.number().default(150),
  REPAYMENT_PERIOD_DAYS: z.coerce.number().default(7),
  LATE_FEE_BPS: z.coerce.number().default(50),
  LOG_LEVEL: z.string().default("info"),
  LOG_FILE: z.string().default("./logs/agentcredit.log"),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = ConfigSchema.parse(process.env);
  }
  return _config;
}

export const config = getConfig();
