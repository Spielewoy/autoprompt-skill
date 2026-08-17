# Shared contracts

This is the provider-neutral source of truth for Autoprompt.

- [`autoprompt.contract.json`](autoprompt.contract.json): inventories, tiers, capabilities, and provider deltas
- [`personas`](personas/): 25 complete L1 to L4 role prompts
- [`frameworks`](frameworks/): 18 complete task and gate workflows
- [`generic.md`](generic.md): portable runtime contract for other agents

Run `node scripts/generate-provider-contracts.cjs --check` from the repository root to prove that every provider package matches these files.
