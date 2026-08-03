import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getDammV1Config, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { getStatus } from '../../lib/damm_v1/stake2earn';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDammV1Config();

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  const { poolAddress: poolAddressRaw } = parseCliArguments();
  if (!poolAddressRaw) {
    throw new Error('Please provide --poolAddress flag to do this action');
  }
  const poolAddress = new PublicKey(poolAddressRaw);

  // Read-only action: the wallet is optional and only used to additionally show the
  // per-wallet stake escrow / unstake view. No keypair -> plain farm status only.
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

  await getStatus(connection, poolAddress, walletPubkey);
}

main();
