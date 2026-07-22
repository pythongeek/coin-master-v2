import { PrismaClient, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { computeLedgerHash, signLedgerEntry } from '../utils/crypto';
import { InsufficientBalanceError, GameIntegrityError } from '../utils/errors';
import { logger } from '../config/logger';
import { query } from '../config/database';

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
});

// Bridge to existing CryptoFlip user balance columns.
async function syncExistingBalance(userId: string, amount: Decimal, depositId: string): Promise<void> {
  try {
    // Credit the real play-money column; convert net credit to coins as 1:1.
    const creditCoins = parseFloat(amount.toString());
    await query('UPDATE users SET wallet_balance_coins = wallet_balance_coins + $1, balance = balance + $1 WHERE id = $2', [creditCoins, userId]);
    // Record a wallet transaction for audit trail
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, 'credit', creditCoins, `Crypto deposit ${depositId}`, 'completed']
    );
  } catch (err) {
    logger.error('Failed to sync existing user balance', { userId, depositId, error: (err as Error).message });
    throw new GameIntegrityError('Balance sync failed during deposit');
  }
}

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
    await prisma.$transaction(async (tx) => {
      const balance = await tx.userBalance.findUnique({
        where: { userId_currencyId: { userId, currencyId } },
      });

      const beforeBalance = balance?.availableBalance || new Decimal(0);
      const afterBalance = beforeBalance.plus(amount);

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
    }, {
      isolationLevel: 'Serializable',
    });
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
