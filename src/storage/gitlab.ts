/**
 * GitLab provider. Mirrors the GitHub fetcher's directory-or-file logic
 * via GitLab's Repository Files + Repository Tree APIs. Supports both
 * gitlab.com and self-hosted via `baseUrl`.
 */

import type {
  GitLabConfig,
  FetchOptions,
  FetchedCatalog,
  ProviderFetcher,
} from "./types.js";
import { ProviderError } from "./types.js";
import { getSecret } from "./secrets.js";

const DEFAULT_API = "https://gitlab.com";

interface GlTreeEntry {
  id: string;
  name: string;
  path: string;
  type: "tree" | "blob";
}

export const gitlabFetcher: ProviderFetcher = {
  async fetch(rawConfig, opts = {}): Promise<FetchedCatalog> {
    if (rawConfig.provider !== "gitlab") {
      throw new ProviderError("gitlab", `wrong provider: ${rawConfig.provider}`);
    }
    const config = rawConfig as GitLabConfig;
    const token = opts.secret ?? getSecret("gitlab");
    const apiBase = (config.baseUrl?.replace(/\/$/, "")) || DEFAULT_API;
    const projectId = encodeURIComponent(config.id);
    const description = `gitlab://${config.id}@${config.branch}/${config.filePath}`;

    // Probe whether filePath is a directory.
    const tree = await listTree(apiBase, projectId, config, token).catch(() => null);
    if (tree && tree.length > 0) {
      const files = tree.filter((e) => e.type === "blob" && e.name.endsWith(".json"));
      if (files.length === 0) {
        throw new ProviderError(
          "gitlab",
          `no .json files at ${description}`,
          "Check the filePath in Tokens Studio's sync settings."
        );
      }
      const tokenSets: Record<string, unknown> = {};
      let themes: unknown = undefined;
      let metadata: unknown = undefined;

      const fetched = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          json: await readFile(apiBase, projectId, f.path, config.branch, token),
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
        source: { provider: "gitlab", description, filesFetched: fetched.length },
      };
    }

    // Single file.
    const json = await readFile(apiBase, projectId, config.filePath, config.branch, token);
    return {
      values: json,
      source: { provider: "gitlab", description, filesFetched: 1 },
    };
  },
};

async function listTree(
  apiBase: string,
  projectId: string,
  config: GitLabConfig,
  token: string | undefined
): Promise<GlTreeEntry[]> {
  const url = new URL(`/api/v4/projects/${projectId}/repository/tree`, apiBase);
  url.searchParams.set("ref", config.branch);
  if (config.filePath && config.filePath !== ".") {
    url.searchParams.set("path", config.filePath);
  }
  url.searchParams.set("per_page", "100");
  const res = await glFetch(url, token);
  if (res.status === 404) return [];
  return (await res.json()) as GlTreeEntry[];
}

async function readFile(
  apiBase: string,
  projectId: string,
  path: string,
  branch: string,
  token: string | undefined
): Promise<unknown> {
  const url = new URL(
    `/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(path)}/raw`,
    apiBase
  );
  url.searchParams.set("ref", branch);
  const res = await glFetch(url, token);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(
      "gitlab",
      `GitLab API ${res.status} ${res.statusText} for ${path}`,
      res.status === 401 || res.status === 403
        ? "Auth failed — set TOKENS_STUDIO_GITLAB_TOKEN to a PAT with `read_api` scope."
        : undefined
    );
  }
  return res.json();
}

async function glFetch(url: URL, token: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["PRIVATE-TOKEN"] = token;
  return fetch(url, { headers });
}
