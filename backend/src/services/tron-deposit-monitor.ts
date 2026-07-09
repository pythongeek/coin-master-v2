import { PrismaClient, DepositStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { depositService } from './deposit.service';

const prisma = new PrismaClient();
const USDT_CONTRACT = env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_FULL_NODE = env.TRON_FULL_NODE || 'https://api.trongrid.io';
const POLL_INTERVAL_MS = 30000; // 30 seconds

export class TronDepositMonitor {
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('TronGrid deposit monitor started', { intervalMs: POLL_INTERVAL_MS });
    this.interval = setInterval(() => {
      void this.poll().catch((err: unknown) => {
        logger.error('Deposit monitor poll failed', { error: (err as Error).message });
      });
    }, POLL_INTERVAL_MS);
    // Run immediately once
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
    logger.info('TronGrid deposit monitor stopped');
  }

  private async poll(): Promise<void> {
    const pending = await prisma.depositTransaction.findMany({
      where: {
        status: { in: ['rate_locked', 'awaiting_payment'] },
        expiresAt: { gt: new Date() },
      },
      take: 50,
    });

    if (pending.length === 0) return;

    logger.info('Polling pending deposits', { count: pending.length });

    for (const deposit of pending) {
      try {
        if (!deposit.toAddress) continue;
        const tx = await this.findLatestUsdtTransfer(deposit.toAddress, deposit.cryptoAmount, deposit.id);
        if (!tx) continue;

        logger.info('Deposit payment detected', {
          depositId: deposit.id,
          txId: tx.txID,
          amount: deposit.cryptoAmount.toString(),
          toAddress: deposit.toAddress,
        });

        await depositService.detectPayment(deposit.id, tx.txID, tx.fromAddress, deposit.cryptoAmount);
      } catch (err) {
        logger.error('Error processing deposit', {
          depositId: deposit.id,
          error: (err as Error).message,
        });
      }
    }
  }

  private async findLatestUsdtTransfer(
    expectedToAddress: string,
    expectedAmount: Decimal,
    depositId: string
  ): Promise<{ txID: string; fromAddress: string } | null> {
    const to = expectedToAddress.toLowerCase().trim();
    const amountSun = expectedAmount.mul(1000000).toNumber();
    const minAmountSun = amountSun * 0.99;
    const maxAmountSun = amountSun * 1.01;

    const url = new URL(`${TRON_FULL_NODE}/v1/accounts/${expectedToAddress}/transactions/trc20`);
    url.searchParams.set('limit', '20');
    url.searchParams.set('contract_address', USDT_CONTRACT);
    url.searchParams.set('only_confirmed', 'false');
    url.searchParams.set('order_by', 'block_timestamp,desc');

    const headers: Record<string, string> = {};
    if (env.TRON_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRON_API_KEY;

    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      throw new Error(`TronGrid API error: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as { data?: Array<any> };
    if (!data.data || data.data.length === 0) return null;

    for (const tx of data.data) {
      if (!tx.transaction_id || !tx.from || !tx.to || !tx.value) continue;
      const toAddress = this.normalizeAddress(tx.to);
      const fromAddress = this.normalizeAddress(tx.from);
      const value = parseFloat(tx.value);

      if (toAddress.toLowerCase() !== to) continue;
      if (value < minAmountSun || value > maxAmountSun) continue;

      // Already processed?
      const existing = await prisma.depositTransaction.findFirst({
        where: {
          blockchainTxId: tx.transaction_id,
          id: { not: depositId },
        },
      });
      if (existing) continue;

      return { txID: tx.transaction_id, fromAddress };
    }

    return null;
  }

  private normalizeAddress(addr: string): string {
    if (!addr) return '';
    if (addr.startsWith('T') && addr.length === 34) return addr;
    try {
      const { TronWeb } = require('tronweb');
      const tw = new TronWeb({ fullHost: TRON_FULL_NODE });
      return tw.address.fromHex(addr);
    } catch {
      return addr;
    }
  }
}

export const tronDepositMonitor = new TronDepositMonitor();
