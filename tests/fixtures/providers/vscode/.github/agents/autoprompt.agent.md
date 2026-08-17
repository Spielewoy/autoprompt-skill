---
name: "autoprompt"
description: "Run the Autoprompt workflow through its allowlisted coordinator."
tools: ["agent"]
agents: ["ap-feature-coordinator"]
user-invocable: true
disable-model-invocation: true
---
Run the Autoprompt workflow. Delegate feature work only to the allowlisted coordinator.
