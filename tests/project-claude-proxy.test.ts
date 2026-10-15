import test from "node:test";
import assert from "node:assert/strict";
import { projectClaudeInput } from "../src/lib/project-claude-proxy.js";

test("OpenCode title generation can be answered without calling Claude", () => {
  assert.deepEqual(projectClaudeInput([
    { role: "system", content: "You are a title generator. You output ONLY a thread title. Nothing else." },
    { role: "user", content: '"检查项目状态"' },
  ]), { kind: "title", title: "检查项目状态" });
});

test("OpenCode agent wrapper is removed while dialogue is preserved", () => {
  assert.deepEqual(projectClaudeInput([
    { role: "system", content: "You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goal.\nExtra instructions" },
    { role: "user", content: '"检查 README"' },
    { role: "assistant", content: "README exists" },
    { role: "user", content: '"总结一下"' },
  ]), { kind: "prompt", prompt: "USER: 检查 README\n\nASSISTANT: README exists\n\nUSER: 总结一下" });
  assert.deepEqual(projectClaudeInput([
    { role: "system", content: "Other client instructions" },
    { role: "user", content: "Keep this" },
  ]), null);
});
