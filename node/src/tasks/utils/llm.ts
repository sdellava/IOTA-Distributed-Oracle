// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { normalizeJsonCanonical } from "./json";
import { validateAgainstSchema } from "./schema";
import { httpFetchBytes } from "../../http";

function envInt(name: string, def: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

function parseJsonObject(text: string): any {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("Empty LLM response");

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`LLM response is not valid JSON: ${trimmed.slice(0, 300)}`);
    return JSON.parse(match[0]);
  }
}

function extractMessageContent(payload: any): string {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;

  const choice0 = payload?.choices?.[0]?.message?.content;
  if (typeof choice0 === "string" && choice0.trim()) return choice0;
  if (Array.isArray(choice0)) {
    const joined = choice0
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }

  const output = payload?.output;
  if (Array.isArray(output)) {
    // Prefer "message" items over "reasoning" items to avoid extracting thinking text.
    const sorted = [...output].sort((a: any, b: any) => (a?.type === "message" ? -1 : b?.type === "message" ? 1 : 0));
    for (const block of sorted) {
      const parts = Array.isArray(block?.content) ? block.content : [];
      const joined = parts
        .map((part: any) => {
          if (typeof part?.text === "string") return part.text;
          if (typeof part === "string") return part;
          return "";
        })
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }

  throw new Error(`Unsupported LLM response payload: ${JSON.stringify(payload).slice(0, 400)}`);
}

function parseFallbackModels(): string[] {
  const raw = process.env.LLM_MODEL_FALLBACK?.trim();
  if (!raw) return [];
  return raw.split(",").map((m) => m.trim()).filter(Boolean);
}

function isRetryableError(status: number, body?: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503) return true;
  if (status === 400 && body) {
    const t = body.toLowerCase();
    if (t.includes("provider returned error") || t.includes("not a valid model")) return true;
  }
  return false;
}

function parseLlmPlugins(): any[] | undefined {
  const raw = process.env.LLM_PLUGINS_JSON?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed;
  } catch (e: any) {
    throw new Error(`Invalid LLM_PLUGINS_JSON: ${String(e?.message ?? e)}`);
  }
}

function parseExtraHeaders(): Record<string, string> {
  const raw = process.env.LLM_API_HEADERS_JSON?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const key = String(k ?? "").trim();
      if (!key || v == null) continue;
      const value = String(v).trim();
      if (!value) continue;
      out[key] = value;
    }
    return out;
  } catch (e: any) {
    throw new Error(`Invalid LLM_API_HEADERS_JSON: ${String(e?.message ?? e)}`);
  }
}

function resolveResponsesApiUrl(): string {
  const explicit = process.env.LLM_RESPONSES_API_URL?.trim();
  if (explicit) return explicit;

  const apiUrl = process.env.LLM_API_URL?.trim() || "";
  if (apiUrl.includes("/chat/completions")) {
    return apiUrl.replace(/\/chat\/completions\/?$/i, "/responses");
  }
  if (apiUrl.endsWith("/responses")) return apiUrl;
  if (apiUrl) return apiUrl;
  return "https://api.openai.com/v1/responses";
}

function extractResponseApiText(payload: any): string {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;

  const output = Array.isArray(payload?.output) ? payload.output : [];
  // Prefer "message" items over "reasoning" items to avoid extracting thinking text.
  const sorted = [...output].sort((a, b) => (a?.type === "message" ? -1 : b?.type === "message" ? 1 : 0));
  for (const item of sorted) {
    const parts = Array.isArray(item?.content) ? item.content : [];
    const joined = parts
      .map((part: any) => {
        if (typeof part?.text === "string") return part.text;
        if (typeof part === "string") return part;
        return "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }

  throw new Error(`Unsupported Responses payload: ${JSON.stringify(payload).slice(0, 400)}`);
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || "document.pdf";
    return last.toLowerCase().endsWith(".pdf") ? last : `${last}.pdf`;
  } catch {
    return "document.pdf";
  }
}

export async function callLlmJson(opts: {
  taskName: string;
  prompt: string;
  schema: any;
  llmConfig?: any;
  normalization?: any;
}): Promise<{ parsed: any; canonical: string; rawText: string }> {
  const apiUrl = process.env.LLM_API_URL?.trim();
  const primaryModel = String(opts.llmConfig?.model ?? process.env.LLM_MODEL ?? "").trim();
  if (!apiUrl) throw new Error("Missing env LLM_API_URL");
  if (!primaryModel) throw new Error("Missing env LLM_MODEL");

  const models = [primaryModel, ...parseFallbackModels()];
  const timeoutMs = Math.max(1_000, Number(opts.llmConfig?.timeoutMs ?? opts.llmConfig?.timeout_ms ?? envInt("LLM_TIMEOUT_MS", 60_000)));
  const temperature = Number(opts.llmConfig?.temperature ?? 0);
  const topP = Number(opts.llmConfig?.top_p ?? opts.llmConfig?.topP ?? 1);
  const maxTokens = Number(opts.llmConfig?.max_output_tokens ?? opts.llmConfig?.maxTokens ?? envInt("LLM_MAX_OUTPUT_TOKENS", 400));
  const apiKey = process.env.LLM_API_KEY?.trim();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...parseExtraHeaders(),
  };
  if (apiKey && !headers.Authorization) headers.Authorization = `Bearer ${apiKey}`;

  const plugins = parseLlmPlugins();

  let lastError: Error | undefined;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const isLastModel = i === models.length - 1;
    const body: Record<string, any> = {
      model,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a deterministic extraction engine. Return only valid JSON. Do not add markdown, commentary, or code fences.",
        },
        {
          role: "user",
          content: opts.prompt,
        },
      ],
    };
    if (plugins) body.plugins = plugins;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers,
        redirect: "error",
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        if (isRetryableError(res.status, raw) && !isLastModel) {
          lastError = new Error(`LLM HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 600)}`);
          continue;
        }
        throw new Error(`LLM HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 600)}`);
      }

      let parsedPayload: any;
      try {
        parsedPayload = JSON.parse(raw);
      } catch (e: any) {
        throw new Error(`Invalid LLM JSON envelope: ${String(e?.message ?? e)} | ${raw.slice(0, 400)}`);
      }

      const rawText = extractMessageContent(parsedPayload);
      const parsed = parseJsonObject(rawText);
      validateAgainstSchema(parsed, opts.schema);
      const normalizedInput = JSON.parse(JSON.stringify(parsed));
      const canonical = normalizeJsonCanonical(normalizedInput, opts.normalization ?? { canonical: true, dropNulls: false, sortArrays: true });
      return { parsed, canonical, rawText };
    } catch (e: any) {
      lastError = e;
      if (!isLastModel && (e?.name === "AbortError" || isRetryableError(Number(String(e?.message).match(/HTTP (\d+)/)?.[1]), String(e?.message)))) {
        continue;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastError ?? new Error("LLM call failed: no models available");
}

export async function callLlmJsonWithPdfUrl(opts: {
  taskName: string;
  prompt: string;
  schema: any;
  pdfUrl: string;
  llmConfig?: any;
  normalization?: any;
}): Promise<{ parsed: any; canonical: string; rawText: string }> {
  const apiUrl = resolveResponsesApiUrl();
  const primaryModel = String(opts.llmConfig?.model ?? process.env.LLM_MODEL ?? "").trim();
  if (!apiUrl) throw new Error("Missing env LLM_RESPONSES_API_URL/LLM_API_URL");
  if (!primaryModel) throw new Error("Missing env LLM_MODEL");

  const models = [primaryModel, ...parseFallbackModels()];
  const timeoutMs = Math.max(
    1_000,
    Number(opts.llmConfig?.timeoutMs ?? opts.llmConfig?.timeout_ms ?? envInt("LLM_TIMEOUT_MS", 60_000)),
  );
  const temperature = Number(opts.llmConfig?.temperature ?? 0);
  const topP = Number(opts.llmConfig?.top_p ?? opts.llmConfig?.topP ?? 1);
  const maxTokens = Number(
    opts.llmConfig?.max_output_tokens ?? opts.llmConfig?.maxTokens ?? envInt("LLM_MAX_OUTPUT_TOKENS", 400),
  );
  const apiKey = process.env.LLM_API_KEY?.trim();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...parseExtraHeaders(),
  };
  if (apiKey && !headers.Authorization) headers.Authorization = `Bearer ${apiKey}`;

  const plugins = parseLlmPlugins();
  const buildBody = (model: string, fileInput: { type: "input_file"; file_data: string; filename: string }) => {
    const b: Record<string, any> = {
      model,
      temperature,
      top_p: topP,
      max_output_tokens: maxTokens,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You are a deterministic extraction engine. Return only valid JSON with no markdown or prose.",
            },
          ],
        },
        {
          role: "user",
          content: [
            fileInput,
            { type: "input_text", text: opts.prompt },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "oracle_output",
          schema: opts.schema,
          strict: true,
        },
      },
    };
    if (plugins) b.plugins = plugins;
    return b;
  };

  // Download once under the node's SSRF policy, including redirects and DNS pinning.
  // Do not delegate arbitrary task URLs to a provider on a potentially private network.
  const fetched = await httpFetchBytes({ url: opts.pdfUrl, timeoutMs: 30_000, maxBytes: 25_000_000 });
  const fileInput = {
    type: "input_file" as const,
    filename: filenameFromUrl(opts.pdfUrl),
    file_data: `data:application/pdf;base64,${fetched.bytes.toString("base64")}`,
  };

  let lastError: Error | undefined;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const isLastModel = i === models.length - 1;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers,
        redirect: "error",
        body: JSON.stringify(buildBody(model, fileInput)),
        signal: ac.signal,
      });
      const raw = await res.text();

      if (!res.ok) {
        if (isRetryableError(res.status, raw) && !isLastModel) {
          lastError = new Error(`LLM HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 600)}`);
          continue;
        }
        throw new Error(`LLM HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 600)}`);
      }

      let parsedPayload: any;
      try {
        parsedPayload = JSON.parse(raw);
      } catch (e: any) {
        throw new Error(`Invalid LLM JSON envelope: ${String(e?.message ?? e)} | ${raw.slice(0, 400)}`);
      }

      const rawText = extractResponseApiText(parsedPayload);
      const parsed = parseJsonObject(rawText);
      validateAgainstSchema(parsed, opts.schema);
      const normalizedInput = JSON.parse(JSON.stringify(parsed));
      const canonical = normalizeJsonCanonical(normalizedInput, opts.normalization ?? { canonical: true, dropNulls: false, sortArrays: true });
      return { parsed, canonical, rawText };
    } catch (e: any) {
      lastError = e;
      if (!isLastModel && (e?.name === "AbortError" || isRetryableError(Number(String(e?.message).match(/HTTP (\d+)/)?.[1]), String(e?.message)))) {
        continue;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastError ?? new Error("LLM call failed: no models available");
}
