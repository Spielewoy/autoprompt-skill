# What are the layers for?

Layers divide responsibility and control how far work can be delegated.

| Layer | Responsibility |
|---|---|
| L0 | Receives the goal and coordinates the complete run. |
| L1 | Owns scope, feature delivery, or the final sweep. |
| L2 | Optionally manages a slice with several related work lanes. |
| L3 | Researches, plans, implements, reviews, verifies, or sweeps one bounded task. |
| L4 | Makes fresh terminal judgments such as plan approval, sign-off, arbitration, and goal checking. |

The hierarchy keeps context focused and prevents an author from approving its own work. A layer is a responsibility boundary, not a quality rank or an extra set of agents running all the time. Codex v2 defines 13 launchable logical child roles, an L0 run owner, and a deterministic control plane; its 32 physical TOMLs keep canonical roles and migration aliases separately hashable. Only the roles required by the selected route and concurrency limit start. Other provider adapters retain their existing role packages until their later migration.

Frameworks are different: a [framework](../../agents/claude/frameworks/README.md) is the route those roles follow for one feature.
