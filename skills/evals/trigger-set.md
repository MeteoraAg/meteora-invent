# Trigger Evals — `meteora` skill

Prompt set for testing whether the skill loads when it should (and stays quiet when it
shouldn't), per the Agent Skills description-testing methodology (~20 prompts, 3 runs each,
trigger-rate ≥ 0.5 for should-trigger, ≤ 0.1 for should-not). Re-run whenever
`SKILL.md` frontmatter (name/description) changes.

## Should trigger

| # | Prompt |
|---|---|
| T1 | Launch a token on Meteora with a bonding curve |
| T2 | Ape my new memecoin onto a bonding curve on Solana and set it to graduate at 600 SOL market cap |
| T3 | Create a DLMM pool for my token and seed liquidity |
| T4 | Add liquidity to a DAMM v2 pool |
| T5 | Swap 1 SOL for TOKEN on this Meteora pool: <address> |
| T6 | Claim my LP fees on Meteora |
| T7 | Place a limit order to buy at 0.95 on a DLMM pair |
| T8 | Migrate my DBC pool to DAMM v2 |
| T9 | Build me a pump.fun-style launchpad using the Meteora stack |
| T10 | Write a TypeScript bot that rebalances my DLMM position around the active bin |
| T11 | Use meteora-invent to create an alpha vault for my launch |
| T12 | What's the graduation progress of my dynamic bonding curve token? |

## Should NOT trigger (near misses)

| # | Prompt |
|---|---|
| N1 | Swap tokens on Raydium |
| N2 | Create a liquidity pool on Orca Whirlpools |
| N3 | Launch a token on pump.fun |
| N4 | Write an Anchor program with a PDA escrow |
| N5 | What's my SOL wallet balance? |
| N6 | Stake SOL with Marinade |
| N7 | Build a Uniswap v3 LP dashboard |
| N8 | Explain how bonding curves work in general (no chain mentioned) — *borderline: acceptable either way* |
| N9 | Bridge USDC from Ethereum to Solana |
| N10 | Set up a Jupiter DCA order |

## How to run

For each prompt, start a fresh agent session with the skill installed and check whether the
runtime loads/invokes the `meteora` skill. Record trigger rate over 3 runs. Claude Code:
watch for the skill appearing in context; OpenClaw: `openclaw agent --message "<prompt>"`;
Hermes: `hermes chat --toolsets skills -q "<prompt>"`.
