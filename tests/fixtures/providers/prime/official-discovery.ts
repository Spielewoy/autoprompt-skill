import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function pythonEnvelope(modulePath: string, missionPath: string): string {
	const script = [
		"import importlib.util, sys",
		"sys.dont_write_bytecode = True",
		'spec = importlib.util.spec_from_file_location("autoprompt_prime_official", sys.argv[1])',
		"module = importlib.util.module_from_spec(spec)",
		"sys.modules[spec.name] = module",
		"spec.loader.exec_module(module)",
		'binding = module.bind(sys.argv[2], nonce="prime-official-fixture-0001")',
		'sys.stdout.buffer.write(module._sealed_prompt("ap-reviewer", "bounded task", "plan-scope", 1, binding).encode("utf-8"))',
	].join("; ");
	const candidates: Array<[string, string[]]> = process.platform === "win32"
		? [["python", []], ["py", ["-3"]]]
		: [["python3", []], ["python", []]];
	for (const [command, prefix] of candidates) {
		const completed = spawnSync(command, [...prefix, "-c", script, modulePath, missionPath], {
			encoding: "utf8",
		});
		if (completed.error && (completed.error as NodeJS.ErrnoException).code === "ENOENT") continue;
		if (completed.status !== 0) throw new Error(completed.stderr || completed.stdout);
		return completed.stdout;
	}
	throw new Error("Python 3 is required for the official Prime adapter fixture");
}

async function main(): Promise<void> {
	const [officialRootInput, packageRootInput] = process.argv.slice(2);
	if (!officialRootInput || !packageRootInput) {
		throw new Error("usage: official-discovery.ts <prime-agent-v0.7.2-root> <adapter-package-root>");
	}

	const officialRoot = resolve(officialRootInput);
	const packageRoot = resolve(packageRootInput);
	const packageManagerModule = await import(
		pathToFileURL(join(officialRoot, "packages/coding-agent/src/core/package-manager.ts")).href
	);
	const settingsModule = await import(
		pathToFileURL(join(officialRoot, "packages/coding-agent/src/core/settings-manager.ts")).href
	);
	const extensionLoaderModule = await import(
		pathToFileURL(join(officialRoot, "packages/coding-agent/src/core/extensions/loader.ts")).href
	);

	const fixtureRoot = mkdtempSync(join(tmpdir(), "autoprompt-prime-official-"));
	try {
		const cwd = join(fixtureRoot, "project");
		const agentDir = join(fixtureRoot, "agent-home");
		const settings = settingsModule.SettingsManager.create(cwd, agentDir);
		const manager = new packageManagerModule.DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager: settings,
			bundledSkillsDir: null,
		});
		const resolved = await manager.resolveExtensionSources([packageRoot], { temporary: true });
		const extensions = resolved.extensions.filter((item: { enabled: boolean }) => item.enabled);
		const skills = resolved.skills.filter((item: { enabled: boolean }) => item.enabled);
		const prompts = resolved.prompts.filter((item: { enabled: boolean }) => item.enabled);

		if (extensions.length !== 1) throw new Error(`expected 1 extension, got ${extensions.length}`);
		if (skills.length !== 1) throw new Error(`expected 1 skill, got ${skills.length}`);
		if (prompts.length !== 18) throw new Error(`expected 18 prompts, got ${prompts.length}`);

		const loaded = await extensionLoaderModule.loadExtensions(
			extensions.map((item: { path: string }) => item.path),
			cwd,
		);
		if (loaded.errors.length !== 0) throw new Error(JSON.stringify(loaded.errors));
		if (loaded.extensions.length !== 1) {
			throw new Error(`expected 1 loaded extension, got ${loaded.extensions.length}`);
		}
		const beforeAgentStartHandlers = loaded.extensions[0]?.handlers.get("before_agent_start")?.length ?? 0;
		if (beforeAgentStartHandlers !== 1) {
			throw new Error(`expected 1 before_agent_start handler, got ${beforeAgentStartHandlers}`);
		}
		const handler = loaded.extensions[0]?.handlers.get("before_agent_start")?.[0];
		if (!handler) throw new Error("official loader did not expose the before_agent_start handler");
		let sessionId = "raw-prime-session";
		const context = {
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionName: () => "ap-reviewer",
			},
		};
		const event = (prompt: string) => ({
			type: "before_agent_start",
			prompt,
			images: undefined,
			systemPrompt: "Prime base system prompt",
			systemPromptOptions: {},
		});
		const rawResult = await handler(event("raw unmanaged task"), context) as { systemPrompt?: string } | undefined;
		const rawImpersonationDenied = Boolean(
			rawResult?.systemPrompt?.includes("AUTOPROMPT PERSONA ACTIVATION DENIED")
			&& !rawResult.systemPrompt.includes("# SEALED AUTOPROMPT PERSONA"),
		);
		if (!rawImpersonationDenied) throw new Error("raw ap-* session received the canonical persona");

		const missionPath = join(fixtureRoot, "PROMPTS.txt");
		writeFileSync(missionPath, "exact official-loader mission\n", "utf8");
		const modulePath = join(packageRoot, "skills/autoprompt/src/autoprompt/__init__.py");
		const sealedPrompt = pythonEnvelope(modulePath, missionPath);
		sessionId = "sealed-prime-session";
		const sealedResult = await handler(event(sealedPrompt), context) as { systemPrompt?: string } | undefined;
		const sealedPersonaLoaded = Boolean(
			sealedResult?.systemPrompt?.includes("# SEALED AUTOPROMPT PERSONA")
			&& sealedResult.systemPrompt.includes("AUTOPROMPT_PERSONA: ap-reviewer"),
		);
		if (!sealedPersonaLoaded) throw new Error("valid sealed dispatch did not receive its canonical persona");

		process.stdout.write(
			`${JSON.stringify({
				extensions: extensions.length,
				skills: skills.length,
				prompts: prompts.length,
				loadedExtensions: loaded.extensions.length,
				beforeAgentStartHandlers,
				rawImpersonationDenied,
				sealedPersonaLoaded,
			})}\n`,
		);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
});
