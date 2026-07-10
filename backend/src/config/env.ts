import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Required for Prisma / DB connectivity
  DATABASE_URL: z.string().min(1),

  // Redis (v2-pro services expect REDIS_URL, existing project uses REDIS_HOST/PORT/PASSWORD)
  REDIS_URL: z.string().default(
    process.env.REDIS_PASSWORD
      ? `redis://:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || '6379'}`
      : `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || '6379'}`
  ),
  REDIS_PASSWORD: z.string().optional(),

  // Secrets (optional for v2.1.0 deposit-only mode)
  JWT_SECRET: z.string().min(32).optional(),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  API_SIGNING_SECRET: z.string().min(32).optional(),
  LEDGER_HMAC_SECRET: z.string().min(32).optional(),
  ENCRYPTION_KEY: z.string().min(32).optional(),

  // Tron / USDT deposit configuration
  TRON_FULL_NODE: z.string().default('https://api.trongrid.io'),
  TRON_MCP_ENDPOINT: z.string().default('https://mcp.trongrid.io/mcp'),
  TRON_MCP_MAX_RPS: z.string().default('10'),
  TRON_API_KEY: z.string().optional(),
  USDT_CONTRACT: z.string().default('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
  HOT_WALLET_ADDRESS: z.string().min(34).startsWith('T').optional(),
  HOT_WALLET_PRIVATE_KEY_ENCRYPTED: z.string().min(1).optional(),
  DEPOSIT_DERIVATION_SEED_ENCRYPTED: z.string().min(1).optional(),
  DEPOSIT_ADDRESS_DERIVATION: z.enum(['static', 'per_user']).default('static'),

  // Rate / deposit settings
  DEFAULT_BUY_SPREAD: z.string().default('0.005'),
  DEFAULT_SELL_SPREAD: z.string().default('0.005'),
  RATE_LOCK_DURATION_MINUTES: z.string().default('15'),
  DEPOSIT_EXPIRY_MINUTES: z.string().default('60'),
  MAX_ACTIVE_LOCKS_PER_USER: z.string().default('3'),
  WEBHOOK_SECRET: z.string().optional(),

  BANGLADESH_BANK_API_URL: z.string().default('https://www.bangladesh-bank.org/en/currency/exchange_rate'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid v2-pro environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
