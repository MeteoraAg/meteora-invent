# Reads: Data APIs vs SDK State Fetchers

Two ways to read Meteora state. Prefer **REST** for discovery/analytics (no deps, no RPC
cost); prefer **SDK fetchers** for exact on-chain state right before building a transaction.
For documentation (not chain state): every docs.meteora.ag page serves raw markdown
(`https://docs.meteora.ag/llms.txt` is the index), and `https://docs.meteora.ag/mcp` is a
live docs MCP server (search + read tools) — connect it when the runtime supports MCP.

## REST data APIs (verified 2026-08-01, docs.meteora.ag)

| Protocol | Base URL | Rate limit |
|---|---|---|
| DLMM | `https://dlmm.datapi.meteora.ag` | 30 RPS |
| DAMM v2 | `https://damm-v2.datapi.meteora.ag` | 10 RPS |
| DAMM v1 | `https://damm-api.meteora.ag` (devnet: `https://damm-api.devnet.meteora.ag`) | 10 RPS |

Key endpoints (see the per-protocol API reference under
`https://docs.meteora.ag/developer-guides/<protocol>/api-reference/overview.md` for full
schemas / Swagger):

**DLMM** (`dlmm.datapi.meteora.ag`) — params below verified live 2026-08-02:
- `GET /pools?page_size=<n>&sort_by=<field>:desc` — paginated pool list; sort fields include
  `tvl`, `volume_24h` (also `_30m/_1h/_2h/_4h/_12h`), `fee_pct`, `bin_step`, `pool_created_at`.
  Response: `{ total, pages, current_page, page_size, data: [{ address, name, token_x, token_y, ... }] }`
- `GET /pools/{address}` — pool detail · `GET /pools/{address}/ohlcv` — candles
- `GET /portfolio?user=<wallet>` and `GET /portfolio/open?user=<wallet>` — the wallet's
  positions (+ PnL); **the wallet param is `user`**
- `GET /positions/{address}/historical` — add/remove/claim events
- `GET /wallets/{wallet}/limit_orders/open/pools` — open limit orders
- `GET /stats/protocol_metrics`

**DAMM v2** (`damm-v2.datapi.meteora.ag`)
- `GET /pools`, `GET /pools/{address}`, `GET /pools/groups`, `GET /pools/{address}/ohlcv`,
  `GET /pools/{address}/volume/history`, `GET /stats/protocol_metrics`

**DAMM v1** (`damm-api.meteora.ag`)
- pool listing/search + metrics, pool configs, alpha vault data, fee configs, farms

```bash
# verified: most active DLMM pools right now — note the volume field is NESTED
# (.volume["24h"]), unlike the flat sort key volume_24h
curl -s "https://dlmm.datapi.meteora.ag/pools?page_size=10&sort_by=volume_24h:desc" \
  | jq -r '.data[] | [.address, .name, (.volume["24h"]|tostring)] | @tsv'
# verified: a wallet's open DLMM positions
curl -s "https://dlmm.datapi.meteora.ag/portfolio/open?user=<WALLET>" | jq '.'
```

Each base URL serves a Swagger UI with the full schemas — fetch it when a param is unknown
rather than guessing. Notes: REST data is indexed (may lag a few seconds); don't use it for
pre-trade exactness. No dedicated DBC REST API is published — use the DBC SDK `state`
service. There is also still no REST read for alpha vault state, but the SDK is now covered
by this skill and has an ACT-path verification call: `pnpm studio alpha-vault-get-status
--vault <VAULT>` (or `--poolAddress <POOL>`) — see `other-products.md` for the underlying
SDK surface.

## SDK state fetchers (exact, RPC-based)

| Need | Call |
|---|---|
| DBC pool by token | ACT: `pnpm studio dbc-get-status --baseMint <MINT>` · SDK: `client.state.getPoolByBaseMint(mint)` |
| DBC graduation progress | `client.state.getPoolQuoteTokenCurveProgress(pool)` (0–1) |
| DBC fees owed | `client.state.getPoolFeeBreakdown(pool)` |
| DAMM v2 pool / position | ACT: `pnpm studio damm-v2-get-positions --poolAddress <POOL>` · SDK: `cpAmm.fetchPoolState(pool)` / `getUserPositionByPool` / `getPositionsByUser` |
| DAMM v2 pools by mint | `cpAmm.fetchPoolStatesByTokenMint(mint)` |
| DLMM pool state | `DLMM.create(connection, pool)` → `getActiveBin()`, `getFeeInfo()`, `getDynamicFee()` |
| DLMM user positions | ACT: `pnpm studio dlmm-get-positions --poolAddress <POOL>` · SDK: `dlmm.getPositionsByUserAndLbPair(user)` · `DLMM.getAllLbPairPositionsByUser(connection, user)` (all pools — heavy) · `DLMM.getPositionsByUserAndTokenAddress(connection, user, mint)` |
| DLMM limit orders | `dlmm.getLimitOrderByUserAndLbPair(user)` · `DLMM.getLimitOrdersByUserAndTokenAddress(...)` |
| DAMM v1 pool | `AmmImpl.create(connection, pool)` → `updateState()` → `poolInfo` |
| DAMM v1 pools by token | `AmmImpl.searchPoolsByToken(connection, mint)` |
| DAMM v1 lock escrow / fees | `pool.getUserLockEscrow(owner)` |
| Alpha Vault state (vault + per-wallet escrow) | ACT: `pnpm studio alpha-vault-get-status --vault <VAULT>` (or `--poolAddress <POOL>`) · SDK: `AlphaVault.create(connection, vault)` → `.vault`, `.vaultState` · `interactionState(escrow)` |

Warning: `getLbPairs()`, `getAllPools()`, `getPools()` (all-accounts scans) are heavy
`getProgramAccounts` calls — use the REST APIs or by-mint filters for discovery instead.

## Token metadata / prices

- Token lists & prices: Jupiter APIs (e.g. `https://lite-api.jup.ag/price/v3?ids=<MINT>`) or the owner's preferred source.
- Charts/analytics: DexScreener `https://dexscreener.com/solana/<pool>`; Meteora app `https://app.meteora.ag`.
