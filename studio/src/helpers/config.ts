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
        supply: {
          type: 'number',
        },
        decimals: {
          type: 'number',
        },
        tokenMintKeypairFilePath: {
          type: 'string',
        },
        name: {
          type: 'string',
        },
        symbol: {
          type: 'string',
        },
        metadata: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
            },
            image: {
              type: 'string',
            },
            description: {
              type: 'string',
            },
            website: {
              type: 'string',
            },
            twitter: {
              type: 'string',
            },
            telegram: {
              type: 'string',
            },
          },
          additionalProperties: false,
        },
        authorities: {
          type: 'object',
          properties: {
            mint: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
            freeze: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
            update: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
          },
          required: ['mint', 'freeze', 'update'],
          additionalProperties: false,
        },
        sellerFeeBasisPoints: {
          type: 'number',
        },
        creators: {
          anyOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                // Creator properties would need to be defined based on @metaplex-foundation/mpl-token-metadata
                additionalProperties: true,
              },
            },
            { type: 'null' },
          ],
        },
        collection: {
          anyOf: [
            {
              type: 'object',
              // Collection properties would need to be defined based on @metaplex-foundation/mpl-token-metadata
              additionalProperties: true,
            },
            { type: 'null' },
          ],
        },
        uses: {
          anyOf: [
            {
              type: 'object',
              // Uses properties would need to be defined based on @metaplex-foundation/mpl-token-metadata
              additionalProperties: true,
            },
            { type: 'null' },
          ],
        },
      },
      required: [
        'supply',
        'decimals',
        'name',
        'symbol',
        'metadata',
        'authorities',
        'sellerFeeBasisPoints',
        'creators',
        'collection',
        'uses',
      ],
      additionalProperties: false,
    },
    quoteSymbol: {
      type: 'string',
      nullable: true,
    },
    quoteMint: {
      type: 'string',
      nullable: true,
    },
    dammV1Config: {
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
          type: 'number',
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
    dammV1LockLiquidity: {
      type: 'object',
      nullable: true,
      properties: {
        allocations: {
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
            additionalProperties: false,
          },
        },
      },
      required: ['allocations'],
      additionalProperties: false,
    },
    stake2EarnFarm: {
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
      additionalProperties: false,
    },
    dammV2Config: {
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
          type: 'number',
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
    addLiquidity: {
      type: 'object',
      nullable: true,
      properties: {
        amountIn: {
          type: 'number',
        },
        isTokenA: {
          type: 'boolean',
        },
      },
      required: ['amountIn', 'isTokenA'],
      additionalProperties: false,
    },
    splitPosition: {
      type: 'object',
      nullable: true,
      properties: {
        newPositionOwner: {
          type: 'string',
        },
        unlockedLiquidityPercentage: {
          type: 'number',
        },
        permanentLockedLiquidityPercentage: {
          type: 'number',
        },
        feeAPercentage: {
          type: 'number',
        },
        feeBPercentage: {
          type: 'number',
        },
        reward0Percentage: {
          type: 'number',
        },
        reward1Percentage: {
          type: 'number',
        },
      },
      required: [
        'newPositionOwner',
        'unlockedLiquidityPercentage',
        'permanentLockedLiquidityPercentage',
        'feeAPercentage',
        'feeBPercentage',
        'reward0Percentage',
        'reward1Percentage',
      ],
      additionalProperties: false,
    },
    dlmmConfig: {
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
          type: 'number',
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
        'creatorPoolOnOffControl',
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
        allocations: {
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
        enabled: { type: 'boolean' },
      },
      required: ['enabled'],
    },
    dbcConfig: {
      type: 'object',
      nullable: true,
      properties: {
        buildCurveMode: {
          type: 'number',
          enum: [0, 1, 2, 3, 4, 5],
        },
        // Mode 0 (buildCurve) params
        percentageSupplyOnMigration: { type: 'number' },
        migrationQuoteThreshold: { type: 'number' },
        // Mode 1, 2, 3, 4 params
        initialMarketCap: { type: 'number' },
        migrationMarketCap: { type: 'number' },
        // Mode 3, 5 params
        liquidityWeights: {
          type: 'array',
          items: { type: 'number' },
        },
        // Mode 4 params
        midPrice: { type: 'number' },
        // Mode 5 params
        sqrtPrices: {
          type: 'array',
          items: { anyOf: [{ type: 'number' }, { type: 'string' }] },
        },
        // Token configuration
        token: {
          type: 'object',
          properties: {
            totalTokenSupply: { type: 'number' },
            tokenBaseDecimal: { type: 'number' },
            tokenQuoteDecimal: { type: 'number' },
            tokenType: { type: 'number', enum: [0, 1] },
            tokenUpdateAuthority: { type: 'number', enum: [0, 1, 2, 3, 4] },
            leftover: { type: 'number' },
          },
          required: [
            'totalTokenSupply',
            'tokenBaseDecimal',
            'tokenQuoteDecimal',
            'tokenType',
            'tokenUpdateAuthority',
            'leftover',
          ],
          additionalProperties: false,
        },
        // Fee configuration
        fee: {
          type: 'object',
          properties: {
            baseFeeParams: {
              type: 'object',
              properties: {
                baseFeeMode: { type: 'number', enum: [0, 1, 2] },
                feeSchedulerParam: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    startingFeeBps: { type: 'number' },
                    endingFeeBps: { type: 'number' },
                    numberOfPeriod: { type: 'number' },
                    totalDuration: { type: 'number' },
                  },
                  required: ['startingFeeBps', 'endingFeeBps', 'numberOfPeriod', 'totalDuration'],
                  additionalProperties: false,
                },
                rateLimiterParam: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    baseFeeBps: { type: 'number' },
                    feeIncrementBps: { type: 'number' },
                    referenceAmount: { type: 'number' },
                    maxLimiterDuration: { type: 'number' },
                  },
                  required: [
                    'baseFeeBps',
                    'feeIncrementBps',
                    'referenceAmount',
                    'maxLimiterDuration',
                  ],
                  additionalProperties: false,
                },
              },
              required: ['baseFeeMode'],
              additionalProperties: false,
            },
            dynamicFeeEnabled: { type: 'boolean' },
            collectFeeMode: { type: 'number', enum: [0, 1] },
            creatorTradingFeePercentage: { type: 'number' },
            poolCreationFee: { type: 'number' },
            enableFirstSwapWithMinFee: { type: 'boolean' },
          },
          required: [
            'baseFeeParams',
            'dynamicFeeEnabled',
            'collectFeeMode',
            'creatorTradingFeePercentage',
            'poolCreationFee',
          ],
          additionalProperties: false,
        },
        // Migration configuration
        migration: {
          type: 'object',
          properties: {
            migrationOption: { type: 'number', enum: [0, 1] },
            migrationFeeOption: { type: 'number', enum: [0, 1, 2, 3, 4, 5, 6] },
            migrationFee: {
              type: 'object',
              properties: {
                feePercentage: { type: 'number' },
                creatorFeePercentage: { type: 'number' },
              },
              required: ['feePercentage', 'creatorFeePercentage'],
              additionalProperties: false,
            },
            migratedPoolFee: {
              type: 'object',
              nullable: true,
              properties: {
                collectFeeMode: { type: 'number', enum: [0, 1] },
                dynamicFee: { type: 'number', enum: [0, 1] },
                poolFeeBps: { type: 'number' },
                baseFeeMode: { type: 'number', enum: [3, 4] },
                marketCapFeeSchedulerParams: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    endingBaseFeeBps: { type: 'number' },
                    numberOfPeriod: { type: 'number' },
                    sqrtPriceStepBps: { type: 'number' },
                    schedulerExpirationDuration: { type: 'number' },
                  },
                  required: [
                    'endingBaseFeeBps',
                    'numberOfPeriod',
                    'sqrtPriceStepBps',
                    'schedulerExpirationDuration',
                  ],
                  additionalProperties: false,
                },
              },
              required: ['collectFeeMode', 'dynamicFee', 'poolFeeBps'],
              additionalProperties: false,
            },
          },
          required: ['migrationOption', 'migrationFeeOption', 'migrationFee'],
          additionalProperties: false,
        },
        // Liquidity distribution configuration
        liquidityDistribution: {
          type: 'object',
          properties: {
            partnerLiquidityPercentage: { type: 'number' },
            creatorLiquidityPercentage: { type: 'number' },
            partnerPermanentLockedLiquidityPercentage: { type: 'number' },
            creatorPermanentLockedLiquidityPercentage: { type: 'number' },
            partnerLiquidityVestingInfoParams: {
              type: 'object',
              nullable: true,
              properties: {
                vestingPercentage: { type: 'number' },
                bpsPerPeriod: { type: 'number' },
                numberOfPeriods: { type: 'number' },
                cliffDurationFromMigrationTime: { type: 'number' },
                totalDuration: { type: 'number' },
              },
              required: [
                'vestingPercentage',
                'bpsPerPeriod',
                'numberOfPeriods',
                'cliffDurationFromMigrationTime',
                'totalDuration',
              ],
              additionalProperties: false,
            },
            creatorLiquidityVestingInfoParams: {
              type: 'object',
              nullable: true,
              properties: {
                vestingPercentage: { type: 'number' },
                bpsPerPeriod: { type: 'number' },
                numberOfPeriods: { type: 'number' },
                cliffDurationFromMigrationTime: { type: 'number' },
                totalDuration: { type: 'number' },
              },
              required: [
                'vestingPercentage',
                'bpsPerPeriod',
                'numberOfPeriods',
                'cliffDurationFromMigrationTime',
                'totalDuration',
              ],
              additionalProperties: false,
            },
          },
          required: [
            'partnerLiquidityPercentage',
            'creatorLiquidityPercentage',
            'partnerPermanentLockedLiquidityPercentage',
            'creatorPermanentLockedLiquidityPercentage',
          ],
          additionalProperties: false,
        },
        // Locked vesting configuration
        lockedVesting: {
          type: 'object',
          properties: {
            totalLockedVestingAmount: { type: 'number' },
            numberOfVestingPeriod: { type: 'number' },
            cliffUnlockAmount: { type: 'number' },
            totalVestingDuration: { type: 'number' },
            cliffDurationFromMigrationTime: { type: 'number' },
          },
          required: [
            'totalLockedVestingAmount',
            'numberOfVestingPeriod',
            'cliffUnlockAmount',
            'totalVestingDuration',
            'cliffDurationFromMigrationTime',
          ],
          additionalProperties: false,
        },
        activationType: { type: 'number', enum: [0, 1] },
        leftoverReceiver: { type: 'string' },
        feeClaimer: { type: 'string' },
      },
      required: [
        'buildCurveMode',
        'token',
        'fee',
        'migration',
        'liquidityDistribution',
        'lockedVesting',
        'activationType',
        'leftoverReceiver',
        'feeClaimer',
      ],
      additionalProperties: false,
    },
    dbcPool: {
      type: 'object',
      nullable: true,
      properties: {
        baseMintKeypairFilepath: { type: 'string' },
        creator: { type: 'string' },
        name: { type: 'string' },
        symbol: { type: 'string' },
        metadata: {
          type: 'object',
          properties: {
            uri: { type: 'string' },
            image: { type: 'string' },
            description: { type: 'string' },
            website: { type: 'string' },
            twitter: { type: 'string' },
            telegram: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      required: ['creator', 'name', 'symbol', 'metadata'],
      additionalProperties: false,
    },
    dbcSwap: {
      type: 'object',
      nullable: true,
      properties: {
        amountIn: { type: 'number' },
        slippageBps: { type: 'number' },
        swapBaseForQuote: { type: 'boolean' },
        referralTokenAccount: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
        },
      },
      required: ['amountIn', 'slippageBps', 'swapBaseForQuote'],
      additionalProperties: false,
    },
    dbcTransferPoolCreator: {
      type: 'object',
      nullable: true,
      properties: {
        newCreator: { type: 'string' },
      },
      required: ['newCreator'],
      additionalProperties: false,
    },
  },
  required: ['rpcUrl', 'dryRun', 'keypairFilePath', 'computeUnitPriceMicroLamports'],
  additionalProperties: true,
};
