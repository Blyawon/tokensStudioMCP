/**
 * Bitbucket Cloud provider. Bitbucket's REST API uses HTTP Basic auth
 * with username + app password (or API token). Both come from env:
 *   TOKENS_STUDIO_BITBUCKET_USERNAME
 *   TOKENS_STUDIO_BITBUCKET_TOKEN
 *
 * Self-hosted (Bitbucket Server) is NOT supported here — that uses a
 * different REST surface. Open an issue if you need it.
 */

import type {
  BitbucketConfig,
  FetchOptions,
  FetchedCatalog,
  ProviderFetcher,
} from "./types.js";
import { ProviderError } from "./types.js";
import { getSecret } from "./secrets.js";

const API_BASE = "https://api.bitbucket.org/2.0";

interface BbDirEntry {
  type: "commit_file" | "commit_directory";
  path: string;
}

export const bitbucketFetcher: ProviderFetcher = {
  async fetch(rawConfig, opts = {}): Promise<FetchedCatalog> {
    if (rawConfig.provider !== "bitbucket") {
      throw new ProviderError("bitbucket", `wrong provider: ${rawConfig.provider}`);
    }
    const config = rawConfig as BitbucketConfig;
    const token = opts.secret ?? getSecret("bitbucket");
    const username =
      process.env.TOKENS_STUDIO_BITBUCKET_USERNAME ?? config.username;
    if (!token) {
      throw new ProviderError(
        "bitbucket",
        "Missing API token",
        "Set TOKENS_STUDIO_BITBUCKET_TOKEN to a Bitbucket app password (or API token)."
      );
    }
    if (!username) {
      throw new ProviderError(
        "bitbucket",
        "Missing username",
        "Set TOKENS_STUDIO_BITBUCKET_USERNAME (Bitbucket Basic auth needs both)."
      );
    }
    const auth = "Basic " + Buffer.from(`${username}:${token}`).toString("base64");
    const description = `bitbucket://${config.id}@${config.branch}/${config.filePath}`;

    // Try treating filePath as a directory first.
    const tree = await listSrc(config, config.filePath, auth).catch(() => null);
    if (tree && tree.length > 0) {
      const files = tree.filter((e) => e.type === "commit_file" && e.path.endsWith(".json"));
      if (files.length === 0) {
        throw new ProviderError(
          "bitbucket",
          `no .json files at ${description}`,
          "Check the filePath in Tokens Studio's sync settings."
        );
      }
      const tokenSets: Record<string, unknown> = {};
      let themes: unknown = undefined;
      let metadata: unknown = undefined;
      const fetched = await Promise.all(
        files.map(async (f) => ({
          name: f.path.split("/").pop()!,
          json: await readSrc(config, f.path, auth),
        }))
      );
      for (const { name, json } of fetched) {
        const setName = name.replace(/\.json$/, "");
        if (setName === "$themes") themes = json;
        else if (setName === "$metadata") metadata = json;
        else tokenSets[setName] = json;
      }
      return {
        values: tokenSets,
        themes,
        metadata,
        source: { provider: "bitbucket", description, filesFetched: fetched.length },
      };
    }

    const json = await readSrc(config, config.filePath, auth);
    return {
      values: json,
      source: { provider: "bitbucket", description, filesFetched: 1 },
    };
  },
};

async function listSrc(
  config: BitbucketConfig,
  path: string,
  auth: string
): Promise<BbDirEntry[]> {
  const url = `${API_BASE}/repositories/${config.id}/src/${encodeURIComponent(
    config.branch
  )}/${path}/`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (res.status === 404) return [];
  if (!res.ok) throw new ProviderError("bitbucket", `tree ${res.status} for ${path}`);
  const body = (await res.json()) as { values: BbDirEntry[] };
  return body.values;
}

async function readSrc(
  config: BitbucketConfig,
  path: string,
  auth: string
): Promise<unknown> {
  const url = `${API_BASE}/repositories/${config.id}/src/${encodeURIComponent(
    config.branch
  )}/${path}`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) {
    throw new ProviderError(
      "bitbucket",
      `Bitbucket ${res.status} ${res.statusText} for ${path}`,
      res.status === 401 ? "Auth failed — check Bitbucket username + app password." : undefined
    );
  }
  return res.json();
}
