import { Logger } from './logger';

/**
 * Simple consecutive-failure circuit breaker for API providers.
 *
 * Opens after `threshold` consecutive failures to stop hammering a failing
 * endpoint. Auto-recovers after `cooldownMs` so transient outages resolve
 * without user intervention.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly logger: Logger,
    private readonly label: string,
    private readonly onOpen?: () => void,
    private readonly onClose?: () => void,
  ) {}

  isOpen(): boolean {
    if (this.consecutiveFailures < this.threshold) return false;
    if (Date.now() - this.circuitOpenedAt > this.cooldownMs) {
      this.consecutiveFailures = 0;
      this.onClose?.();
      return false;
    }
    return true;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === this.threshold) {
      this.circuitOpenedAt = Date.now();
      this.logger.error(
        `${this.label}: circuit breaker open after ${this.threshold} consecutive failures`,
      );
      this.onOpen?.();
    }
  }

  recordSuccess(): void {
    const wasOpen = this.consecutiveFailures >= this.threshold;
    this.consecutiveFailures = 0;
    if (wasOpen) this.onClose?.();
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = 0;
  }
}
