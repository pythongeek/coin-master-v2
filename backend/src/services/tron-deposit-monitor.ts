import { PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { logger } from '../config/logger';
import { tronMcpService } from './tron-mcp.service';
import { depositService } from './deposit.service';

const prisma = new PrismaClient();
const POLL_INTERVAL_MS = 30000; // 30 seconds
const REQUIRED_CONFIRMATIONS = 19;
const TOLERANCE_PERCENT = 0.01; // 1% amount tolerance

/**
 * TronGrid MCP-powered deposit monitor.
 *
 * Replaces the old REST-API poller that was failing with 401s because the
 * API key was missing. All on-chain reads now go through the MCP service,
 * which is rate-limited to 10 req/sec to stay safely under the free-tier
 * 15 req/sec cap.
 */
export class TronDepositMonitor {
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('TronGrid MCP deposit monitor started', { intervalMs: POLL_INTERVAL_MS });

    this.interval = setInterval(() => {
      void this.poll().catch((err: unknown) => {
        logger.error('Deposit monitor poll failed', { error: (err as Error).message });
      });
    }, POLL_INTERVAL_MS);

    void this.poll().catch((err: unknown) => {
      logger.error('Deposit monitor initial poll failed', { error: (err as Error).message });
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.running = false;
    logger.info('TronGrid MCP deposit monitor stopped');
  }

  private async poll(): Promise<void> {
    await this.detectPayments();
    await this.confirmDeposits();
  }

  /**
   * Stage 1: Detect incoming transfers for all pending deposits.
   */
  private async detectPayments(): Promise<void> {
    const pending = await prisma.depositTransaction.findMany({
      where: {
        status: { in: ['rate_locked', 'awaiting_payment'] },
        expiresAt: { gt: new Date() },
      },
      take: 50,
    });

    if (pending.length === 0) return;

    logger.info('Polling pending deposits via TronGrid MCP', { count: pending.length });

    for (const deposit of pending) {
      try {
        if (!deposit.toAddress) continue;

        const transfer = await this.findMatchingUsdtTransfer(deposit.toAddress, deposit.cryptoAmount, deposit.id);
        if (!transfer) continue;

        logger.info('Deposit payment detected', {
          depositId: deposit.id,
          txId: transfer.txHash,
          amount: transfer.amount,
          blockTimestamp: transfer.blockTimestamp,
          blockNumber: transfer.blockNumber,
          toAddress: deposit.toAddress,
        });

        await depositService.detectPayment(
          deposit.id,
          transfer.txHash,
          transfer.fromAddress,
          new Decimal(transfer.amount)
        );

        // Persist on-chain metadata for audit and rollback checks
        await prisma.depositTransaction.update({
          where: { id: deposit.id },
          data: {
            statusHistory: {
              push: {
                status: 'payment_detected_chain_meta',
                at: new Date().toISOString(),
                blockTimestamp: transfer.blockTimestamp,
                blockNumber: transfer.blockNumber,
              },
            },
          },
        });
      } catch (err) {
        logger.error('Error detecting deposit', {
          depositId: deposit.id,
          error: (err as Error).message,
        });
      }
    }
  }

  private async findMatchingUsdtTransfer(
    expectedToAddress: string,
    expectedAmount: Decimal,
    depositId: string
  ): Promise<{ txHash: string; fromAddress: string; amount: string; blockTimestamp: number; blockNumber?: number } | null> {
    const to = expectedToAddress.toLowerCase().trim();

    // Fetch the latest incoming USDT transfers via MCP (rate-limited internally)
    const transfers = await tronMcpService.getIncomingUsdt(expectedToAddress, { limit: 20 });

    for (const tx of transfers) {
      if (!tx.txHash || !tx.fromAddress || !tx.toAddress) continue;
      if (tx.toAddress.toLowerCase() !== to) continue;

      // Verify amount against expected with 1% tolerance, using Decimal for precision
      const txAmount = new Decimal(tx.amount);
      const diff = txAmount.minus(expectedAmount).abs();
      const tolerance = expectedAmount.mul(TOLERANCE_PERCENT);
      if (diff.greaterThan(tolerance)) continue;

      // Prevent replay / double credit
      const existing = await prisma.depositTransaction.findFirst({
        where: {
          blockchainTxId: tx.txHash,
          id: { not: depositId },
        },
      });
      if (existing) continue;

      return {
        txHash: tx.txHash,
        fromAddress: tx.fromAddress,
        amount: tx.amount,
        blockTimestamp: tx.blockTimestamp,
        blockNumber: tx.blockNumber,
      };
    }

    return null;
  }

  /**
   * Stage 2: Confirm deposits already detected by the monitor.
   * Uses getTransactionInfoById for real confirmation count and SUCCESS status.
   */
  private async confirmDeposits(): Promise<void> {
    const detecting = await prisma.depositTransaction.findMany({
      where: {
        status: { in: ['payment_detected', 'confirming'] },
        blockchainTxId: { not: null },
      },
      take: 50,
    });

    for (const deposit of detecting) {
      if (!deposit.blockchainTxId) continue;
      try {
        const confirmation = await tronMcpService.confirmTransaction(
          deposit.blockchainTxId,
          REQUIRED_CONFIRMATIONS
        );

        logger.info('Deposit confirmation check', {
          depositId: deposit.id,
          txId: deposit.blockchainTxId,
          confirmations: confirmation.confirmations,
          confirmed: confirmation.confirmed,
          blockNumber: confirmation.blockNumber,
        });

        await depositService.confirmDeposit(deposit.id, confirmation.confirmations);
      } catch (err) {
        logger.error('Error confirming deposit', {
          depositId: deposit.id,
          txId: deposit.blockchainTxId,
          error: (err as Error).message,
        });
      }
    }
  }
}

export const tronDepositMonitor = new TronDepositMonitor();
