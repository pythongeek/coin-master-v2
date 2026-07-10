import { Request, Response, NextFunction } from 'express';
import { Decimal } from '@prisma/client/runtime/library';
import { depositService } from '../services/deposit.service';
import { priceFeedService } from '../services/price-feed.service';
import { AppError } from '../utils/errors';
import { AuthRequest } from '../middleware/auth';

export async function initiateDeposit(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { cryptoAmount, currencyPair = 'USDT_BDT' } = req.body;

    if (!cryptoAmount || isNaN(parseFloat(cryptoAmount))) {
      throw new AppError(400, 'INVALID_AMOUNT', 'Valid crypto amount required');
    }

    const userId = req.user.id || req.user.userId;
    const result = await depositService.initiateDeposit(
      userId,
      new Decimal(cryptoAmount),
      currencyPair,
      req.ip || 'unknown',
      req.headers['x-device-fingerprint'] as string || 'unknown'
    );

    res.status(201).json({
      success: true,
      data: {
        depositId: result.depositId,
        lockId: result.lockId,
        depositAddress: result.depositAddress,
        network: result.network,
        memo: result.memo,
        cryptoAmount: result.cryptoAmount.toString(),
        fiatEquivalent: result.fiatEquivalent.toString(),
        lockedRate: result.lockedRate.toString(),
        expiresAt: result.expiresAt.toISOString(),
        timeRemaining: Math.floor((result.expiresAt.getTime() - Date.now()) / 1000),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getCurrentRate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { pair = 'USDT_BDT', direction = 'buy' } = req.query;

    const effectiveRate = await priceFeedService.getEffectiveRate(
      pair as string,
      direction as 'buy' | 'sell'
    );

    res.json({
      success: true,
      data: {
        pair,
        direction,
        marketRate: effectiveRate.rate.toString(),
        spread: effectiveRate.spread.toString(),
        effectiveRate: effectiveRate.effectiveRate.toString(),
        source: effectiveRate.source,
        fetchedAt: effectiveRate.fetchedAt.toISOString(),
        expiresAt: effectiveRate.expiresAt.toISOString(),
        isPlatformDefault: effectiveRate.source === 'custom' || effectiveRate.source === 'manual_override',
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getDepositStatus(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const depositId = req.params.depositId as string;
    const status = await depositService.getDepositStatus(depositId, req.user.id || req.user.userId);

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDepositHistory(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const history = await depositService.getDepositHistory(req.user.id || req.user.userId, limit, offset);

    res.json({
      success: true,
      data: {
        deposits: history.map((d: any) => ({
          id: d.id,
          status: d.status,
          cryptoAmount: d.cryptoAmount.toString(),
          fiatEquivalent: d.fiatEquivalent.toString(),
          netCreditAmount: d.netCreditAmount?.toString(),
          lockedRate: undefined,
          toAddress: d.toAddress,
          blockchainTxId: d.blockchainTxId,
          confirmations: d.confirmations,
          requiredConfirmations: d.requiredConfirmations,
          completedAt: d.completedAt,
          createdAt: d.createdAt,
        })),
        pagination: { limit, offset },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function handlePaymentWebhook(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const providedSecret = req.headers['x-webhook-secret'] as string;
    if (!process.env.WEBHOOK_SECRET || providedSecret !== process.env.WEBHOOK_SECRET) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid webhook secret');
    }

    const { depositId, txId } = req.body;
    if (!depositId || !txId) {
      throw new AppError(400, 'MISSING_PARAMS', 'depositId and txId required');
    }

    // Do NOT trust user-provided amount or confirmations. Re-query via MCP.
    const { tronMcpService } = await import('../services/tron-mcp.service');
    const confirmation = await tronMcpService.confirmTransaction(txId, 19);
    if (!confirmation.confirmed) {
      throw new AppError(400, 'NOT_CONFIRMED', 'Transaction is not yet confirmed');
    }

    // Fetch transfer details and match to deposit address
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const deposit = await prisma.depositTransaction.findUnique({ where: { id: depositId } });
    if (!deposit?.toAddress) {
      throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');
    }

    const transfers = await tronMcpService.getIncomingUsdt(deposit.toAddress, { limit: 20 });
    const match = transfers.find((t: any) => t.txHash === txId);
    if (!match) {
      throw new AppError(400, 'TX_MISMATCH', 'Transaction does not match this deposit address');
    }

    await depositService.detectPayment(depositId, txId, match.fromAddress, new Decimal(match.amount));
    await depositService.confirmDeposit(depositId, confirmation.confirmations);

    res.json({ success: true, message: 'Payment processed and verified on-chain' });
  } catch (error) {
    next(error);
  }
}
