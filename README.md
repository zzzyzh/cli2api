# CursorCLI2API

将 Cursor Agent CLI 反代为 OpenAI / Anthropic 兼容的 HTTP API 网关。同时支持 Codex、Claude Code、Gemini CLI 作为 Provider。

## 工作原理

```
客户端 (Cherry Studio / OpenAI SDK / ...)
    │
    │  标准 OpenAI / Anthropic HTTP 请求
    ▼
┌──────────────────────────────┐
│  CursorCLI2API  (Hono)       │
│  - 认证 (Bearer Token)       │
│  - 并发控制 (信号量)          │
│  - SSE 流式 / JSON 响应      │
│  - Tool Call 模拟 (Cursor)   │
└──────────┬───────────────────┘
           │
     ┌─────┼─────┬──────────┐
     ▼     ▼     ▼          ▼
   Codex  Claude  Gemini  Cursor Agent
   (CLI)  (CLI)   (CLI)   (CLI subprocess)
```

每个请求通过 `child_process.spawn` 启动对应 CLI，解析 NDJSON/stream-json 输出，转换为标准 OpenAI SSE 格式返回。

## 功能特性

- **OpenAI 兼容** — `POST /v1/chat/completions`、`POST /v1/responses`
- **Anthropic 兼容** — `POST /v1/messages`（流式和非流式）
- **多 Provider** — Cursor Agent、Codex、Claude Code、Gemini CLI
- **SSE 流式** — Claude Code 文本与可用的思考增量、心跳、缓存 token 用量统计；避免重复输出
- **本地 OpenCode 接入** — OpenCode 连接远程网关；项目模式下由远程 Claude Code 执行模型请求和工具操作
- **模型映射** — 公共模型 ID 可映射到 Claude 模型与独立的 `--effort` 强度
- **客户端断连取消** — 客户端断开时自动终止子进程，不浪费资源
- **优雅关闭** — SIGTERM/SIGINT 时 clean shutdown，不留僵尸进程
- **Tool Call** — Cursor Agent 与 Claude CLI 通过提示工程实现标准 function calling
- **OAuth 直连** — Claude OAuth API、Gemini Cloud Code API
- **并发控制** — 可配置最大并发数
- **认证** — 可选 Bearer Token 鉴权
- **预设系统** — 一键应用推荐配置

## 前置要求

- **Node.js >= 20**
- 安装 Cursor Agent CLI：

```bash
curl https://cursor.com/install -fsS | bash
agent login    # 或准备 CURSOR_API_KEY
```

## 快速开始

### 1. 安装

```bash
cd ~/project/cursorcli2api
npm install
```

### 2. 环境检查

```bash
npm run doctor
```

### 3. 配置

```bash
cp .env.example .env
# 编辑 .env 设置 CODEX_GATEWAY_TOKEN 等
```

### 4. 启动

```bash
# 开发模式（Cursor Agent）
npm run dev -- cursor-agent --host 0.0.0.0

# 指定模型和 token
CODEX_GATEWAY_TOKEN=sk-your-key \
CODEX_ADVERTISED_MODELS="auto,gpt-5.4-medium,claude-4.6-sonnet-medium" \
npm run dev -- cursor-agent --host 0.0.0.0

# 生产模式
npm run build
npm start
```

服务默认监听 `http://0.0.0.0:8000`。

### 5. 测试

```bash
# 健康检查
curl http://127.0.0.1:8000/healthz

# 单元测试
npm test
```

服务启动后可通过 `Ctrl+C` 优雅关闭 — 停止接受新请求后等待活跃请求完成，然后清理连接池退出。

## 流式与非流式

两种模式均支持。OpenCode 等聊天界面可使用 `stream: true` 接收 Claude Code 的文本增量，以及 CLI 实际返回的思考增量。网关在内部工具事件期间发送 SSE 心跳，避免长时间没有可见文本时客户端超时；完整消息快照不会重复输出。只需要一次性 JSON 响应时使用 `stream: false`。

```bash
# 非流式
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude:sonnet","messages":[{"role":"user","content":"你好"}],"stream":false}'

# 流式
curl -N http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude:sonnet","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## API 端点

| 方法 | 路径 | 描述 |
|------|------|------|
| `GET` | `/healthz` | 健康检查 |
| `GET` | `/v1/models` | 列出可用模型 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `GET` | `/debug/config` | 查看当前配置 |

## 客户端对接

### OpenCode：本地界面与远程 Claude Code

在运行 Claude Code CLI 且已完成登录的主机上启动网关。本地 OpenCode 配置自定义 OpenAI 兼容 Provider，Base URL 指向 `http://<gateway-host>:8000/v1`，API Key 填写 `CODEX_GATEWAY_TOKEN`。本地 OpenCode 负责会话界面，模型请求在网关主机执行。启用下述项目模式后，远程 Claude Code 可以使用原生工具读取它有权访问的项目；若项目只能通过另一台机器的 SSH 访问，需要自行配置项目访问桥接，SSH 凭证可保留在本地。

以下是网关侧的通用模型映射示例，地址和密钥由部署环境设置：

```bash
CODEX_PROVIDER=auto
CODEX_MODEL_ALIASES='{"remote-sonnet-high":"claude:sonnet"}'
CODEX_ADVERTISED_MODELS=remote-sonnet-high
CLAUDE_MODEL_EFFORTS='{"remote-sonnet-high":"high"}'
CODEX_GATEWAY_TOKEN=your-secret-token
```

在 OpenCode 中添加模型 ID `remote-sonnet-high`。为远程 Claude Code 的原生工具配置项目访问后，可选设 `CODEX_CLAUDE_PROJECT_BRIDGE=1`：网关会跳过 OpenCode 自身的通用 Agent 提示和工具定义，将对话交给远程 Claude Code，并在本地回答标题生成请求。工具权限仍由远程 Claude Code 与所配置的项目桥接管理。

### Cherry Studio / NextChat / ChatBox

| 配置项 | 值 |
|--------|-----|
| API Base URL | `http://127.0.0.1:8000/v1` |
| API Key | 你设置的 `CODEX_GATEWAY_TOKEN` |
| Model | `auto` 或从列表选择 |

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="sk-your-key")

# 对话
resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)

# 流式
for chunk in client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")

# Tool Call
resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "北京天气"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "获取天气",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }],
)
if resp.choices[0].finish_reason == "tool_calls":
    print(resp.choices[0].message.tool_calls)
```

### Python (Anthropic SDK)

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8000/v1", api_key="sk-your-key")
msg = client.messages.create(
    model="auto", max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content[0].text)
```

## Tool Call 说明

Cursor Agent 通过**提示工程**实现了 OpenAI 标准 function calling：

1. 请求中的 `tools` 定义注入到 prompt
2. 模型用特定标记格式输出工具调用
3. 服务端解析标记，转换为标准 `tool_calls` 返回
4. 客户端发送 `tool` 角色结果后继续对话

支持嵌套 JSON 参数、多轮调用、流式和非流式。每次限调一个工具。

## 配置预设

| 预设 | Provider | 模型 | 说明 |
|------|----------|------|------|
| `cursor-auto` | cursor-agent | auto | 自动选模型，高并发（默认） |
| `cursor-fast` | cursor-agent | gpt-5.3-codex | 固定快速模型 |
| `codex-fast` | codex | gpt-5.2 | Codex 低推理，高并发 |
| `claude-oauth` | claude | — | Claude OAuth 直连 |
| `gemini-cloudcode` | gemini | gemini-3-flash-preview | Gemini 直连 |

## 环境变量

详见 [`.env.example`](.env.example)，关键变量：

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `CODEX_GATEWAY_TOKEN` | — | Bearer Token 鉴权（空=无鉴权） |
| `CODEX_PROVIDER` | `auto` | Provider: `cursor-agent`/`codex`/`claude`/`gemini` |
| `CODEX_PRESET` | — | 预设名 |
| `CURSOR_AGENT_BIN` | `cursor-agent` | CLI 路径 |
| `CURSOR_AGENT_WORKSPACE` | — | 工作目录（建议 `/tmp/cursor-empty-workspace`） |
| `CURSOR_AGENT_API_KEY` | — | Cursor API Key |
| `CURSOR_AGENT_MODEL` | — | 默认模型 |
| `CODEX_ADVERTISED_MODELS` | — | `/v1/models` 返回的模型列表 |
| `CODEX_MAX_CONCURRENCY` | `100` | 最大并发 |
| `CODEX_TIMEOUT_SECONDS` | `600` | 请求超时 |

## Provider 路由

```json
{"model": "auto"}                                  // 默认 Provider
{"model": "cursor-agent:claude-4.6-sonnet-medium"}  // 指定 Cursor + 模型
{"model": "claude:sonnet"}                          // Claude Code
{"model": "gemini:gemini-3-flash-preview"}          // Gemini
```

需设置 `CODEX_ALLOW_CLIENT_PROVIDER_OVERRIDE=true`。

## 部署

### WSL2 + Windows

```bash
npm run dev -- cursor-agent --host 0.0.0.0
# Windows 浏览器访问 http://localhost:8000/healthz
```

### systemd

```ini
# /etc/systemd/system/cursorcli2api.service
[Unit]
Description=CursorCLI2API
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/home/your-user/project/cursorcli2api
ExecStart=/usr/bin/node dist/cli.js cursor-agent --host 0.0.0.0
Restart=always
EnvironmentFile=/home/your-user/project/cursorcli2api/.env

[Install]
WantedBy=multi-user.target
```

```bash
npm run build
sudo systemctl enable --now cursorcli2api
```

## 项目结构

```
cursorcli2api/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
├── src/
│   ├── cli.ts                  # CLI 入口
│   ├── server.ts               # HTTP 服务器 + 路由 + 请求处理
│   ├── config.ts               # 环境变量 + 预设
│   ├── doctor.ts               # 诊断工具
│   ├── index.ts                # 模块导出
│   ├── lib/
│   │   ├── openai-compat.ts    # OpenAI 格式转换 + Tool Call
│   │   ├── anthropic-compat.ts # Anthropic 格式转换
│   │   └── http-client.ts      # HTTP 客户端
│   ├── providers/
│   │   ├── stream-json-cli.ts  # NDJSON 流解析器
│   │   ├── codex-cli.ts        # Codex CLI
│   │   ├── codex-responses.ts  # Codex Responses API
│   │   ├── claude-oauth.ts     # Claude OAuth
│   │   └── gemini-cloudcode.ts # Gemini Cloud Code
│   └── codex_instructions/     # 系统指令模板
├── tests/
│   ├── openai-compat.test.ts    # OpenAI 兼容层测试
│   ├── claude-oauth.test.ts     # Claude OAuth 测试
│   └── stream-json-cli.test.ts  # 子进程生命周期测试
└── dist/                       # 编译输出
```

## License

MIT


## 致谢

本项目受到 [LINUX DO](https://linux.do/) 社区的启发和支持。
