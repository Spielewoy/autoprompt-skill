"""Private fixed-tool Hermes plugin. No hooks, skills, MCP discovery, or subagents."""
import atexit
import json
import os
import re
import subprocess
import sys
import threading

TOOLS = (
    ("read", "Read a bounded text range from an assigned physical file.", {"path": {"type": "string"}, "startLine": {"type": "integer", "minimum": 1}, "lineCount": {"type": "integer", "minimum": 1, "maximum": 5000}}, ["path"]),
    ("list", "List an assigned directory without following links.", {"path": {"type": "string"}}, ["path"]),
    ("search", "Find literal text in assigned files; no regular-expression execution.", {"path": {"type": "string"}, "text": {"type": "string"}, "maxResults": {"type": "integer", "minimum": 1, "maximum": 200}}, ["path", "text"]),
    ("write", "Atomically write an explicitly authorized task or checker scratch file.", {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]),
    ("edit", "Replace exact text in an authorized file. Ambiguous matches fail.", {"path": {"type": "string"}, "oldText": {"type": "string"}, "newText": {"type": "string"}, "replaceAll": {"type": "boolean"}}, ["path", "oldText", "newText"]),
    ("bash", "Run a foreground command in the assigned OS sandbox with no outbound network or host credentials.", {"command": {"type": "string"}, "cwd": {"type": "string"}, "timeoutMs": {"type": "integer", "minimum": 1, "maximum": 300000}}, ["command"]),
)

class Controller:
    def __init__(self):
        node = os.environ["AUTOPROMPT_NODE"]
        server = os.environ["AUTOPROMPT_TOOL_SERVER"]
        # The owned wrapper captures stderr outside model context. Preserve
        # startup errors there instead of silently losing registration failures.
        self.proc = subprocess.Popen([node, server, "--policy", os.environ["AUTOPROMPT_TOOL_POLICY"], "--sha256", os.environ["AUTOPROMPT_TOOL_POLICY_SHA256"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.lock, self.next_id = threading.Lock(), 1
        try:
            self.request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "autoprompt-hermes", "version": "0.1"}})
            self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); self.proc.stdin.flush()
        except BaseException:
            self.close()
            raise
    def request(self, method, params):
        with self.lock:
            request_id = self.next_id; self.next_id += 1
            self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n"); self.proc.stdin.flush()
            while True:
                line = self.proc.stdout.readline()
                if not line: raise RuntimeError("Controller tool server closed")
                reply = json.loads(line)
                if reply.get("id") != request_id: continue
                if "error" in reply:
                    failure = reply.get("error")
                    data = failure.get("data") if isinstance(failure, dict) else None
                    code = data.get("code") if isinstance(data, dict) else None
                    if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", code): code = "TOOL_SERVER_FAILED"
                    print("AUTOPROMPT_HERMES_CONTROLLER_FAILURE:" + code, file=sys.stderr, flush=True)
                    raise RuntimeError("Controller tool request failed: " + code)
                return reply["result"]
    def call(self, name, params):
        result = self.request("tools/call", {"name": name, "arguments": params})
        content = result.get("content") or []
        if len(content) != 1 or content[0].get("type") != "text" or not isinstance(content[0].get("text"), str): raise RuntimeError("Controller tool result is malformed")
        return content[0]["text"]
    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try: self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired: self.proc.kill(); self.proc.wait(timeout=2)

def register(ctx):
    controller = Controller()
    atexit.register(controller.close)
    inventory = controller.request("tools/list", {}).get("tools")
    if not isinstance(inventory, list): raise RuntimeError("Controller tool inventory is malformed")
    names = [item.get("name") for item in inventory if isinstance(item, dict)]
    expected = [item[0] for item in TOOLS]
    if names != [] and names != expected: raise RuntimeError("Controller tool inventory is unexpected")
    if len(names) != len(inventory): raise RuntimeError("Controller tool inventory is malformed")
    for short, description, properties, required in TOOLS:
        if short not in names: continue
        name = "autoprompt_owned_" + short
        schema = {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}
        def handler(params, _short=short, **_kwargs): return controller.call(_short, params)
        ctx.register_tool(name=name, toolset="autoprompt_owned", schema=schema, handler=handler)
