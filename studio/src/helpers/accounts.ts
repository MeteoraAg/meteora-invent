import { SEED } from '@meteora-ag/alpha-vault';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

export function deriveAlphaVault(
  base: PublicKey,
  lbPair: PublicKey,
  alphaVaultProgramId: PublicKey
) {
  const [alphaVaultAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.vault), base.toBuffer(), lbPair.toBuffer()],
    alphaVaultProgramId
  );
  return alphaVaultAddress;
}

export function deriveMerkleRootConfig(
  alphaVault: PublicKey,
  version: BN,
  programId: PublicKey
): PublicKey {
  const [merkleRootConfig] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(SEED.merkleRoot),
      alphaVault.toBuffer(),
      new Uint8Array(version.toArrayLike(Buffer, 'le', 8)),
    ],
    programId
  );
  return merkleRootConfig;
}
