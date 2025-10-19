import { Creator, Collection, Uses } from '@metaplex-foundation/mpl-token-metadata';
import { ILockedVestingArgs, IPresaleArgs, IPresaleRegistryArgs } from '@meteora-ag/presale';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

export interface CliArguments {
  config?: string | undefined;
  network?: string | undefined;
  baseMint?: string | undefined;
  poolAddress?: string | undefined;
  airdrop?: boolean | undefined;
  help?: boolean | undefined;
}

export interface CommandOption {
  flag: string;
  description: string;
  required: boolean;
  type: 'string' | 'boolean';
  example?: string;
}

/* COMMON */

export type MeteoraConfig = DammV1Config | DammV2Config | DlmmConfig | DbcConfig | AlphaVaultConfig;

export interface CreateTokenMintOptions {
  dryRun: boolean;
  computeUnitPriceMicroLamports: number;
  tokenConfig?: TokenConfig;
}

export interface TokenConfig {
  supply: number;
  decimals: number;
  tokenMintKeypairFilePath?: string;
  name: string;
  symbol: string;
  metadata: TokenMetadata;
  authorities: {
    mint: string | null;
    freeze: string | null;
    update: string | null;
  };
  sellerFeeBasisPoints: number;
  creators: Creator[] | null;
  collection: Collection | null;
  uses: Uses | null;
}

export interface TokenMetadata {
  uri?: string;
  image?: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export type MeteoraConfigBase = {
  rpcUrl: string;
  dryRun: boolean;
  keypairFilePath: string;
  computeUnitPriceMicroLamports?: number;
  quoteMint?: string | null;
};

export type AllocationByAmount = {
  address: PublicKey;
  amount: BN;
  percentage: number;
};

export interface NetworkConfig {
  rpcUrl: string;
  airdropAmount: number;
}

/* DAMM v1 */

export type DammV1Config = MeteoraConfigBase & {
  createBaseToken: TokenConfig | null;
  dammV1Config: DynamicAmmV1Config | null;
  dammV1LockLiquidity: LockLiquidityConfig | null;
  stake2EarnFarm: Stake2EarnFarmConfig | null;
  alphaVault: FcfsAlphaVaultConfig | ProrataAlphaVaultConfig | null;
};

export interface DynamicAmmV1Config {
  baseAmount: number | string;
  quoteAmount: number | string;
  tradeFeeNumerator: number;
  activationType: number;
  activationPoint: number | null;
  hasAlphaVault: boolean;
}

export interface LockLiquidityConfig {
  allocations: LockLiquidityAllocation[];
}

export interface LockLiquidityAllocation {
  percentage: number;
  address: string;
}

export interface Stake2EarnFarmConfig {
  topListLength: number;
  unstakeLockDurationSecs: number;
  secondsToFullUnlock: number;
  startFeeDistributeTimestamp: number;
}

/* DAMM v2 */

export type DammV2Config = MeteoraConfigBase & {
  createBaseToken: TokenConfig | null;
  dammV2Config: DynamicAmmV2Config | null;
  addLiquidity: AddLiquidityConfig | null;
  splitPosition: SplitPositionConfig | null;
  alphaVault: FcfsAlphaVaultConfig | ProrataAlphaVaultConfig | null;
};

export interface DynamicAmmV2Config {
  creator: string;
  baseAmount: number | string;
  quoteAmount: number | string | null;
  initPrice: number | string;
  maxPrice: number | string | null;
  poolFees: {
    maxBaseFeeBps: number;
    minBaseFeeBps: number;
    numberOfPeriod: number;
    totalDuration: number;
    feeSchedulerMode: number;
    useDynamicFee: boolean;
    dynamicFeeConfig: DynamicFee | null;
  };
  collectFeeMode: number;
  activationType: number;
  activationPoint: number | null;
  hasAlphaVault: boolean;
}

export interface DynamicFee {
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: number;
  maxVolatilityAccumulator: number;
}

export interface SplitPositionConfig {
  newPositionOwner: string;
  unlockedLiquidityPercentage: number;
  permanentLockedLiquidityPercentage: number;
  feeAPercentage: number;
  feeBPercentage: number;
  reward0Percentage: number;
  reward1Percentage: number;
}

export interface AddLiquidityConfig {
  amountIn: number;
  isTokenA: boolean;
}

/* DLMM */

export type DlmmConfig = MeteoraConfigBase & {
  createBaseToken: TokenConfig | null;
  dlmmConfig: DynamicLmmConfig | null;
  alphaVault: FcfsAlphaVaultConfig | ProrataAlphaVaultConfig | null;
  lfgSeedLiquidity: LfgSeedLiquidityConfig | null;
  singleBinSeedLiquidity: SingleBinSeedLiquidityConfig | null;
  setDlmmPoolStatus: SetDlmmPoolStatusConfig | null;
};

export interface DynamicLmmConfig {
  binStep: number;
  feeBps: number;
  initialPrice: number;
  activationType: number;
  activationPoint: number | null;
  priceRounding: PriceRoundingConfig;
  hasAlphaVault: boolean;
  // Allow creator to turn on/off the pool
  creatorPoolOnOffControl: boolean;
}

export interface LfgSeedLiquidityConfig {
  minPrice: number;
  maxPrice: number;
  curvature: number;
  seedAmount: string;
  operatorKeypairFilepath: string;
  positionOwner: string;
  feeOwner: string;
  lockReleasePoint: number;
  seedTokenXToPositionOwner: boolean;
}

export interface SingleBinSeedLiquidityConfig {
  price: number;
  priceRounding: string;
  seedAmount: string;
  operatorKeypairFilepath: string;
  positionOwner: string;
  feeOwner: string;
  lockReleasePoint: number;
  seedTokenXToPositionOwner: boolean;
}

export interface SetDlmmPoolStatusConfig {
  enabled: boolean;
}

export enum PriceRoundingConfig {
  Up = 'up',
  Down = 'down',
}

/* DBC */

export type DbcConfig = MeteoraConfigBase & {
  dbcConfig?:
    | (BuildCurve & { buildCurveMode: 0 })
    | (BuildCurveWithMarketCap & { buildCurveMode: 1 })
    | (BuildCurveWithTwoSegments & { buildCurveMode: 2 })
    | (BuildCurveWithLiquidityWeights & { buildCurveMode: 3 })
    | null;
  dbcPool?: DbcPool | null;
  dbcSwap?: DbcSwap | null;
  dbcTransferPoolCreator?: DbcTransferPoolCreator | null;
};

export type BaseFee =
  | {
      baseFeeMode: 0 | 1;
      feeSchedulerParam: FeeSchedulerParams;
    }
  | {
      baseFeeMode: 2;
      rateLimiterParam: RateLimiterParams;
    };

export type FeeSchedulerParams = {
  startingFeeBps: number;
  endingFeeBps: number;
  numberOfPeriod: number;
  totalDuration: number;
};

export type RateLimiterParams = {
  baseFeeBps: number;
  feeIncrementBps: number;
  referenceAmount: number;
  maxLimiterDuration: number;
};

export type LockedVesting = {
  totalLockedVestingAmount: number;
  numberOfVestingPeriod: number;
  cliffUnlockAmount: number;
  totalVestingDuration: number;
  cliffDurationFromMigrationTime: number;
};

export type BuildCurveBase = {
  totalTokenSupply: number;
  migrationOption: number;
  tokenBaseDecimal: number;
  tokenQuoteDecimal: number;
  lockedVestingParam: LockedVesting;
  baseFeeParams: BaseFee;
  dynamicFeeEnabled: boolean;
  activationType: number;
  collectFeeMode: number;
  migrationFeeOption: number;
  tokenType: number;
  partnerLpPercentage: number;
  creatorLpPercentage: number;
  partnerLockedLpPercentage: number;
  creatorLockedLpPercentage: number;
  creatorTradingFeePercentage: number;
  leftover: number;
  tokenUpdateAuthority: number;
  migrationFee: {
    feePercentage: number;
    creatorFeePercentage: number;
  };
  leftoverReceiver: string;
  feeClaimer: string;
};

export type BuildCurve = BuildCurveBase & {
  percentageSupplyOnMigration: number;
  migrationQuoteThreshold: number;
};

export type BuildCurveWithMarketCap = BuildCurveBase & {
  initialMarketCap: number;
  migrationMarketCap: number;
};

export type BuildCurveWithTwoSegments = BuildCurveBase & {
  initialMarketCap: number;
  migrationMarketCap: number;
  percentageSupplyOnMigration: number;
};

export type BuildCurveWithLiquidityWeights = BuildCurveBase & {
  initialMarketCap: number;
  migrationMarketCap: number;
  liquidityWeights: number[];
};

export type DbcPool = {
  baseMintKeypairFilepath?: string;
  creator: string;
  name: string;
  symbol: string;
  metadata: TokenMetadata;
};

export type DbcSwap = {
  amountIn: number;
  slippageBps: number;
  swapBaseForQuote: boolean;
  referralTokenAccount?: string | null;
};

export type DbcTransferPoolCreator = {
  newCreator: string;
};

/* Alpha Vault */

export type AlphaVaultConfig = MeteoraConfigBase & {
  createBaseToken: TokenConfig | null;
  alphaVault: FcfsAlphaVaultConfig | ProrataAlphaVaultConfig | null;
};

export interface FcfsAlphaVaultConfig {
  poolType: PoolTypeConfig;
  alphaVaultType: AlphaVaultTypeConfig;
  // absolute value, depend on the pool activation type it will be the timestamp in secs or the slot number
  depositingPoint: number;
  // absolute value
  startVestingPoint: number;
  // absolute value
  endVestingPoint: number;
  // total max deposit
  maxDepositCap: number;
  // user max deposit
  individualDepositingCap: number;
  // fee to create stake escrow account
  escrowFee: number;
  // whitelist mode: permissionless / permission_with_merkle_proof / permission_with_authority
  whitelistMode: WhitelistModeConfig;
  merkleProofBaseUrl: string;
  whitelistFilepath?: string;
  chunkSize?: number;
  kvProofFilepath?: string;
  cloudflareKvProofUpload?: CloudflareKvProofUploadConfig;
}

export interface ProrataAlphaVaultConfig {
  poolType: PoolTypeConfig;
  alphaVaultType: AlphaVaultTypeConfig;
  // absolute value, depend on the pool activation type it will be the timestamp in secs or the slot number
  depositingPoint: number;
  // absolute value
  startVestingPoint: number;
  // absolute value
  endVestingPoint: number;
  // total max deposit
  maxBuyingCap: number;
  // fee to create stake escrow account
  escrowFee: number;
  // whitelist mode: permissionless / permission_with_merkle_proof / permission_with_authority
  whitelistMode: WhitelistModeConfig;
  merkleProofBaseUrl: string;
  whitelistFilepath?: string;
  chunkSize?: number;
  kvProofFilepath?: string;
  cloudflareKvProofUpload?: CloudflareKvProofUploadConfig;
}

export enum AlphaVaultTypeConfig {
  Fcfs = 'fcfs',
  Prorata = 'prorata',
}

export enum PoolTypeConfig {
  Dlmm = 'dlmm',
  DammV1 = 'dynamic',
  DammV2 = 'damm2',
}

export enum WhitelistModeConfig {
  Permissionless = 'permissionless',
  PermissionedWithMerkleProof = 'permissioned_with_merkle_proof',
  PermissionedWithAuthority = 'permissioned_with_authority',
}

export interface CloudflareKvProofUploadConfig {
  kvNamespaceId: string;
  accountId: string;
  apiKey: string;
}

export interface WhitelistCsv {
  address: string;
  maxAmount: string;
}

export interface ProofRecord {
  [key: string]: {
    merkle_tree: string;
    amount: number;
    proof: Array<number[]>;
  };
}

export interface BodyItem {
  base64: boolean;
  key: string;
  value: string;
}

export interface KvMerkleProof {
  [key: string]: {
    merkle_root_config: string;
    max_cap: number;
    proof: number[][];
  };
}

/* Stake2Earn */

export type Stake2EarnConfig = MeteoraConfigBase & {
  createBaseToken: TokenConfig | null;
  dammV1LockLiquidity: LockLiquidityConfig | null;
  alphaVault: FcfsAlphaVaultConfig | ProrataAlphaVaultConfig | null;
};

/* Presale */

export type PresaleConfig = MeteoraConfigBase & {
  createBaseToken: TokenConfig | null;
  presaleVault: FcfsPresaleVaultConfig | null;
  presaleVaultType: PresaleVaultTypeConfig;
};

export enum PresaleVaultTypeConfig {
  Fcfs = 'fcfs',
  Prorata = 'prorata',
  FixedPrice = 'fixed_price',
  PermissionedFixedPriceWithAuthority = 'permissioned_fixed_price_with_authority',
  PermissionedFixedPriceWithMerkleProof = 'permissioned_fixed_price_with_merkle_proof',
}

export interface FcfsPresaleVaultConfig {
  presaleArgs: IPresaleArgs;
  presaleRegistries: IPresaleRegistryArgs[];
  lockedVestingArgs?: ILockedVestingArgs;
}
