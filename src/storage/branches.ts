/**
 * List branches for the active storage source. v1: GitHub. Other git
 * providers return a structured "not implemented yet" so the plugin UI
 * can hide the switcher cleanly instead of crashing.
 */

import type { AnyStorageConfig, GitHubConfig } from "./types.js";
import { resolveSecret } from "./secrets.js";

export interface BranchListResult {
  ok: boolean;
  provider: string;
  branches?: string[];
  active?: string | null;
  error?: { message: string; hint?: string };
}

export async function listBranches(
  config: AnyStorageConfig
): Promise<BranchListResult> {
  switch (config.provider) {
    case "github":
      return listGitHubBranches(config as GitHubConfig);
    case "gitlab":
    case "bitbucket":
    case "ado":
      return {
        ok: false,
        provider: config.provider,
        error: {
          message: `Branch listing for ${config.provider} isn't implemented yet.`,
          hint: "Set the branch manually in the Override form.",
        },
      };
    default:
      return {
        ok: false,
        provider: config.provider,
        error: {
          message: `Provider '${config.provider}' has no concept of branches.`,
        },
      };
  }
}

interface GhBranch {
  name: string;
  commit?: { sha: string };
  protected?: boolean;
}

async function listGitHubBranches(config: GitHubConfig): Promise<BranchListResult> {
  const token = await resolveSecret("github");
  const apiBase = (config.baseUrl?.replace(/\/$/, "")) || "https://api.github.com";

  // Paginate at the maximum page size to grab everything in one or two
  // round-trips. Most token repos have <100 branches.
  const branches: string[] = [];
  let page = 1;
  const perPage = 100;
  while (page <= 5) {
    const url = new URL(`/repos/${config.id}/branches`, apiBase);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        provider: "github",
        error: {
          message: `GitHub ${res.status} ${res.statusText} listing branches`,
          hint:
            res.status === 401 || res.status === 403
              ? "Set TOKENS_STUDIO_GITHUB_TOKEN (or store one in the plugin) with `repo` read scope."
              : res.status === 404
              ? "Check the repo identifier in your storage config."
              : body || undefined,
        },
      };
    }
    const data = (await res.json()) as GhBranch[];
    for (const b of data) branches.push(b.name);
    if (data.length < perPage) break;
    page += 1;
  }

  // Bring the active branch (if known) to the top so the dropdown shows
  // the right thing first.
  const active = config.branch || null;
  if (active) {
    const idx = branches.indexOf(active);
    if (idx > 0) {
      branches.splice(idx, 1);
      branches.unshift(active);
    }
  }

  return { ok: true, provider: "github", branches, active };
}
