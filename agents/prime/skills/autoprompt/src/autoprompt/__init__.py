"""Native, fail-closed Autoprompt dispatcher for Prime Agent 0.7.2."""

from __future__ import annotations

import re
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any


MAX_DEPTH = 4
_INSTANCE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
_NONCE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")
_PACKAGE_ROOT = Path(__file__).resolve().parents[4]
_PERSONA_DATA = {
  "ap-arbiter": [],
  "ap-depth-prober": [],
  "ap-execharness-resolver": [],
  "ap-feature-coordinator": [
    "ap-arbiter",
    "ap-depth-prober",
    "ap-execharness-resolver",
    "ap-framework-generator",
    "ap-framework-validator",
    "ap-fresh-verifier",
    "ap-goal-checker",
    "ap-implementer",
    "ap-intake",
    "ap-janitor",
    "ap-juror",
    "ap-manager",
    "ap-planner",
    "ap-preflight-probe",
    "ap-re-anchor",
    "ap-researcher",
    "ap-reviewer",
    "ap-scoper",
    "ap-scribe",
    "ap-sweeper",
    "ap-synthesizer",
    "ap-verifier"
  ],
  "ap-framework-generator": [],
  "ap-framework-validator": [],
  "ap-fresh-verifier": [],
  "ap-goal-checker": [],
  "ap-implementer": [
    "ap-arbiter",
    "ap-depth-prober",
    "ap-framework-validator",
    "ap-fresh-verifier",
    "ap-goal-checker",
    "ap-janitor",
    "ap-juror",
    "ap-preflight-probe",
    "ap-re-anchor",
    "ap-scribe"
  ],
  "ap-intake": [
    "ap-arbiter",
    "ap-depth-prober",
    "ap-framework-validator",
    "ap-fresh-verifier",
    "ap-goal-checker",
    "ap-janitor",
    "ap-juror",
    "ap-preflight-probe",
    "ap-re-anchor",
    "ap-scribe"
  ],
  "ap-janitor": [],
  "ap-juror": [],
  "ap-manager": [
    "ap-arbiter",
    "ap-depth-prober",
    "ap-execharness-resolver",
    "ap-framework-generator",
    "ap-framework-validator",
    "ap-fresh-verifier",
    "ap-goal-checker",
    "ap-implementer",
    "ap-intake",
    "ap-janitor",
    "ap-juror",
    "ap-planner",
    "ap-preflight-probe",
    "ap-re-anchor",
    "ap-researcher",
    "ap-reviewer",
    "ap-scoper",
    "ap-scribe",
    "ap-sweeper",
    "ap-synthesizer",
    "ap-verifier"
  ],
  "ap-planner": [],
  "ap-preflight-probe": [
    "ap-preflight-probe"
  ],
  "ap-re-anchor": [],
  "ap-researcher": [],
  "ap-reviewer": [],
  "ap-scope-coordinator": [
    "ap-arbiter",
    "ap-depth-prober",
    "ap-execharness-resolver",
    "ap-framework-generator",
    "ap-framework-validator",
    "ap-fresh-verifier",
    "ap-goal-checker",
    "ap-implementer",
    "ap-intake",
    "ap-janitor",
    "ap-juror",
    "ap-manager",
    "ap-planner",
    "ap-preflight-probe",
    "ap-re-anchor",
    "ap-researcher",
    "ap-reviewer",
    "ap-scoper",
    "ap-scribe",
    "ap-sweeper",
    "ap-synthesizer",
    "ap-verifier"
  ],
  "ap-scoper": [],
  "ap-scribe": [],
  "ap-sweep-coordinator": [
    "ap-arbiter",
    "ap-depth-prober",
    "ap-execharness-resolver",
    "ap-framework-generator",
    "ap-framework-validator",
    "ap-fresh-verifier",
    "ap-goal-checker",
    "ap-implementer",
    "ap-intake",
    "ap-janitor",
    "ap-juror",
    "ap-manager",
    "ap-planner",
    "ap-preflight-probe",
    "ap-re-anchor",
    "ap-researcher",
    "ap-reviewer",
    "ap-scoper",
    "ap-scribe",
    "ap-sweeper",
    "ap-synthesizer",
    "ap-verifier"
  ],
  "ap-sweeper": [],
  "ap-synthesizer": [],
  "ap-verifier": []
}
_FRAMEWORK_DATA = {
  "apply": "prompts/frameworks/apply.md",
  "backend-build": "prompts/frameworks/backend-build.md",
  "backend-fix": "prompts/frameworks/backend-fix.md",
  "backend-implement": "prompts/frameworks/backend-implement.md",
  "composition": "prompts/frameworks/composition.md",
  "docs": "prompts/frameworks/docs.md",
  "frontend-build": "prompts/frameworks/frontend-build.md",
  "frontend-fix": "prompts/frameworks/frontend-fix.md",
  "frontend-implement": "prompts/frameworks/frontend-implement.md",
  "frontend-review": "prompts/frameworks/frontend-review.md",
  "generation": "prompts/frameworks/generation.md",
  "plan-design": "prompts/frameworks/plan-design.md",
  "plan-research": "prompts/frameworks/plan-research.md",
  "plan-scope": "prompts/frameworks/plan-scope.md",
  "polish": "prompts/frameworks/polish.md",
  "QUICKSTART": "prompts/frameworks/QUICKSTART.md",
  "README": "prompts/frameworks/README.md",
  "refactor": "prompts/frameworks/refactor.md"
}
PERSONAS = MappingProxyType({key: tuple(value) for key, value in _PERSONA_DATA.items()})
FRAMEWORKS = MappingProxyType(dict(_FRAMEWORK_DATA))
ROOT_ALLOWED_CHILDREN = tuple([
  "ap-scope-coordinator",
  "ap-feature-coordinator",
  "ap-sweep-coordinator",
  "ap-preflight-probe",
  "ap-intake"
])


class DispatchError(RuntimeError):
    """Base error for a rejected Autoprompt dispatch."""


class DispatchDenied(DispatchError):
    """The daemon-derived caller is not allowed to create the requested child."""


class UnknownPersona(DispatchError):
    """The requested persona is outside the sealed canonical registry."""


class UnknownFramework(DispatchError):
    """The requested framework is outside the sealed canonical registry."""


@dataclass(frozen=True, slots=True)
class RunBinding:
    """Verified binding to one exact Autoprompt prompt ledger."""

    path: str
    sha256: str
    bytes: int
    nonce: str


def bind(mission_path: str | Path, *, nonce: str) -> RunBinding:
    """Bind a run nonce to the exact current bytes of its prompt ledger."""
    if not isinstance(nonce, str) or not _NONCE_PATTERN.fullmatch(nonce):
        raise ValueError("nonce must be 8-128 safe characters")
    try:
        target = Path(mission_path).expanduser().resolve(strict=True)
        payload = target.read_bytes()
        payload.decode("utf-8")
    except (OSError, UnicodeError, TypeError) as error:
        raise DispatchDenied("mission binding path must be a readable UTF-8 file") from error
    if not payload:
        raise DispatchDenied("mission binding file must not be empty")
    return RunBinding(
        path=str(target),
        sha256=hashlib.sha256(payload).hexdigest(),
        bytes=len(payload),
        nonce=nonce,
    )


def _validated_binding(binding: Any) -> RunBinding:
    if not isinstance(binding, RunBinding):
        raise DispatchDenied("mission binding must come from autoprompt.bind()")
    if not _NONCE_PATTERN.fullmatch(binding.nonce):
        raise DispatchDenied("mission binding contains an invalid nonce")
    try:
        target = Path(binding.path)
        resolved = target.resolve(strict=True)
        if not target.is_absolute() or resolved != target:
            raise DispatchDenied("mission binding path is not canonical")
        payload = resolved.read_bytes()
        payload.decode("utf-8")
    except DispatchDenied:
        raise
    except (OSError, UnicodeError, TypeError) as error:
        raise DispatchDenied("mission binding path must remain a readable UTF-8 file") from error
    digest = hashlib.sha256(payload).hexdigest()
    if not payload or len(payload) != binding.bytes or digest != binding.sha256:
        raise DispatchDenied("mission binding no longer matches the exact prompt ledger")
    return binding


def _canonical_role(session_name: Any) -> str:
    if not isinstance(session_name, str):
        raise DispatchDenied("daemon identity has no valid session name")
    if session_name in PERSONAS:
        return session_name
    for persona in PERSONAS:
        prefix = f"{persona}--"
        if session_name.startswith(prefix) and _INSTANCE_PATTERN.fullmatch(session_name[len(prefix):]):
            return persona
    raise DispatchDenied(f"daemon identity is not an allowlisted Autoprompt persona: {session_name!r}")


def _validated_identity(roster: Any) -> tuple[str | None, int]:
    if not isinstance(roster, dict):
        raise DispatchDenied("daemon roster is unavailable or malformed")
    current = roster.get("current")
    entries = roster.get("entries")
    if not isinstance(current, dict) or not isinstance(entries, list):
        raise DispatchDenied("daemon roster is unavailable or malformed")
    depth = current.get("depth")
    if isinstance(depth, bool) or not isinstance(depth, int) or depth < 0 or depth > MAX_DEPTH:
        raise DispatchDenied("daemon roster reports an invalid depth")
    if not isinstance(current.get("id"), str) or not current["id"]:
        raise DispatchDenied("daemon roster reports an invalid current id")

    parents = [entry for entry in entries if isinstance(entry, dict) and entry.get("relationship") == "parent"]
    if depth == 0:
        if parents:
            raise DispatchDenied("daemon root unexpectedly reports a parent edge")
        root_name = current.get("name")
        if isinstance(root_name, str) and root_name.startswith("ap-"):
            root_role = _canonical_role(root_name)
            if not PERSONAS[root_role]:
                raise DispatchDenied(f"terminal role {root_role} cannot dispatch children from root depth")
            raise DispatchDenied(f"Autoprompt persona {root_role} cannot occupy daemon root depth")
        return None, depth

    current_role = _canonical_role(current.get("name"))
    if len(parents) != 1:
        raise DispatchDenied("daemon roster must contain exactly one parent edge")
    parent = parents[0]
    if parent.get("depth") != depth - 1 or not isinstance(parent.get("id"), str) or not parent["id"]:
        raise DispatchDenied("daemon roster contains an invalid parent edge")

    if depth == 1:
        if current_role not in ROOT_ALLOWED_CHILDREN:
            raise DispatchDenied(f"parent edge from root to {current_role} is not allowlisted")
    else:
        parent_role = _canonical_role(parent.get("name"))
        if current_role not in PERSONAS[parent_role]:
            raise DispatchDenied(f"parent edge {parent_role} -> {current_role} is not allowlisted")
    return current_role, depth


def _child_name(persona: str, instance: str | None) -> str:
    if instance is None:
        return persona
    if not isinstance(instance, str) or not _INSTANCE_PATTERN.fullmatch(instance):
        raise ValueError("instance must match ^[a-z0-9][a-z0-9-]{0,23}$")
    name = f"{persona}--{instance}"
    if len(name) > 64:
        raise ValueError("Prime Agent child session name must be at most 64 characters")
    return name


def _framework_text(framework: str | None) -> str:
    if framework is None:
        return ""
    relative_path = FRAMEWORKS.get(framework)
    if relative_path is None:
        raise UnknownFramework(f"unknown Autoprompt framework: {framework!r}")
    target = _PACKAGE_ROOT.joinpath(*relative_path.split("/"))
    try:
        return target.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise DispatchError(f"installed framework is unavailable: {framework}") from error


def _sealed_prompt(
    persona: str,
    task: str,
    framework: str | None,
    parent_depth: int,
    binding: RunBinding,
) -> str:
    framework_text = _framework_text(framework)
    framework_id = framework if framework is not None else "none"
    binding_json = json.dumps(
        {
            "path": binding.path,
            "sha256": binding.sha256,
            "bytes": binding.bytes,
            "nonce": binding.nonce,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return "\n".join(
        [
            "# SEALED AUTOPROMPT DISPATCH ENVELOPE",
            f"AUTOPROMPT-RUN-MARKER: runtime=prime-agent-adapter-v1 nonce={binding.nonce} prompt=sha256:{binding.sha256}",
            f"RUN-NONCE: {binding.nonce}",
            "MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.",
            f"AUTOPROMPT_MISSION_BINDING: {binding_json}",
            f"AUTOPROMPT_BINDING_CALL: autoprompt.bind({json.dumps(binding.path, ensure_ascii=False)}, nonce={json.dumps(binding.nonce)})",
            f"AUTOPROMPT_PERSONA: {persona}",
            f"AUTOPROMPT_FRAMEWORK: {framework_id}",
            f"AUTOPROMPT_RUNTIME_DEPTH: parent={parent_depth} child={parent_depth + 1}",
            "The extension binds the canonical persona prompt by this allowlisted session name.",
            "",
            "## BEGIN SEALED FRAMEWORK",
            framework_text,
            "## END SEALED FRAMEWORK",
            "",
            f"## BEGIN BOUNDED TASK (utf8-bytes={len(task.encode('utf-8'))})",
            task,
            "## END BOUNDED TASK",
        ]
    )


async def _list_roster() -> dict[str, Any]:
    from rlm import host_request

    return await host_request("agent_message.list_agents")


async def _spawn_child(prompt: str, name: str) -> Any:
    from rlm import rlm as prime_rlm

    # Deliberately omit model: Prime Agent 0.7.2 inherits the selected parent model.
    return await prime_rlm(prompt, name=name)


async def dispatch(
    persona: str,
    task: str,
    *,
    binding: RunBinding,
    framework: str | None = None,
    instance: str | None = None,
) -> Any:
    """Validate topology and spawn one native Prime Agent RLM child."""
    if persona not in PERSONAS:
        raise UnknownPersona(f"unknown Autoprompt persona: {persona!r}")
    if not isinstance(task, str) or not task.strip():
        raise ValueError("task must be a non-empty string")
    if framework is not None and framework not in FRAMEWORKS:
        raise UnknownFramework(f"unknown Autoprompt framework: {framework!r}")
    binding = _validated_binding(binding)
    name = _child_name(persona, instance)
    current_role, depth = _validated_identity(await _list_roster())
    if depth >= MAX_DEPTH:
        raise DispatchDenied(f"Autoprompt depth limit reached at depth {depth}")

    if current_role is None:
        allowed = ROOT_ALLOWED_CHILDREN
    else:
        allowed = PERSONAS[current_role]
        if not allowed:
            raise DispatchDenied(f"terminal role {current_role} cannot dispatch children")
    if persona not in allowed:
        caller = "root" if current_role is None else current_role
        raise DispatchDenied(f"child edge {caller} -> {persona} is not allowlisted")

    prompt = _sealed_prompt(persona, task, framework, depth, binding)
    return await _spawn_child(prompt, name)


async def run(
    persona: str,
    task: str,
    *,
    binding: RunBinding,
    framework: str | None = None,
    instance: str | None = None,
) -> Any:
    """Callable-skill alias for :func:`dispatch`."""
    return await dispatch(persona, task, binding=binding, framework=framework, instance=instance)
