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
| Migration action fails | `quoteReserve` below `migrationQuoteThreshold`, or `migrationOption` doesn't match the target action | Check progress: `getPoolQuoteTokenCurveProgress`; use `dbc-migrate-to-damm-v1` for option 0, `-v2` for option 1 |

## SDK / TypeScript (BUILD path)

| Symptom | Cause | Fix |
|---|---|---|
| Method doesn't exist / wrong signature at compile time | Using a pre-2026 or hallucinated API | Check the "Version fences" section of the protocol reference; verify against the SDK's `docs.md` or source |
| `TypeError: ... is not a constructor` importing DLMM | `DLMM` is the **default** export | `import DLMM from '@meteora-ag/dlmm'` |
| `SyntaxError: ... does not provide an export named 'BN'` (path inside `@meteora-ag/dlmm`) when running your own standalone script | `tsx` on recent Node mis-resolves the DLMM package as ESM | Run with `npx ts-node` (CommonJS pipeline), not `tsx` (the studio's bundled setup is unaffected) |
| BN / type identity errors across packages | Mixed Anchor versions (DAMM v1 = 0.29; others = 0.31) or duplicate `bn.js` | Isolate DAMM v1 in its own package; import `BN` from one place |
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
| Swap fails only on one pool | Pool disabled (`setPairStatus`), pre-activation, or rate limiter active | No — until state changes | Check pool state + activation point; DBC rate-limiter configs restrict early swap sizes |
| `Insufficient funds` / lamports | Wallet underfunded | No — fund first | Airdrop (devnet) or owner funds (mainnet), then retry |
| Simulation reports `AccountNotFound` right after a valid quote (or a swap action reports a 0-SOL wallet) | Fee payer has 0 SOL / doesn't exist on-chain | No — fund first | The printed quote is still valid; fund the signer, then re-run |
| Airdrop fails | Devnet faucet limits | **Yes** — later | Retry, or fund from another devnet wallet |

## Escalation

Still stuck: search the protocol reference's Deep links (SDK `docs.md`, docs.meteora.ag
page for the flow), read the actual SDK source for the method, or ask in Meteora's Discord
(https://discord.gg/meteora). Include: network, pool address, full program logs, SDK version.
