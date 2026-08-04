import path from 'path';
import {
  DynamicVaultConfig,
  FarmingConfig,
  FeeSharingConfig,
  ZapConfig,
  LockConfig,
} from '../utils/types';
import { safeParseJsonFromFile } from './utils';

export async function getDynamicVaultConfig(): Promise<DynamicVaultConfig> {
  const configPath = path.join(__dirname, '../../config/dynamic_vault_config.jsonc');
  const config: DynamicVaultConfig = await safeParseJsonFromFile(configPath);
  return config;
}

export async function getFarmingConfig(): Promise<FarmingConfig> {
  const configPath = path.join(__dirname, '../../config/farming_config.jsonc');
  const config: FarmingConfig = await safeParseJsonFromFile(configPath);
  return config;
}

export async function getFeeSharingConfig(): Promise<FeeSharingConfig> {
  const configPath = path.join(__dirname, '../../config/fee_sharing_config.jsonc');
  const config: FeeSharingConfig = await safeParseJsonFromFile(configPath);
  return config;
}

export async function getZapConfig(): Promise<ZapConfig> {
  const configPath = path.join(__dirname, '../../config/zap_config.jsonc');
  const config: ZapConfig = await safeParseJsonFromFile(configPath);
  return config;
}

export async function getLockConfig(): Promise<LockConfig> {
  const configPath = path.join(__dirname, '../../config/lock_config.jsonc');
  const config: LockConfig = await safeParseJsonFromFile(configPath);
  return config;
}
