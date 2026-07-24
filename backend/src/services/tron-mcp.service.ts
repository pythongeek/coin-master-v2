import { logger } from '../config/logger';
import { env } from '../config/env';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setTimeout as delay } from 'timers/promises';
import { CircuitBreaker, CircuitState } from '../utils/circuit-breaker';
import { trongridEndpointFailuresTotal } from '../routes/metrics';

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
 * ═══════════════════════════════════════════════════════════════
 *  TronGrid MCP service wrapper — P1-13
 *  ─────────────────────────────────────────────────────────────
 *
 *  Opens a long-lived Streamable HTTP MCP session against TronGrid
 *  with automatic endpoint failover and per-endpoint circuit
 *  breakers.
 *
 *  Failover strategy
 *  ─────────────────
 *  1. `start()` opens the MCP session against the first reachable
 *     endpoint in the ordered list, persisting the working one.
 *  2. Every `callTool` goes through `tryCallToolWithFailover`, which
 *     runs the call against the current working endpoint. On
 *     failure (network error, timeout, or HTTP 5xx), it:
 *       a) records the failure on the per-endpoint CircuitBreaker,
 *       b) increments `trongrid_endpoint_failures_total{endpoint, status_code}`,
 *       c) closes the broken transport (if any) and tries the next
 *          endpoint in the list.
 *     This continues until one endpoint returns successfully, or
 *     all endpoints fail (in which case the structured
 *     `AllEndpointsFailedError` is thrown with the full failure
 *     log).
 *  3. A CircuitBreaker in OPEN state short-circuits the call to
 *     that endpoint, preventing wasted timeouts on a known-bad
 *     host. After the cooldown period the circuit moves to
 *     HALF_OPEN and the next request is allowed as a trial.
 *
 *  Configuration
 *  ──────────────
 *  Operators can override the endpoint list via env vars:
 *    - TRONGRID_PRIMARY_ENDPOINT  (default: https://mcp.trongrid.io/mcp)
 *    - TRONGRID_FALLBACK_ENDPOINT (default: https://api.trongrid.io/mcp)
 *    - TRONGRID_TESTNET_ENDPOINT  (default: https://api.shasta.trongrid.io/mcp)
 *      Only included in non-production NODE_ENV to prevent a testnet
 *      fallback in prod.
 *
 *  Testnet guard
 *  ─────────────
 *  The Shasta testnet endpoint is explicitly excluded from
 *  production builds. If TRONGRID_TESTNET_ENDPOINT is set in
 *  production we log a loud warning AND omit it from the rotation,
 *  to prevent a stale testnet config from being used as a
 *  last-resort fallback that returns garbage data.
 *
 *  Dependencies
 *  ────────────
 *  - `circuit-breaker.ts` — generic stateful breaker. We instantiate
 *    one per endpoint so each host has its own state.
 *  - `routes/metrics.ts` — `trongridEndpointFailuresTotal` counter.
 *    The service imports it (rather than re-registering locally)
 *    so the registry is shared and the counter is exposed at /metrics.
 *  - `setTimeout` from `timers/promises` — clean async sleep.
 *
 *  Rate limit
 *  ──────────
 *  The 10 req/sec limit from the original service is preserved
 *  (TronGrid's free tier is 15 req/sec; 10 leaves headroom). The
 *  rate-limit queue is per-process and unchanged.
 * ═══════════════════════════════════════════════════════════════
 */

const DEFAULT_PRIMARY = 'https://mcp.trongrid.io/mcp';
const DEFAULT_FALLBACK = 'https://api.trongrid.io/mcp';
const DEFAULT_TESTNET = 'https://api.shasta.trongrid.io/mcp';
const MAX_FALLBACK_RETRIES = 2; // try each endpoint at most twice per call
const RECONNECT_COOLDOWN_MS = 5_000;

/**
 * Structured error thrown when every endpoint in the rotation
 * fails. Carries the per-endpoint failure list so operators can
 * diagnose the outage from the error alone.
 */
export class AllEndpointsFailedError extends Error {
  public readonly failures: Array<{ endpoint: string; reason: string; statusCode?: number }>;
  constructor(failures: Array<{ endpoint: string; reason: string; statusCode?: number }>) {
    const summary = failures
      .map((f) => `${f.endpoint}: ${f.reason}${f.statusCode ? ` (HTTP ${f.statusCode})` : ''}`)
      .join('; ');
    super(`All TronGrid MCP endpoints failed. ${summary}`);
    this.name = 'AllEndpointsFailedError';
    this.failures = failures;
  }
}

export class TronMcpService {
  /**
   * Ordered list of endpoints to try. Built once at construction
   * (from env) and re-read only when `reloadEndpoints()` is called.
   */
  private readonly endpoints: string[];
  private readonly apiKey: string;
  private readonly usdtContract: string;
  private readonly maxRps: number;
  private readonly minIntervalMs: number;

  /**
   * The currently-active endpoint URL. Persisted across calls so
   * we don't re-try endpoints that just failed. Updated when
   * `start()` opens a session OR when a failover replaces it.
   */
  private currentEndpoint: string;

  /**
   * Per-endpoint circuit breakers. Keyed by URL host (not full URL
   * for shorter label names in logs/metrics). One breaker per
   * endpoint so an outage of one host doesn't affect the other's
   * state.
   */
  private readonly breakers: Map<string, CircuitBreaker> = new Map();

  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private queue: Array<() => void> = [];
  private lastCallAt = 0;
  private draining = false;
  private loopPromise?: Promise<void>;

  constructor() {
    const primary = env.TRONGRID_PRIMARY_ENDPOINT || DEFAULT_PRIMARY;
    const fallback = env.TRONGRID_FALLBACK_ENDPOINT || DEFAULT_FALLBACK;
    const list: string[] = [primary, fallback];
    if (process.env.NODE_ENV !== 'production' || env.TRONGRID_ALLOW_TESTNET) {
      const testnet = env.TRONGRID_TESTNET_ENDPOINT || DEFAULT_TESTNET;
      if (testnet) list.push(testnet);
    } else if (env.TRONGRID_TESTNET_ENDPOINT) {
      // Operator set the testnet endpoint in production. Loud
      // warning + DO NOT include it in the rotation. This is a
      // safety net: a misconfigured .env that has
      // `TRONGRID_TESTNET_ENDPOINT=https://api.shasta...` would
      // otherwise route real-money requests to testnet.
      // eslint-disable-next-line no-console
      console.warn(
        '[tron-mcp] TRONGRID_TESTNET_ENDPOINT is set in production — IGNORING it to prevent testnet fallback. ' +
          'If this is intentional, set TRONGRID_ALLOW_TESTNET=true.',
      );
    }
    this.endpoints = list;
    this.currentEndpoint = primary;
    this.apiKey = env.TRON_API_KEY || '';
    this.usdtContract = env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    this.maxRps = parseInt(env.TRON_MCP_MAX_RPS || '10', 10);
    this.minIntervalMs = 1000 / this.maxRps;

    // Build a circuit breaker per endpoint.
    for (const ep of this.endpoints) {
      const host = new URL(ep).host;
      this.breakers.set(
        host,
        new CircuitBreaker(`tron-mcp:${host}`, {
          failureThreshold: 0.5,
          minimumRequests: 3,
          cooldownPeriod: 10_000,
          rollingWindow: 60_000,
        }),
      );
    }
  }

  /**
   * Public method: return the list of configured endpoints
   * (read-only). Useful for /api/health checks and tests.
   */
  public getEndpoints(): readonly string[] {
    return this.endpoints;
  }

  /**
   * Return the host name of the currently-active endpoint. For
   * use in logs and metrics.
   */
  public getCurrentEndpointHost(): string {
    try {
      return new URL(this.currentEndpoint).host;
    } catch {
      return this.currentEndpoint;
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /**
   * Open an MCP session, trying endpoints in order. The first one
   * to successfully complete `client.connect()` is the
   * `currentEndpoint`. We start the rate-limit loop only on
   * success; a failed start leaves `client` undefined so the
   * caller can either retry or surface the error.
   */
  async start(): Promise<void> {
    if (this.client) return;
    if (!this.apiKey) {
      throw new Error('TRON_API_KEY is required to use TronGrid MCP');
    }

    const errors: Array<{ endpoint: string; reason: string; statusCode?: number }> = [];
    for (const endpoint of this.endpoints) {
      try {
        await this.connectToEndpoint(endpoint);
        // success — start rate limiter and return.
        this.currentEndpoint = endpoint;
        this.startRateLimitLoop();
        logger.info('TronGrid MCP session started', { endpoint, host: this.getCurrentEndpointHost() });
        return;
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err));
        const statusCode = this.extractStatusCode(err);
        errors.push({ endpoint, reason, statusCode });
        // Best-effort: bump the failure counter here too so even
        // startup-time failures are visible to operators.
        this.recordEndpointFailure(endpoint, statusCode, reason);
        logger.warn('TronGrid MCP endpoint connect failed; trying next', {
          endpoint, reason, statusCode,
        });
      }
    }
    throw new AllEndpointsFailedError(errors);
  }

  /**
   * Open a session against a single endpoint. Used by `start()`
   * to probe the rotation. May throw; caller decides what to do.
   */
  private async connectToEndpoint(endpoint: string): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: {
        headers: {
          'TRON-PRO-API-KEY': this.apiKey,
        },
      },
    });
    const client = new Client({ name: 'coin-master', version: '2.1.0' });
    try {
      await client.connect(transport);
    } catch (err) {
      // Tear down the half-initialized transport.
      try { await transport.close(); } catch { /* ignore */ }
      throw err;
    }
    // Commit the new session atomically.
    await this.teardownCurrentSession(); // close any old one (defensive)
    this.client = client;
    this.transport = transport;
  }

  /**
   * Disconnect from the current endpoint. Idempotent.
   */
  private async teardownCurrentSession(): Promise<void> {
    if (this.transport) {
      try { await this.transport.terminateSession?.(); } catch { /* ignore */ }
      try { await this.transport.close?.(); } catch { /* ignore */ }
    }
    if (this.client) {
      try { await this.client.close?.(); } catch { /* ignore */ }
    }
    this.client = undefined;
    this.transport = undefined;
  }

  async stop(): Promise<void> {
    this.draining = true;
    await this.teardownCurrentSession();
    logger.info('TronGrid MCP session stopped', { endpoint: this.currentEndpoint });
  }

  // ─── Internal primitives ───────────────────────────────────────

  /**
   * Execute an MCP tool call with circuit-breaker + failover. On
   * any network error, timeout, or HTTP 5xx response:
   *  1. Record the failure on the per-endpoint CircuitBreaker.
   *  2. Increment `trongrid_endpoint_failures_total`.
   *  3. If more endpoints are available, try the next one.
   *  4. If all endpoints fail, throw `AllEndpointsFailedError`.
   *
   * On success, the response is returned and the per-endpoint
   * breaker records a success (which closes a HALF_OPEN breaker
   * or refreshes the rolling window).
   */
  private async tryCallToolWithFailover(
    toolName: string,
    args: Record<string, any>,
    timeoutMs: number,
  ): Promise<any> {
    await this.start();
    if (!this.client || !this.transport) {
      throw new Error('TronGrid MCP client not initialized');
    }

    // Build the ordered list of endpoints to try for THIS call.
    // Start with the currently-active one, then fall back to the
    // rest of the rotation in declared order.
    const tryOrder = this.buildTryOrder(this.currentEndpoint);

    const failures: Array<{ endpoint: string; reason: string; statusCode?: number }> = [];
    let lastTransport = this.transport;
    let lastClient = this.client;
    let lastEndpoint = this.currentEndpoint;

    for (const endpoint of tryOrder) {
      const host = this.hostFor(endpoint);
      const breaker = this.breakers.get(host);
      // If the breaker for this endpoint is OPEN, skip without
      // attempting a request. The circuit will move to HALF_OPEN
      // after the cooldown period.
      if (breaker && breaker.getState() === CircuitState.OPEN) {
        failures.push({ endpoint, reason: 'circuit_open' });
        continue;
      }

      // For non-current endpoints, we need to open a fresh MCP
      // session to talk to them (the SDK keeps one transport per
      // client). We open a temporary session only when we actually
      // need to call; for the current endpoint we reuse the
      // existing session.
      let isCurrent = endpoint === this.currentEndpoint && lastTransport === this.transport;
      let tempTransport: StreamableHTTPClientTransport | undefined;
      let tempClient: Client | undefined;
      if (!isCurrent) {
        try {
          tempTransport = new StreamableHTTPClientTransport(new URL(endpoint), {
            requestInit: { headers: { 'TRON-PRO-API-KEY': this.apiKey } },
          });
          tempClient = new Client({ name: 'coin-master', version: '2.1.0' });
          await tempClient.connect(tempTransport);
        } catch (err) {
          const reason = (err instanceof Error ? err.message : String(err));
          const statusCode = this.extractStatusCode(err);
          failures.push({ endpoint, reason, statusCode });
          this.recordEndpointFailure(endpoint, statusCode, reason);
          continue;
        }
      }

      try {
        const result = await this.executeCallOnEndpoint(
          isCurrent ? lastClient! : tempClient!,
          toolName,
          args,
          timeoutMs,
        );
        // Success.
        if (!isCurrent) {
          // Promote the temporary session to the canonical one so
          // subsequent calls reuse it. Tear down the old one.
          try { await this.teardownCurrentSession(); } catch { /* ignore */ }
          this.client = tempClient;
          this.transport = tempTransport;
          this.currentEndpoint = endpoint;
        }
        breaker?.recordSuccessExternal();
        return result;
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err));
        const statusCode = this.extractStatusCode(err);
        failures.push({ endpoint, reason, statusCode });
        this.recordEndpointFailure(endpoint, statusCode, reason);
        if (!isCurrent && tempClient) {
          try { await tempTransport?.close?.(); } catch { /* ignore */ }
          try { await tempClient.close?.(); } catch { /* ignore */ }
        }
        // Continue to the next endpoint.
        continue;
      }
    }

    // Every endpoint failed. Throw a structured error with the full
    // failure log so operators can diagnose.
    throw new AllEndpointsFailedError(failures);
  }

  /**
   * The "real" call to an MCP tool. Encapsulated so we can swap the
   * (client, transport) pair per endpoint.
   */
  private executeCallOnEndpoint(
    client: Client,
    toolName: string,
    args: Record<string, any>,
    timeoutMs: number,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`TronGrid MCP tool ${toolName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Use the rate-limit queue to avoid bursting past maxRps.
      this.enqueue(async () => {
        try {
          const result = await client.callTool(
            { name: toolName, arguments: args },
            undefined,
            { timeout: timeoutMs },
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

  private async callTool(toolName: string, args: Record<string, any>, timeoutMs = 15000): Promise<any> {
    return this.tryCallToolWithFailover(toolName, args, timeoutMs);
  }

  /**
   * Build the ordered list of endpoints to try for a single call.
   * The currently-active endpoint goes first, then the rest of
   * the rotation in declared order.
   */
  private buildTryOrder(currentFirst: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    if (currentFirst) {
      out.push(currentFirst);
      seen.add(currentFirst);
    }
    for (const ep of this.endpoints) {
      if (!seen.has(ep)) {
        out.push(ep);
        seen.add(ep);
      }
    }
    return out;
  }

  private hostFor(endpoint: string): string {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint;
    }
  }

  private extractStatusCode(err: unknown): number | undefined {
    if (!err || typeof err !== 'object') return undefined;
    const e = err as { code?: string; status?: number; statusCode?: number };
    // MCP SDK errors sometimes include `code` like 'ECONNREFUSED' but
    // not an HTTP status. Map common network codes to a sentinel
    // for the metrics label.
    if (typeof e.statusCode === 'number') return e.statusCode;
    if (typeof e.status === 'number') return e.status;
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT') {
      return undefined; // network error, distinct from HTTP 5xx
    }
    return undefined;
  }

  private recordEndpointFailure(endpoint: string, statusCode: number | undefined, reason: string): void {
    const host = this.hostFor(endpoint);
    const label = statusCode === undefined ? 'network_error' : String(statusCode);
    try {
      trongridEndpointFailuresTotal.inc({ endpoint: host, status_code: label });
    } catch {
      // Metrics registry may be unavailable in tests; never let
      // metrics throw back into the calling code path.
    }
    // Best-effort: also record on the per-endpoint CircuitBreaker
    // so a flaky endpoint gets opened after the configured
    // failure-rate threshold.
    const breaker = this.breakers.get(host);
    if (breaker) {
      breaker.recordFailureExternal();
    }
    logger.warn('[tron-mcp] endpoint failure recorded', { endpoint: host, status_code: label, reason });
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

  private hotWalletAddressFromKey(privateKey: string | Buffer): string {
    // Accept Buffer so callers with a secret Bytes (NodeJS Buffer) can
    // stay Buffer-only end-to-end and rely on `.fill(0)` after use
    // instead of forcing a string copy. TronWeb's API accepts either.
    const { TronWeb } = require('tronweb');
    if (Buffer.isBuffer(privateKey)) {
      return TronWeb.address.fromPrivateKey(privateKey.toString('hex'));
    }
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
    const isFinal = parsed.status === 'CONFIRMED' || parsed.status === 'confirmed';

    return {
      confirmed: confirmations >= minConfirmations && success && isFinal,
      confirmations,
      blockNumber,
      status: `${parsed.status}:${parsed.receipt?.result}`,
    };
  }

  /**
   * Build a signed USDT transfer from the hot wallet to a destination.
   * The private key is used only locally; TronGrid never receives it.
   */
  async buildUsdtTransfer(
    toAddress: string,
    amountUsdt: number,
    privateKey: string | Buffer
  ): Promise<{ signedTx: any; txId: string }> {
    const decimals = 6;
    const rawAmount = Math.round(amountUsdt * 10 ** decimals);
    const ownerAddress = this.hotWalletAddressFromKey(privateKey);

    const { TronWeb } = require('tronweb');
    const tw = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': this.apiKey },
      privateKey,
    });

    const trigger = await tw.transactionBuilder.triggerSmartContract(
      this.usdtContract,
      'transfer(address,uint256)',
      { feeLimit: 100_000_000, callValue: 0 },
      [
        { type: 'address', value: toAddress },
        { type: 'uint256', value: rawAmount },
      ],
      ownerAddress
    );

    if (!trigger?.transaction) {
      throw new Error('Failed to build USDT transfer: triggerSmartContract failed');
    }

    const signedTx = await tw.trx.sign(trigger.transaction);
    return {
      signedTx: signedTx as any,
      txId: signedTx.txID,
    };
  }

  /**
   * Estimate energy required for a USDT transfer from the hot wallet.
   */
  async estimateEnergy(
    toAddress: string,
    amountUsdt: number,
    privateKey: string | Buffer
  ): Promise<{ energy: number; transaction?: any }> {
    const decimals = 6;
    const rawAmount = Math.round(amountUsdt * 10 ** decimals);
    const ownerAddress = this.hotWalletAddressFromKey(privateKey);

    const result = await this.callTool('estimateEnergy', {
      contract_address: this.usdtContract,
      function_selector: 'transfer(address,uint256)',
      parameter: {
        to_address: toAddress,
        amount: rawAmount.toString(),
      },
      owner_address: ownerAddress,
      visible: true,
    });
    const parsed = this.parseToolResult(result);
    return {
      energy: Number(parsed?.energy_required || parsed?.energy || 0),
      transaction: parsed?.transaction,
    };
  }

  /**
   * Broadcast a signed transaction to the TRON network.
   */
  async broadcastTransaction(signedTx: string | object): Promise<{ txId: string; result: boolean; code?: string }> {
    const transaction = typeof signedTx === 'string' ? signedTx : JSON.stringify(signedTx);
    const result = await this.callTool('broadcastTransaction', { transaction });
    const parsed = this.parseToolResult(result);
    return {
      txId: parsed.txid || parsed.txID || parsed.transaction?.txID,
      result: parsed.result === true || parsed.result === 'true' || parsed.code === 'SUCCESS',
      code: parsed.code,
    };
  }
}

export const tronMcpService = new TronMcpService();
