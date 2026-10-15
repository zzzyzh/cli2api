/**
 * Tests for stream-json-cli.ts — subprocess lifecycle management.
 *
 * Uses real child_process.spawn (echo + node -e scripts) to produce
 * controllable NDJSON output without mocking.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  iterStreamJsonEvents,
  TextAssembler,
  extractClaudeDelta,
  extractClaudeThinkingDelta,
  extractUsageFromClaudeResult,
} from "../src/providers/stream-json-cli.js";

test("iterStreamJsonEvents yields parsed NDJSON events from subprocess stdout", async () => {
  const events: Record<string, unknown>[] = [];
  // Exercise lines that arrive in separate writes.
  const lines = [
    `process.stdout.write('{"type":"test","n":1}\\n');`,
    `setTimeout(() => { process.stdout.write('{"type":"test","n":2}\\n'); }, 10);`,
  ].join("");
  for await (const evt of iterStreamJsonEvents({
    cmd: ["node", "-e", lines],
    timeoutMs: 5000,
  })) {
    events.push(evt);
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "test");
  assert.equal(events[0].n, 1);
  assert.equal(events[1].type, "test");
  assert.equal(events[1].n, 2);
});

test("iterStreamJsonEvents keeps every line when stdout writes a batch", async () => {
  const events: Record<string, unknown>[] = [];
  for await (const evt of iterStreamJsonEvents({
    cmd: ["node", "-e", `process.stdout.write([1, 2, 3].map(n => JSON.stringify({ type: 'delta', n })).join('\\n') + '\\n')`],
    timeoutMs: 5000,
  })) {
    events.push(evt);
  }
  assert.deepEqual(events.map((e) => e.n), [1, 2, 3]);
});

test("iterStreamJsonEvents handles killOnResult", async () => {
  const events: Record<string, unknown>[] = [];
  const script = [
    `process.stdout.write('{"type":"assistant","message":{"content":"hello"}}\\n');`,
    `setTimeout(() => { process.stdout.write('{"type":"result","result":"done"}\\n'); }, 10);`,
    // Would output after result but process should be killed before this
    `setTimeout(() => process.stdout.write('{"type":"after","x":1}\\n'), 15000);`,
  ].join(" ");
  for await (const evt of iterStreamJsonEvents({
    cmd: ["node", "-e", script],
    timeoutMs: 5000,
    killOnResult: true,
  })) {
    events.push(evt);
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "assistant");
  assert.equal(events[1].type, "result");
});

test("iterStreamJsonEvents propagates subprocess non-zero exit as error", async () => {
  try {
    for await (const _evt of iterStreamJsonEvents({
      cmd: ["node", "-e", `process.stderr.write('something broke'); process.exit(1);`],
      timeoutMs: 5000,
    })) {
      // should throw before yielding anything useful
    }
    assert.fail("Expected error was not thrown");
  } catch (e) {
    const msg = String(e);
    assert.ok(
      msg.includes("something broke") || msg.includes("subprocess failed") || msg.includes("1"),
      `error message should indicate subprocess failure, got: ${msg}`,
    );
  }
});

test("iterStreamJsonEvents with AbortSignal kills subprocess early", async () => {
  const ac = new AbortController();
  const events: Record<string, unknown>[] = [];

  const script = [
    `process.stdout.write('{"type":"start"}\\n');`,
    // Sleep 30 seconds — abort should kill before this
    `setTimeout(() => process.stdout.write('{"type":"never"}\\n'), 30000);`,
  ].join(" ");

  const iter = iterStreamJsonEvents({
    cmd: ["node", "-e", script],
    timeoutMs: 3000,
    signal: ac.signal,
  });

  try {
    for await (const evt of iter) {
      events.push(evt);
      if (evt.type === "start") ac.abort();
    }
  } catch (_) {
    // Expected — generator should throw after abort kills the process
  }

  const types = events.map((e) => e.type);
  assert.ok(types.includes("start"), "should have received start event");
  assert.ok(!types.includes("never"), "should NOT have received never event");
});

test("TextAssembler produces clean deltas from partial/full text", () => {
  const a = new TextAssembler();
  assert.equal(a.feed("Hello"), "Hello");
  assert.equal(a.text, "Hello");
  assert.equal(a.feed("Hello World"), " World");
  assert.equal(a.text, "Hello World");
  assert.equal(a.feed("New"), "New");
  assert.equal(a.text, "Hello WorldNew");
  assert.equal(a.feed(""), "");
  assert.equal(a.text, "Hello WorldNew");
});

test("Claude partial text and thinking are streamed without repeating final assistant blocks", () => {
  const text = new TextAssembler();
  const thinking = new TextAssembler();
  const partial = (delta: Record<string, unknown>) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta },
  });

  assert.equal(extractClaudeThinkingDelta(partial({ type: "thinking_delta", thinking: "Check " }), thinking), "Check ");
  assert.equal(extractClaudeThinkingDelta(partial({ type: "thinking_delta", thinking: "inputs." }), thinking), "inputs.");
  assert.equal(extractClaudeDelta(partial({ type: "text_delta", text: "Hel" }), text), "Hel");
  assert.equal(extractClaudeDelta(partial({ type: "text_delta", text: "lo" }), text), "lo");

  const full = { type: "assistant", message: { content: [
    { type: "thinking", thinking: "Check inputs." },
    { type: "text", text: "Hello" },
  ] } };
  assert.equal(extractClaudeThinkingDelta(full, thinking), "");
  assert.equal(extractClaudeDelta(full, text), "");
  assert.equal(thinking.text, "Check inputs.");
  assert.equal(text.text, "Hello");
});

test("Claude tool turns do not repeat final snapshots after partial output", () => {
  const text = new TextAssembler();
  const thinking = new TextAssembler();
  const partial = (delta: Record<string, unknown>) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta },
  });
  const full = (content: Record<string, unknown>[]) => ({ type: "assistant", message: { content } });

  assert.equal(extractClaudeDelta(partial({ type: "text_delta", text: "Checking files. " }), text), "Checking files. ");
  assert.equal(extractClaudeDelta(full([{ type: "text", text: "Checking files. " }]), text), "");
  assert.equal(extractClaudeThinkingDelta(partial({ type: "thinking_delta", thinking: "Found issue. " }), thinking), "Found issue. ");
  assert.equal(extractClaudeThinkingDelta(full([{ type: "thinking", thinking: "Found issue. " }]), thinking), "");

  assert.equal(extractClaudeDelta(partial({ type: "text_delta", text: "Here is the result." }), text), "Here is the result.");
  assert.equal(extractClaudeDelta(full([{ type: "text", text: "Here is the result." }]), text), "");
  assert.equal(extractClaudeThinkingDelta(partial({ type: "thinking_delta", thinking: "Done." }), thinking), "Done.");
  assert.equal(extractClaudeThinkingDelta(full([{ type: "thinking", thinking: "Done." }]), thinking), "");
  assert.equal(text.text, "Checking files. Here is the result.");
  assert.equal(thinking.text, "Found issue. Done.");
});

test("Claude usage includes cached input tokens for context accounting", () => {
  assert.deepEqual(extractUsageFromClaudeResult({
    type: "result",
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 4,
    },
  }), { prompt_tokens: 60, completion_tokens: 4, total_tokens: 64 });
});
