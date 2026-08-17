# How autonomous is Autoprompt?

Autoprompt can carry a well-defined coding goal through discovery, planning, implementation, tests, review, repair, and final verification. It keeps evidence and run state so a long task can be checked and resumed.

Its autonomy stays inside the goal and the permissions of the active coding host. It does not invent product decisions, publish or delete external resources without authority, bypass missing credentials, or pretend an unavailable check passed.

It pauses when your answer would materially change the result. It reports a blocker when the environment or required external state prevents safe progress. Otherwise, it continues until the required checks reach `DONE`.
