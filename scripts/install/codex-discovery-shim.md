---
name: autoprompt
description: 'Explicit-only Codex launcher for Autoprompt. Start with `autoprompt activate codex ... -- <mission>`; ordinary prompts, discovery, and `/autoprompt` never activate it.'
activation: explicit-only
allow-implicit-invocation: false
---

# Autoprompt launcher for Codex

Activation is explicit-only. This discovery file never starts Autoprompt, loads its
private roles, or continues a prior run by itself.

Start a new run with exactly:

```text
autoprompt activate codex ... -- <mission>
```

The launcher creates a private activation and supplies the internal `$autoprompt`
skill envelope. `/autoprompt` is unsupported and must return `INVALID_INPUT`.
