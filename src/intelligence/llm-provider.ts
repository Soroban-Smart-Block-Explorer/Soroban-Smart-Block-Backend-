import axios from 'axios';
import { config } from '../config';

export interface LlmDescriptionResult {
  description: string;
  provider: string;
  cached: boolean;
  cost?: number;
}

interface CacheEntry {
  result: LlmDescriptionResult;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const descriptionCache = new Map<string, CacheEntry>();
let totalCostUsd = 0;
let requestCount = 0;
const RATE_LIMIT_PER_MIN = 20;
const requestTimestamps: number[] = [];

function checkRateLimit(): boolean {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - 60_000) {
    requestTimestamps.shift();
  }
  return requestTimestamps.length < RATE_LIMIT_PER_MIN;
}

function buildPrompt(functionNames: string[], category: string): string {
  return `You are an expert Soroban/Stellar smart contract analyst.

Given the following contract with category "${category}" and functions: ${functionNames.join(', ')}

Write a concise 1-2 sentence human-readable description of what this contract does.
Be specific. Reference actual function names where helpful.
Return only the description text, no preamble.`;
}

async function tryOpenAi(prompt: string): Promise<{ text: string; costUsd: number } | null> {
  const apiKey = config.openAiApiKey;
  if (!apiKey) return null;

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.3,
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10_000 },
    );
    const text = res.data.choices?.[0]?.message?.content?.trim() ?? '';
    const tokens = res.data.usage?.total_tokens ?? 0;
    const costUsd = (tokens / 1_000_000) * 0.15;
    return { text, costUsd };
  } catch {
    return null;
  }
}

async function tryAnthropic(prompt: string): Promise<{ text: string; costUsd: number } | null> {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) return null;

  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 10_000,
      },
    );
    const text = res.data.content?.[0]?.text?.trim() ?? '';
    const inputTokens = res.data.usage?.input_tokens ?? 0;
    const outputTokens = res.data.usage?.output_tokens ?? 0;
    const costUsd = (inputTokens * 0.00025 + outputTokens * 0.00125) / 1000;
    return { text, costUsd };
  } catch {
    return null;
  }
}

export async function getLlmDescription(
  address: string,
  functionNames: string[],
  category: string,
): Promise<LlmDescriptionResult | null> {
  const cacheKey = `${address}:${category}`;
  const cached = descriptionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }

  if (!checkRateLimit()) return null;

  const prompt = buildPrompt(functionNames, category);

  let result: { text: string; costUsd: number } | null = null;
  let provider = '';

  result = await tryAnthropic(prompt);
  if (result) {
    provider = 'anthropic';
  } else {
    result = await tryOpenAi(prompt);
    if (result) provider = 'openai';
  }

  if (!result) return null;

  requestTimestamps.push(Date.now());
  requestCount++;
  totalCostUsd += result.costUsd;

  const entry: LlmDescriptionResult = {
    description: result.text,
    provider,
    cached: false,
    cost: result.costUsd,
  };

  descriptionCache.set(cacheKey, { result: entry, expiresAt: Date.now() + CACHE_TTL_MS });
  return entry;
}

export function getLlmStats() {
  return { totalCostUsd, requestCount, cachedEntries: descriptionCache.size };
}
