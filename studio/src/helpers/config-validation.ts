/**
 * Config Validation Module
 *
 * Validates all pool type configs before executing any actions.
 * Checks for:
 *   - Placeholder values (YOUR_*, PLACEHOLDER, XXX, TOKEN_NAME, etc.)
 *   - Valid Solana PublicKey format (base58, 32 bytes)
 *   - Required fields presence
 */

import { PublicKey } from '@solana/web3.js';

/** Patterns that indicate a placeholder that hasn't been replaced */
const PLACEHOLDER_PATTERNS = [
  /^YOUR_/i,
  /^PLACEHOLDER/i,
  /^XXX$/i,
  /^TOKEN_NAME$/i,
  /^TOKEN_SYMBOL$/i,
  /^TOKEN_DESCRIPTION$/i,
];

/**
 * Returns true if the value looks like an un-replaced placeholder.
 */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

/**
 * Returns true if the string is a valid base-58 Solana public key.
 */
export function isValidPublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export interface ValidationError {
  field: string;
  value: string;
  message: string;
  fix: string;
}

/**
 * Validate a single address field.  Returns an error object or null.
 */
function validateAddress(
  field: string,
  value: string | null | undefined,
  configFile: string
): ValidationError | null {
  if (!value) {
    return {
      field,
      value: String(value),
      message: `"${field}" is missing or empty.`,
      fix: `Set a valid Solana address in ${configFile} for the "${field}" field.`,
    };
  }
  if (isPlaceholder(value)) {
    return {
      field,
      value,
      message: `"${field}" contains a placeholder value: "${value}".`,
      fix: `Update ${configFile} and replace "${value}" with a valid Solana address.`,
    };
  }
  if (!isValidPublicKey(value)) {
    return {
      field,
      value,
      message: `"${field}" is not a valid Solana base58 address: "${value}".`,
      fix: `Update ${configFile}: set "${field}" to a valid 32-byte base58 public key. Did you hit a "Non-base58 character" error? This is why.`,
    };
  }
  return null;
}

/**
 * Throw a consolidated error if any errors are present.
 */
function throwIfErrors(errors: ValidationError[], context: string): void {
  if (errors.length === 0) return;

  const lines = [
    `\n❌  Config validation failed for ${context} (${errors.length} error${errors.length > 1 ? 's' : ''}):\n`,
    ...errors.map((e, i) => `  ${i + 1}. [${e.field}] ${e.message}\n     👉 Fix: ${e.fix}`),
    '\nPlease update your config file and try again.',
  ];

  throw new Error(lines.join('\n'));
}

// ─────────────────────────────────────────────
// DBC Config
// ─────────────────────────────────────────────

export function validateDbcConfigFields(dbcConfig: {
  feeClaimer?: string;
  leftoverReceiver?: string;
  transferHookProgram?: string | null;
  dbcPool?: { creator?: string; transferHookProgram?: string | null } | null;
  dbcTransferPoolCreator?: { newCreator?: string } | null;
}): void {
  const CONFIG_FILE = 'config/dbc_config.jsonc';
  const errors: ValidationError[] = [];

  // Validate top-level dbcConfig fields (called unconditionally so absent required fields are caught)
  const feeClaimerErr = validateAddress('dbcConfig.feeClaimer', dbcConfig.feeClaimer, CONFIG_FILE);
  if (feeClaimerErr) errors.push(feeClaimerErr);

  const leftoverReceiverErr = validateAddress(
    'dbcConfig.leftoverReceiver',
    dbcConfig.leftoverReceiver,
    CONFIG_FILE
  );
  if (leftoverReceiverErr) errors.push(leftoverReceiverErr);

  // Validate dbcConfig.transferHookProgram (optional)
  if (dbcConfig.transferHookProgram != null) {
    const err = validateAddress(
      'dbcConfig.transferHookProgram',
      dbcConfig.transferHookProgram,
      CONFIG_FILE
    );
    if (err) errors.push(err);
  }

  // Validate dbcPool.creator
  if (dbcConfig.dbcPool?.creator !== undefined) {
    const err = validateAddress('dbcPool.creator', dbcConfig.dbcPool.creator, CONFIG_FILE);
    if (err) errors.push(err);
  }

  // Validate dbcPool.transferHookProgram (optional)
  if (dbcConfig.dbcPool?.transferHookProgram != null) {
    const err = validateAddress(
      'dbcPool.transferHookProgram',
      dbcConfig.dbcPool.transferHookProgram,
      CONFIG_FILE
    );
    if (err) errors.push(err);
  }

  // Validate dbcTransferPoolCreator.newCreator
  if (dbcConfig.dbcTransferPoolCreator?.newCreator !== undefined) {
    const err = validateAddress(
      'dbcTransferPoolCreator.newCreator',
      dbcConfig.dbcTransferPoolCreator.newCreator,
      CONFIG_FILE
    );
    if (err) errors.push(err);
  }

  throwIfErrors(errors, 'DBC Config');
}

// ─────────────────────────────────────────────
// DAMM V1 Config
// ─────────────────────────────────────────────

export function validateDammV1ConfigFields(config: {
  quoteMint?: string | null;
  dammV1Config?: { baseAmount?: unknown } | null;
  dammV1LockLiquidity?: { allocations?: Array<{ address?: string }> } | null;
}): void {
  const CONFIG_FILE = 'config/damm_v1_config.jsonc';
  const errors: ValidationError[] = [];

  if (config.dammV1LockLiquidity?.allocations) {
    config.dammV1LockLiquidity.allocations.forEach((alloc, i) => {
      if (alloc.address !== undefined) {
        const err = validateAddress(
          `dammV1LockLiquidity.allocations[${i}].address`,
          alloc.address,
          CONFIG_FILE
        );
        if (err) errors.push(err);
      }
    });
  }

  throwIfErrors(errors, 'DAMM V1 Config');
}

// ─────────────────────────────────────────────
// DAMM V2 Config
// ─────────────────────────────────────────────

export function validateDammV2ConfigFields(config: {
  dammV2Config?: { creator?: string } | null;
  splitPosition?: { newPositionOwner?: string } | null;
}): void {
  const CONFIG_FILE = 'config/damm_v2_config.jsonc';
  const errors: ValidationError[] = [];

  if (config.dammV2Config?.creator !== undefined) {
    const err = validateAddress('dammV2Config.creator', config.dammV2Config.creator, CONFIG_FILE);
    if (err) errors.push(err);
  }

  if (config.splitPosition?.newPositionOwner !== undefined) {
    const err = validateAddress(
      'splitPosition.newPositionOwner',
      config.splitPosition.newPositionOwner,
      CONFIG_FILE
    );
    if (err) errors.push(err);
  }

  throwIfErrors(errors, 'DAMM V2 Config');
}

// ─────────────────────────────────────────────
// DLMM Config
// ─────────────────────────────────────────────

export function validateDlmmConfigFields(config: {
  lfgSeedLiquidity?: {
    positionOwner?: string;
    feeOwner?: string;
    operatorKeypairFilepath?: string;
  } | null;
  singleBinSeedLiquidity?: {
    positionOwner?: string;
    feeOwner?: string;
    operatorKeypairFilepath?: string;
  } | null;
}): void {
  const CONFIG_FILE = 'config/dlmm_config.jsonc';
  const errors: ValidationError[] = [];

  if (config.lfgSeedLiquidity) {
    const liq = config.lfgSeedLiquidity;
    if (liq.positionOwner !== undefined) {
      const err = validateAddress('lfgSeedLiquidity.positionOwner', liq.positionOwner, CONFIG_FILE);
      if (err) errors.push(err);
    }
    if (liq.feeOwner !== undefined) {
      const err = validateAddress('lfgSeedLiquidity.feeOwner', liq.feeOwner, CONFIG_FILE);
      if (err) errors.push(err);
    }
  }

  if (config.singleBinSeedLiquidity) {
    const liq = config.singleBinSeedLiquidity;
    if (liq.positionOwner !== undefined) {
      const err = validateAddress(
        'singleBinSeedLiquidity.positionOwner',
        liq.positionOwner,
        CONFIG_FILE
      );
      if (err) errors.push(err);
    }
    if (liq.feeOwner !== undefined) {
      const err = validateAddress('singleBinSeedLiquidity.feeOwner', liq.feeOwner, CONFIG_FILE);
      if (err) errors.push(err);
    }
  }

  throwIfErrors(errors, 'DLMM Config');
}

// ─────────────────────────────────────────────
// Alpha Vault Config
// ─────────────────────────────────────────────

export function validateAlphaVaultConfigFields(
  alphaVault: {
    whitelistFilepath?: string;
    merkleProofBaseUrl?: string;
  } | null
): void {
  if (!alphaVault) return;
  // Alpha vault currently has no user-facing address placeholders to validate
  // Future: add validation if/when address fields are added
}

// ─────────────────────────────────────────────
// Presale Vault Config
// ─────────────────────────────────────────────

export function validatePresaleConfigFields(_config: unknown): void {
  // Presale vault uses generated keypairs; no address placeholder fields currently
}

// ─────────────────────────────────────────────
// Generic: validate any MeteoraConfigBase
// ─────────────────────────────────────────────

export function validateBaseConfig(config: { rpcUrl?: string; keypairFilePath?: string }): void {
  const errors: ValidationError[] = [];

  if (!config.rpcUrl || config.rpcUrl.trim() === '') {
    errors.push({
      field: 'rpcUrl',
      value: String(config.rpcUrl),
      message: '"rpcUrl" is missing or empty.',
      fix: 'Set a valid RPC URL (e.g. https://api.devnet.solana.com) in your config file.',
    });
  }

  if (!config.keypairFilePath || config.keypairFilePath.trim() === '') {
    errors.push({
      field: 'keypairFilePath',
      value: String(config.keypairFilePath),
      message: '"keypairFilePath" is missing or empty.',
      fix: 'Set the path to your keypair JSON file (e.g. ./keypair.json) in your config file.',
    });
  }

  throwIfErrors(errors, 'Base Config');
}
