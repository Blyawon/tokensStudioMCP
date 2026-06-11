/**
 * GitHub provider. Fetches a single file or a directory tree from the
 * GitHub Contents API. Tokens Studio supports both single-file and
 * multi-file repos — we detect by inspecting whether `filePath` resolves
 * to a file or a directory and behave accordingly.
 *
 * Auth: a PAT in `TOKENS_STUDIO_GITHUB_TOKEN`. Public repos work without
 * one but rate limits drop to 60/hr unauth'd.
 *
 * Self-hosted GHE supported via `baseUrl` (e.g. https://github.acme.com/api/v3).
 */

import type {
  GitHubConfig,
  FetchOptions,
  FetchedCatalog,
  ProviderFetcher,
} from "./types.js";
import { ProviderError } from "./types.js";
import { getSecret } from "./secrets.js";

interface GhContent {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  download_url: string | null;
  content?: string; // base64 when type="file" and small
  encoding?: "base64";
}

interface GhTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

const DEFAULT_API = "https://api.github.com";
/** Hard cap so a misconfigured filePath can't pull a 10k-file repo. */
const MAX_FILES = 1000;
/**
 * Concurrent in-flight fetches. Empirically a directory with 400+ files
 * fans out to that many TCP connections at once — macOS's default file
 * descriptor limit (256) plus undici's own pool limits cause "fetch failed"
 * errors. 12 keeps us well under any platform cap and finishes ~450 files
 * in well under a minute on a typical PAT.
 */
const MAX_CONCURRENCY = 12;

export const githubFetcher: ProviderFetcher = {
  async fetch(rawConfig, opts = {}): Promise<FetchedCatalog> {
    if (rawConfig.provider !== "github") {
      throw new ProviderError("github", `wrong provider: ${rawConfig.provider}`);
    }
    const config = rawConfig as GitHubConfig;
    const token = opts.secret ?? getSecret("github");
    const apiBase = (config.baseUrl?.replace(/\/$/, "")) || DEFAULT_API;

    const description = `github://${config.id}@${config.branch}/${config.filePath}`;

    // Probe whether filePath is a directory or a single file. The contents
    // API lets us peek without committing to a strategy yet.
    const root = await ghContents(apiBase, config, config.filePath, token);

    if (!Array.isArray(root)) {
      // Single file mode.
      const json = await readGhFile(apiBase, config, root, token);
      return {
        values: json,
        source: { provider: "github", description, filesFetched: 1 },
      };
    }

    // Directory mode — recurse with the Git Trees API in ONE call, then
    // fan out fetches in parallel. Tokens Studio's multi-file convention
    // names sets after their relative path (e.g. components/core/tabBar.json
    // → set "components/core/tabBar"), so the nested files matter — without
    // recursion we'd silently miss 90%+ of a typical token catalog.
    const prefix = config.filePath.replace(/^\/+|\/+$/g, "");
    const entries = await ghTree(apiBase, config, token, prefix);
    const jsonFiles = entries.filter(
      (e) => e.type === "blob" && e.path.endsWith(".json")
    );
    if (jsonFiles.length === 0) {
      throw new ProviderError(
        "github",
        `no .json files at ${description}`,
        "Check the filePath in Tokens Studio's sync settings."
      );
    }
    if (jsonFiles.length > MAX_FILES) {
      throw new ProviderError(
        "github",
        `${jsonFiles.length} .json files at ${description} exceeds the ${MAX_FILES}-file safety cap.`,
        "Narrow the filePath to a more specific subdirectory."
      );
    }

    const tokenSets: Record<string, unknown> = {};
    let themes: unknown = undefined;
    let metadata: unknown = undefined;

    // Emit one initial progress so the UI can show "0 / N" before any
    // file completes — the user sees the total upfront.
    opts.onProgress?.({ current: 0, total: jsonFiles.length, message: "fetching files" });

    let completed = 0;
    const fetched = await pMap(jsonFiles, MAX_CONCURRENCY, async (entry) => {
      const result = {
        relativePath: relativeTo(prefix, entry.path),
        json: await withRetry(() => readRawByPath(apiBase, config, entry.path, token)),
      };
      completed += 1;
      opts.onProgress?.({
        current: completed,
        total: jsonFiles.length,
        message: result.relativePath,
      });
      return result;
    });

    for (const { relativePath, json } of fetched) {
      const setName = relativePath.replace(/\.json$/, "");
      if (setName === "$themes") themes = json;
      else if (setName === "$metadata") metadata = json;
      else tokenSets[setName] = json;
    }

    return {
      values: tokenSets,
      themes,
      metadata,
      source: { provider: "github", description, filesFetched: fetched.length },
    };
  },
};

/**
 * Walk the entire repo tree at once with `?recursive=1`, then prune to
 * entries under the configured filePath. Costs one API call regardless of
 * directory depth — the contents API would need O(directories) calls.
 *
 * GitHub truncates trees with >100k entries (`tree.truncated: true`); for
 * those repos we'd need to fall back to per-directory walking. Token
 * sources don't hit that limit.
 */
async function ghTree(
  apiBase: string,
  config: GitHubConfig,
  token: string | undefined,
  prefix: string
): Promise<GhTreeEntry[]> {
  const url = new URL(
    `/repos/${config.id}/git/trees/${encodeURIComponent(config.branch)}`,
    apiBase
  );
  url.searchParams.set("recursive", "1");
  const body = await ghJson<{ tree: GhTreeEntry[]; truncated?: boolean }>(url, token);
  if (body.truncated) {
    throw new ProviderError(
      "github",
      "Git tree was truncated by GitHub (>100k entries) — can't walk this repo with a single call.",
      "Narrow the filePath to a more specific subdirectory."
    );
  }
  if (!prefix) return body.tree;
  return body.tree.filter((e) => e.path === prefix || e.path.startsWith(prefix + "/"));
}

function relativeTo(prefix: string, fullPath: string): string {
  if (!prefix) return fullPath;
  if (fullPath === prefix) return fullPath;
  return fullPath.startsWith(prefix + "/")
    ? fullPath.slice(prefix.length + 1)
    : fullPath;
}

async function readRawByPath(
  apiBase: string,
  config: GitHubConfig,
  path: string,
  token: string | undefined
): Promise<unknown> {
  // Use the contents API (small files) → falls through to download_url for
  // anything >1MB. Same path readGhFile took before; we're just discovering
  // the path via the trees API instead of contents.
  const entry = (await ghContents(apiBase, config, path, token)) as GhContent;
  if (Array.isArray(entry)) {
    throw new ProviderError("github", `expected file at ${path}, got dir`);
  }
  return readGhFile(apiBase, config, entry, token);
}

async function ghContents(
  apiBase: string,
  config: GitHubConfig,
  path: string,
  token: string | undefined
): Promise<GhContent | GhContent[]> {
  const url = new URL(
    `/repos/${config.id}/contents/${encodePath(path)}`,
    apiBase
  );
  url.searchParams.set("ref", config.branch);
  return ghJson<GhContent | GhContent[]>(url, token);
}

async function readGhFile(
  apiBase: string,
  config: GitHubConfig,
  entry: GhContent,
  token: string | undefined
): Promise<unknown> {
  // Files >1MB don't include `content` — fall back to download_url.
  if (entry.content && entry.encoding === "base64") {
    const text = Buffer.from(entry.content, "base64").toString("utf8");
    return JSON.parse(text);
  }
  if (entry.download_url) {
    const res = await fetch(entry.download_url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      throw new ProviderError(
        "github",
        `download_url ${res.status} ${res.statusText} for ${entry.path}`
      );
    }
    return res.json();
  }
  // Last resort — re-hit the contents API for this file alone.
  const sub = await ghContents(apiBase, config, entry.path, token);
  if (Array.isArray(sub)) {
    throw new ProviderError("github", `expected file at ${entry.path}, got dir`);
  }
  return readGhFile(apiBase, config, sub, token);
}

async function ghJson<T>(url: URL, token: string | undefined): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(
      "github",
      `GitHub API ${res.status} ${res.statusText} for ${url.pathname}`,
      res.status === 404
        ? "Path not found — check repo, branch, or filePath."
        : res.status === 401 || res.status === 403
        ? "Auth failed — set TOKENS_STUDIO_GITHUB_TOKEN to a PAT with `repo` scope."
        : undefined
    );
  }
  return (await res.json()) as T;
}

function encodePath(path: string): string {
  // Encode each segment but keep slashes.
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Bounded-concurrency parallel map. Worker pool of `concurrency` consumes
 * a shared index counter — finishes every item exactly once, in input
 * order. Failures bubble (Promise.all-style) so callers see the first
 * error, not a partial result.
 */
async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker
  );
  await Promise.all(workers);
  return results;
}

/**
 * One retry on transient network errors (TCP RST, ETIMEDOUT, "fetch failed"
 * from undici). 4xx/5xx ProviderError-shaped failures bubble immediately —
 * those are not network glitches.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    await new Promise((r) => setTimeout(r, 250));
    return fn();
  }
}
