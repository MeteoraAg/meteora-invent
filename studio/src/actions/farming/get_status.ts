import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getFarmingConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { getStatus, guessFarmingCluster } from '../../lib/farming/status';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getFarmingConfig();

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  const { farm: farmKey, poolAddress: poolKey } = parseCliArguments();
  if (!farmKey && !poolKey) {
    throw new Error('Please provide --farm or --poolAddress flag to do this action');
  }

  // Read-only action: the wallet is optional and only used to additionally show the
  // per-wallet staked balance + claimable rewards. No keypair -> farm-only status.
  let walletPubkey: PublicKey | undefined;
  try {
    const keypair = await safeParseKeypairFromFile(config.keypairFilePath);
    walletPubkey = keypair.publicKey;
    console.log(`- Using wallet ${walletPubkey.toString()} to also show the per-wallet view`);
  } catch {
    console.log(
      `- No usable keypair at ${config.keypairFilePath} — showing farm-only status (no per-wallet view)`
    );
  }

  await getStatus(
    connection,
    {
      farm: farmKey ? new PublicKey(farmKey) : undefined,
      poolAddress: poolKey ? new PublicKey(poolKey) : undefined,
    },
    walletPubkey,
    guessFarmingCluster(config.rpcUrl)
  );
}

main();
