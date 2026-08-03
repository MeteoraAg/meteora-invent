import { PublicKey } from '@solana/web3.js';
import { safeParseKeypairFromFile, getDynamicVaultConfig, parseCliArguments } from '../../helpers';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { getStatus } from '../../lib/dynamic_vault/status';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDynamicVaultConfig();

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  const { baseMint: targetKey } = parseCliArguments();
  if (!targetKey) {
    throw new Error('Please provide --baseMint flag to do this action');
  }
  const baseMint = new PublicKey(targetKey);
  console.log(`- Using baseMint ${baseMint.toString()}`);

  // Read-only action: the wallet is optional and only used to additionally show the
  // per-wallet LP balance + underlying value. No keypair -> plain vault status only.
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

  await getStatus(connection, baseMint, walletPubkey);
}

main();
