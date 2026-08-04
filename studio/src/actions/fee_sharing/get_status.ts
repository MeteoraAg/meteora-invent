import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getFeeSharingConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { getStatus } from '../../lib/fee_sharing/status';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getFeeSharingConfig();

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  const { vault: vaultKey } = parseCliArguments();
  const vault = vaultKey ? new PublicKey(vaultKey) : undefined;
  if (vault) {
    console.log(`- Using vault ${vault.toString()}`);
  }

  // Read-only action: the keypair is optional. It's only used to also show the per-wallet view
  // (highlighting the wallet's own row with --vault) or to run the --vault-less reverse lookup.
  // No usable keypair AND no --vault -> getStatus() throws a clear error naming both options.
  let walletPubkey: PublicKey | undefined;
  try {
    const keypair = await safeParseKeypairFromFile(config.keypairFilePath);
    walletPubkey = keypair.publicKey;
    console.log(`- Using wallet ${walletPubkey.toString()} to also show the per-wallet view`);
  } catch {
    console.log(
      `- No usable keypair at ${config.keypairFilePath} — showing vault-only status (no per-wallet view / reverse lookup)`
    );
  }

  await getStatus(connection, vault, walletPubkey);
}

main();
