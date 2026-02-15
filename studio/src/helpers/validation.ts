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
  if (config.dlmmConfig && config.dlmmConfig.hasAlphaVault) {
    if (config.quoteMint == null) {
      throw new Error('quoteMint must be provided for DLMM');
    }
  }

  if (config.alphaVault) {
    validateAlphaVaultCommon(config.alphaVault);
  }
}

function validateDbcConfig(config: DbcConfig) {
  if (!config.dbcConfig) {
    throw new Error('DBC configuration is required but not provided.');
  }

  const validModes = [0, 1, 2, 3, 4, 5];
  if (!validModes.includes(config.dbcConfig.buildCurveMode)) {
    throw new Error(
      `Build curve mode ${config.dbcConfig.buildCurveMode} isn't supported. Valid modes: 0 (buildCurve), 1 (buildCurveWithMarketCap), 2 (buildCurveWithTwoSegments), 3 (buildCurveWithLiquidityWeights), 4 (buildCurveWithMidPrice), 5 (buildCurveWithCustomSqrtPrices).`
    );
  }

  // Validate required nested groups exist
  if (!config.dbcConfig.token) {
    throw new Error('DBC configuration is missing the "token" section.');
  }
  if (!config.dbcConfig.fee) {
    throw new Error('DBC configuration is missing the "fee" section.');
  }
  if (!config.dbcConfig.migration) {
    throw new Error('DBC configuration is missing the "migration" section.');
  }
  if (!config.dbcConfig.liquidityDistribution) {
    throw new Error('DBC configuration is missing the "liquidityDistribution" section.');
  }
  if (!config.dbcConfig.lockedVesting) {
    throw new Error('DBC configuration is missing the "lockedVesting" section.');
  }

  // Validate marketCapFeeSchedulerParams requires poolFeeBps
  const migratedPoolFee = config.dbcConfig.migration.migratedPoolFee;
  if (migratedPoolFee?.marketCapFeeSchedulerParams) {
    if (!migratedPoolFee.poolFeeBps || migratedPoolFee.poolFeeBps <= 0) {
      throw new Error(
        'When marketCapFeeSchedulerParams is configured, migratedPoolFee.poolFeeBps is required and must be greater than 0.'
      );
    }
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
