import { Wallet } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { Presale, PRESALE_PROGRAM_ID, PresaleProgress } from '@meteora-ag/presale';
import { PresaleConfig } from '../../utils/types';
import { getAmountInTokens, modifyComputeUnitPriceIx } from '../../helpers';
import { assertFunded, simulateOrSend } from './participant';

/**
 * Withdraw the creator's proceeds once the raise has resolved: raise proceeds (quote token)
 * once Completed, or the unsold base-token supply back once Failed. Guarded on
 * canCreatorWithdraw() (progress Completed/Failed and not already withdrawn) and a client-side
 * creator check (the on-chain owner signer check would otherwise surface as a generic revert).
 * When config.presaleCreatorWithdraw.collectFee is set, also calls creatorCollectFee() right
 * after (as its own transaction), skipping with a clear log line if not yet eligible.
 */
export async function creatorWithdraw(
  config: PresaleConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  console.log('\n> Initializing Presale creator-withdraw...');
  await assertFunded(connection, wallet.publicKey);

  const presale = await Presale.create(connection, vault, PRESALE_PROGRAM_ID);
  const w = presale.getParsedPresale();

  console.log(`- Presale ${vault.toString()}`);
  console.log(`- Progress: ${PresaleProgress[w.getPresaleProgressState()]}`);

  if (!presale.presaleAccount.owner.equals(wallet.publicKey)) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} is not the creator of presale ${vault.toString()} ` +
        `(creator is ${presale.presaleAccount.owner.toString()}).`
    );
  }

  if (!w.canCreatorWithdraw()) {
    throw new Error(
      `Cannot creator-withdraw from presale ${vault.toString()} right now — progress must be ` +
        `Completed or Failed (currently ${PresaleProgress[w.getPresaleProgressState()]}), and the ` +
        'creator must not have already withdrawn.'
    );
  }

  const withdrawable = w.getCreatorWithdrawableToken();
  const decimals = withdrawable.isBaseToken
    ? presale.baseMint.decimals
    : presale.quoteMint.decimals;
  const kind =
    w.getPresaleProgressState() === PresaleProgress.Completed
      ? 'raise proceeds'
      : 'unsold supply refund after a failed raise';
  console.log(
    `- Withdrawable now: ${getAmountInTokens(withdrawable.amount, decimals)} ` +
      `(${withdrawable.isBaseToken ? 'base' : 'quote'} token — ${kind})`
  );

  const withdrawTx = await presale.creatorWithdraw({ creator: wallet.publicKey });
  modifyComputeUnitPriceIx(withdrawTx, config.computeUnitPriceMicroLamports ?? 0);
  await simulateOrSend(connection, wallet, config.dryRun, withdrawTx, 'creator-withdraw');

  if (!config.presaleCreatorWithdraw?.collectFee) {
    return;
  }

  console.log('\n> presaleCreatorWithdraw.collectFee is set — also collecting the deposit fee...');
  if (!w.canCreatorCollectFee()) {
    console.log(
      '> Skipping creatorCollectFee: not eligible right now (already collected, the presale end ' +
        'time has not passed, or the raise failed — failed raises have no fee to collect).'
    );
    return;
  }

  const collectFeeTx = await presale.creatorCollectFee();
  modifyComputeUnitPriceIx(collectFeeTx, config.computeUnitPriceMicroLamports ?? 0);
  await simulateOrSend(connection, wallet, config.dryRun, collectFeeTx, 'creator-collect-fee');
}

/**
 * Permissionless crank: burns or refunds-to-creator the unsold base-token supply per the
 * presale's unsoldTokenAction, once the raise has resolved. Anyone can pay for this — the
 * resulting tokens always go to the presale's own creator account (performUnsoldBaseTokenAction
 * hardcodes that internally), so there is no creator-only guard beyond the progress/already-done
 * checks below.
 */
export async function handleUnsold(
  config: PresaleConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  console.log('\n> Initializing Presale handle-unsold...');
  await assertFunded(connection, wallet.publicKey);

  const presale = await Presale.create(connection, vault, PRESALE_PROGRAM_ID);
  const w = presale.getParsedPresale();

  console.log(`- Presale ${vault.toString()}`);
  console.log(`- Progress: ${PresaleProgress[w.getPresaleProgressState()]}`);
  console.log(
    `- Unsold token action: ${presale.presaleAccount.unsoldTokenAction === 1 ? 'burn' : 'refund to creator'}`
  );

  const progress = w.getPresaleProgressState();
  if (progress !== PresaleProgress.Completed && progress !== PresaleProgress.Failed) {
    throw new Error(
      `Presale ${vault.toString()} has not resolved yet (progress: ${PresaleProgress[progress]}) — ` +
        'unsold-token handling only applies once the raise has ended.'
    );
  }

  if (presale.presaleAccount.isUnsoldTokenActionPerformed) {
    throw new Error(
      `The unsold-token action has already been performed for presale ${vault.toString()}.`
    );
  }

  const unsoldTx = await presale.performUnsoldBaseTokenAction(wallet.publicKey);
  modifyComputeUnitPriceIx(unsoldTx, config.computeUnitPriceMicroLamports ?? 0);
  await simulateOrSend(connection, wallet, config.dryRun, unsoldTx, 'handle-unsold');
}
