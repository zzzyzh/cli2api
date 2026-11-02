/**
 * Codex CLI subprocess execution. Ported from Python codex_cli.py.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalPolicy, SandboxMode } from "../config.js";
import { iterStreamJsonEvents } from "./stream-json-cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const _GATEWAY_ROOT = path.resolve(__dirname, "..", "..");
const _DEFAULT_CODEX_CLI_HOME = path.join(_GATEWAY_ROOT, ".codex-gateway-home");

export interface CodexResult {
  text: string;
  usage: Record<string, number> | null;
  rawEvents?: Record<string, unknown>[];
}

export interface EnsureCodexHomeOpts {
  codexCliHome: string | null;
  trustedDir: string;
  defaultModel: string;
  modelReasoningEffort: string | null;
}

export interface BuildCodexExecCmdOpts {
  prompt: string;
  model: string;
  cd: string;
  images: string[];
  disableShellTool: boolean;
  disableViewImageTool: boolean;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  enableSearch: boolean;
  addDirs: string[];
  jsonEvents: boolean;
  skipGitRepoCheck: boolean;
  modelReasoningEffort: string | null;
}

export interface RunCodexFinalOpts extends BuildCodexExecCmdOpts {
  codexCliHome: string | null;
  timeoutSeconds: number;
  streamLimit?: number;
}

export interface IterCodexEventsOpts extends RunCodexFinalOpts {
  captureEvents?: boolean;
  eventCallback?: (evt: Record<string, unknown>) => void;
  stderrCallback?: (line: string) => void;
  signal?: AbortSignal;
}

function _buildEnv(codexCliHome: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (codexCliHome) {
    env.HOME = codexCliHome;
  }
  return env;
}

function _tomlEscapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function ensureCodexHome(opts: EnsureCodexHomeOpts): void {
  const { codexCliHome, trustedDir, defaultModel, modelReasoningEffort } = opts;
  if (!codexCliHome) return;

  const codexDir = path.join(codexCliHome, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });

  const destAuth = path.join(codexDir, "auth.json");
  if (!fs.existsSync(destAuth)) {
    const homeDir = process.env.HOME ?? homedir();
    const srcAuth = path.join(homeDir, ".codex", "auth.json");
    if (fs.existsSync(srcAuth)) {
      fs.copyFileSync(srcAuth, destAuth);
    }
  }

  const configPath = path.join(codexDir, "config.toml");
  const managedHome =
    path.resolve(codexCliHome) === path.resolve(_DEFAULT_CODEX_CLI_HOME);
  if (managedHome || !fs.existsSync(configPath)) {
    const trusted = _tomlEscapeString(path.resolve(trustedDir));
    const modelStr = _tomlEscapeString(defaultModel);
    const lines: string[] = [`model = "${modelStr}"`];
    if (modelReasoningEffort) {
      const effortStr = _tomlEscapeString(modelReasoningEffort);
      lines.push(`model_reasoning_effort = "${effortStr}"`);
    }
    lines.push("");
    if (managedHome) {
      lines.push("# Managed by codex-api; set CODEX_CLI_HOME to use your own config.");
      lines.push("");
    }
    lines.push(`[projects."${trusted}"]`);
    lines.push('trust_level = "trusted"');
    fs.writeFileSync(configPath, lines.join("\n") + "\n", "utf-8");
  }
}

export function buildCodexExecCmd(opts: BuildCodexExecCmdOpts): string[] {
  const {
    prompt,
    model,
    cd,
    images,
    disableShellTool,
    disableViewImageTool,
    sandbox,
    approvalPolicy,
    enableSearch,
    addDirs,
    jsonEvents,
    skipGitRepoCheck,
    modelReasoningEffort,
  } = opts;

  const cmd: string[] = [process.env.CODEX_BIN ?? "codex", "-a", approvalPolicy];
  if (disableShellTool) cmd.push("--disable", "shell_tool");
  if (disableViewImageTool) cmd.push("--disable", "view_image_tool");
  if (enableSearch) cmd.push("--search");

  cmd.push("exec");
  if (modelReasoningEffort) {
    cmd.push("-c", `model_reasoning_effort="${modelReasoningEffort}"`);
  }
  cmd.push(
    "--color",
    "never",
    "--sandbox",
    sandbox,
    "--model",
    model,
    "--cd",
    cd
  );
  if (skipGitRepoCheck) cmd.push("--skip-git-repo-check");
  for (const d of addDirs) cmd.push("--add-dir", d);
  if (images.length) {
    cmd.push("--image", ...images);
  }
  if (jsonEvents) cmd.push("--json");
  cmd.push(prompt);
  return cmd;
}

export function runCodexFinal(opts: RunCodexFinalOpts): Promise<CodexResult> {
  const {
    codexCliHome,
    timeoutSeconds,
    streamLimit = 8 * 1024 * 1024,
  } = opts;

  ensureCodexHome({
    codexCliHome,
    trustedDir: opts.cd,
    defaultModel: opts.model,
    modelReasoningEffort: opts.modelReasoningEffort,
  });

  const cmd = buildCodexExecCmd({ ...opts, jsonEvents: false });
  const env = _buildEnv(codexCliHome);

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    const timeoutId = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("codex exec timed out"));
    }, timeoutSeconds * 1000);

    proc.on("close", (code, signal) => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        const msg = stderr.trim() || `codex exec failed: ${code}`;
        reject(new RuntimeError(msg));
        return;
      }
      resolve({
        text: stdout.trim(),
        usage: null,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export async function* iterCodexEvents(
  opts: IterCodexEventsOpts
): AsyncGenerator<Record<string, unknown>> {
  ensureCodexHome({
    codexCliHome: opts.codexCliHome,
    trustedDir: opts.cd,
    defaultModel: opts.model,
    modelReasoningEffort: opts.modelReasoningEffort,
  });

  // stdin avoids the OS argument-size limit for long API conversations.
  const cmd = buildCodexExecCmd({ ...opts, prompt: "-", jsonEvents: true });
  let lastError: string | null = null;
  for await (const evt of iterStreamJsonEvents({
    cmd,
    env: opts.codexCliHome ? { CODEX_HOME: path.join(opts.codexCliHome, ".codex") } : undefined,
    stdinData: opts.prompt,
    timeoutMs: opts.timeoutSeconds * 1000,
    totalTimeoutMs: opts.timeoutSeconds * 1000,
    signal: opts.signal,
    eventCallback: opts.eventCallback,
    stderrCallback: opts.stderrCallback,
  })) {
    if (evt.type === "error" || evt.type === "turn.failed") {
      const err = evt.error as Record<string, unknown> | undefined;
      lastError = String(err?.message ?? evt.message ?? "codex exec failed");
      if (evt.type === "turn.failed") throw new Error(lastError);
    }
    yield opts.captureEvents ? { _event: evt } : evt;
  }
  if (lastError) throw new Error(lastError);
}

export async function collectCodexTextAndUsageFromEvents(
  events: AsyncIterable<Record<string, unknown>>
): Promise<CodexResult> {
  const textParts: string[] = [];
  let usage: Record<string, number> | null = null;

  for await (const evt of events) {
    const unwrapped = (evt as { _event?: Record<string, unknown> })._event ?? evt;
    if (unwrapped.type === "item.completed") {
      const item = (unwrapped.item as Record<string, unknown>) ?? {};
      if (
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        textParts.push(item.text);
      }
    }
    if (unwrapped.type === "turn.completed") {
      const rawUsage = (unwrapped.usage as Record<string, unknown>) ?? {};
      if (rawUsage && typeof rawUsage === "object") {
        const inTokens = Number(rawUsage.input_tokens ?? 0) || 0;
        const outTokens = Number(rawUsage.output_tokens ?? 0) || 0;
        usage = {
          prompt_tokens: inTokens,
          completion_tokens: outTokens,
          total_tokens: inTokens + outTokens,
        };
      }
    }
  }

  return {
    text: textParts.join("").trim(),
    usage,
  };
}
