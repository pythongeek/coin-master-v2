import { z } from 'zod';

export const CurrencyCodeSchema = z.enum(['BDT', 'USD', 'USDT']);

export const MoneySchema = z.string().refine(
  (val) => {
    const num = parseFloat(val);
    return !isNaN(num) && num >= 0 && /^\d+(\.\d{1,8})?$/.test(val);
  },
  { message: 'Invalid monetary amount (max 8 decimals)' }
);

export const ClientSeedSchema = z.string()
  .regex(/^[a-f0-9]{32}$/, 'Client seed must be 32 hex characters')
  .refine(
    (seed) => {
      const uniqueChars = new Set(seed).size;
      return uniqueChars >= 8;
    },
    { message: 'Client seed entropy too low' }
  );

export const BetAmountSchema = z.string().refine(
  (val) => {
    const num = parseFloat(val);
    return !isNaN(num) && num > 0;
  },
  { message: 'Bet amount must be positive' }
);

export const PredictedOutcomeSchema = z.enum(['heads', 'tails']);

export const PlaceBetSchema = z.object({
  clientSeed: ClientSeedSchema,
  betAmount: BetAmountSchema,
  currency: CurrencyCodeSchema,
  predictedOutcome: PredictedOutcomeSchema,
}).strict();

export const LoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(12).max(128),
  deviceFingerprint: z.string().max(512).optional(),
  turnstileToken: z.string().optional(),
}).strict();

export const RegisterSchema = z.object({
  email: z.string().email().max(255),
  password: z.string()
    .min(12)
    .max(128)
    .regex(/[A-Z]/, 'Must contain uppercase')
    .regex(/[a-z]/, 'Must contain lowercase')
    .regex(/[0-9]/, 'Must contain number')
    .regex(/[^A-Za-z0-9]/, 'Must contain special character'),
  phone: z.string().regex(/^\+?[1-9]\d{7,14}$/).optional(),
  currencyPreference: CurrencyCodeSchema.default('BDT'),
}).strict();

export const AdminBalanceAdjustmentSchema = z.object({
  userId: z.string().uuid(),
  currency: CurrencyCodeSchema,
  amount: z.string().refine(
    (val) => {
      const num = parseFloat(val);
      return !isNaN(num) && num !== 0;
    },
    { message: 'Amount must be non-zero' }
  ),
  reason: z.enum(['bonus', 'correction', 'refund', 'penalty', 'other']),
  justification: z.string().min(50).max(2000),
  evidenceUrl: z.string().url().optional(),
}).strict();

export const CurrencyUpdateSchema = z.object({
  code: CurrencyCodeSchema,
  exchangeRate: z.string().refine(
    (val) => {
      const num = parseFloat(val);
      return !isNaN(num) && num > 0;
    },
    { message: 'Exchange rate must be positive' }
  ),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  minDeposit: MoneySchema.optional(),
  maxDeposit: MoneySchema.optional(),
  minWithdrawal: MoneySchema.optional(),
  maxWithdrawal: MoneySchema.optional(),
  withdrawalFee: MoneySchema.optional(),
}).strict();

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /system\s+prompt/i,
  /DAN\s+mode/i,
  /jailbreak/i,
  /\[\[\[SYS:\s*.*\s*\]\]\]/i,
  /new\s+role\s*:/i,
  /override\s+security/i,
];

export function sanitizeForAI(input: string): string {
  let clean = input.replace(/[\x00-\x1F\x7F]/g, '');
  clean = clean.replace(/[`\*_{}\[\]()#+\-.!|]/g, '\\$&');

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(clean)) {
      throw new Error('Input contains prohibited security patterns');
    }
  }
  return clean;
}

export function sanitizeInput(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[<>]/g, '')
    .slice(0, 1000)
    .trim();
}
