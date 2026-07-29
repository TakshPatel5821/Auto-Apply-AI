import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

export async function openaiComplete(
  prompt: string,
  systemPrompt?: string,
  maxTokens: number = 4096
): Promise<string> {
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [
      ...(systemPrompt
        ? [{ role: "system" as const, content: systemPrompt }]
        : []),
      { role: "user" as const, content: prompt },
    ],
  });

  return response.choices[0]?.message?.content || "";
}

export async function openaiCompleteJSON<T>(
  prompt: string,
  systemPrompt?: string,
  maxTokens: number = 4096
): Promise<T> {
  const jsonSystemPrompt = `${systemPrompt || ""}

Respond with ONLY valid JSON. No markdown, no explanation.`;

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system" as const, content: jsonSystemPrompt },
      { role: "user" as const, content: prompt },
    ],
  });

  const text = response.choices[0]?.message?.content || "{}";
  return JSON.parse(text) as T;
}
