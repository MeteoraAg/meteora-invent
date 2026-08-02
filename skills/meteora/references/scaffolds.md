# Scaffolds — Building Launchpad UIs

meteora-invent ships production-ready frontend templates under `scaffolds/` for the BUILD
path when the user wants a **launchpad or token site**, not just on-chain actions.

## fun-launch (`scaffolds/fun-launch`)

Next.js (pages router) + Tailwind token launchpad on **DBC**: explore page, token pages
(TradingView chart, txs/holders tables), trading terminal, pool creation page.

```bash
git clone https://github.com/MeteoraAg/meteora-invent && cd meteora-invent
pnpm install
cd scaffolds/fun-launch
cp .env.example .env    # fill in, then:
pnpm dev
```

Required `.env`:

| Var | Purpose |
|---|---|
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID` / `R2_BUCKET` | Cloudflare R2 bucket for token image + metadata uploads |
| `RPC_URL` | Solana RPC endpoint |
| `POOL_CONFIG_KEY` | The DBC **config account** new pools launch on |

`POOL_CONFIG_KEY` comes from creating a DBC config first — ACT path `dbc-create-config`
(intake contract in `dbc.md`), or SDK `client.partner.createConfig`. The scaffold's
launch flow creates pools on that config; a launchpad operator is the **partner**
(fee claimer) for every token launched through it.

Working on the scaffold — layout (verified against `src/`):
- Pages: `index.tsx` (explore), `token/` (token detail: chart, txs, holders),
  `create-pool.tsx` (launch flow), `_app.tsx`; API routes: `api/upload.ts` (R2
  image/metadata upload), `api/send-transaction.ts`.
- Components: `Explore/`, `Token*` (Card/Chart/Header/Age), `AdvancedTradingView/`,
  `Terminal/` (trading UI), `CreatePoolButton.tsx`, `Table/`, plus `contexts/`, `hooks/`,
  `lib/`, `constants/`.
- Env vars actually read by the code: `RPC_URL`, `POOL_CONFIG_KEY` /
  `NEXT_PUBLIC_POOL_CONFIG_KEY`, and the `R2_*` credentials (upload route only).

Wallet handling in the UI uses standard Solana wallet-adapter patterns
(`wallets-and-txs.md` §Browser); on-chain logic goes through the DBC SDK (see `dbc.md` —
the same version fences apply to frontend code).

Transfer-hook launches are configured in the **studio config** (`dbcConfig.transferHookProgram`
+ `dbcPool.transferHookProgram`), not in the scaffold.

## Custom frontends

For custom apps skip the scaffold and use the SDK reference packs directly. Typical
launchpad building blocks:
- Launch: `client.partner.createConfigAndPoolWithFirstBuy` (two txs — bundle for snipe
  protection) or scaffold-style pool-on-existing-config.
- Trade UI: `swapQuote`/`swap` per `dbc.md`; after graduation, route to DAMM v2 (`damm-v2.md`).
- Progress bar: `client.state.getPoolQuoteTokenCurveProgress(pool)`.
- Discovery/charts: REST APIs (`data-and-apis.md`).
