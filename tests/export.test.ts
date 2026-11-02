import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("exporter starts real gateways with CLI model settings, streams through Codex CLI, reuses and stops services", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli2api-export-test-"));
  const configDir = join(dir, "config");
  const binaries: Record<string, string> = {};
  for (const source of ["codex", "cursor"]) {
    const bin = join(dir, source);
    binaries[source] = bin;
    writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("test-cli"); process.exit(0); }
const args = process.argv.slice(2);
const source = ${JSON.stringify(source)};
const prompt = source === "codex" || args.at(-1) === "--stream-partial-output" ? fs.readFileSync(0, "utf8") : args.at(-1);
const config = source === "cursor" ? JSON.parse(fs.readFileSync(process.env.CURSOR_CONFIG_DIR + "/cli-config.json", "utf8")) : null;
fs.appendFileSync(${JSON.stringify(join(dir, source + ".trace"))}, JSON.stringify({args, promptLength: prompt.length, config}) + "\\n");
const events = source === "codex" ? [
  {type:"item.completed", item:{type:"agent_message", text:"CLI2API_OK"}},
  {type:"turn.completed", usage:{input_tokens:12,output_tokens:3}}
] : [
  {type:"assistant", message:{content:[{type:"text",text:"CLI2API_OK"}]}},
  {type:"result",result:"CLI2API_OK"}
];
process.stdout.write(events.map(e => JSON.stringify(e)).join("\\n") + "\\n");
`);
    chmodSync(bin, 0o700);
  }
  const env = {
    ...process.env,
    CLI2API_CONFIG_DIR: configDir,
    CODEX_BIN: binaries.codex,
    CURSOR_AGENT_BIN: binaries.cursor,
    CODEX_CODEX_BASE_URL: "http://127.0.0.1:1",
  };
  const run = (...args: string[]) => exec(join(root, "export.sh"), args, { cwd: root, env, timeout: 25_000 });
  const load = (source: string) => JSON.parse(readFileSync(join(configDir, source + ".json"), "utf8"));
  const ports = { codex: await freePort(), cursor: await freePort() };
  try {
    for (const source of ["codex", "cursor"] as const) {
      await run(source, "--port", String(ports[source]));
      const config = load(source);
      assert.ok(config.verified_at);
      assert.equal(statSync(join(configDir, source + ".json")).mode & 0o777, 0o600);
      assert.equal((await fetch(config.base_url + "/models")).status, 401);
      const headers = { Authorization: "Bearer " + config.api_key, "Content-Type": "application/json" };
      const response = await fetch(config.base_url + "/chat/completions", {
        method: "POST", headers,
        body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: "x".repeat(150_000) }], stream: true }),
      });
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.ok(body.includes("CLI2API_OK"));
      assert.ok(body.includes("data: [DONE]"));
      if (source === "codex") assert.ok(body.includes('"total_tokens":15'));
      const repeated = await run(source, "--port", String(ports[source]));
      assert.ok(repeated.stdout.includes("已运行"));
      assert.equal(load(source).pid, config.pid);
    }
    const codexCalls = readFileSync(join(dir, "codex.trace"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(codexCalls.some(call => call.promptLength > 150_000));
    assert.ok(codexCalls.every(call => call.args.at(-1) === "-" && call.args.includes('model_reasoning_effort="xhigh"')));
    const cursorCalls = readFileSync(join(dir, "cursor.trace"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(cursorCalls.every(call => !call.args.includes("--model") && !call.args.includes("--disable-indexing")));
    assert.deepEqual(cursorCalls[0].config.selectedModel, { modelId: "grok-4.7", parameters: [
      { id: "context", value: "500k" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "false" },
    ] });

    await run("codex", "--port", String(ports.codex), "--model", "test-model", "--effort", "high");
    assert.equal(load("codex").model, "test-model");
    assert.equal(load("codex").reasoning_effort, "high");
    // No positional argument must select both defaults, including --stop.
    await run("--stop");
    for (const source of ["codex", "cursor"]) {
      await assert.rejects(fetch(load(source).base_url + "/models"));
    }
  } finally {
    await run("all", "--stop").catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
