import { WalletDepositCap } from '@meteora-ag/alpha-vault';
import { BalanceTree } from './balance_tree';

export const createMerkleTree = async (
  whitelistedWallets: WalletDepositCap[]
): Promise<BalanceTree> => {
  const tree = new BalanceTree(
    whitelistedWallets.map((info) => {
      return {
        account: info.address,
        maxCap: info.maxAmount,
      };
    })
  );

  return tree;
};

export * from './balance_tree';
export * from './merkle_tree';
