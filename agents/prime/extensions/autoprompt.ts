import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PERSONA_IDS = Object.freeze([
  "ap-arbiter",
  "ap-depth-prober",
  "ap-execharness-resolver",
  "ap-feature-coordinator",
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
  "ap-scope-coordinator",
  "ap-scoper",
  "ap-scribe",
  "ap-sweep-coordinator",
  "ap-sweeper",
  "ap-synthesizer",
  "ap-verifier"
]) as readonly string[];
export const FRAMEWORK_IDS = Object.freeze([
  "apply",
  "backend-build",
  "backend-fix",
  "backend-implement",
  "composition",
  "docs",
  "frontend-build",
  "frontend-fix",
  "frontend-implement",
  "frontend-review",
  "generation",
  "plan-design",
  "plan-research",
  "plan-scope",
  "polish",
  "QUICKSTART",
  "README",
  "refactor"
]) as readonly string[];

const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ENVELOPE_HEADER = "# SEALED AUTOPROMPT DISPATCH ENVELOPE";
const FRAMEWORK_START = "## BEGIN SEALED FRAMEWORK";
const FRAMEWORK_END = "## END SEALED FRAMEWORK";
const TASK_END = "## END BOUNDED TASK";
const PERSONA_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "personas");
const FRAMEWORK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "frameworks");
const PERSONA_PROMPTS = new Map(
  PERSONA_IDS.map((id) => [id, readFileSync(join(PERSONA_ROOT, `${id}.md`), "utf8").replace(/\r\n/g, "\n")]),
);
const FRAMEWORK_PROMPTS = new Map(
  FRAMEWORK_IDS.map((id) => [id, readFileSync(join(FRAMEWORK_ROOT, `${id}.md`), "utf8").replace(/\r\n/g, "\n").trim()]),
);

interface MissionBinding {
  path: string;
  sha256: string;
  bytes: number;
  nonce: string;
}

interface DispatchEnvelope {
  persona: string;
  framework: string | null;
  binding: MissionBinding;
}

export function resolvePersonaId(sessionName: string | undefined): string | undefined {
  if (!sessionName) return undefined;
  for (const persona of PERSONA_IDS) {
    if (sessionName === persona) return persona;
    const prefix = `${persona}--`;
    if (sessionName.startsWith(prefix) && INSTANCE_PATTERN.test(sessionName.slice(prefix.length))) {
      return persona;
    }
  }
  return undefined;
}

function missionBindingIsCurrent(binding: MissionBinding): boolean {
  if (!isAbsolute(binding.path) || resolve(binding.path) !== binding.path) return false;
  if (!SHA256_PATTERN.test(binding.sha256)) return false;
  if (!Number.isSafeInteger(binding.bytes) || binding.bytes <= 0) return false;
  if (!NONCE_PATTERN.test(binding.nonce)) return false;
  try {
    const payload = readFileSync(binding.path);
    new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return (
      payload.length === binding.bytes
      && createHash("sha256").update(payload).digest("hex") === binding.sha256
    );
  } catch {
    return false;
  }
}

function parseMissionBinding(value: string): MissionBinding | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (Object.keys(parsed).sort().join(",") !== "bytes,nonce,path,sha256") return undefined;
    if (typeof parsed.path !== "string") return undefined;
    if (typeof parsed.sha256 !== "string") return undefined;
    if (typeof parsed.bytes !== "number") return undefined;
    if (typeof parsed.nonce !== "string") return undefined;
    const binding: MissionBinding = {
      path: parsed.path,
      sha256: parsed.sha256,
      bytes: parsed.bytes,
      nonce: parsed.nonce,
    };
    if (JSON.stringify(binding) !== value || !missionBindingIsCurrent(binding)) return undefined;
    return binding;
  } catch {
    return undefined;
  }
}

export function validateDispatchEnvelope(
  prompt: string,
  expectedPersona: string,
): DispatchEnvelope | undefined {
  if (typeof prompt !== "string" || !PERSONA_IDS.includes(expectedPersona)) return undefined;
  const lines = prompt.split("\n");
  if (lines[0] !== ENVELOPE_HEADER) return undefined;
  if (lines[3] !== "MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.") return undefined;
  if (lines[6] !== `AUTOPROMPT_PERSONA: ${expectedPersona}`) return undefined;
  if (lines[9] !== "The extension binds the canonical persona prompt by this allowlisted session name.") return undefined;
  if (lines[10] !== "" || lines[11] !== FRAMEWORK_START) return undefined;

  const bindingPrefix = "AUTOPROMPT_MISSION_BINDING: ";
  if (!lines[4]?.startsWith(bindingPrefix)) return undefined;
  const binding = parseMissionBinding(lines[4].slice(bindingPrefix.length));
  if (!binding) return undefined;
  if (lines[1] !== `AUTOPROMPT-RUN-MARKER: runtime=prime-agent-adapter-v1 nonce=${binding.nonce} prompt=sha256:${binding.sha256}`) return undefined;
  if (lines[2] !== `RUN-NONCE: ${binding.nonce}`) return undefined;
  if (lines[5] !== `AUTOPROMPT_BINDING_CALL: autoprompt.bind(${JSON.stringify(binding.path)}, nonce=${JSON.stringify(binding.nonce)})`) return undefined;

  const frameworkPrefix = "AUTOPROMPT_FRAMEWORK: ";
  if (!lines[7]?.startsWith(frameworkPrefix)) return undefined;
  const frameworkValue = lines[7].slice(frameworkPrefix.length);
  const framework = frameworkValue === "none" ? null : frameworkValue;
  if (framework !== null && !FRAMEWORK_IDS.includes(framework)) return undefined;

  const depth = /^AUTOPROMPT_RUNTIME_DEPTH: parent=([0-3]) child=([1-4])$/.exec(lines[8] ?? "");
  if (!depth || Number(depth[2]) !== Number(depth[1]) + 1) return undefined;

  const frameworkEnd = lines.indexOf(FRAMEWORK_END, 12);
  if (frameworkEnd < 12 || lines[frameworkEnd + 1] !== "") return undefined;
  const expectedFrameworkText = framework === null ? "" : FRAMEWORK_PROMPTS.get(framework);
  if (expectedFrameworkText === undefined) return undefined;
  if (lines.slice(12, frameworkEnd).join("\n") !== expectedFrameworkText) return undefined;

  const taskHeader = /^## BEGIN BOUNDED TASK \(utf8-bytes=([1-9][0-9]*)\)$/.exec(lines[frameworkEnd + 2] ?? "");
  if (!taskHeader || lines.at(-1) !== TASK_END) return undefined;
  const task = lines.slice(frameworkEnd + 3, -1).join("\n");
  if (Buffer.byteLength(task, "utf8") !== Number(taskHeader[1])) return undefined;
  return { persona: expectedPersona, framework, binding };
}

function sameAdmission(left: DispatchEnvelope, right: DispatchEnvelope): boolean {
  return (
    left.persona === right.persona
    && left.framework === right.framework
    && JSON.stringify(left.binding) === JSON.stringify(right.binding)
  );
}

function deniedSystemPrompt(base: string, sessionName: string): string {
  return [
    base,
    "",
    "# AUTOPROMPT PERSONA ACTIVATION DENIED",
    `Session ${JSON.stringify(sessionName)} has an ap-* name but no valid sealed Autoprompt dispatch envelope.`,
    "No canonical Autoprompt persona was loaded. Treat this as an unmanaged Prime Agent session.",
  ].join("\n");
}

export default function autopromptExtension(pi: ExtensionAPI) {
  const admissions = new Map<string, DispatchEnvelope>();
  pi.on("before_agent_start", async (event, ctx) => {
    const sessionName = ctx.sessionManager.getSessionName();
    const persona = resolvePersonaId(sessionName);
    if (!persona) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const candidate = validateDispatchEnvelope(event.prompt, persona);
    const previous = admissions.get(sessionId);
    const resemblesEnvelope = event.prompt.startsWith(`${ENVELOPE_HEADER}\n`)
      || event.prompt.includes("AUTOPROMPT-RUN-MARKER:");
    let admission: DispatchEnvelope | undefined;
    if (candidate) {
      if (previous && !sameAdmission(previous, candidate)) admissions.delete(sessionId);
      admissions.set(sessionId, candidate);
      admission = candidate;
    } else if (previous && !resemblesEnvelope && missionBindingIsCurrent(previous.binding)) {
      admission = previous;
    }
    if (!admission || admission.persona !== persona) {
      admissions.delete(sessionId);
      return { systemPrompt: deniedSystemPrompt(event.systemPrompt, sessionName ?? persona) };
    }
    const canonicalPrompt = PERSONA_PROMPTS.get(persona);
    if (!canonicalPrompt) return undefined;
    return {
      systemPrompt: [
        event.systemPrompt,
        "",
        "# SEALED AUTOPROMPT PERSONA",
        `AUTOPROMPT_PERSONA: ${persona}`,
        `AUTOPROMPT_ADMISSION: nonce=${admission.binding.nonce} prompt=sha256:${admission.binding.sha256} framework=${admission.framework ?? "none"}`,
        "This session is an Autoprompt role. Dispatch only through await autoprompt.dispatch(...); the Python adapter derives daemon identity and enforces the canonical child topology.",
        "Never call rlm or rlm.run directly. Omitting a model in the adapter is deliberate: Prime Agent inherits the selected parent model.",
        "",
        canonicalPrompt.trim(),
      ].join("\n"),
    };
  });
  pi.on("session_shutdown", (_event, ctx) => {
    admissions.delete(ctx.sessionManager.getSessionId());
  });
}
