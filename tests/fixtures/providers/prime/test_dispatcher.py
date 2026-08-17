from __future__ import annotations

import asyncio
import dataclasses
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


sys.dont_write_bytecode = True


ROOT = Path(__file__).resolve().parents[4]
CONTRACT = json.loads((ROOT / "agents/contracts/autoprompt.contract.json").read_text(encoding="utf-8"))
MODULE_PATH = ROOT / "agents/prime/skills/autoprompt/src/autoprompt/__init__.py"


def load_adapter():
    spec = importlib.util.spec_from_file_location("autoprompt_prime_fixture", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def role_name(role: str, instance: str | None = None) -> str:
    return role if instance is None else f"{role}--{instance}"


def roster(current_role: str, depth: int, parent_role: str | None = None):
    entries = []
    if depth > 0:
        entries.append(
            {
                "relationship": "parent",
                "name": "autoprompt-root" if parent_role is None else role_name(parent_role, "parent"),
                "id": "parent-id",
                "depth": depth - 1,
                "status": "running",
            }
        )
    return {
        "current": {
            "name": "autoprompt-root" if depth == 0 else role_name(current_role, "current"),
            "id": "current-id",
            "depth": depth,
        },
        "entries": entries,
    }


class PrimeDispatcherTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.adapter = load_adapter()
        cls.personas = {item["id"]: item for item in CONTRACT["personas"]}
        cls.mission_directory = tempfile.TemporaryDirectory(prefix="autoprompt-prime-binding-")
        cls.mission_path = Path(cls.mission_directory.name) / "PROMPTS.txt"
        cls.mission_path.write_text("exact fixture mission\n", encoding="utf-8")
        cls.binding = cls.adapter.bind(cls.mission_path, nonce="prime-fixture-nonce-0001")

    @classmethod
    def tearDownClass(cls):
        cls.mission_directory.cleanup()

    async def asyncSetUp(self):
        self.spawned = []
        self.real_spawn = self.adapter._spawn_child
        self.real_dispatch = self.adapter.dispatch

        async def fake_spawn(prompt: str, name: str):
            self.spawned.append({"prompt": prompt, "name": name})
            return {"prompt": prompt, "name": name, "model": "inherited/model"}

        async def bound_dispatch(persona: str, task: str, **kwargs):
            kwargs.setdefault("binding", self.binding)
            return await self.real_dispatch(persona, task, **kwargs)

        self.spawn_patch = patch.object(self.adapter, "_spawn_child", fake_spawn)
        self.dispatch_patch = patch.object(self.adapter, "dispatch", bound_dispatch)
        self.spawn_patch.start()
        self.dispatch_patch.start()

    async def asyncTearDown(self):
        self.dispatch_patch.stop()
        self.spawn_patch.stop()

    def test_exports_all_25_personas_and_18_frameworks(self):
        self.assertEqual(set(self.adapter.PERSONAS), set(self.personas))
        self.assertEqual(set(self.adapter.FRAMEWORKS), {item["id"] for item in CONTRACT["frameworks"]})
        self.assertEqual(len(self.adapter.PERSONAS), 25)
        self.assertEqual(len(self.adapter.FRAMEWORKS), 18)

    async def test_root_dispatch_is_restricted_to_canonical_root_children(self):
        for child in self.adapter.ROOT_ALLOWED_CHILDREN:
            with self.subTest(child=child):
                self.spawned.clear()
                with patch.object(self.adapter, "_list_roster", return_value=roster("", 0)):
                    await self.adapter.dispatch(child, "bounded task")
                self.assertEqual(self.spawned[0]["name"], child)

        for child in sorted(set(self.personas) - set(self.adapter.ROOT_ALLOWED_CHILDREN)):
            with self.subTest(forbidden_child=child):
                self.spawned.clear()
                with patch.object(self.adapter, "_list_roster", return_value=roster("", 0)):
                    with self.assertRaises(self.adapter.DispatchDenied):
                        await self.adapter.dispatch(child, "skip the coordinator")
                self.assertEqual(self.spawned, [])

    async def test_every_persona_enforces_its_exact_child_allowlist(self):
        for role, persona in self.personas.items():
            parent = "ap-scope-coordinator"
            depth = 2
            if role in self.adapter.ROOT_ALLOWED_CHILDREN:
                parent = None
                depth = 1

            current_roster = roster(role, depth, parent)
            for child in self.personas:
                with self.subTest(role=role, child=child):
                    self.spawned.clear()
                    with patch.object(self.adapter, "_list_roster", return_value=current_roster):
                        if child in persona["allowedChildren"]:
                            await self.adapter.dispatch(child, "edge exercise")
                            self.assertEqual(self.spawned[0]["name"], child)
                        else:
                            with self.assertRaises(self.adapter.DispatchDenied):
                                await self.adapter.dispatch(child, "forbidden edge")
                            self.assertEqual(self.spawned, [])

    async def test_all_terminal_roles_are_code_level_non_dispatchers(self):
        terminals = [item for item in CONTRACT["personas"] if not item["allowedChildren"]]
        self.assertGreater(len(terminals), 0)
        for persona in terminals:
            with self.subTest(role=persona["id"]):
                with patch.object(
                    self.adapter,
                    "_list_roster",
                    return_value=roster(persona["id"], 2, "ap-scope-coordinator"),
                ):
                    with self.assertRaisesRegex(self.adapter.DispatchDenied, "terminal"):
                        await self.adapter.dispatch("ap-juror", "must not spawn")
        self.assertEqual(self.spawned, [])

    async def test_persona_name_cannot_masquerade_as_the_depth_zero_root(self):
        masquerade = roster("", 0)
        masquerade["current"]["name"] = "ap-reviewer"
        with patch.object(self.adapter, "_list_roster", return_value=masquerade):
            with self.assertRaisesRegex(self.adapter.DispatchDenied, "terminal"):
                await self.adapter.dispatch("ap-scope-coordinator", "bypass terminal role")
        self.assertEqual(self.spawned, [])

    async def test_parent_edge_and_depth_are_daemon_derived_and_fail_closed(self):
        bad_parent = roster("ap-manager", 2, "ap-reviewer")
        with patch.object(self.adapter, "_list_roster", return_value=bad_parent):
            with self.assertRaisesRegex(self.adapter.DispatchDenied, "parent edge"):
                await self.adapter.dispatch("ap-implementer", "bad ancestry")

        at_limit = roster("ap-implementer", 4, "ap-manager")
        with patch.object(self.adapter, "_list_roster", return_value=at_limit):
            with self.assertRaisesRegex(self.adapter.DispatchDenied, "depth"):
                await self.adapter.dispatch("ap-juror", "too deep")
        self.assertEqual(self.spawned, [])

    async def test_framework_is_allowlisted_and_sealed_into_the_child_envelope(self):
        current = roster("ap-scope-coordinator", 1)
        with patch.object(self.adapter, "_list_roster", return_value=current):
            await self.adapter.dispatch(
                "ap-scoper",
                "write the roadmap",
                framework="plan-scope",
                instance="lane-a",
            )
        call = self.spawned[0]
        self.assertEqual(call["name"], "ap-scoper--lane-a")
        self.assertIn("AUTOPROMPT_FRAMEWORK: plan-scope", call["prompt"])
        self.assertIn("write the roadmap", call["prompt"])
        self.assertIn("AUTOPROMPT_RUNTIME_DEPTH: parent=1 child=2", call["prompt"])
        self.assertIn("AUTOPROMPT-RUN-MARKER: runtime=prime-agent-adapter-v1", call["prompt"])
        self.assertIn("RUN-NONCE: prime-fixture-nonce-0001", call["prompt"])
        self.assertIn("MISSION POINTER:", call["prompt"])

        with patch.object(self.adapter, "_list_roster", return_value=current):
            with self.assertRaises(self.adapter.UnknownFramework):
                await self.adapter.dispatch("ap-scoper", "task", framework="invented")

    async def test_native_rlm_call_omits_model_to_inherit_parent(self):
        calls = []

        class FakeRlm:
            async def __call__(self, prompt, **kwargs):
                calls.append((prompt, kwargs))
                return {"model": "provider/parent-model"}

        fake_module = types.ModuleType("rlm")
        fake_module.rlm = FakeRlm()
        with patch.dict(sys.modules, {"rlm": fake_module}):
            result = await self.real_spawn("sealed prompt", "ap-reviewer")

        self.assertEqual(result, {"model": "provider/parent-model"})
        self.assertEqual(calls, [("sealed prompt", {"name": "ap-reviewer"})])

    async def test_unknown_names_and_unsafe_instances_fail_before_rlm(self):
        current = roster("ap-scope-coordinator", 1)
        with patch.object(self.adapter, "_list_roster", return_value=current):
            with self.assertRaises(self.adapter.UnknownPersona):
                await self.adapter.dispatch("reviewer", "task")
            with self.assertRaises(ValueError):
                await self.adapter.dispatch("ap-scoper", "task", instance="../escape")
        self.assertEqual(self.spawned, [])

    async def test_mission_binding_is_required_and_revalidated_before_rlm(self):
        current = roster("", 0)
        with patch.object(self.adapter, "_list_roster", return_value=current):
            with self.assertRaisesRegex(TypeError, "binding"):
                await self.real_dispatch("ap-scope-coordinator", "task")
            tampered = dataclasses.replace(self.binding, sha256="0" * 64)
            with self.assertRaisesRegex(self.adapter.DispatchDenied, "mission binding"):
                await self.real_dispatch(
                    "ap-scope-coordinator",
                    "task",
                    binding=tampered,
                )
        self.assertEqual(self.spawned, [])

    def test_binding_creation_and_revalidation_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "nonce"):
            self.adapter.bind(self.mission_path, nonce="short")
        with self.assertRaisesRegex(self.adapter.DispatchDenied, "readable UTF-8"):
            self.adapter.bind(self.mission_path.with_name("missing.txt"), nonce="prime-fixture-nonce-0001")

        empty_path = self.mission_path.with_name("EMPTY.txt")
        empty_path.write_bytes(b"")
        with self.assertRaisesRegex(self.adapter.DispatchDenied, "must not be empty"):
            self.adapter.bind(empty_path, nonce="prime-fixture-nonce-0001")

        with self.assertRaisesRegex(self.adapter.DispatchDenied, "must come from"):
            self.adapter._validated_binding(None)
        with self.assertRaisesRegex(self.adapter.DispatchDenied, "invalid nonce"):
            self.adapter._validated_binding(dataclasses.replace(self.binding, nonce="bad"))
        with self.assertRaisesRegex(self.adapter.DispatchDenied, "not canonical"):
            self.adapter._validated_binding(dataclasses.replace(self.binding, path="package.json"))
        with self.assertRaisesRegex(self.adapter.DispatchDenied, "remain a readable UTF-8"):
            self.adapter._validated_binding(
                dataclasses.replace(self.binding, path=str(self.mission_path.with_name("missing.txt")))
            )

    def test_malformed_daemon_identity_is_rejected(self):
        malformed = [
            None,
            {},
            {"current": {"id": "current", "depth": True}, "entries": []},
            {"current": {"id": "", "depth": 0}, "entries": []},
            {
                "current": {"id": "current", "name": "root", "depth": 0},
                "entries": [{"relationship": "parent", "id": "parent", "depth": 0}],
            },
            {"current": {"id": "current", "name": "ap-manager", "depth": 2}, "entries": []},
            {
                "current": {"id": "current", "name": "ap-manager", "depth": 2},
                "entries": [{"relationship": "parent", "id": "parent", "name": "ap-scope-coordinator", "depth": 0}],
            },
            roster("ap-reviewer", 1),
        ]
        for value in malformed:
            with self.subTest(value=value):
                with self.assertRaises(self.adapter.DispatchDenied):
                    self.adapter._validated_identity(value)

        nonterminal_root = roster("", 0)
        nonterminal_root["current"]["name"] = "ap-manager"
        with self.assertRaisesRegex(self.adapter.DispatchDenied, "cannot occupy daemon root"):
            self.adapter._validated_identity(nonterminal_root)
        with self.assertRaisesRegex(self.adapter.DispatchDenied, "valid session name"):
            self.adapter._canonical_role(None)
        with self.assertRaisesRegex(self.adapter.DispatchDenied, "not an allowlisted"):
            self.adapter._canonical_role("unregistered-agent")

    async def test_native_helpers_and_callable_alias_cover_remaining_guards(self):
        with self.assertRaisesRegex(ValueError, "at most 64"):
            self.adapter._child_name("x" * 50, "y" * 20)
        with self.assertRaises(self.adapter.UnknownFramework):
            self.adapter._framework_text("invented")
        with tempfile.TemporaryDirectory(prefix="autoprompt-prime-no-frameworks-") as empty_root:
            with patch.object(self.adapter, "_PACKAGE_ROOT", Path(empty_root)):
                with self.assertRaisesRegex(self.adapter.DispatchError, "unavailable"):
                    self.adapter._framework_text("plan-scope")

        host_calls = []

        async def fake_host_request(method):
            host_calls.append(method)
            return roster("", 0)

        fake_module = types.ModuleType("rlm")
        fake_module.host_request = fake_host_request
        with patch.dict(sys.modules, {"rlm": fake_module}):
            self.assertEqual(await self.adapter._list_roster(), roster("", 0))
        self.assertEqual(host_calls, ["agent_message.list_agents"])

        with self.assertRaisesRegex(ValueError, "non-empty"):
            await self.real_dispatch("ap-scope-coordinator", "", binding=self.binding)

        with patch.object(self.adapter, "_list_roster", return_value=roster("", 0)):
            result = await self.adapter.run(
                "ap-scope-coordinator",
                "launch through callable alias",
                binding=self.binding,
            )
        self.assertEqual(result["name"], "ap-scope-coordinator")


if __name__ == "__main__":
    unittest.main()
