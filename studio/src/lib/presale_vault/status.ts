import { Connection, PublicKey } from '@solana/web3.js';
import {
  getOnChainTimestamp,
  Presale,
  PRESALE_PROGRAM_ID,
  PresaleProgress,
} from '@meteora-ag/presale';

/**
 * Print the full status of a presale (read-only, no keypair required): progress state/%, mode,
 * whitelist mode, totals, average token price, timings, every gate boolean, and a per-registry
 * table. When Completed, prints next-step hints for both sides of the hand-off. With a wallet,
 * also prints that wallet's per-escrow view (deposited/claimed/pending/withdrawable).
 */
export async function getStatus(
  connection: Connection,
  presaleAddress: PublicKey,
  walletPubkey?: PublicKey
) {
  const presale = await Presale.create(connection, presaleAddress, PRESALE_PROGRAM_ID);
  const w = presale.getParsedPresale();
  const account = presale.presaleAccount;

  console.log(`\n> Presale:           ${presaleAddress.toString()}`);
  console.log(`> Creator:           ${account.owner.toString()}`);
  console.log(`> Base mint:         ${account.baseMint.toString()}`);
  console.log(`> Quote mint:        ${account.quoteMint.toString()}`);
  console.log(`> Mode:              ${w.getPresaleModeName()}`);
  console.log(`> Whitelist mode:    ${w.getWhitelistModeName()}`);
  console.log(
    `> Progress:          ${PresaleProgress[w.getPresaleProgressState()]} (${w.getPresaleProgressPercentage().toFixed(2)}%)`
  );
  console.log(`> Total deposited:   ${w.getTotalDepositUiAmount()} (quote)`);
  console.log(`> Total sold:        ${w.getUiTotalBaseTokenSold()} (base)`);
  console.log(`> Minimum cap:       ${w.getPresaleMinimumUiCap()} (quote)`);
  console.log(`> Maximum cap:       ${w.getPresaleMaximumUiCap()} (quote)`);
  console.log(`> Average price:     ${w.getAverageTokenPrice()} (quote per base)`);
  console.log(
    `> Immediate release: ${w.getImmediateReleasePercentage()}% (${w.getImmediateReleaseUiAmount()} base)`
  );
  console.log(
    `> Unsold token action: ${account.unsoldTokenAction === 1 ? 'burn' : 'refund to creator'}` +
      `${account.isUnsoldTokenActionPerformed ? ' (already performed)' : ''}`
  );

  const timings = w.getTimings();
  console.log(`> Presale start:     ${timings.presaleStartTime} (unix seconds)`);
  console.log(`> Presale end:       ${timings.presaleEndTime} (unix seconds)`);
  console.log(`> Vesting start:     ${timings.vestingStartTime} (unix seconds)`);
  console.log(`> Vesting end:       ${timings.vestingEndTime} (unix seconds)`);
  console.log(`> Subject to early end once cap reached: ${timings.subjectToEarlyEnd}`);

  console.log(`\n> Gates:`);
  console.log(`> canDeposit:                ${w.canDeposit()}`);
  console.log(`> canWithdraw:               ${w.canWithdraw()}`);
  console.log(`> canWithdrawRemainingQuote: ${w.canWithdrawRemainingQuote()}`);
  console.log(`> canClaim:                  ${w.canClaim()}`);
  console.log(`> canCreatorWithdraw:        ${w.canCreatorWithdraw()}`);
  console.log(`> canCreatorCollectFee:      ${w.canCreatorCollectFee()}`);

  const registries = w.getAllPresaleRegistries();
  console.log(`\n> Registries (${registries.length}):`);
  for (const registry of registries) {
    console.log(`  [${registry.getRegistryIndex()}]`);
    console.log(`    Supply:        ${registry.getPresaleUiSupply()} (base)`);
    console.log(`    Total deposit: ${registry.getTotalDepositUiAmount()} (quote)`);
    console.log(`    Min cap:       ${registry.getBuyerMinimumUiDepositCap()} (quote)`);
    console.log(`    Max cap:       ${registry.getBuyerMaximumUiDepositCap()} (quote)`);
    console.log(`    Deposit fee:   ${registry.getDepositFeePercentage()}%`);
    console.log(`    Token price:   ${registry.getTokenPrice()}`);
    console.log(`    Total sold:    ${registry.getTotalBaseTokenSoldUiAmount()} (base)`);
  }

  if (w.getPresaleProgressState() === PresaleProgress.Completed) {
    console.log('\n> The raise is Completed — next steps:');
    console.log(
      `  Creator: pnpm studio presale-vault-creator-withdraw --vault ${presaleAddress.toString()}, ` +
        'then seed a market with the raised quote + reserved supply — pick one: dlmm-create-pool, ' +
        'damm-v2-create-balanced-pool, damm-v1-create-pool, or a DBC config + pool for curve-style launches.'
    );
    console.log(`  Buyers:  pnpm studio presale-vault-claim --vault ${presaleAddress.toString()}`);
  }

  if (!walletPubkey) {
    return;
  }

  console.log(`\n> Wallet: ${walletPubkey.toString()}`);
  const escrows = await presale.getPresaleEscrowByOwner(walletPubkey);
  if (escrows.length === 0) {
    console.log('> No escrow found for this wallet on this presale (it has not deposited yet).');
    return;
  }

  const currentTimestamp = Number(await getOnChainTimestamp(connection));
  for (const escrow of escrows) {
    const escrowAccount = escrow.getEscrowAccount();
    console.log(`\n  Registry ${escrowAccount.registryIndex}:`);
    console.log(`    Deposited:                    ${escrow.getDepositUiAmount()} (quote)`);
    console.log(`    Total claimable (lifetime):   ${escrow.getTotalClaimableUiAmount(w)} (base)`);
    console.log(`    Claimed so far:               ${escrow.getClaimedUiAmount()} (base)`);
    console.log(
      `    Pending claimable now:        ${escrow.getPendingClaimableUiAmount(w, currentTimestamp)} (base)`
    );
    console.log(
      `    Withdrawable remaining quote: ${escrow.getWithdrawableRemainingQuoteUiAmount(w)} (quote)`
    );
    console.log(`    Individual deposit cap:       ${escrow.getIndividualDepositUiCap()} (quote)`);
  }
}
