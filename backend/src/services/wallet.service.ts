import { PrismaClient, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { computeLedgerHash, signLedgerEntry } from '../utils/crypto';
import { InsufficientBalanceError, GameIntegrityError } from '../utils/errors';
import { logger } from '../config/logger';

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
});

// USDCoin → BDT (legacy play-money column) conversion rate.
// All CryptoFlip play-money columns are 1:1 with USDT at the user
// surface, so the conversion is a no-op; the value is a named
// constant so future margin changes have one home.
const USDT_TO_PLAY_COINS = 1;

export class WalletService {
  async getBalance(userId: string, currencyId: string) {
    const balance = await prisma.userBalance.findUnique({
      where: { userId_currencyId: { userId, currencyId } },
    });

    if (!balance) {
      return prisma.userBalance.create({
        data: {
          userId,
          currencyId,
          availableBalance: new Decimal(0),
          reservedBalance: new Decimal(0),
        },
      });
    }

    return balance;
  }

  async getBalances(userId: string) {
    return prisma.userBalance.findMany({
      where: { userId },
    });
  }

  async transferToCreditMeter(
    userId: string,
    currencyId: string,
    amount: Decimal,
    sessionId: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const balance = await tx.userBalance.findUnique({
        where: { userId_currencyId: { userId, currencyId } },
      });

      if (!balance || balance.availableBalance.lessThan(amount)) {
        throw new InsufficientBalanceError();
      }

      await tx.userBalance.update({
        where: { 
          userId_currencyId: { userId, currencyId },
          version: balance.version,
        },
        data: {
          availableBalance: { decrement: amount },
          reservedBalance: { increment: amount },
          version: { increment: 1 },
          lastUpdatedAt: new Date(),
        },
      });

      await this.createLedgerEntry(tx, {
        userId,
        currencyId,
        entryType: 'transfer_out',
        amount: amount.neg(),
        balanceBefore: balance.availableBalance,
        balanceAfter: balance.availableBalance.minus(amount),
        sessionId,
        referenceId: `session:${sessionId}:transfer_out`,
        metadata: { type: 'credit_meter_transfer', sessionId },
      });
    }, {
      isolationLevel: 'Serializable',
    });
  }

  async transferFromCreditMeter(
    userId: string,
    currencyId: string,
    amount: Decimal,
    sessionId: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const balance = await tx.userBalance.findUnique({
        where: { userId_currencyId: { userId, currencyId } },
      });

      if (!balance) {
        throw new GameIntegrityError('Balance record missing during credit meter return');
      }

      await tx.userBalance.update({
        where: { 
          userId_currencyId: { userId, currencyId },
          version: balance.version,
        },
        data: {
          availableBalance: { increment: amount },
          reservedBalance: { decrement: amount },
          version: { increment: 1 },
          lastUpdatedAt: new Date(),
        },
      });

      await this.createLedgerEntry(tx, {
        userId,
        currencyId,
        entryType: 'transfer_in',
        amount,
        balanceBefore: balance.availableBalance,
        balanceAfter: balance.availableBalance.plus(amount),
        sessionId,
        referenceId: `session:${sessionId}:transfer_in`,
        metadata: { type: 'credit_meter_return', sessionId },
      });
    }, {
      isolationLevel: 'Serializable',
    });
  }

  async processBet(
    userId: string,
    currencyId: string,
    amount: Decimal,
    sessionId: string,
    gameRoundId: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const balance = await tx.userBalance.findUnique({
        where: { userId_currencyId: { userId, currencyId } },
      });

      if (!balance || balance.reservedBalance.lessThan(amount)) {
        throw new InsufficientBalanceError('Insufficient reserved balance for bet');
      }

      await tx.userBalance.update({
        where: { 
          userId_currencyId: { userId, currencyId },
          version: balance.version,
        },
        data: {
          reservedBalance: { decrement: amount },
          totalWagered: { increment: amount },
          version: { increment: 1 },
          lastUpdatedAt: new Date(),
        },
      });

      await this.createLedgerEntry(tx, {
        userId,
        currencyId,
        entryType: 'bet',
        amount: amount.neg(),
        balanceBefore: balance.availableBalance.plus(balance.reservedBalance),
        balanceAfter: balance.availableBalance.plus(balance.reservedBalance).minus(amount),
        sessionId,
        gameRoundId,
        referenceId: `round:${gameRoundId}:bet`,
        metadata: { type: 'game_bet', sessionId, gameRoundId },
      });
    }, {
      isolationLevel: 'Serializable',
    });
  }

  async processWin(
    userId: string,
    currencyId: string,
    amount: Decimal,
    sessionId: string,
    gameRoundId: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const balance = await tx.userBalance.findUnique({
        where: { userId_currencyId: { userId, currencyId } },
      });

      if (!balance) {
        throw new GameIntegrityError('Balance missing during win processing');
      }

      await tx.userBalance.update({
        where: { 
          userId_currencyId: { userId, currencyId },
          version: balance.version,
        },
        data: {
          availableBalance: { increment: amount },
          totalWon: { increment: amount },
          version: { increment: 1 },
          lastUpdatedAt: new Date(),
        },
      });

      await this.createLedgerEntry(tx, {
        userId,
        currencyId,
        entryType: 'win',
        amount,
        balanceBefore: balance.availableBalance.plus(balance.reservedBalance),
        balanceAfter: balance.availableBalance.plus(balance.reservedBalance).plus(amount),
        sessionId,
        gameRoundId,
        referenceId: `round:${gameRoundId}:win`,
        metadata: { type: 'game_win', sessionId, gameRoundId, payout: amount.toString() },
      });
    }, {
      isolationLevel: 'Serializable',
    });
  }

  async processDeposit(
    userId: string,
    currencyId: string,
    amount: Decimal,
    depositId: string,
    description: string
  ): Promise<void> {
    // Idempotency layer 1 (optimistic pre-check): the unique constraint
    // on `ledger_entries.referenceId` (`deposit:${depositId}`) makes
    // *sequential* duplicates a no-op. We catch that case BEFORE the
    // transaction starts and return early. This handles the common
    // case of webhook redelivery arriving after the first write has
    // committed.
    //
    // Idempotency layer 2 (concurrent duplicates — see Scenario 5 in
    // the test file): two webhook deliveries can pass the pre-check
    // simultaneously and both enter the transaction. The unique
    // constraint catches the second one with P2002 (unique violation
    // from the INSERT) or the Serializable isolation throws 40001
    // (serialization failure) when both try to write the same row.
    // We catch both error codes below and treat them as the same
    // idempotent no-op the pre-check would have produced. Without this
    // catch, the loser propagates a 500 to the webhook caller, the
    // provider retries, and on the next attempt the pre-check
    // catches it — noisy, Sentry-bound, and (worse) leaves an
    // unhandled exception in financial code.
    const existingEntry = await prisma.ledgerEntry.findUnique({
      where: { referenceId: `deposit:${depositId}` },
    });
    if (existingEntry) {
      logger.info('processDeposit: ledger entry already exists, treating as idempotent no-op', {
        depositId,
        existingEntryId: existingEntry.id,
      });
      return;
    }

    const creditCoins = amount.times(USDT_TO_PLAY_COINS).toDecimalPlaces(8);

    try {
      await prisma.$transaction(async (tx) => {
        const balance = await tx.userBalance.findUnique({
          where: { userId_currencyId: { userId, currencyId } },
        });

        const beforeBalance = balance?.availableBalance || new Decimal(0);
        const afterBalance = beforeBalance.plus(amount);

        // ── Prisma-side writes: user_balances + ledger_entries ──
        await tx.userBalance.upsert({
          where: { userId_currencyId: { userId, currencyId } },
          create: {
            userId,
            currencyId,
            availableBalance: amount,
            totalDeposited: amount,
          },
          update: {
            availableBalance: { increment: amount },
            totalDeposited: { increment: amount },
            version: { increment: 1 },
            lastUpdatedAt: new Date(),
          },
        });

        await this.createLedgerEntry(tx, {
          userId,
          currencyId,
          entryType: 'deposit',
          amount,
          balanceBefore: beforeBalance,
          balanceAfter: afterBalance,
          referenceId: `deposit:${depositId}`,
          metadata: {
            depositId,
            description,
            type: 'crypto_deposit',
          },
        });

        // ── Legacy-side writes: users.{wallet_balance_coins,
        //    withdrawable_balance_coins} + wallet_transactions.
        //    These columns power the live game (the 2x-multiplier bet
        //    path reads wallet_balance_coins; the trigger
        //    trg_sync_user_balance derives `users.balance` from
        //    withdrawable + bonus on every UPDATE).
        //    Same transaction = atomic with the Prisma writes. If any
        //    statement in the tx throws, all writes roll back.
        //
        //    $executeRaw is the Prisma-canonical way to write raw SQL
        //    that participates in the surrounding transaction. The
        //    previous syncExistingBalance used the raw pg pool (query()
        //    imported from '../config/database'), which runs OUTSIDE the
        //    transaction — that was the bug shape the audit flagged.
        //
        //    The UPDATE must increment `withdrawable_balance_coins`
        //    (NOT `balance` directly). The trg_sync_user_balance
        //    trigger recomputes `balance = bonus + withdrawable` on
        //    every row update, so directly incrementing `balance` would
        //    be silently overwritten by the trigger back to its
        //    pre-update value. The split-pair credit is the
        //    schema-correct way; the trigger then keeps `balance` in
        //    sync.
        //
        //    wallet_transactions columns (real schema.sql):
        //      id, user_id, type, amount_coins, currency, source, note,
        //      metadata, created_at
        //    The previous INSERT referenced amount/description/status —
        //    none of which exist. That would have crashed on first
        //    execution. Fixed by mapping to the real columns.
        await tx.$executeRaw`
          UPDATE users
             SET wallet_balance_coins       = wallet_balance_coins       + ${creditCoins}::numeric,
                 withdrawable_balance_coins = withdrawable_balance_coins + ${creditCoins}::numeric
           WHERE id = ${userId}::uuid
        `;
        await tx.$executeRaw`
          INSERT INTO wallet_transactions
            (user_id, type, amount_coins, currency, source, note, metadata)
          VALUES
            (${userId}::uuid, 'topup', ${creditCoins}::numeric, 'COIN', 'crypto_deposit',
             ${`Crypto deposit ${depositId}`}, ${JSON.stringify({ depositId, description })}::jsonb)
        `;
      }, {
        isolationLevel: 'Serializable',
      });
    } catch (err) {
      // Idempotency layer 2: concurrent duplicates that race past the
      // pre-check surface as P2002 (unique violation — second writer's
      // ledger_entries INSERT hits the constraint) or 40001
      // (serialization failure — both writers' Serializable tx tried
      // to commit conflicting changes). Either way the constraint did
      // its job: only one credit landed. Treat it as the same
      // idempotent no-op layer 1 would have produced.
      if (isUniqueViolationOnLedgerReference(err) || isPostgresSerializationFailure(err)) {
        logger.info('processDeposit: concurrent duplicate absorbed by constraint', {
          depositId,
          prismaCode: (err as any)?.code,
          postgresCode: (err as any)?.meta?.code,
        });
        return;
      }
      throw err;
    }
  }

  async adminAdjustment(
    adminId: string,
    userId: string,
    currencyId: string,
    amount: Decimal,
    reason: string,
    justification: string,
    approvedById: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const balance = await tx.userBalance.findUnique({
        where: { userId_currencyId: { userId, currencyId } },
      });

      const beforeBalance = balance?.availableBalance || new Decimal(0);
      const afterBalance = beforeBalance.plus(amount);

      if (afterBalance.lessThan(0)) {
        throw new InsufficientBalanceError('Adjustment would result in negative balance');
      }

      await tx.userBalance.upsert({
        where: { userId_currencyId: { userId, currencyId } },
        create: {
          userId,
          currencyId,
          availableBalance: amount,
          totalDeposited: amount.greaterThan(0) ? amount : new Decimal(0),
        },
        update: {
          availableBalance: { increment: amount },
          version: { increment: 1 },
          lastUpdatedAt: new Date(),
        },
      });

      await this.createLedgerEntry(tx, {
        userId,
        currencyId,
        entryType: 'admin_adjustment',
        amount,
        balanceBefore: beforeBalance,
        balanceAfter: afterBalance,
        referenceId: `admin:${adminId}:${Date.now()}`,
        metadata: {
          adminId,
          approvedById,
          reason,
          justification,
        },
      });

      await tx.adminAction.create({
        data: {
          adminId,
          actionType: 'balance_adjustment',
          targetType: 'user',
          targetId: userId,
          oldValue: { balance: beforeBalance.toString() },
          newValue: { balance: afterBalance.toString() },
          justification,
          approvalStatus: 'executed',
          approvedById,
          executedAt: new Date(),
        },
      });
    }, {
      isolationLevel: 'Serializable',
    });
  }

  private async createLedgerEntry(
    tx: Prisma.TransactionClient,
    data: {
      userId: string;
      currencyId: string;
      entryType: any;
      amount: Decimal;
      balanceBefore: Decimal;
      balanceAfter: Decimal;
      sessionId?: string;
      gameRoundId?: string;
      referenceId: string;
      metadata?: any;
    }
  ): Promise<void> {
    const lastEntry = await tx.ledgerEntry.findFirst({
      where: { userId: data.userId, currencyId: data.currencyId },
      orderBy: { createdAt: 'desc' },
    });

    const previousHash = lastEntry?.currentHash || 'genesis';

    const entryData = {
      userId: data.userId,
      currencyId: data.currencyId,
      entryType: data.entryType,
      amount: data.amount,
      balanceBefore: data.balanceBefore,
      balanceAfter: data.balanceAfter,
      sessionId: data.sessionId,
      gameRoundId: data.gameRoundId,
      referenceId: data.referenceId,
      metadata: data.metadata,
      createdAt: new Date().toISOString(),
    };

    const currentHash = computeLedgerHash(entryData, previousHash);
    const signature = signLedgerEntry(currentHash);

    await tx.ledgerEntry.create({
      data: {
        ...entryData,
        previousHash,
        currentHash,
        signature,
      },
    });
  }

  async verifyLedgerIntegrity(userId: string, currencyId: string): Promise<boolean> {
    const entries = await prisma.ledgerEntry.findMany({
      where: { userId, currencyId },
      orderBy: { createdAt: 'asc' },
    });

    let previousHash = 'genesis';

    for (const entry of entries) {
      const entryData = {
        userId: entry.userId,
        currencyId: entry.currencyId,
        entryType: entry.entryType,
        amount: entry.amount,
        balanceBefore: entry.balanceBefore,
        balanceAfter: entry.balanceAfter,
        sessionId: entry.sessionId,
        gameRoundId: entry.gameRoundId,
        referenceId: entry.referenceId,
        metadata: entry.metadata,
        createdAt: entry.createdAt.toISOString(),
      };

      const expectedHash = computeLedgerHash(entryData, previousHash);
      if (expectedHash !== entry.currentHash) {
        logger.error('Ledger integrity violation', {
          userId,
          currencyId,
          entryId: entry.id,
          expectedHash,
          actualHash: entry.currentHash,
        });
        return false;
      }

      previousHash = entry.currentHash;
    }

    return true;
  }

  async reconcileBalance(userId: string, currencyId: string): Promise<{ 
    matches: boolean; 
    ledgerSum: Decimal; 
    balance: Decimal 
  }> {
    const [ledgerResult] = await prisma.$queryRaw<{ sum: Decimal }[]>`
      SELECT SUM(amount) as sum FROM ledger_entries 
      WHERE user_id = ${userId}::uuid AND currency_id = ${currencyId}::uuid
    `;

    const balance = await this.getBalance(userId, currencyId);
    const ledgerSum = ledgerResult?.sum || new Decimal(0);

    return {
      matches: ledgerSum.equals(balance.availableBalance.plus(balance.reservedBalance)),
      ledgerSum,
      balance: balance.availableBalance.plus(balance.reservedBalance),
    };
  }
}

export const walletService = new WalletService();

// ── Idempotency helpers (layer 2 in processDeposit) ─────────────
// Placed at the bottom so the call site above can reference them.
// Function declarations are hoisted within the module, so this
// ordering is purely cosmetic.
//
// Prisma surfaces unique-constraint violations as
//   { code: 'P2002', meta: { target: ['ledger_entries_reference_id_key', ...] } }
// Serializable-isolation conflicts surface as raw Postgres errors with
//   { code: '40001' } (serialization_failure) or '40P01' (deadlock).
// Either way, the database did its job — only one writer committed.
// We treat both as idempotent no-ops so the loser of a concurrent
// race doesn't propagate a 500 to the webhook caller.
function isUniqueViolationOnLedgerReference(err: unknown): boolean {
  const e = err as any;
  if (e?.code !== 'P2002') return false;
  const target = e?.meta?.target;
  if (Array.isArray(target)) {
    return target.some((t: string) => typeof t === 'string' && t.includes('reference'));
  }
  // meta.target is sometimes just a string; sometimes omitted.
  // Fall back to the message text — P2002 messages on this column
  // include the column name.
  const msg = String(e?.message ?? '');
  return msg.includes('reference_id') || msg.includes('referenceId');
}

function isPostgresSerializationFailure(err: unknown): boolean {
  const e = err as any;
  // Prisma surfaces the raw Postgres SQLSTATE on PrismaClientKnownRequestError
  // but in this code path the error comes through as PrismaClientUnknownRequestError
  // or even a plain Error — both expose the SQLSTATE via different fields.
  const candidates = [
    e?.code,                       // PrismaClientUnknownRequestError
    e?.meta?.code,                 // PrismaClientKnownRequestError meta.code
  ];
  return candidates.includes('40001') || candidates.includes('40P01');
}
