import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getAlphaVaultConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { getStatus } from '../../lib/alpha_vault/status';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getAlphaVaultConfig();

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  const { vault: vaultKey, poolAddress: poolKey } = parseCliArguments();
  if (!vaultKey && !poolKey) {
    throw new Error('Please provide --vault or --poolAddress flag to do this action');
  }

  // Read-only action: the wallet is optional and only used to additionally show the
  // per-wallet interactionState() view. No keypair -> plain vault status only.
  let walletPubkey: PublicKey | undefined;
  try {
    const keypair = await safeParseKeypairFromFile(config.keypairFilePath);
    walletPubkey = keypair.publicKey;
    console.log(`- Using wallet ${walletPubkey.toString()} to also show the per-wallet view`);
  } catch {
    console.log(
      `- No usable keypair at ${config.keypairFilePath} — showing vault-only status (no per-wallet view)`
    );
  }

  await getStatus(
    connection,
    {
      vault: vaultKey ? new PublicKey(vaultKey) : undefined,
      poolAddress: poolKey ? new PublicKey(poolKey) : undefined,
    },
    walletPubkey
  );
}

main();
