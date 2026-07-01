export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;  // e.g. 0.50 (50% failure rate)
  cooldownPeriod?: number;    // Cooldown duration in ms before trial (default 10s)
  minimumRequests?: number;   // Min requests in rolling window to trigger checks (default 5)
  rollingWindow?: number;     // Window duration in ms (default 1 min)
}

/**
 * A generic, stateful Circuit Breaker utility to prevent cascading failures 
 * when calling unreliable external APIs/services (e.g. KYC, RPC nodes).
 */
export class CircuitBreaker {
  private name: string;
  private state: CircuitState = CircuitState.CLOSED;
  private failureThreshold: number;
  private cooldownPeriod: number;
  private minimumRequests: number;
  private rollingWindow: number;

  private requests: { timestamp: number; success: boolean }[] = [];
  private lastStateChange: number = Date.now();

  constructor(name: string, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 0.5;
    this.cooldownPeriod = options.cooldownPeriod ?? 10000;
    this.minimumRequests = options.minimumRequests ?? 5;
    this.rollingWindow = options.rollingWindow ?? 60000;
  }

  /**
   * Get the current state of the circuit. Handles cooldown checks.
   */
  public getState(): CircuitState {
    this.updateState();
    return this.state;
  }

  private updateState(): void {
    const now = Date.now();

    if (this.state === CircuitState.OPEN) {
      // Transition from OPEN to HALF_OPEN after cooldown period expires
      if (now - this.lastStateChange > this.cooldownPeriod) {
        this.transitionTo(CircuitState.HALF_OPEN);
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();
    console.warn(`[CircuitBreaker:${this.name}] State transition: ${oldState} ➡️ ${newState}`);
  }

  /**
   * Executes the specified action guarded by the circuit breaker.
   * If the circuit is open, attempts to run the fallback (if provided) or throws immediately.
   * 
   * @param action Async function to execute
   * @param fallback Optional fallback function to execute if the circuit is open or execution fails
   */
  public async execute<T>(action: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    this.updateState();

    if (this.state === CircuitState.OPEN) {
      if (fallback) {
        if (process.env.NODE_ENV === 'development') {
          console.log(`[CircuitBreaker:${this.name}] Circuit is OPEN. Executing fallback.`);
        }
        return fallback();
      }
      throw new Error(`[CircuitBreaker:${this.name}] Circuit is OPEN. Execution blocked.`);
    }

    try {
      const result = await action();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      if (fallback) {
        console.warn(`[CircuitBreaker:${this.name}] Action failed. Executing fallback. Error:`, error);
        return fallback();
      }
      throw error;
    }
  }

  private recordSuccess(): void {
    const now = Date.now();
    this.requests.push({ timestamp: now, success: true });
    this.cleanRollingWindow(now);

    if (this.state === CircuitState.HALF_OPEN) {
      // Trial succeeded, close the circuit
      this.transitionTo(CircuitState.CLOSED);
      this.requests = []; // Clear statistical history
    }
  }

  private recordFailure(): void {
    const now = Date.now();
    this.requests.push({ timestamp: now, success: false });
    this.cleanRollingWindow(now);

    if (this.state === CircuitState.HALF_OPEN) {
      // Trial failed, reopen circuit
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    if (this.state === CircuitState.CLOSED) {
      const relevantRequests = this.requests.filter(r => now - r.timestamp <= this.rollingWindow);
      if (relevantRequests.length >= this.minimumRequests) {
        const failures = relevantRequests.filter(r => !r.success).length;
        const failureRate = failures / relevantRequests.length;
        if (failureRate >= this.failureThreshold) {
          this.transitionTo(CircuitState.OPEN);
        }
      }
    }
  }

  private cleanRollingWindow(now: number): void {
    this.requests = this.requests.filter(r => now - r.timestamp <= this.rollingWindow);
  }
}
