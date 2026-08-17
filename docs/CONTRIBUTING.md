# Contributing to Autoprompt

Keep changes focused and show that they work.

## Before you start

- Read the [README](../README.md) and [support guide](SUPPORT.md).
- Search existing issues before opening a bug report, feature request, or benchmark request.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities through the [security policy](SECURITY.md), never publicly.

## Make the change

1. Start from current `main` on a short, descriptive branch.
2. Keep one logical change per pull request.
3. Update focused tests and documentation when behavior changes.
4. If `agents/contracts/` changes, regenerate provider views:

   ```console
   node scripts/generate-provider-contracts.cjs
   ```

5. Run:

   ```console
   node scripts/generate-provider-contracts.cjs --check
   node --test tests/source/*.test.cjs
   ```

Some checks need PowerShell, Bash, or Python 3. List any relevant check you could not run.

## Pull requests

Explain what changed, why, and how you tested it. Link related issues. Include before-and-after output or screenshots only when they make the change clearer.

Contributions are accepted under the [MIT License](../LICENSE).
