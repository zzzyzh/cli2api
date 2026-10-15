import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Claude stream keeps sending SSE heartbeats while internal events arrive", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-heartbeat-"));
  const fakeClaude = join(dir, "claude");
  writeFileSync(fakeClaude, `#!/bin/sh
cat >/dev/null
i=0
while [ "$i" -lt 15 ]; do
  printf '%s\\n' '{"type":"system","subtype":"progress"}'
  sleep 0.2
  i=$((i + 1))
done
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"MOCK_DONE"}]}}'
printf '%s\\n' '{"type":"result","result":"MOCK_DONE"}'
`);
  chmodSync(fakeClaude, 0o700);

  const previous = new Map<string, string | undefined>();
  const overrides: Record<string, string> = {
    CLAUDE_BIN: fakeClaude,
    CODEX_PROVIDER: "claude",
    CODEX_WORKSPACE: dir,
    CODEX_SSE_KEEPALIVE_SECONDS: "1",
    CODEX_TIMEOUT_SECONDS: "10",
    CLAUDE_USE_OAUTH_API: "0",
  };
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const { app } = await import("../src/server.js");
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude:mock", messages: [{ role: "user", content: "mock" }], stream: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const firstPing = body.indexOf(": ping\n\n");
    const result = body.indexOf("MOCK_DONE");
    assert.ok(firstPing > 0, "expected an SSE heartbeat before the result");
    assert.ok(result > firstPing, "heartbeat should arrive while Claude is emitting internal events");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
