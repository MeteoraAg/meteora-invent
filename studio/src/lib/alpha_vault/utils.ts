import AlphaVault, { WhitelistMode } from '@meteora-ag/alpha-vault';
import { WhitelistModeConfig } from '../../utils/types';
import { Cluster, Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { getAmountInTokens } from '../../helpers';
import { ALPHA_VAULT_PROGRAM_IDS } from '../../utils/constants';

// getAvailableDepositQuota() (in the SDK) uses this exact sentinel to mean "no cap applies"
// (FCFS-only caps default to it when the vault/mode doesn't constrain deposits) — recognized
// here so status/participant output prints "unlimited" instead of a confusing huge number.
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
 * The alpha vault program id every action in this codebase resolves against unless told
 * otherwise (mainnet-beta and devnet share this id; only localhost differs — see
 * ALPHA_VAULT_PROGRAM_IDS). Matches the create-path precedent in lib/alpha_vault/index.ts.
 */
export function defaultAlphaVaultProgramId(): PublicKey {
  return new PublicKey(ALPHA_VAULT_PROGRAM_IDS['mainnet-beta']);
}

/**
 * Hydrate an AlphaVault instance (fetches .vault/.mode/.vaultState + base/quote mint info) for
 * a known vault address, using the same program-id -> cluster resolution as the create-path
 * actions (createMerkleProofMetadata, etc.) — reused here so participant/status ops stay
 * consistent with vault creation.
 */
export async function loadAlphaVault(
  connection: Connection,
  vault: PublicKey,
  alphaVaultProgramId: PublicKey = defaultAlphaVaultProgramId()
): Promise<AlphaVault> {
  const cluster = getClusterFromProgramId(alphaVaultProgramId);
  return AlphaVault.create(connection, vault, { cluster: cluster as Cluster });
}

/**
 * Format a quota/cap BN as human token units, recognizing the SDK's "no cap" sentinel
 * (Number.MAX_SAFE_INTEGER, returned by getAvailableDepositQuota when nothing constrains the
 * deposit — e.g. prorata mode, or FCFS with no individual cap left to hit).
 */
export function formatAlphaVaultAmount(amount: BN, decimals: number): string {
  if (amount.gte(UNLIMITED_QUOTA)) {
    return 'unlimited';
  }
  return getAmountInTokens(amount, decimals);
}
