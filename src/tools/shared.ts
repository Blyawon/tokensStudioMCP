/**
 * Cross-tool helpers: error formatting, debug logging, token-path
 * validation, and shared constants. Kept tiny so every tool file can
 * import from here without pulling in the world.
 */

import { ProviderError } from "../storage/index.js";

export const BRIDGE_NOT_CONNECTED =
  "Plugin not connected. Open the 'Tokens Studio MCP Bridge' plugin in Figma to establish the connection.";

const FT_DEBUG = process.env.FT_DEBUG === "1";

export function debugLog(context: string, err: unknown): void {
  if (!FT_DEBUG) return;
  const msg = err instanceof Error ? err.message : String(err);
  // stderr only — stdout is the MCP protocol stream.
  console.error(`[ft:debug] ${context}: ${msg}`);
}

export function toolError(err: unknown) {
  let message: string;
  if (err instanceof ProviderError) {
    message = err.hint ? `${err.message}\n\nHint: ${err.hint}` : err.message;
  } else {
    message = err instanceof Error ? err.message : String(err);
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

const TOKEN_PATH_RE = /^[a-zA-Z_$][a-zA-Z0-9_.$-]*$/;

export function validateTokenPath(path: string): void {
  if (!path) throw new Error("Token path must not be empty.");
  if (!TOKEN_PATH_RE.test(path)) {
    throw new Error(
      `Invalid token path "${path}". Paths must start with a letter/underscore ` +
        `and contain only alphanumeric, dot, dash, underscore, or $ characters.`
    );
  }
}
