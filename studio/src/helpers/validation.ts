import Ajv from 'ajv';
import { CONFIG_SCHEMA } from './config';
import {
  MeteoraConfig,
  DammV1Config,
  DammV2Config,
  DlmmConfig,
  DbcConfig,
  AlphaVaultConfig,
} from '../utils/types';

function isDammV1Config(config: MeteoraConfig): config is DammV1Config {
  return 'tradeFeeNumerator' in config && 'baseAmount' in config && 'quoteAmount' in config;
}

function isDammV2Config(config: MeteoraConfig): config is DammV2Config {
  return 'dynamicAmmV2' in config;
}

function isDlmmConfig(config: MeteoraConfig): config is DlmmConfig {
  return 'dlmm' in config;
}

function isDbcConfig(config: MeteoraConfig): config is DbcConfig {
  return 'dbc' in config;
}

function isAlphaVaultConfig(config: MeteoraConfig): config is AlphaVaultConfig {
  return 'alphaVault' in config && Object.keys(config).length === 7; // Only has base properties + alphaVault
}

export function validateConfig(config: MeteoraConfig) {
  const ajv = new Ajv({
    strict: false,
  });
  const validate = ajv.compile(CONFIG_SCHEMA);
  const isValid = validate(config);
  if (!isValid) {
    console.error(validate.errors);
    throw new Error('Config file is invalid');
  }

  extraConfigValidation(config);
}

export function extraConfigValidation(config: MeteoraConfig) {
  if (!config.keypairFilePath) {
    throw new Error('Missing keypairFilePath in config file.');
  }
  if (!config.rpcUrl) {
    throw new Error('Missing rpcUrl in config file.');
  }

  // Check createBaseToken vs baseMint conflict for applicable config types
  if ('createBaseToken' in config && config.createBaseToken && config.baseMint) {
    throw new Error('Both createBaseToken and baseMint cannot be set simultaneously.');
  }

  // Type-specific validation
  if (isDammV1Config(config)) {
    validateDammV1Config(config);
  } else if (isDammV2Config(config)) {
    validateDammV2Config(config);
  } else if (isDlmmConfig(config)) {
    validateDlmmConfig(config);
  } else if (isDbcConfig(config)) {
    validateDbcConfig(config);
  } else if (isAlphaVaultConfig(config)) {
    validateAlphaVaultConfig(config);
  }
}

function validateDammV1Config(config: DammV1Config) {
  if (config.alphaVault) {
    validateAlphaVaultCommon(config.alphaVault);
  }
}

function validateDammV2Config(config: DammV2Config) {
  if (config.alphaVault) {
    validateAlphaVaultCommon(config.alphaVault);
  }
}

function validateDlmmConfig(config: DlmmConfig) {
  if (config.dlmm && config.dlmm.hasAlphaVault) {
    if (config.quoteMint == null) {
      throw new Error('quoteMint must be provided for DLMM');
    }
  }

  if (config.alphaVault) {
    validateAlphaVaultCommon(config.alphaVault);
  }
}

function validateDbcConfig(config: DbcConfig) {
  if (!config.dbc) {
    throw new Error('DBC configuration is required but not provided.');
  }

  if (
    config.dbc.buildCurveMode !== 0 &&
    config.dbc.buildCurveMode !== 1 &&
    config.dbc.buildCurveMode !== 2 &&
    config.dbc.buildCurveMode !== 3
  ) {
    throw new Error(`Build curve mode isn't supported.`);
  }
}

function validateAlphaVaultConfig(config: AlphaVaultConfig) {
  if (config.alphaVault) {
    validateAlphaVaultCommon(config.alphaVault);
  }
}

function validateAlphaVaultCommon(alphaVault: any) {
  if (alphaVault.alphaVaultType != 'fcfs' && alphaVault.alphaVaultType != 'prorata') {
    throw new Error(`Alpha vault type ${alphaVault.alphaVaultType} isn't supported.`);
  }

  if (
    alphaVault.poolType != 'dynamic' &&
    alphaVault.poolType != 'dlmm' &&
    alphaVault.poolType != 'damm2'
  ) {
    throw new Error(`Alpha vault pool type ${alphaVault.poolType} isn't supported.`);
  }
}
