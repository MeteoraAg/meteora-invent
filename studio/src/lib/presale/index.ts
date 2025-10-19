import { Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { FcfsPresaleVaultConfig, PresaleVaultTypeConfig, PresaleConfig } from '../../utils/types';
import { Presale, derivePresale, PRESALE_PROGRAM_ID } from '@meteora-ag/presale';
import BN from 'bn.js';
import { runSimulateTransaction } from '../../helpers/transaction';

export async function createFcfsPresaleVault(
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  params: FcfsPresaleVaultConfig,
  dryRun: boolean
) {
  console.log(`\n> Initializing FCFS Presale...`);
  console.log(`- Using baseMint: ${baseMint.toBase58()}`);
  console.log(`- Using quoteMint: ${quoteMint.toBase58()}`);

  console.log(`- Generating new base keypair`);
  const baseKeypair = Keypair.generate();
  console.log(`- Base public key: ${baseKeypair.publicKey.toBase58()}`);

  const presaleRegistriesArgs = params.presaleRegistries.map((registry) => ({
    presaleSupply: new BN(registry.presaleSupply),
    buyerMaximumDepositCap: new BN(registry.buyerMaximumDepositCap),
    buyerMinimumDepositCap: new BN(registry.buyerMinimumDepositCap),
    depositFeeBps: new BN(registry.depositFeeBps),
  }));

  console.log(`\n> Presale Registries (${presaleRegistriesArgs.length} tier(s)):`);
  presaleRegistriesArgs.forEach((registry, index) => {
    console.log(`  Tier ${index + 1}:`);
    console.log(`    - Supply: ${registry.presaleSupply.toString()}`);
    console.log(`    - Max deposit cap: ${registry.buyerMaximumDepositCap.toString()}`);
    console.log(`    - Min deposit cap: ${registry.buyerMinimumDepositCap.toString()}`);
    console.log(`    - Deposit fee (bps): ${registry.depositFeeBps.toString()}`);
  });

  const presaleArgs = {
    presaleMaximumCap: new BN(params.presaleArgs.presaleMaximumCap),
    presaleMinimumCap: new BN(params.presaleArgs.presaleMinimumCap),
    presaleStartTime: new BN(params.presaleArgs.presaleStartTime),
    presaleEndTime: new BN(params.presaleArgs.presaleEndTime),
    whitelistMode: params.presaleArgs.whitelistMode,
    unsoldTokenAction: params.presaleArgs.unsoldTokenAction,
  };

  console.log(`\n> Presale Configuration:`);
  console.log(`  - Maximum cap: ${presaleArgs.presaleMaximumCap.toString()}`);
  console.log(`  - Minimum cap: ${presaleArgs.presaleMinimumCap.toString()}`);
  console.log(
    `  - Start time: ${presaleArgs.presaleStartTime.toString()} (${presaleArgs.presaleStartTime.toNumber() === 0 ? 'immediate' : new Date(presaleArgs.presaleStartTime.toNumber() * 1000).toISOString()})`
  );
  console.log(
    `  - End time: ${presaleArgs.presaleEndTime.toString()} (${new Date(presaleArgs.presaleEndTime.toNumber() * 1000).toISOString()})`
  );
  console.log(
    `  - Whitelist mode: ${presaleArgs.whitelistMode} (0=permissionless, 1=merkle_proof, 2=authority)`
  );
  console.log(`  - Unsold token action: ${presaleArgs.unsoldTokenAction} (0=burn, 1=refund)`);

  let lockedVestingArgs;
  if (params.lockedVestingArgs) {
    lockedVestingArgs = {
      lockDuration: new BN(params.lockedVestingArgs.lockDuration),
      vestDuration: new BN(params.lockedVestingArgs.vestDuration),
      immediateReleaseBps: new BN(params.lockedVestingArgs.immediateReleaseBps),
    };

    console.log(`\n> Locked Vesting Configuration:`);
    console.log(`  - Lock duration: ${lockedVestingArgs.lockDuration.toString()} seconds`);
    console.log(`  - Vest duration: ${lockedVestingArgs.vestDuration.toString()} seconds`);
    console.log(
      `  - Immediate release: ${lockedVestingArgs.immediateReleaseBps.toString()} bps (${lockedVestingArgs.immediateReleaseBps.toNumber() / 100}%)`
    );
  }

  console.log(`\n> Creating FCFS presale transaction...`);
  const initializeFcfsPresaleTx = await Presale.createFcfsPresale(connection, PRESALE_PROGRAM_ID, {
    baseMintPubkey: baseMint,
    quoteMintPubkey: quoteMint,
    basePubkey: baseKeypair.publicKey,
    creatorPubkey: wallet.publicKey,
    feePayerPubkey: wallet.publicKey,
    presaleRegistries: presaleRegistriesArgs,
    presaleArgs,
    lockedVestingArgs,
  });

  initializeFcfsPresaleTx.sign(wallet.payer, baseKeypair);

  if (dryRun) {
    console.log(`\n> Simulating presale initialization...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [
      initializeFcfsPresaleTx,
    ]);
  } else {
    console.log(`>> Sending presale initialization transaction...`);
    const txSig = await connection.sendRawTransaction(initializeFcfsPresaleTx.serialize());
    console.log(`>>> Transaction sent: ${txSig}`);

    console.log(`>>> Confirming transaction...`);
    await connection.confirmTransaction(
      {
        signature: txSig,
        lastValidBlockHeight: initializeFcfsPresaleTx.lastValidBlockHeight!,
        blockhash: initializeFcfsPresaleTx.recentBlockhash!,
      },
      'confirmed'
    );

    console.log(`>>> Waiting for finalization...`);
    await connection.confirmTransaction(
      {
        signature: txSig,
        lastValidBlockHeight: initializeFcfsPresaleTx.lastValidBlockHeight!,
        blockhash: initializeFcfsPresaleTx.recentBlockhash!,
      },
      'finalized'
    );

    const presaleAddress = derivePresale(
      baseMint,
      quoteMint,
      baseKeypair.publicKey,
      PRESALE_PROGRAM_ID
    );

    console.log(`\n✅ Presale initialized successfully!`);
    console.log(`   Transaction: ${txSig}`);
    console.log(`   Presale Address: ${presaleAddress.toBase58()}`);

    try {
      const presaleInstance = await Presale.create(connection, presaleAddress, PRESALE_PROGRAM_ID);
      console.log(`\n> Presale State:`);
      console.log(JSON.stringify(presaleInstance.presaleAccount, null, 2));
    } catch (err) {
      console.warn('Could not fetch presale state:', err);
    }
  }
}

export async function createProrataPresaleVault() {
  throw new Error('Not implemented yet');
}

export async function createFixedPricePresaleVault() {
  throw new Error('Not implemented yet');
}

export async function createPermissionedFixedPricePresaleVaultWithAuthority() {
  throw new Error('Not implemented yet');
}

export async function createPermissionedFixedPricePresaleVaultWithMerkleProof() {
  throw new Error('Not implemented yet');
}

/**
 * Main routing function to create presale vaults based on configuration
 */
export async function createPresaleVault(
  connection: Connection,
  wallet: Wallet,
  config: PresaleConfig,
  baseMint: PublicKey
) {
  if (!config.presaleVault) {
    throw new Error('Presale vault configuration is missing');
  }

  if (!config.quoteMint) {
    throw new Error('Quote mint configuration is missing');
  }

  const quoteMint = new PublicKey(config.quoteMint);
  const presaleVaultType = config.presaleVaultType;

  console.log(`\n> Creating presale vault of type: ${presaleVaultType}`);

  switch (presaleVaultType) {
    case PresaleVaultTypeConfig.Fcfs:
      await createFcfsPresaleVault(
        connection,
        wallet,
        baseMint,
        quoteMint,
        config.presaleVault,
        config.dryRun
      );
      break;

    case PresaleVaultTypeConfig.Prorata:
      await createProrataPresaleVault();
      break;

    case PresaleVaultTypeConfig.FixedPrice:
      await createFixedPricePresaleVault();
      break;

    case PresaleVaultTypeConfig.PermissionedFixedPriceWithAuthority:
      await createPermissionedFixedPricePresaleVaultWithAuthority();
      break;

    case PresaleVaultTypeConfig.PermissionedFixedPriceWithMerkleProof:
      await createPermissionedFixedPricePresaleVaultWithMerkleProof();
      break;

    default:
      throw new Error(`Invalid presale vault type: ${presaleVaultType}`);
  }
}
