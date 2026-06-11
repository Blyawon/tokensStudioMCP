/// <reference types="@figma/plugin-typings" />

/**
 * Arbitrary JS execution in the plugin sandbox — the capability that makes
 * a separate figma-cli unnecessary. The MCP server ships a code string;
 * we run it inside an async IIFE so both sync and async code work, race it
 * against a timeout, and return a JSON-safe result.
 *
 * Figma's QuickJS sandbox blocks `new Function`, so indirect eval is the
 * only execution path. The code runs with the full `figma` plugin API in
 * scope — same trust level as the plugin itself (localhost bridge only).
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESULT_DEPTH = 6;
const MAX_ARRAY_ITEMS = 200;

export async function opEvalCode(params: unknown): Promise<unknown> {
  const p = (params ?? {}) as { code?: string; timeoutMs?: number };
  if (!p.code || typeof p.code !== "string") {
    throw new Error("evalCode needs { code: string }");
  }
  const timeoutMs = Math.min(Math.max(p.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), 300_000);

  let body = p.code.trim();
  // Auto-return: a single expression like `figma.currentPage.name` should
  // come back as a value without the caller having to write `return`.
  if (looksLikeExpression(body)) body = `return (${body});`;

  // Indirect eval → global scope (where `figma` lives), not module scope.
  const indirectEval = (0, eval);
  const exec = (async () => {
    const fnPromise = indirectEval(`(async () => { ${body} })`)();
    return await fnPromise;
  })();

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`evalCode timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  const result = await Promise.race([exec, timeout]);
  return { result: sanitize(result, 0) };
}

function looksLikeExpression(code: string): boolean {
  if (/[;\n]/.test(code)) return false;
  if (/^\s*(return|const|let|var|if|for|while|function|class|throw|await\s+import)\b/.test(code)) return false;
  return true;
}

/**
 * Make any value JSON-safe for the wire: Figma nodes become id/name/type
 * stubs, functions/symbols are dropped, depth and array length are capped.
 */
export function sanitize(value: unknown, depth: number): unknown {
  if (value == null) return value;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") return Number.isFinite(value as number) ? value : String(value);
  if (t === "function" || t === "symbol" || t === "bigint") return String(value);
  if (depth >= MAX_RESULT_DEPTH) return "[max depth]";

  // Figma node? Return a compact stub instead of a huge (often cyclic) object.
  const obj = value as Record<string, unknown>;
  if (typeof obj.id === "string" && typeof obj.type === "string" && "parent" in obj) {
    return { id: obj.id, name: obj.name ?? null, type: obj.type };
  }

  if (Array.isArray(value)) {
    const capped = value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitize(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) capped.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return capped;
  }
  if (value instanceof Uint8Array) return `[Uint8Array ${value.length} bytes]`;

  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(obj)) {
    if (count++ > 60) { out["…"] = "[truncated]"; break; }
    try { out[key] = sanitize(obj[key], depth + 1); }
    catch { out[key] = "[unreadable]"; }
  }
  return out;
}
