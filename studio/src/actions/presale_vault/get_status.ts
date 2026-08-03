import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getPresaleConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { getStatus } from '../../lib/presale_vault/status';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getPresaleConfig();

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  const { vault: vaultKey } = parseCliArguments();
  if (!vaultKey) {
    throw new Error('Please provide --vault flag to do this action');
  }
  const vault = new PublicKey(vaultKey);

  // Read-only action: the wallet is optional and only used to additionally show the
  // per-wallet escrow view. No keypair -> plain presale status only.
  let walletPubkey: PublicKey | undefined;
  try {
    const keypair = await safeParseKeypairFromFile(config.keypairFilePath);
    walletPubkey = keypair.publicKey;
    console.log(`- Using wallet ${walletPubkey.toString()} to also show the per-wallet view`);
  } catch {
    console.log(
      `- No usable keypair at ${config.keypairFilePath} — showing presale-only status (no per-wallet view)`
    );
  }

  await getStatus(connection, vault, walletPubkey);
}

main();
