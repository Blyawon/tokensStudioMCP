/**
 * Provider secrets — read once from env, never logged. The Settings tab
 * surfaces "configured" / "missing" state but never asks the user to type
 * the secret into the plugin UI (it would have to travel through the bridge
 * and we don't want secrets crossing process boundaries unnecessarily).
 *
 * Convention: TOKENS_STUDIO_<PROVIDER>_TOKEN. Bitbucket also needs
 * TOKENS_STUDIO_BITBUCKET_USERNAME (its API uses Basic auth).
 */

import type { StorageProvider } from "./types.js";

const ENV_KEYS: Record<StorageProvider, string | null> = {
  local: null,
  file: null,
  url: "TOKENS_STUDIO_URL_TOKEN",       // optional bearer for protected URLs
  jsonbin: "TOKENS_STUDIO_JSONBIN_KEY",
  github: "TOKENS_STUDIO_GITHUB_TOKEN",
  gitlab: "TOKENS_STUDIO_GITLAB_TOKEN",
  bitbucket: "TOKENS_STUDIO_BITBUCKET_TOKEN",
  ado: "TOKENS_STUDIO_ADO_TOKEN",
  tokensStudio: "TOKENS_STUDIO_API_KEY",
  tokensStudioOAuth: "TOKENS_STUDIO_API_KEY",
  supernova: "TOKENS_STUDIO_SUPERNOVA_KEY",
};

export function getSecret(provider: StorageProvider): string | undefined {
  const key = ENV_KEYS[provider];
  if (!key) return undefined;
  return process.env[key] || undefined;
}

/**
 * Async secret resolver. Priority:
 *   1. Explicit `explicit` (passed by the caller — usually a tool arg).
 *   2. Plugin-saved secret (per-user, via the WebSocket bridge).
 *   3. Env var (.env on the MCP server).
 *
 * Plugin-saved beats env so a designer can transparently override a
 * shared .env on a per-user basis without restarting anything.
 */
export async function resolveSecret(
  provider: StorageProvider,
  explicit?: string
): Promise<string | undefined> {
  if (explicit) return explicit;
  // Lazy-import to avoid a static cycle: storage/* imports secrets,
  // server.ts also lives outside storage/.
  const { getBridge } = await import("../bridge/server.js");
  const bridge = getBridge();
  if (bridge.isConnected()) {
    try {
      const res = (await bridge.request(
        "getSecret",
        { provider },
        { timeoutMs: 4000 }
      )) as { secret: string | null };
      if (res?.secret) return res.secret;
    } catch {
      // Bridge unavailable — fall through to env.
    }
  }
  return getSecret(provider);
}

export function envVarFor(provider: StorageProvider): string | null {
  return ENV_KEYS[provider];
}

export interface SecretStatus {
  provider: StorageProvider;
  envVar: string | null;
  configured: boolean;
}

export function listSecretStatus(): SecretStatus[] {
  const out: SecretStatus[] = [];
  for (const [provider, envVar] of Object.entries(ENV_KEYS) as Array<
    [StorageProvider, string | null]
  >) {
    out.push({
      provider,
      envVar,
      configured: !!(envVar && process.env[envVar]),
    });
  }
  return out;
}
