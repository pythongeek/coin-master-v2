import { getRawSetting, setRawSetting } from './admin-config';
import { decryptSecret, encryptSecret } from './secret-vault';

/**
 * ═══════════════════════════════════════════════════════════════
 *  KYC SETTINGS — Load KYC provider configuration from the admin
 *  settings table at runtime. The MiniMax API key is encrypted.
 * ═══════════════════════════════════════════════════════════════
 */

export interface KycSettings {
  provider: 'minimax' | 'manual';
  minimaxApiKey: string | null;
  minimaxApiKeySet: boolean;
  minimaxModel: string;
  minimaxBaseUrl: string;
  requiredForWithdrawal: boolean;
  requiredForBetAbove: number;
  autoApproveThreshold: number;
  autoRejectThreshold: number;
  maxFileSizeBytes: number;
  allowedExtensions: string[];
}

const SETTING_KEYS = {
  provider: 'kyc_provider',
  minimaxApiKeyEncrypted: 'kyc_minimax_api_key_encrypted',
  minimaxModel: 'kyc_minimax_model',
  minimaxBaseUrl: 'kyc_minimax_base_url',
  requiredForWithdrawal: 'kyc_required_for_withdrawal',
  requiredForBetAbove: 'kyc_required_for_bet_above',
  autoApproveThreshold: 'kyc_auto_approve_threshold',
  autoRejectThreshold: 'kyc_auto_reject_threshold',
  maxFileSizeBytes: 'kyc_max_file_size_bytes',
  allowedExtensions: 'kyc_allowed_extensions',
};

const DEFAULTS: KycSettings = {
  provider: 'manual',
  minimaxApiKey: null,
  minimaxApiKeySet: false,
  minimaxModel: 'MiniMax-M3',
  minimaxBaseUrl: 'https://api.minimax.io/v1',
  requiredForWithdrawal: true,
  requiredForBetAbove: 500,
  autoApproveThreshold: 30,
  autoRejectThreshold: 70,
  maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB
  allowedExtensions: ['jpg', 'jpeg', 'png'],
};

function parseBool(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value === 'true';
}

function parseNumber(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = parseFloat(value);
  return Number.isNaN(n) ? fallback : n;
}

export async function getKycSettings(): Promise<KycSettings> {
  const [
    provider,
    encryptedKey,
    model,
    baseUrl,
    requiredForWithdrawal,
    requiredForBetAbove,
    autoApproveThreshold,
    autoRejectThreshold,
    maxFileSizeBytes,
    allowedExtensions,
  ] = await Promise.all([
    getRawSetting(SETTING_KEYS.provider),
    getRawSetting(SETTING_KEYS.minimaxApiKeyEncrypted),
    getRawSetting(SETTING_KEYS.minimaxModel),
    getRawSetting(SETTING_KEYS.minimaxBaseUrl),
    getRawSetting(SETTING_KEYS.requiredForWithdrawal),
    getRawSetting(SETTING_KEYS.requiredForBetAbove),
    getRawSetting(SETTING_KEYS.autoApproveThreshold),
    getRawSetting(SETTING_KEYS.autoRejectThreshold),
    getRawSetting(SETTING_KEYS.maxFileSizeBytes),
    getRawSetting(SETTING_KEYS.allowedExtensions),
  ]);

  let minimaxApiKey: string | null = null;
  if (encryptedKey) {
    try {
      minimaxApiKey = decryptSecret(encryptedKey);
    } catch (e) {
      console.error('Failed to decrypt KYC MiniMax API key:', e instanceof Error ? e.message : 'unknown');
      minimaxApiKey = null;
    }
  }

  return {
    provider: (provider as 'minimax' | 'manual') || DEFAULTS.provider,
    minimaxApiKey,
    minimaxApiKeySet: !!minimaxApiKey,
    minimaxModel: model || DEFAULTS.minimaxModel,
    minimaxBaseUrl: baseUrl || DEFAULTS.minimaxBaseUrl,
    requiredForWithdrawal: parseBool(requiredForWithdrawal, DEFAULTS.requiredForWithdrawal),
    requiredForBetAbove: parseNumber(requiredForBetAbove, DEFAULTS.requiredForBetAbove),
    autoApproveThreshold: parseNumber(autoApproveThreshold, DEFAULTS.autoApproveThreshold),
    autoRejectThreshold: parseNumber(autoRejectThreshold, DEFAULTS.autoRejectThreshold),
    maxFileSizeBytes: parseNumber(maxFileSizeBytes, DEFAULTS.maxFileSizeBytes),
    allowedExtensions: allowedExtensions ? allowedExtensions.split(',') : DEFAULTS.allowedExtensions,
  };
}

export async function setKycApiKey(apiKey: string): Promise<void> {
  const encrypted = encryptSecret(apiKey);
  await setRawSetting(
    SETTING_KEYS.minimaxApiKeyEncrypted,
    encrypted,
    'Encrypted MiniMax API key for KYC verification'
  );
}

export async function clearKycApiKey(): Promise<void> {
  await setRawSetting(SETTING_KEYS.minimaxApiKeyEncrypted, '', 'Encrypted MiniMax API key for KYC verification');
}

export async function setKycSettings(partial: Partial<Omit<KycSettings, 'minimaxApiKey' | 'minimaxApiKeySet'>>): Promise<void> {
  if (partial.provider !== undefined) {
    await setRawSetting(SETTING_KEYS.provider, partial.provider, 'KYC provider: minimax or manual');
  }
  if (partial.minimaxModel !== undefined) {
    await setRawSetting(SETTING_KEYS.minimaxModel, partial.minimaxModel, 'MiniMax model name for KYC');
  }
  if (partial.minimaxBaseUrl !== undefined) {
    await setRawSetting(SETTING_KEYS.minimaxBaseUrl, partial.minimaxBaseUrl, 'MiniMax API base URL');
  }
  if (partial.requiredForWithdrawal !== undefined) {
    await setRawSetting(SETTING_KEYS.requiredForWithdrawal, String(partial.requiredForWithdrawal), 'Require KYC before withdrawal');
  }
  if (partial.requiredForBetAbove !== undefined) {
    await setRawSetting(SETTING_KEYS.requiredForBetAbove, String(partial.requiredForBetAbove), 'Require KYC for bets above this amount');
  }
  if (partial.autoApproveThreshold !== undefined) {
    await setRawSetting(SETTING_KEYS.autoApproveThreshold, String(partial.autoApproveThreshold), 'Risk score below this is auto-approved');
  }
  if (partial.autoRejectThreshold !== undefined) {
    await setRawSetting(SETTING_KEYS.autoRejectThreshold, String(partial.autoRejectThreshold), 'Risk score above this is auto-rejected');
  }
  if (partial.maxFileSizeBytes !== undefined) {
    await setRawSetting(SETTING_KEYS.maxFileSizeBytes, String(partial.maxFileSizeBytes), 'Max KYC image upload size in bytes');
  }
  if (partial.allowedExtensions !== undefined) {
    await setRawSetting(SETTING_KEYS.allowedExtensions, partial.allowedExtensions.join(','), 'Allowed KYC image extensions');
  }
}
