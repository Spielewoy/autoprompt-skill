# Does Autoprompt mean I literally do not have to prompt?

No. Autoprompt replaces step-by-step micromanagement, not the initial goal.

Give it the outcome you want, relevant constraints, and what success should look like. Include details the coding agent cannot discover from the repository, such as product choices, external credentials, or actions it is not allowed to take. A useful request can still be one sentence:

```text
/autoprompt fix the checkout race, keep the public API compatible, and add a regression test
```

Autoprompt then scopes the work, assigns implementation, runs checks, repairs failures, and verifies the result. It asks you when a missing choice would materially change the result or when an action needs your authority.
