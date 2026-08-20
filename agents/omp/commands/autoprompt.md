---
description: Start an Autoprompt run - explicit-only orchestration. Invoke only when the user names autoprompt.
---

Start an Autoprompt run. Arguments: $ARGUMENTS

Read the installed Autoprompt skill at skill://autoprompt and follow its doctrine exactly, starting at section 1 (Start contract). The mission is the text after any knobs (`mode=`, `max_subs=`, `agents=`).

Rules:
- Invocation with a mission authorizes that mission: do not ask the user to restate, narrow, or approve it.
- A bare invocation (no mission, no `resume`) performs only the section-10 frontier check, reports the result, and stops.
- Never start or resume a run from leftover artifacts unless the user explicitly typed `resume`.
- Dispatch every worker through the task tool binding the registered `ap-*` persona name as `agent`; never use an unnamed/general-purpose dispatch.