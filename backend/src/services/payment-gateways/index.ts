/**
 * ═══════════════════════════════════════════════════════════════
 *  PAYMENT PROVIDER FACTORY + REGISTRY
 * ═══════════════════════════════════════════════════════════════
 *
 *  Single source of truth for which providers are available.
 *  Adding a new gateway = add it here + create one provider class
 *  in ./binance-pay.ts or ./redot-pay.ts (or new file).
 *
 *  Disabled providers return null from getProvider() — call sites
 *  must handle the null case gracefully.
 */

import { binancePay } from './binance-pay';
import { redotPay } from './redot-pay';
import { PaymentGateway, PaymentProvider } from './types';

const PROVIDERS: Record<PaymentGateway, PaymentProvider> = {
  binance_pay: binancePay,
  redot_pay: redotPay,
};

export function getProvider(gateway: PaymentGateway): PaymentProvider | null {
  const provider = PROVIDERS[gateway];
  if (!provider) return null;
  // Could also check payment_provider_config.is_enabled here
  return provider;
}

export function listProviders(): PaymentProvider[] {
  return Object.values(PROVIDERS);
}