import OpenAI from "openai";

const ollamaClient = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
  apiKey: "ollama",
});

const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";

export async function ollamaComplete(
  prompt: string,
  systemPrompt?: string,
  maxTokens: number = 4096
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

  return response.choices[0]?.message?.content || "";
}

export async function ollamaCompleteJSON<T>(
  prompt: string,
  systemPrompt?: string,
  maxTokens: number = 4096
): Promise<T> {
  const jsonSystemPrompt = `${systemPrompt || ""}

CRITICAL: Respond with ONLY valid JSON. No markdown code blocks, no explanation, no text before or after. Start your response with { and end with }`;

  const text = await ollamaComplete(prompt, jsonSystemPrompt, maxTokens);

  // Extract JSON from response (handles cases where model adds extra text)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in Ollama response: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(jsonMatch[0]) as T;
  } catch {
    // Try to fix common JSON issues
    const fixed = jsonMatch[0]
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]")
      .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":');
    return JSON.parse(fixed) as T;
  }
}
