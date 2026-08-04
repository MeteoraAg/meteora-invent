import AlphaVault, { WhitelistMode } from '@meteora-ag/alpha-vault';
import { WhitelistModeConfig } from '../../utils/types';
import { Cluster, Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { getAmountInTokens } from '../../helpers';
import { ALPHA_VAULT_PROGRAM_IDS } from '../../utils/constants';

// SDK sentinel from getAvailableDepositQuota() meaning "no cap applies"
const UNLIMITED_QUOTA = new BN(Number.MAX_SAFE_INTEGER);

export function getAlphaVaultWhitelistMode(mode: WhitelistModeConfig): WhitelistMode {
  if (mode == WhitelistModeConfig.Permissionless) {
    return WhitelistMode.Permissionless;
  } else if (mode == WhitelistModeConfig.PermissionedWithAuthority) {
    return WhitelistMode.PermissionWithAuthority;
  } else if (mode == WhitelistModeConfig.PermissionedWithMerkleProof) {
    return WhitelistMode.PermissionWithMerkleProof;
  } else {
    throw new Error(`Unsupported alpha vault whitelist mode: ${mode}`);
  }
}

export function getClusterFromProgramId(alphaVaultProgramId: PublicKey): string {
  let cluster = 'mainnet-beta';
  switch (alphaVaultProgramId.toString()) {
    case ALPHA_VAULT_PROGRAM_IDS['mainnet-beta']:
      cluster = 'mainnet-beta';
      break;
    case ALPHA_VAULT_PROGRAM_IDS['devnet']:
      cluster = 'devnet';
      break;
    case ALPHA_VAULT_PROGRAM_IDS['localhost']:
      cluster = 'localhost';
      break;
    default:
      throw new Error(`Invalid alpha vault program id ${alphaVaultProgramId}`);
  }

  return cluster;
}

/**
 * Default alpha vault program id (mainnet-beta and devnet share this id; only localhost differs).
 * @returns The alpha vault program id
 */
export function defaultAlphaVaultProgramId(): PublicKey {
  return new PublicKey(ALPHA_VAULT_PROGRAM_IDS['mainnet-beta']);
}

/**
 * Hydrate an AlphaVault instance for a known vault address.
 *
 * `AlphaVault.create` returns null for a nonexistent vault but reads `.data` off it with no
 * guard, throwing a raw `TypeError` — wrapped here into an actionable error.
 * @param connection - The connection to the network
 * @param vault - The alpha vault address
 * @param alphaVaultProgramId - The alpha vault program id
 * @returns The hydrated AlphaVault instance
 */
export async function loadAlphaVault(
  connection: Connection,
  vault: PublicKey,
  alphaVaultProgramId: PublicKey = defaultAlphaVaultProgramId()
): Promise<AlphaVault> {
  const cluster = getClusterFromProgramId(alphaVaultProgramId);
  try {
    return await AlphaVault.create(connection, vault, { cluster: cluster as Cluster });
  } catch {
    throw new Error(
      `No alpha vault at ${vault.toString()} — check the address, or discover one with ` +
        '--poolAddress <pool>.'
    );
  }
}

/**
 * Format a quota/cap BN as human token units, printing "unlimited" for the SDK's no-cap sentinel.
 * @param amount - The quota/cap amount
 * @param decimals - The token decimals
 * @returns The formatted amount
 */
export function formatAlphaVaultAmount(amount: BN, decimals: number): string {
  if (amount.gte(UNLIMITED_QUOTA)) {
    return 'unlimited';
  }
  return getAmountInTokens(amount, decimals);
}
