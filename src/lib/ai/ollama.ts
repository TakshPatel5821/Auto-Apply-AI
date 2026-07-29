import OpenAI from "openai";

const ollamaClient = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
  apiKey: "ollama",
  // Local LLMs generating long output (full LaTeX résumés) regularly take longer
  // than 2 min — the old 120s cap was the main "Request timed out." cause.
  // Configurable via OLLAMA_TIMEOUT_MS; default 10 min.
  timeout: Number(process.env.OLLAMA_TIMEOUT_MS) || 600000,
  // ollamaCompleteJSON already retries on parse failures. Letting the SDK also
  // retry timeouts 2x compounded the wait to ~6 min per call before failing.
  maxRetries: 0,
});

const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";
// Use deepseek-coder for technical analysis — better at understanding tech stacks
const CODER_MODEL = process.env.OLLAMA_CODER_MODEL || "deepseek-coder:6.7b";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

export async function ollamaComplete(
  prompt: string,
  systemPrompt?: string,
  maxTokens = 4096
): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    { role: "user" as const, content: prompt },
  ];

  const response = await ollamaClient.chat.completions.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages,
    temperature: 0.1,
  });

  return response.choices[0]?.message?.content ?? "";
}

export async function ollamaCompleteJSON<T>(
  prompt: string,
  systemPrompt?: string,
  maxTokens = 4096,
  useCoder = false
): Promise<T> {
  const model = useCoder ? CODER_MODEL : MODEL;
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        {
          role: "system",
          content: `${systemPrompt ?? ""}

CRITICAL RULES:
- Respond with ONLY valid JSON. Nothing else.
- Start your response directly with {
- End with }
- No markdown, no code blocks, no explanation`,
        },
        { role: "user", content: prompt },
      ];

      const response = await ollamaClient.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages,
        temperature: attempt === 0 ? 0.05 : 0.15,
        // Ollama supports response_format for JSON mode
        response_format: { type: "json_object" },
      });

      const text = response.choices[0]?.message?.content ?? "";
      return parseJSONSafe<T>(text);
    } catch (e) {
      const msg = String(e);
      // If it's a parse error, retry; if it's a network/model error, throw immediately
      if (attempt === maxRetries - 1 || !msg.includes("JSON")) {
        throw e;
      }
      // Brief wait before retry
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }

  throw new Error("ollamaCompleteJSON: all retries exhausted");
}

function parseJSONSafe<T>(text: string): T {
  // Strip markdown code blocks if model adds them despite instructions
  let clean = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Extract the first { ... } block
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    clean = clean.slice(start, end + 1);
  }

  try {
    return JSON.parse(clean) as T;
  } catch {
    // Common fixes: trailing commas, unquoted keys, single quotes
    const fixed = clean
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ': "$1"');
    return JSON.parse(fixed) as T;
  }
}

// ─── Semantic embeddings (nomic-embed-text) ────────────────────────────────────
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await ollamaClient.embeddings.create({
    model: EMBED_MODEL,
    input: text.slice(0, 8192), // nomic-embed-text supports up to 8192 tokens
  });
  return response.data[0].embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Semantic similarity score 0-100 between two texts
export async function semanticScore(textA: string, textB: string): Promise<number> {
  const [embA, embB] = await Promise.all([
    generateEmbedding(textA),
    generateEmbedding(textB),
  ]);
  const sim = cosineSimilarity(embA, embB);
  // Convert cosine similarity (typically 0.5-1.0 for related text) to 0-100 scale
  return Math.round(Math.max(0, Math.min(100, (sim - 0.3) / 0.7 * 100)));
}
