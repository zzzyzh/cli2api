/** Keep OpenCode's presentation layer out of the Claude Code prompt. */
import type { ChatMessage } from "./openai-compat.js";
import { normalizeMessageContent } from "./openai-compat.js";

export type ProjectClaudeInput =
  | { kind: "title"; title: string }
  | { kind: "prompt"; prompt: string };

function messageText(message: ChatMessage): string {
  const text = normalizeMessageContent(message.content);
  // OpenCode V2 JSON-encodes text parts before sending them to OpenAI-compatible providers.
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(text);
      if (typeof decoded === "string") return decoded;
    } catch {
      // A literal quoted message is still valid input.
    }
  }
  return text;
}

export function projectClaudeInput(messages: ChatMessage[]): ProjectClaudeInput | null {
  const first = messages[0];
  if (!first || first.role !== "system") return null;
  const system = normalizeMessageContent(first.content);
  if (system.startsWith("You are a title generator. You output ONLY a thread title.")) {
    const user = messages.find((message) => message.role === "user");
    const title = Array.from(user ? messageText(user).trim() : "New conversation")
      .slice(0, 48).join("") || "New conversation";
    return { kind: "title", title };
  }
  if (!system.startsWith("You are an AI agent running in OpenCode, a coding agent harness.")) {
    return null;
  }
  const turns = messages.filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: messageText(message) }))
    .filter((message) => message.content.trim());
  if (turns.length === 0) return { kind: "prompt", prompt: "" };
  if (turns.length === 1 && turns[0].role === "user") {
    return { kind: "prompt", prompt: turns[0].content };
  }
  return {
    kind: "prompt",
    prompt: turns.map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`).join("\n\n"),
  };
}
