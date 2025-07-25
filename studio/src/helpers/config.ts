export const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    rpcUrl: {
      type: 'string',
    },
    dryRun: {
      type: 'boolean',
    },
    keypairFilePath: {
      type: 'string',
    },
    computeUnitPriceMicroLamports: {
      type: 'number',
    },
    createBaseToken: {
      type: 'object',
      nullable: true,
      properties: {
        mintBaseTokenAmount: {
          anyOf: [{ type: 'number' }, { type: 'string' }],
        },
        baseDecimals: {
          type: 'number',
        },
      },
      required: ['mintBaseTokenAmount', 'baseDecimals'],
      additionalProperties: false,
    },
    baseMint: {
      type: 'string',
      nullable: true,
    },
    quoteSymbol: {
      type: 'string',
      nullable: true,
    },
    quoteMint: {
      type: 'string',
      nullable: true,
    },
    dynamicAmm: {
      type: 'object',
      nullable: true,
      properties: {
        baseAmount: {
          anyOf: [{ type: 'number' }, { type: 'string' }],
        },
        quoteAmount: {
          anyOf: [{ type: 'number' }, { type: 'string' }],
        },
        tradeFeeNumerator: {
          type: 'number',
        },
        activationType: {
          enum: ['slot', 'timestamp'],
        },
        activationPoint: {
          type: 'number',
          nullable: true,
        },
        hasAlphaVault: {
          type: 'boolean',
        },
      },
      required: [
        'baseAmount',
        'quoteAmount',
        'tradeFeeNumerator',
        'activationType',
        'hasAlphaVault',
      ],
      additionalProperties: false,
    },
    dynamicAmmV2: {
      type: 'object',
      nullable: true,
      properties: {
        creator: {
          type: 'string',
          nullable: false,
        },
        baseAmount: {
          anyOf: [{ type: 'number' }, { type: 'string' }],
        },
        quoteAmount: {
          anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }],
        },
        initPrice: {
          anyOf: [{ type: 'number' }, { type: 'string' }],
        },
        maxPrice: {
          anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }],
        },
        poolFees: {
          maxBaseFeeBps: {
            type: 'number',
          },
          minBaseFeeBps: {
            type: 'number',
          },
          numberOfPeriod: {
            type: 'number',
          },
          totalDuration: {
            type: 'number',
          },
          feeSchedulerMode: {
            type: 'number',
            enum: [0, 1],
          },
          useDynamicFee: {
            type: 'boolean',
          },
          dynamicFeeConfig: {
            type: 'object',
            nullable: true,
            properties: {
              filterPeriod: {
                type: 'number',
              },
              decayPeriod: {
                type: 'number',
              },
              reductionFactor: {
                type: 'number',
              },
              variableFeeControl: {
                type: 'number',
              },
              maxVolatilityAccumulator: {
                type: 'number',
              },
            },
          },
        },
        collectFeeMode: {
          type: 'number',
          enum: [0, 1],
        },
        activationType: {
          type: 'string',
          enum: ['slot', 'timestamp'],
        },
        activationPoint: {
          type: 'number',
          nullable: true,
        },
        hasAlphaVault: {
          type: 'boolean',
        },
      },
      required: ['activationType', 'hasAlphaVault', 'collectFeeMode', 'poolFees'],
      additionalProperties: false,
    },
    dlmm: {
      type: 'object',
      nullable: true,
      properties: {
        binStep: {
          type: 'number',
        },
        feeBps: {
          type: 'number',
        },
        initialPrice: {
          type: 'number',
        },
        activationType: {
          enum: ['slot', 'timestamp'],
        },
        activationPoint: {
          type: 'number',
          nullable: true,
        },
        priceRounding: {
          enum: ['up', 'down'],
        },
        hasAlphaVault: {
          type: 'boolean',
        },
        creatorPoolOnOffControl: {
          type: 'boolean',
        },
      },
      required: [
        'binStep',
        'feeBps',
        'initialPrice',
        'activationType',
        'priceRounding',
        'hasAlphaVault',
      ],
      additionalProperties: false,
    },
    alphaVault: {
      type: 'object',
      nullable: true,
      properties: {
        poolType: {
          enum: ['dynamic', 'dlmm', 'damm2'],
        },
        alphaVaultType: {
          enum: ['fcfs', 'prorata'],
        },
        depositingPoint: { type: 'number' },
        startVestingPoint: { type: 'number' },
        endVestingPoint: { type: 'number' },
        maxDepositCap: { type: 'number', nullable: true },
        individualDepositingCap: { type: 'number', nullable: true },
        maxBuyingCap: { type: 'number', nullable: true },
        escrowFee: { type: 'number' },
        whitelistMode: {
          enum: ['permissionless', 'permissioned_with_merkle_proof', 'permissioned_with_authority'],
        },
        whitelistFilepath: { type: 'string', nullable: true },
        chunkSize: { type: 'number', nullable: true },
        kvProofFilepath: { type: 'string', nullable: true },
        merkleProofBaseUrl: { type: 'string' },
        cloudflareKvProofUpload: {
          type: 'object',
          nullable: true,
          properties: {
            kvNameSpaceId: { type: 'string' },
            accountId: { type: 'string' },
            apiKey: { type: 'string' },
          },
        },
      },
      required: [
        'poolType',
        'alphaVaultType',
        'depositingPoint',
        'startVestingPoint',
        'endVestingPoint',
        'escrowFee',
        'whitelistMode',
      ],
    },
    lockLiquidity: {
      type: 'object',
      nullable: true,
      properties: {
        alllocations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              percentage: {
                type: 'number',
              },
              address: {
                type: 'string',
              },
            },
            required: ['percentage', 'address'],
          },
        },
      },
      required: ['allocations'],
    },
    lfgSeedLiquidity: {
      type: 'object',
      nullable: true,
      properties: {
        minPrice: {
          type: 'number',
        },
        maxPrice: { type: 'number' },
        curvature: { type: 'number' },
        seedAmount: { type: 'string' },
        operatorKeypairFilepath: { type: 'string' },
        positionOwner: { type: 'string' },
        feeOwner: { type: 'string' },
        lockReleasePoint: { type: 'number' },
        seedTokenXToPositionOwner: { type: 'boolean' },
      },
      required: [
        'minPrice',
        'maxPrice',
        'curvature',
        'seedAmount',
        'operatorKeypairFilepath',
        'positionOwner',
        'feeOwner',
        'lockReleasePoint',
        'seedTokenXToPositionOwner',
      ],
    },
    singleBinSeedLiquidity: {
      type: 'object',
      nullable: true,
      properties: {
        price: { type: 'number' },
        priceRounding: { type: 'string' },
        seedAmount: { type: 'string' },
        operatorKeypairFilepath: { type: 'string' },
        positionOwner: { type: 'string' },
        feeOwner: { type: 'string' },
        lockReleasePoint: { type: 'number' },
        seedTokenXToPositionOwner: { type: 'boolean' },
      },
      required: [
        'price',
        'priceRounding',
        'seedAmount',
        'operatorKeypairFilepath',
        'positionOwner',
        'feeOwner',
        'lockReleasePoint',
        'seedTokenXToPositionOwner',
      ],
    },
    m3m3: {
      type: 'object',
      nullable: true,
      properties: {
        topListLength: {
          type: 'number',
        },
        unstakeLockDurationSecs: {
          type: 'number',
        },
        secondsToFullUnlock: {
          type: 'number',
        },
        startFeeDistributeTimestamp: {
          type: 'number',
        },
      },
      required: [
        'topListLength',
        'unstakeLockDurationSecs',
        'secondsToFullUnlock',
        'startFeeDistributeTimestamp',
      ],
    },
    setDlmmPoolStatus: {
      type: 'object',
      nullable: true,
      properties: {
        poolAddress: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['poolAddress', 'enabled'],
    },
  },
  required: ['rpcUrl', 'dryRun', 'keypairFilePath', 'computeUnitPriceMicroLamports'],
  additionalProperties: true,
};
