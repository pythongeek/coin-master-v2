import { logger } from '../config/logger';
import { env } from '../config/env';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setTimeout as delay } from 'timers/promises';

interface UsdtTransfer {
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: string; // major units, e.g. 1.0 USDT
  blockTimestamp: number;
  blockNumber?: number;
  confirmations?: number;
}

/**
 * TronGrid MCP service wrapper using the official MCP SDK.
 * - Opens a single long-lived Streamable HTTP MCP session.
 * - Provides typed helpers for deposit monitoring and withdrawal broadcasting.
 * - Enforces a 10 req/sec rate limit (safe margin under free-tier 15 req/sec).
 * - All on-chain reads are fetched from TronGrid; user input is never trusted.
 */
export class TronMcpService {
  private readonly endpoint = env.TRON_MCP_ENDPOINT || 'https://mcp.trongrid.io/mcp';
  private readonly apiKey = env.TRON_API_KEY || '';
  private readonly usdtContract = env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  private readonly maxRps = parseInt(env.TRON_MCP_MAX_RPS || '10', 10);
  private readonly minIntervalMs = 1000 / this.maxRps;

  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private queue: Array<() => void> = [];
  private lastCallAt = 0;
  private draining = false;
  private loopPromise?: Promise<void>;

  // ─── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.client) return;
    if (!this.apiKey) {
      throw new Error('TRON_API_KEY is required to use TronGrid MCP');
    }

    this.transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
      requestInit: {
        headers: {
          'TRON-PRO-API-KEY': this.apiKey,
        },
      },
    });

    this.client = new Client({ name: 'coin-master', version: '2.1.0' });
    await this.client.connect(this.transport);

    this.startRateLimitLoop();
    logger.info('TronGrid MCP session started');
  }

  async stop(): Promise<void> {
    this.draining = true;
    try {
      await this.transport?.terminateSession?.();
      await this.transport?.close?.();
      await this.client?.close?.();
    } catch (err) {
      logger.warn('TronGrid MCP stop error', { err });
    }
    this.client = undefined;
    this.transport = undefined;
    logger.info('TronGrid MCP session stopped');
  }

  // ─── Internal primitives ───────────────────────────────────────

  private async callTool(toolName: string, args: Record<string, any>, timeoutMs = 15000): Promise<any> {
    await this.start();
    if (!this.client) throw new Error('TronGrid MCP client not initialized');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`TronGrid MCP tool ${toolName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.enqueue(async () => {
        try {
          const result = await this.client!.callTool(
            { name: toolName, arguments: args },
            undefined, // resultSchema
            { timeout: timeoutMs }
          );
          clearTimeout(timer);
          resolve(result);
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private enqueue(fn: () => void): void {
    this.queue.push(fn);
  }

  private startRateLimitLoop(): void {
    if (this.loopPromise) return;

    this.loopPromise = (async () => {
      while (!this.draining) {
        const now = Date.now();
        const elapsed = now - this.lastCallAt;
        const wait = Math.max(0, this.minIntervalMs - elapsed);
        await delay(wait);

        if (this.draining) break;

        const next = this.queue.shift();
        if (next) {
          this.lastCallAt = Date.now();
          try {
            next();
          } catch (err) {
            logger.error('TronGrid MCP queue execution error', { err });
          }
        }
      }
    })();
  }

  private parseToolResult(result: any): any {
    if (!result?.content?.[0]?.text) return result;
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  }

  private formatMajor(raw: string | number, decimals: number): string {
    const value = typeof raw === 'string' ? parseFloat(raw) : raw;
    return (value / 10 ** decimals).toFixed(decimals).replace(/\.?0+$/, '');
  }

  private hotWalletAddressFromKey(privateKey: string): string {
    const { TronWeb } = require('tronweb');
    return TronWeb.address.fromPrivateKey(privateKey);
  }

  // ─── High-level helpers (deposit / withdrawal) ──────────────────

  /**
   * Get incoming TRC-20 USDT transfers for a deposit address.
   * Optional minBlock lets us poll incrementally.
   */
  async getIncomingUsdt(address: string, options?: { minBlock?: number; limit?: number }): Promise<UsdtTransfer[]> {
    const args: Record<string, any> = {
      address,
      limit: options?.limit ?? 20,
    };
    if (options?.minBlock !== undefined) {
      args.min_block_timestamp = options.minBlock;
    }

    const result = await this.callTool('getAccountTrc20Transactions', args);
    const parsed = this.parseToolResult(result);
    const items = parsed?.data || [];
    const decimals = 6;

    return items.map((tx: any) => ({
      txHash: tx.transaction_id || tx.txHash,
      fromAddress: tx.from,
      toAddress: tx.to,
      amount: this.formatMajor(tx.value || tx.amount, decimals),
      blockTimestamp: tx.block_timestamp,
      blockNumber: tx.block_number,
      confirmations: tx.confirmations,
    }));
  }

  /**
   * Get USDT balance of an address (major units).
   */
  async getUsdtBalance(address: string): Promise<string> {
    const result = await this.callTool('getTrc20Balance', {
      address,
      contract_address: this.usdtContract,
      limit: 1,
    });
    const parsed = this.parseToolResult(result);
    const majorKey = `${this.usdtContract}_major`;
    const raw = parsed?.data?.[0]?.[majorKey] ?? parsed?.data?.[0]?.[this.usdtContract] ?? '0';
    return String(raw);
  }

  /**
   * Confirm a transaction has reached the required number of confirmations.
   */
  async confirmTransaction(
    txHash: string,
    minConfirmations = 19
  ): Promise<{ confirmed: boolean; confirmations: number; blockNumber?: number; status?: string }> {
    const result = await this.callTool('getTransactionInfoById', { txHash });
    const parsed = this.parseToolResult(result) || {};

    const confirmations = Number(parsed.confirmations ?? 0);
    const blockNumber = parsed.blockNumber || parsed.block_height || parsed.blockNumber;
    const success = parsed.receipt?.result === 'SUCCESS' || parsed.receipt?.result === 'success';

    return {
      confirmed: confirmations >= minConfirmations && success,
      confirmations,
      blockNumber,
      status: parsed.receipt?.result,
    };
  }

  /**
   * Build a signed USDT transfer from the hot wallet to a destination.
   */
  async buildUsdtTransfer(
    toAddress: string,
    amountUsdt: number,
    privateKey: string
  ): Promise<{ signedTx: string; txId: string }> {
    const decimals = 6;
    const rawAmount = Math.round(amountUsdt * 10 ** decimals).toString();

    const result = await this.callTool('triggerSmartContract', {
      contract_address: this.usdtContract,
      function_selector: 'transfer(address,uint256)',
      parameter: {
        to_address: toAddress,
        amount: rawAmount,
      },
      owner_address: this.hotWalletAddressFromKey(privateKey),
      private_key: privateKey,
      visible: true,
    });

    const parsed = this.parseToolResult(result);
    if (!parsed?.transaction?.txID) {
      throw new Error('Failed to build USDT transfer: missing txID');
    }

    return {
      signedTx: parsed.transaction.raw_data_hex || JSON.stringify(parsed.transaction),
      txId: parsed.transaction.txID,
    };
  }

  /**
   * Broadcast a signed transaction to the TRON network.
   */
  async broadcastTransaction(signedTx: string): Promise<{ txId: string; result: boolean; code?: string }> {
    const result = await this.callTool('broadcastTransaction', { transaction: signedTx });
    const parsed = this.parseToolResult(result);
    return {
      txId: parsed.txid || parsed.txID || parsed.transaction?.txID,
      result: parsed.result === true || parsed.result === 'true' || parsed.code === 'SUCCESS',
      code: parsed.code,
    };
  }
}

export const tronMcpService = new TronMcpService();
