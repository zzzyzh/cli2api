import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configDir = resolve(process.env.CLI2API_CONFIG_DIR ?? join(root, ".config"));
const cliPath = join(root, "src", "cli.ts");
type Source = "codex" | "cursor";
interface Connection {
  provider: Source;
  api_format: "openai";
  base_url: string;
  api_key: string;
  model: string;
  upstream_model: string;
  reasoning_effort: string;
  context_window_tokens?: number;
  host: string;
  port: number;
  pid: number;
  log_file: string;
  verified_at: string | null;
}
interface Options {
  model?: string;
  effort?: string;
  context?: string;
  port?: string;
  host: string;
  stop: boolean;
  verify: boolean;
}

function readConnection(source: Source): Connection | null {
  const path = join(configDir, `${source}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Connection : null;
}

function isOurProcess(pid: number): boolean {
  // A saved PID may have been reused after reboot. Never stop another service.
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(cliPath);
  } catch {
    return false;
  }
}

async function stop(connection: Connection): Promise<void> {
  if (!isOurProcess(connection.pid)) return;
  process.kill(-connection.pid, "SIGTERM");
  for (let i = 0; i < 50 && isOurProcess(connection.pid); i++) await delay(100);
  if (isOurProcess(connection.pid)) throw new Error(`进程 ${connection.pid} 尚未退出，请稍后重试。`);
}

function localUrl(connection: Pick<Connection, "host" | "port">): string {
  const host = connection.host === "0.0.0.0" || connection.host === "::" ? "127.0.0.1" : connection.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${connection.port}`;
}

async function ready(connection: Connection): Promise<boolean> {
  try {
    const resp = await fetch(`${localUrl(connection)}/v1/models`, {
      headers: { Authorization: `Bearer ${connection.api_key}` },
      signal: AbortSignal.timeout(1000),
    });
    const body = await resp.json() as { data?: { id: string }[] };
    return resp.ok && Boolean(body.data?.some((model) => model.id === connection.model));
  } catch {
    return false;
  }
}

async function assertFreePort(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => server.close((err) => err ? reject(err) : resolve()));
  });
}

async function verify(connection: Connection): Promise<void> {
  const resp = await fetch(`${localUrl(connection)}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: connection.model,
      messages: [{ role: "user", content: "Reply with exactly CLI2API_OK. Do not use tools." }],
      stream: false,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await resp.json() as { error?: unknown; choices?: { message?: { content?: string } }[] };
  if (!resp.ok || body.error || !body.choices?.[0]?.message?.content?.includes("CLI2API_OK")) {
    throw new Error(`模型调用验证失败：${JSON.stringify(body)}`);
  }
  connection.verified_at = new Date().toISOString();
}

async function start(source: Source, options: Options): Promise<void> {
  const upstreamModel = options.model ?? (source === "codex" ? "gpt-6.1-sol" : "grok-4.7");
  const effort = options.effort ?? (source === "codex" ? "xhigh" : "high");
  const context = options.context ?? "500k";
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`不支持的 effort：${effort}`);
  const contextMatch = /^(\d+)([km])?$/i.exec(context);
  if (!contextMatch || Number(contextMatch[1]) <= 0) throw new Error(`无效的上下文大小：${context}`);
  const contextTokens = Number(contextMatch[1]) * ({ k: 1000, m: 1_000_000 }[contextMatch[2]?.toLowerCase() ?? ""] ?? 1);
  // Cursor's legacy --model slugs reset context to 256K. Parameterized model
  // selection belongs in a dedicated CLI config, with --model omitted.
  const model = source === "cursor" ? `${upstreamModel}-${effort}-${context}` : upstreamModel;
  const port = Number(options.port ?? (source === "codex" ? 18081 : 18082));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`无效端口：${port}`);

  const previous = readConnection(source);
  if (previous && previous.model === model && previous.reasoning_effort === effort &&
      previous.host === options.host && previous.port === port && isOurProcess(previous.pid) && await ready(previous)) {
    if (options.verify && !previous.verified_at) {
      await verify(previous);
      writeFileSync(join(configDir, `${source}.json`), JSON.stringify(previous, null, 2) + "\n", { mode: 0o600 });
    }
    console.log(`${source}: ${previous.base_url}  model=${model}（已运行）`);
    return;
  }

  const binary = source === "codex" ? process.env.CODEX_BIN ?? "codex" : process.env.CURSOR_AGENT_BIN ?? "cursor-agent";
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (version.error || version.status !== 0) throw new Error(`无法运行 ${binary}，请先安装并登录对应 CLI。`);
  if (previous) await stop(previous);
  await assertFreePort(options.host, port);

  const workspace = join(configDir, "workspaces", source);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_PRESET: "export-cli",
    CODEX_NO_DOTENV: "1",
    CODEX_MODEL: source === "codex" ? upstreamModel : model,
    CODEX_MODEL_REASONING_EFFORT: effort,
    CODEX_FORCE_REASONING_EFFORT: effort,
    CODEX_USE_SYSTEM_CODEX_HOME: "1",
    CODEX_USE_CODEX_RESPONSES_API: "0",
    CODEX_FORCE_CLI: "1",
    CODEX_DISABLE_SHELL_TOOL: "1",
    CODEX_DISABLE_VIEW_IMAGE_TOOL: "0", // Removed feature flag in current Codex CLI.
    CODEX_SANDBOX: "read-only",
    CODEX_APPROVAL_POLICY: "never",
    CODEX_SKIP_GIT_REPO_CHECK: "1",
    CODEX_ALLOW_CLIENT_MODEL_OVERRIDE: "0",
    CODEX_ALLOW_CLIENT_PROVIDER_OVERRIDE: "0",
    CODEX_MODEL_ALIASES: "{}",
    CODEX_ADVERTISED_MODELS: model,
    CODEX_WORKSPACE: workspace,
    CODEX_MAX_PROMPT_CHARS: process.env.CODEX_MAX_PROMPT_CHARS ?? "4000000",
    CODEX_MAX_CONCURRENCY: process.env.CODEX_MAX_CONCURRENCY ?? "4",
    CODEX_LOG_MODE: "summary",
    CODEX_LOG_REQUEST_CURL: "0",
  };
  if (source === "cursor") {
    const cursorConfigDir = join(configDir, "cursor-cli");
    mkdirSync(cursorConfigDir, { recursive: true, mode: 0o700 });
    const parameters = [
      { id: "context", value: context },
      { id: "reasoning_effort", value: effort },
      { id: "fast", value: "false" },
    ];
    // Only model selection is written; login credentials stay in the CLI store.
    writeFileSync(join(cursorConfigDir, "cli-config.json"), JSON.stringify({
      version: 1,
      model: { modelId: upstreamModel, displayModelId: upstreamModel },
      modelParameters: { [upstreamModel]: parameters },
      selectedModel: { modelId: upstreamModel, parameters },
    }, null, 2) + "\n", { mode: 0o600 });
    Object.assign(env, {
      CURSOR_CONFIG_DIR: cursorConfigDir,
      CURSOR_AGENT_MODEL: model,
      CURSOR_AGENT_USE_CONFIG_MODEL: "1",
      CURSOR_AGENT_WORKSPACE: workspace,
      CURSOR_AGENT_DISABLE_INDEXING: "0", // Current CLI no longer accepts this flag.
      CURSOR_AGENT_EXTRA_ARGS: "--mode ask",
    });
  }

  const connection: Connection = {
    provider: source,
    api_format: "openai",
    base_url: `${localUrl({ host: options.host, port })}/v1`,
    api_key: process.env.CODEX_GATEWAY_TOKEN || previous?.api_key || `sk-cli2api-${randomBytes(24).toString("hex")}`,
    model,
    upstream_model: upstreamModel,
    reasoning_effort: effort,
    ...(source === "cursor" ? { context_window_tokens: contextTokens } : {}),
    host: options.host,
    port,
    pid: 0,
    log_file: join(configDir, `${source}.log`),
    verified_at: null,
  };
  env.CODEX_GATEWAY_TOKEN = connection.api_key;
  const log = openSync(connection.log_file, "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, source === "cursor" ? "cursor-agent" : "codex",
    "--host", options.host, "--port", String(port)], {
    cwd: root, env, detached: true, stdio: ["ignore", log, log],
  });
  closeSync(log);
  connection.pid = child.pid!;
  let launchError: Error | undefined;
  child.on("error", (err) => { launchError = err; });
  child.unref();

  try {
    let started = false;
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`网关退出：${child.exitCode}`);
      if (await ready(connection)) { started = true; break; }
      await delay(200);
    }
    if (!started) throw new Error("等待网关启动超时");
    if (options.verify) {
      console.log(`${source}: 正在验证 ${model}…`);
      await verify(connection);
    }
    const path = join(configDir, `${source}.json`);
    writeFileSync(path, JSON.stringify(connection, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    console.log(`${source}: ${connection.base_url}  model=${model}\n配置：${path}`);
  } catch (err) {
    await stop(connection);
    throw new Error(`${String(err)}\n日志：${connection.log_file}`);
  }
}

async function main(): Promise<void> {
  const program = new Command()
    .name("./export.sh")
    .description("将本机 Codex/Cursor CLI 导出为后台运行的 OpenAI 兼容 API")
    .argument("[source]", "all | codex | cursor", "all")
    .option("--model <id>", "CLI 模型 ID（Cursor 使用参数化基础 ID，如 grok-4.7）")
    .option("--effort <level>", "推理强度；Codex 默认 xhigh，Cursor 默认 high")
    .option("--context <size>", "Cursor 上下文；默认 500k")
    .option("--port <port>", "端口；Codex 默认 18081，Cursor 默认 18082")
    .option("--host <host>", "监听地址", "127.0.0.1")
    .option("--stop", "停止已导出的服务", false)
    .option("--no-verify", "跳过真实模型调用验证，仍检查 HTTP 就绪")
    .parse();
  const source = program.processedArgs[0] as string;
  if (!["all", "codex", "cursor", "cursor-agent"].includes(source)) throw new Error(`未知来源：${source}`);
  const options = program.opts<Options>();
  if (source === "all" && (options.model || options.port || options.effort || options.context)) {
    throw new Error("指定模型、端口或推理参数时，请单独选择 codex 或 cursor。");
  }
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  const sources: Source[] = source === "all" ? ["codex", "cursor"] : [source === "cursor-agent" ? "cursor" : source as Source];
  let failed = false;
  for (const item of sources) {
    try {
      if (options.stop) {
        const connection = readConnection(item);
        if (connection) await stop(connection);
        console.log(`${item}: 已停止`);
      } else {
        await start(item, options);
      }
    } catch (err) {
      failed = true;
      console.error(`${item}: ${String(err)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => { console.error(String(err)); process.exitCode = 1; });
