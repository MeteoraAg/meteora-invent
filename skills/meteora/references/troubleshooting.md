# Troubleshooting — Error → Cause → Fix

## Studio CLI (ACT path)

| Error | Cause | Fix |
|---|---|---|
| `Configuration validation failed` | JSONC syntax error, missing required field, or wrong nesting for the chosen action | Compare against `configs/<protocol>_config.jsonc`; check the action's "Key Config Fields" in `studio-actions.md` |
| `Insufficient SOL balance` | Wallet can't cover rent + fees | Devnet: `pnpm studio airdrop-sol --network devnet` (fixed 5 SOL/call); mainnet: owner funds wallet. Min-SOL table at the end of `studio-actions.md` |
| `RPC connection failed` / fetch errors | Bad `rpcUrl`, wrong network, rate-limited public RPC | Test the endpoint; match network to the mint addresses in play; use a paid RPC on mainnet |
| `Transaction simulation failed` | Read the program logs below the error — usually wrong network for the mint, missing/wrong account, or constraint violation | Fix per log line; verify every address on the explorer; confirm the mint exists on the selected network |
| Keypair file not found | `keypairFilePath` relative to `studio/`, file missing | Run `pnpm studio generate-keypair` or fix the path |
| `bigint: Failed to load bindings` on every studio command | pnpm skips optional native build scripts | Harmless warning — the pure-JS fallback is used; ignore it |
| Config account mismatch on `dbc-create-pool` | Pool config was created with a transfer hook but `dbcPool.transferHookProgram` unset (or vice versa) | Set the same hook program on both config and pool blocks |
| Migration action fails | `quoteReserve` below `migrationQuoteThreshold`, or `migrationOption` doesn't match the target action | Check progress: `getPoolQuoteTokenCurveProgress`; use `dbc-migrate-to-damm-v1` for option 0 (existing pools only; new configs must use option 1), `-v2` for option 1 |
| `Simulation of <step> failed: DLMM Pro error 60xx (<Name>)` on a `dlmm-pro-*` action | The DLMM Pro program rejected the transaction in simulation; nothing was sent | Fix per name: `InvalidActivationAccess` = the pool is not open yet for this wallet/action (or paused) · `ExceededSlippage` = price moved, re-run · `PositionIsNotEmpty` = locked, vesting or unclaimed balance left, so the position cannot close · `InvalidParameters` on a limit order = a bid above, or an ask at or below, the current price. Full list: https://docs.meteora.ag/developer-guides/dlmm-pro/program/errors.md |
| `dlmm-pro-create-pool` fails with `{"Custom":0}` and `already in use` in the logs | A pool for this pair already exists on that static config (or as the pair's launch pool) | Use the existing pool, or pick another `configIndex`; the pool address is logged before the simulation |
| `Account not found: <address>` from `dlmm-pro-create-pool` (`poolType: static`) | `configIndex` names a static config that does not exist on this cluster | Pick a published index (https://docs.meteora.ag/developer-guides/dlmm-pro/pool-fee-configs.md) |
| `The <step> transaction is N bytes, over the 1232 byte limit` | A DLMM Pro position or order touches too many tick arrays for one transaction | Lower `openPosition.maxRanges`, use fewer order ticks, or narrow the price range. Thrown before anything is sent |
| `amountX and amountY must fund non-zero liquidity` on `dlmm-pro-open-position` | The price range needs a token whose amount is 0 (a range around the current price needs both) | Fund both amounts, or move the range fully above the price (X only) or below it (Y only) |
| `Liquidity is zero` on `dlmm-pro-swap` | The pool has no liquidity in the swap direction (a new pool has none) | Fund a position with `dlmm-pro-open-position` first |
| `Wallet ... has N positions on this pool. Pass --position` | Several DLMM Pro positions on one pool | Re-run with `--position <NFT_MINT>` from the printed list |

## SDK / TypeScript (BUILD path)

| Symptom | Cause | Fix |
|---|---|---|
| Method doesn't exist / wrong signature at compile time | Using a pre-2026 or hallucinated API | Check the "Version fences" section of the protocol reference; verify against the SDK's `docs.md` or source |
| `TypeError: ... is not a constructor` importing DLMM | `DLMM` is the **default** export | `import DLMM from '@meteora-ag/dlmm'` |
| `SyntaxError: ... does not provide an export named 'BN'` (path inside `@meteora-ag/dlmm`) when running your own standalone script | `tsx` on recent Node mis-resolves the DLMM package as ESM | Run with `npx ts-node` (CommonJS pipeline), not `tsx` (the studio's bundled setup is unaffected) |
| BN / type identity errors across packages | Mixed Anchor versions (DLMM Pro = 0.32; Zap = `@anchor-lang/core` 1.x; vault and farming SDKs = 0.28; m3m3 = 0.29; others = 0.31) or duplicate `bn.js` | Never pass `Program` or `BN` objects across SDK boundaries; import `BN` from one place |
| `Module '"@meteora-ag/dlmm-pro-sdk"' has no exported member 'BaseFeeMode'` (or any enum/type) | `moduleResolution` is `Node16`/`NodeNext`, which cannot resolve the package's type re-exports | Set `"moduleResolution": "Bundler"` (with `"module": "ESNext"`) or `"Node"` |
| DLMM Pro transaction runs out of compute units | DLMM Pro builders add no compute budget instructions; many ranges or new tick arrays pass the 200,000 default | Simulate, then prepend `setComputeUnitLimit` (and a unit price) — see `dlmm-pro.md` §Gotchas |
| `Account data length does not align to PositionArray element size` | DLMM Pro position decoded with a `withReward` that does not match its pool's `LiquidityMining` extension | Derive `withReward` from the position's own pool; check `positionArray.pool` before decoding ranges |
| Deep import fails under `moduleResolution: node16/bundler` | DAMM v1 SDK has no `exports` map | Use `"moduleResolution": "node"` or a path alias |
| Quote looks wrong / stale | Cached state | DLMM `refetchStates()`, DAMM v1 `updateState()`, re-fetch pool state in DBC/CP-AMM before quoting |
| Token-2022 quote/transfer off by fee | Missing `{ mint, currentEpoch }` token info params | Pass `inputTokenInfo`/`outputTokenInfo` (CP-AMM) or use the SDK's transfer-fee helpers |
| `Signature verification failed` | Missing extra signer | DBC config keypair, DLMM position keypair, CP-AMM position NFT keypair, DBC `migrateToDammV2`'s two NFT keypairs must all sign |
| Only first transaction lands | Method returned `Transaction[]` | Send all, sequentially, fresh blockhash each |
| `No fee to claim` thrown | DLMM claim methods throw when nothing claimable | Wrap in try/catch; check `positionData.feeX/feeY` first |
| DLMM swap quote throws `INVALID_MAX_EXTRA_BIN_ARRAYS` | `maxExtraBinArrays` outside 0–3 | Clamp to ≤3 |

## On-chain / network

| Symptom | Cause | Retry? | Fix |
|---|---|---|---|
| `Blockhash not found` / expired | Slow send, congested network | **Yes** — rebuild first | Fresh blockhash; raise `computeUnitPriceMicroLamports`; paid RPC |
| Timeout waiting for confirmation | Congestion / low priority fee | **Yes** — after checking the sig didn't land (`getTransaction`) | Raise priority fee and resend; never blind-resend a possibly-landed tx |
| `Transaction too large` | Wide DLMM ranges or batched ops in one tx | No — restructure | Use chunked variants (`addLiquidityByStrategyChunkable`, `initializeMultiplePositionAndAddLiquidityByStrategy2`); split sends |
| Custom program error: slippage / min-out exceeded | Price moved past tolerance | **Yes** — re-quote first | Fresh quote, then retry; widen slippage only with owner consent |
| Custom program error: other `0x...` | Protocol constraint (pool disabled, activation not reached, limit-order side wrong, ≥10% LP-lock rule violated…) | No — fix the cause | Decode via the SDK's error map (`src/*/error*.ts` exports); check pool status/activation |
| Swap fails only on one pool | Pool disabled (`setPairStatus`), pre-activation, or rate limiter active | No — until state changes | Check pool state + activation point; existing DBC and DAMM v2 rate-limiter pools restrict early swap sizes (the mode is rejected for new configs and pools) |
| `Insufficient funds` / lamports | Wallet underfunded | No — fund first | Airdrop (devnet) or owner funds (mainnet), then retry |
| Simulation reports `AccountNotFound` right after a valid quote (or a swap action reports a 0-SOL wallet) | Fee payer has 0 SOL / doesn't exist on-chain | No — fund first | The printed quote is still valid; fund the signer, then re-run |
| Airdrop fails | Devnet faucet limits | **Yes** — later | Retry, or fund from another devnet wallet |

## Escalation

Still stuck: search the protocol reference's Deep links (SDK `docs.md`, docs.meteora.ag
page for the flow), read the actual SDK source for the method, or ask in Meteora's Discord
(https://discord.gg/meteora). Include: network, pool address, full program logs, SDK version.
