import { Wallet } from '@coral-xyz/anchor';
import AlphaVault, {
  deriveMerkleProofMetadata,
  PoolType,
  WalletDepositCap,
} from '@meteora-ag/alpha-vault';
import {
  Cluster,
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import fs from 'fs/promises';
import { BalanceTree } from './merkle_tree';
import {
  ALPHA_VAULT_PROGRAM_IDS,
  DEFAULT_NODES_PER_TREE,
  DEFAULT_SEND_TX_MAX_RETRIES,
  MAX_INSTRUCTIONS_PER_STAKE_ESCROW_ACCOUNTS_CREATED,
} from '../../utils/constants';
import {
  AlphaVaultConfig,
  AlphaVaultTypeConfig,
  FcfsAlphaVaultConfig,
  KvMerkleProof,
  PoolTypeConfig,
  ProrataAlphaVaultConfig,
  WhitelistCsv,
  WhitelistModeConfig,
} from '../../utils/types';
import {
  getAmountInLamports,
  handleSendTxs,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
  deriveAlphaVault,
  deriveMerkleRootConfig,
  parseCsv,
  getQuoteDecimals,
} from '../../helpers';
import { getAlphaVaultWhitelistMode, getClusterFromProgramId } from './utils';
import { uploadProof } from './merkle_tree/metadata';

export async function createFcfsAlphaVault(
  connection: Connection,
  wallet: Wallet,
  poolType: PoolType,
  poolAddress: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  quoteDecimals: number,
  params: FcfsAlphaVaultConfig,
  dryRun: boolean,
  computeUnitPriceMicroLamports: number,
  opts?: {
    alphaVaultProgramId: PublicKey;
  }
): Promise<void> {
  const maxDepositingCap = getAmountInLamports(params.maxDepositCap, quoteDecimals);
  const individualDepositingCap = getAmountInLamports(
    params.individualDepositingCap,
    quoteDecimals
  );
  const escrowFee = getAmountInLamports(params.escrowFee, quoteDecimals);
  const whitelistMode = getAlphaVaultWhitelistMode(params.whitelistMode);

  console.log(`\n> Initializing FcfsAlphaVault...`);
  console.log(`- Using poolType: ${poolType}`);
  console.log(`- Using poolMint ${poolAddress}`);
  console.log(`- Using baseMint ${baseMint}`);
  console.log(`- Using quoteMint ${quoteMint}`);
  console.log(`- Using depositingPoint ${params.depositingPoint}`);
  console.log(`- Using startVestingPoint ${params.startVestingPoint}`);
  console.log(`- Using endVestingPoint ${params.endVestingPoint}`);
  console.log(`- Using maxDepositingCap ${params.maxDepositCap}. In lamports ${maxDepositingCap}`);
  console.log(
    `- Using individualDepositingCap ${params.individualDepositingCap}. In lamports ${individualDepositingCap}`
  );
  console.log(`- Using escrowFee ${params.escrowFee}. In lamports ${escrowFee}`);
  console.log(`- Using whitelistMode ${params.whitelistMode}. In value ${whitelistMode}`);

  const alphaVaultProgramId =
    opts?.alphaVaultProgramId.toBase58() ?? ALPHA_VAULT_PROGRAM_IDS['mainnet-beta'];
  const cluster = getClusterFromProgramId(new PublicKey(alphaVaultProgramId));

  const initAlphaVaultTx = (await AlphaVault.createCustomizableFcfsVault(
    connection,
    {
      quoteMint,
      baseMint,
      poolAddress,
      poolType,
      depositingPoint: new BN(params.depositingPoint),
      startVestingPoint: new BN(params.startVestingPoint),
      endVestingPoint: new BN(params.endVestingPoint),
      maxDepositingCap,
      individualDepositingCap,
      escrowFee,
      whitelistMode,
    },
    wallet.publicKey,
    {
      cluster: cluster as Cluster,
    }
  )) as Transaction;

  modifyComputeUnitPriceIx(initAlphaVaultTx, computeUnitPriceMicroLamports);

  if (dryRun) {
    console.log(`\n> Simulating init alpha vault tx...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [initAlphaVaultTx]);
  } else {
    console.log(`>> Sending init alpha vault transaction...`);
    const initAlphaVaulTxHash = await sendAndConfirmTransaction(
      connection,
      initAlphaVaultTx,
      [wallet.payer],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> Alpha vault initialized successfully with tx hash: ${initAlphaVaulTxHash}`);
  }
}

export async function createProrataAlphaVault(
  connection: Connection,
  wallet: Wallet,
  poolType: PoolType,
  poolAddress: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  quoteDecimals: number,
  params: ProrataAlphaVaultConfig,
  dryRun: boolean,
  computeUnitPriceMicroLamports: number,
  opts?: {
    alphaVaultProgramId: PublicKey;
  }
) {
  const maxBuyingCap = getAmountInLamports(params.maxBuyingCap, quoteDecimals);
  const escrowFee = getAmountInLamports(params.escrowFee, quoteDecimals);
  const whitelistMode = getAlphaVaultWhitelistMode(params.whitelistMode);

  console.log(`\n> Initializing ProrataAlphaVault...`);
  console.log(`- Using poolType: ${poolType}`);
  console.log(`- Using poolAddress ${poolAddress}`);
  console.log(`- Using baseMint ${baseMint}`);
  console.log(`- Using quoteMint ${quoteMint}`);
  console.log(`- Using depositingPoint ${params.depositingPoint}`);
  console.log(`- Using startVestingPoint ${params.startVestingPoint}`);
  console.log(`- Using endVestingPoint ${params.endVestingPoint}`);
  console.log(`- Using maxBuyingCap ${params.maxBuyingCap}. In lamports ${maxBuyingCap}`);
  console.log(`- Using escrowFee ${params.escrowFee}. In lamports ${escrowFee}`);
  console.log(`- Using whitelistMode ${params.whitelistMode}. In value ${whitelistMode}`);

  const alphaVaultProgramId =
    opts?.alphaVaultProgramId.toBase58() ?? ALPHA_VAULT_PROGRAM_IDS['mainnet-beta'];
  const cluster = getClusterFromProgramId(new PublicKey(alphaVaultProgramId));

  const initAlphaVaultTx = (await AlphaVault.createCustomizableProrataVault(
    connection,
    {
      quoteMint,
      baseMint,
      poolAddress,
      poolType,
      depositingPoint: new BN(params.depositingPoint),
      startVestingPoint: new BN(params.startVestingPoint),
      endVestingPoint: new BN(params.endVestingPoint),
      maxBuyingCap,
      escrowFee,
      whitelistMode,
    },
    wallet.publicKey,
    {
      cluster: cluster as Cluster,
    }
  )) as Transaction;

  modifyComputeUnitPriceIx(initAlphaVaultTx, computeUnitPriceMicroLamports);

  if (dryRun) {
    console.log(`\n> Simulating init alpha vault tx...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [initAlphaVaultTx]);
  } else {
    console.log(`>> Sending init alpha vault transaction...`);
    const initAlphaVaulTxHash = await sendAndConfirmTransaction(
      connection,
      initAlphaVaultTx,
      [wallet.payer],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> Alpha vault initialized successfully with tx hash: ${initAlphaVaulTxHash}`);
  }
}

export async function createPermissionedAlphaVaultWithMerkleProof(
  connection: Connection,
  wallet: Wallet,
  alphaVaultType: AlphaVaultTypeConfig,
  poolType: PoolType,
  poolAddress: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  quoteDecimals: number,
  params: FcfsAlphaVaultConfig | ProrataAlphaVaultConfig,
  whitelistList: WalletDepositCap[],
  dryRun: boolean,
  computeUnitPriceMicroLamports: number,
  opts?: {
    alphaVaultProgramId: PublicKey;
  }
): Promise<void> {
  if (params.whitelistMode != WhitelistModeConfig.PermissionedWithMerkleProof) {
    throw new Error(`Invalid whitelist mode ${params.whitelistMode}. Only Permissioned with merkle proof is allowed 
    `);
  }
  const alphaVaultProgramId = new PublicKey(
    opts?.alphaVaultProgramId ?? ALPHA_VAULT_PROGRAM_IDS['mainnet-beta']
  );

  let cluster = '';

  switch (alphaVaultProgramId.toBase58()) {
    case ALPHA_VAULT_PROGRAM_IDS['mainnet-beta']:
      cluster = 'mainnet-beta';
      break;
    case ALPHA_VAULT_PROGRAM_IDS['devnet']:
      cluster = 'devnet';
      break;
    case ALPHA_VAULT_PROGRAM_IDS['localhost']:
      cluster = 'localhost';
      break;
    default:
      throw new Error(`Invalid alpha vault program id ${alphaVaultProgramId}`);
  }

  const alphaVaultPubkey = deriveAlphaVault(wallet.publicKey, poolAddress, alphaVaultProgramId);

  const alphaVaultAccountInfo = await connection.getAccountInfo(
    alphaVaultPubkey,
    connection.commitment
  );
  if (!alphaVaultAccountInfo) {
    // 1. Create alpha vault
    if (alphaVaultType == AlphaVaultTypeConfig.Fcfs) {
      await createFcfsAlphaVault(
        connection,
        wallet,
        poolType,
        poolAddress,
        baseMint,
        quoteMint,
        quoteDecimals,
        params as FcfsAlphaVaultConfig,
        dryRun,
        computeUnitPriceMicroLamports,
        opts
      );
    } else if (alphaVaultType == AlphaVaultTypeConfig.Prorata) {
      await createProrataAlphaVault(
        connection,
        wallet,
        poolType,
        poolAddress,
        baseMint,
        quoteMint,
        quoteDecimals,
        params as ProrataAlphaVaultConfig,
        dryRun,
        computeUnitPriceMicroLamports,
        opts
      );
    }
  } else {
    console.log(`> Alpha vault already exists at ${alphaVaultPubkey}`);
  }

  // 2. Create merkle root config
  console.log('Creating merkle root configs...');

  const chunkSize = params.chunkSize ?? DEFAULT_NODES_PER_TREE;
  console.log(`- Using chunk size of ${chunkSize}`);

  const kvProofFolderPath = params.kvProofFilepath ?? `./${alphaVaultPubkey.toBase58()}`;

  console.log(`- Using kv proof filepath ${kvProofFolderPath}`);

  const alphaVault = await AlphaVault.create(connection, alphaVaultPubkey, {
    cluster: cluster as Cluster,
  });

  let chunkCount = Math.floor(whitelistList.length / chunkSize);
  if (whitelistList.length % chunkSize != 0) {
    chunkCount++;
  }

  console.log(`- Total number of tree ${chunkCount}`);

  for (let i = 0; i < chunkCount; i++) {
    console.log(`- Tree version ${i}`);
    const version = new BN(i);

    const merkleRootConfig = deriveMerkleRootConfig(alphaVaultPubkey, version, alphaVaultProgramId);

    const offset = i * chunkSize;
    const endOffset = Math.min(offset + chunkSize, whitelistList.length);
    const chunkedWhitelistList = whitelistList.slice(offset, endOffset);

    const tree = createMerkleTree(chunkedWhitelistList);
    const root = tree.getRoot();

    const kvProofs: KvMerkleProof = {};
    const kvProofFilePath = `${kvProofFolderPath}/${i}.json`;

    for (const wallet of chunkedWhitelistList) {
      const proof = tree.getProof(wallet.address, wallet.maxAmount);
      kvProofs[wallet.address.toBase58()] = {
        merkle_root_config: merkleRootConfig.toBase58(),
        max_cap: wallet.maxAmount.toNumber(),
        proof: proof.map((buffer) => {
          return Array.from(new Uint8Array(buffer));
        }),
      };
    }

    console.log(`- Writing kv proof to ${kvProofFilePath}`);
    await fs.mkdir(kvProofFolderPath, { recursive: true });
    await fs.writeFile(kvProofFilePath, JSON.stringify(kvProofs), {
      encoding: 'utf-8',
    });

    const merkleRootConfigAccount = await connection.getAccountInfo(merkleRootConfig);
    if (merkleRootConfigAccount != null) {
      console.log(
        '>>> Merkle root config is already existed. Skip creating new merkle root config.'
      );
      continue;
    }

    const tx = await alphaVault.createMerkleRootConfig(root, version, wallet.publicKey);

    const { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash();
    const initMerkleRootConfigTx = new Transaction({
      lastValidBlockHeight,
      blockhash,
    }).add(...tx.instructions);

    modifyComputeUnitPriceIx(initMerkleRootConfigTx, computeUnitPriceMicroLamports);

    if (dryRun) {
      console.log(`\n> Simulating init merkle root config tx...`);
      await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [
        initMerkleRootConfigTx,
      ]);
    } else {
      console.log(`>> Sending init merkle root config transaction...`);
      const initAlphaVaulTxHash = await sendAndConfirmTransaction(
        connection,
        initMerkleRootConfigTx,
        [wallet.payer],
        {
          commitment: connection.commitment,
          maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
        }
      ).catch((err) => {
        console.error(err);
        throw err;
      });
      console.log(
        `>>> Merkle root config version ${i + 1} successfully with tx hash: ${initAlphaVaulTxHash}`
      );
    }
  }
}

export async function createPermissionedAlphaVaultWithAuthority(
  connection: Connection,
  wallet: Wallet,
  alphaVaultType: AlphaVaultTypeConfig,
  poolType: PoolType,
  poolAddress: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  quoteDecimals: number,
  params: FcfsAlphaVaultConfig | ProrataAlphaVaultConfig,
  whitelistList: WalletDepositCap[],
  dryRun: boolean,
  computeUnitPriceMicroLamports: number,
  opts?: {
    alphaVaultProgramId: PublicKey;
  }
): Promise<void> {
  if (params.whitelistMode != WhitelistModeConfig.PermissionedWithAuthority) {
    throw new Error(`Invalid whitelist mode ${params.whitelistMode}. Only Permissioned with authority is allowed 
    `);
  }
  const alphaVaultProgramId = new PublicKey(
    opts?.alphaVaultProgramId ?? ALPHA_VAULT_PROGRAM_IDS['mainnet-beta']
  );

  let cluster = '';

  switch (alphaVaultProgramId.toBase58()) {
    case ALPHA_VAULT_PROGRAM_IDS['mainnet-beta']:
      cluster = 'mainnet-beta';
      break;
    case ALPHA_VAULT_PROGRAM_IDS['devnet']:
      cluster = 'devnet';
      break;
    case ALPHA_VAULT_PROGRAM_IDS['localhost']:
      cluster = 'localhost';
      break;
    default:
      throw new Error(`Invalid alpha vault program id ${alphaVaultProgramId}`);
  }

  const alphaVaultPubkey = deriveAlphaVault(wallet.publicKey, poolAddress, alphaVaultProgramId);

  const alphaVaultAccountInfo = await connection.getAccountInfo(
    alphaVaultPubkey,
    connection.commitment
  );
  if (!alphaVaultAccountInfo) {
    // 1. Create alpha vault
    if (alphaVaultType == AlphaVaultTypeConfig.Fcfs) {
      await createFcfsAlphaVault(
        connection,
        wallet,
        poolType,
        poolAddress,
        baseMint,
        quoteMint,
        quoteDecimals,
        params as FcfsAlphaVaultConfig,
        dryRun,
        computeUnitPriceMicroLamports,
        opts
      );
    } else if (alphaVaultType == AlphaVaultTypeConfig.Prorata) {
      await createProrataAlphaVault(
        connection,
        wallet,
        poolType,
        poolAddress,
        baseMint,
        quoteMint,
        quoteDecimals,
        params as ProrataAlphaVaultConfig,
        dryRun,
        computeUnitPriceMicroLamports,
        opts
      );
    }
  } else {
    console.log(`> Alpha vault already exists at ${alphaVaultPubkey}`);
  }

  // 2. Create StakeEscrow account for each whitelisted wallet
  console.log('Creating stake escrow accounts...');

  const alphaVault = await AlphaVault.create(connection, alphaVaultPubkey, {
    cluster: cluster as Cluster,
  });

  // Create StakeEscrow accounts for whitelist list
  const instructions = await alphaVault.createMultipleStakeEscrowByAuthorityInstructions(
    whitelistList,
    wallet.publicKey
  );

  await handleSendTxs(
    connection,
    instructions,
    MAX_INSTRUCTIONS_PER_STAKE_ESCROW_ACCOUNTS_CREATED,
    wallet.payer,
    computeUnitPriceMicroLamports,
    dryRun,
    'create stake escrow accounts'
  );
}

export function createMerkleTree(walletDepositCap: WalletDepositCap[]): BalanceTree {
  const tree = new BalanceTree(
    walletDepositCap.map((info) => {
      return {
        account: info.address,
        maxCap: info.maxAmount,
      };
    })
  );

  return tree;
}

export function toAlphaVaulSdkPoolType(poolType: PoolTypeConfig): PoolType {
  switch (poolType) {
    case PoolTypeConfig.Dlmm:
      return PoolType.DLMM;
    case PoolTypeConfig.DammV1:
      return PoolType.DAMM;
    case PoolTypeConfig.DammV2:
      return PoolType.DAMMV2;
    default:
      throw new Error(`Unsupported alpha vault pool type: ${poolType}`);
  }
}

export async function createMerkleProofMetadata(
  poolKey: PublicKey,
  wallet: Wallet,
  connection: Connection,
  config: AlphaVaultConfig
) {
  const alphaVaultProgramId = new PublicKey(ALPHA_VAULT_PROGRAM_IDS['mainnet-beta']);

  const alphaVaultPubkey = deriveAlphaVault(wallet.publicKey, poolKey, alphaVaultProgramId);

  const cluster = getClusterFromProgramId(alphaVaultProgramId);

  const alphaVault = await AlphaVault.create(connection, alphaVaultPubkey, {
    cluster: cluster as Cluster,
  });
  const [merkleProofMetadata] = deriveMerkleProofMetadata(alphaVaultPubkey, alphaVaultProgramId);

  const merkleProofMetadataAccount = await connection.getAccountInfo(merkleProofMetadata);

  if (!merkleProofMetadataAccount) {
    if (!config.alphaVault) {
      throw new Error('Alpha vault configuration is missing');
    }

    const createMerkleProofMetadataTx = await alphaVault.createMerkleProofMetadata(
      wallet.publicKey,
      config.alphaVault.merkleProofBaseUrl
    );

    if (config.dryRun) {
      console.log(`\n> Simulating init merkle proof metadata tx...`);
      await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [
        createMerkleProofMetadataTx,
      ]);
    } else {
      console.log(`>> Sending init merkle proof metadata transaction...`);
      const initAlphaVaulTxHash = await sendAndConfirmTransaction(
        connection,
        createMerkleProofMetadataTx,
        [wallet.payer],
        {
          commitment: connection.commitment,
          maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
        }
      ).catch((err) => {
        console.error(err);
        throw err;
      });
      console.log(
        `>>> Merkle proof metadata initialized successfully with tx hash: ${initAlphaVaulTxHash}`
      );
    }
  }

  if (config.alphaVault?.cloudflareKvProofUpload) {
    console.log(`\n> Uploading merkle proof to cloudflare...`);

    const { kvNamespaceId, apiKey, accountId } = config.alphaVault.cloudflareKvProofUpload;

    // Get from https://github.com/MeteoraAg/cloudflare-kv-merkle-proof/blob/main/scripts/upload_merkle_proof.ts
    const kvProofFilepath = config.alphaVault.kvProofFilepath ?? `./${alphaVaultPubkey.toBase58()}`;
    await uploadProof(
      kvProofFilepath,
      alphaVaultPubkey.toBase58(),
      kvNamespaceId,
      accountId,
      apiKey
    );
  }
}

export async function createAlphaVault(
  connection: Connection,
  wallet: Wallet,
  config: AlphaVaultConfig,
  poolAddress: PublicKey,
  baseMint: PublicKey
) {
  if (!config.alphaVault) {
    throw new Error('Alpha vault configuration is missing');
  }

  if (!config.quoteMint) {
    throw new Error('Quote mint configuration is missing');
  }

  const quoteDecimals = await getQuoteDecimals(connection, config.quoteMint);
  const poolType = toAlphaVaulSdkPoolType(config.alphaVault.poolType);

  if (config.alphaVault.whitelistMode == WhitelistModeConfig.PermissionedWithAuthority) {
    if (!config.alphaVault.whitelistFilepath) {
      throw new Error('Missing whitelist filepath in configuration');
    }

    const whitelistListCsv: Array<WhitelistCsv> = await parseCsv(
      config.alphaVault.whitelistFilepath
    );

    const whitelistList: Array<WalletDepositCap> = new Array(0);
    for (const item of whitelistListCsv) {
      whitelistList.push({
        address: new PublicKey(item.address),
        maxAmount: getAmountInLamports(item.maxAmount, quoteDecimals),
      });
    }

    await createPermissionedAlphaVaultWithAuthority(
      connection,
      wallet,
      config.alphaVault.alphaVaultType,
      poolType,
      poolAddress,
      baseMint,
      new PublicKey(config.quoteMint),
      quoteDecimals,
      config.alphaVault,
      whitelistList,
      config.dryRun,
      config.computeUnitPriceMicroLamports ?? 0
    );
  } else if (config.alphaVault.whitelistMode == WhitelistModeConfig.Permissionless) {
    if (config.alphaVault.alphaVaultType == AlphaVaultTypeConfig.Fcfs) {
      await createFcfsAlphaVault(
        connection,
        wallet,
        poolType,
        poolAddress,
        baseMint,
        new PublicKey(config.quoteMint),
        quoteDecimals,
        config.alphaVault as FcfsAlphaVaultConfig,
        config.dryRun,
        config.computeUnitPriceMicroLamports ?? 0
      );
    } else if (config.alphaVault.alphaVaultType == AlphaVaultTypeConfig.Prorata) {
      await createProrataAlphaVault(
        connection,
        wallet,
        poolType,
        poolAddress,
        baseMint,
        new PublicKey(config.quoteMint),
        quoteDecimals,
        config.alphaVault as ProrataAlphaVaultConfig,
        config.dryRun,
        config.computeUnitPriceMicroLamports ?? 0
      );
    } else {
      throw new Error(`Invalid alpha vault type ${config.alphaVault.alphaVaultType}`);
    }
  } else if (config.alphaVault.whitelistMode == WhitelistModeConfig.PermissionedWithMerkleProof) {
    if (!config.alphaVault.whitelistFilepath) {
      throw new Error('Missing whitelist filepath in configuration');
    }

    const whitelistListCsv: Array<WhitelistCsv> = await parseCsv(
      config.alphaVault.whitelistFilepath
    );

    const whitelistList: Array<WalletDepositCap> = new Array(0);
    for (const item of whitelistListCsv) {
      whitelistList.push({
        address: new PublicKey(item.address),
        maxAmount: getAmountInLamports(item.maxAmount, quoteDecimals),
      });
    }

    await createPermissionedAlphaVaultWithMerkleProof(
      connection,
      wallet,
      config.alphaVault.alphaVaultType,
      poolType,
      poolAddress,
      baseMint,
      new PublicKey(config.quoteMint),
      quoteDecimals,
      config.alphaVault,
      whitelistList,
      config.dryRun,
      config.computeUnitPriceMicroLamports ?? 0
    );

    if (config.alphaVault.cloudflareKvProofUpload) {
      await createMerkleProofMetadata(poolAddress, wallet, connection, config);
    }
  }
}
