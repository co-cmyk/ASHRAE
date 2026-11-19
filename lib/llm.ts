// Server-side client for any OpenAI-compatible chat endpoint serving Qwen3.5-2B
// (llama.cpp server on a Hugging Face Space, Ollama, vLLM, ...). Configure with env vars:
//   LLM_BASE_URL  e.g. https://you-qwen.hf.space/v1   (required to enable server mode)
//   LLM_API_KEY   bearer token (optional for Ollama)
//   LLM_MODEL     model name the server expects (default "qwen3.5-2b")
//   LLM_TIMEOUT_MS  default 55000
type Msg = { role: "system" | "user" | "assistant"; content: string };

export function llmConfig() {
  const base = (process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
  return {
    enabled: base.length > 0,
    base,
    key: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "qwen3.5-2b",
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 55000),
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 380),
  };
}

function body(messages: Msg[], stream: boolean) {
  const c = llmConfig();
  return JSON.stringify({
    model: c.model,
    messages,
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: c.maxTokens,
    stream,
    // Qwen3.5 small models answer without "thinking" by default; make it explicit for servers that honour it.
    chat_template_kwargs: { enable_thinking: false },
  });
}

function headers() {
  const c = llmConfig();
  return { "Content-Type": "application/json", ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}) };
}

/** Removes any <think>...</think> block a reasoning-enabled server might return. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();
}

export async function completeChat(messages: Msg[]): Promise<string> {
  const c = llmConfig();
  if (!c.enabled) throw new Error("LLM_BASE_URL is not set");
  const res = await fetch(`${c.base}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: body(messages, false),
    signal: AbortSignal.timeout(c.timeoutMs),
  });
  if (!res.ok) throw new Error(`LLM server returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return stripThinking(json.choices?.[0]?.message?.content ?? "");
}

/** Streams content deltas from an OpenAI-compatible SSE response, hiding <think> blocks. */
export async function* streamChat(messages: Msg[]): AsyncGenerator<string> {
  const c = llmConfig();
  if (!c.enabled) throw new Error("LLM_BASE_URL is not set");
  const res = await fetch(`${c.base}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: body(messages, true),
    signal: AbortSignal.timeout(c.timeoutMs),
  });
  if (!res.ok || !res.body) throw new Error(`LLM server returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let inThink = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const j = JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[] };
        let t = j.choices?.[0]?.delta?.content ?? "";
        if (!t) continue;
        if (t.includes("<think>")) {
          inThink = true;
          t = t.split("<think>")[0];
        }
        if (inThink) {
          if (t.includes("</think>")) {
            inThink = false;
            t = t.split("</think>").pop() ?? "";
          } else continue;
        }
        if (t) yield t;
      } catch {
        /* ignore keep-alive or partial lines */
      }
    }
  }
}
