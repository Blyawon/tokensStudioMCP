/**
 * GitHub WritableProvider via the Git Data API. Multi-file commits land
 * as one logical commit (blob → tree → commit → ref update), preserving
 * git history hygiene compared to the per-file Contents API path.
 *
 * Conflict-safe: the commit step refuses (via `parentSha` check) if the
 * branch head moved between fetch and commit. Designer must pull and
 * redo their edits — auto-merging is out of scope.
 */

import type { GitHubConfig } from "./types.js";
import { ProviderError } from "./types.js";
import {
  registerWritable,
  type WritableProvider,
  type CommitArgs,
  type CommitResult,
  type CommittableFile,
} from "./writable.js";

interface GhRefResponse { object: { sha: string } }
interface GhCommitResponse { tree: { sha: string } }
interface GhBlobResponse { sha: string }
interface GhTreeResponse { sha: string }
interface GhNewCommitResponse { sha: string }

const DEFAULT_API = "https://api.github.com";

export function makeGitHubWritable(
  rawConfig: import("./types.js").AnyStorageConfig,
  secret: string | undefined
): WritableProvider {
  if (rawConfig.provider !== "github") {
    throw new ProviderError("github", `wrong provider: ${rawConfig.provider}`);
  }
  if (!secret) {
    throw new ProviderError(
      "github",
      "Missing GitHub PAT for write operations.",
      "Set TOKENS_STUDIO_GITHUB_TOKEN with `repo` write scope, or save a token in the plugin Settings."
    );
  }
  const config = rawConfig as GitHubConfig;
  const apiBase = (config.baseUrl?.replace(/\/$/, "")) || DEFAULT_API;
  const repo = config.id;

  async function gh<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${apiBase}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(
        "github",
        `GitHub API ${res.status} ${res.statusText} for ${path}`,
        res.status === 401 || res.status === 403
          ? "Token lacks write scope. Use a PAT with `repo` (classic) or `contents:write` (fine-grained)."
          : res.status === 404
          ? "Repo or branch not found."
          : res.status === 422
          ? body || "Validation failed — branch may already exist or commit was rejected."
          : undefined
      );
    }
    return (await res.json()) as T;
  }

  async function getRefSha(branch: string): Promise<string> {
    const r = await gh<GhRefResponse>(
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
    );
    return r.object.sha;
  }

  async function createBranch(name: string, fromSha: string): Promise<{ sha: string }> {
    const r = await gh<{ object: { sha: string } }>(
      `/repos/${repo}/git/refs`,
      {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha: fromSha }),
      }
    );
    return { sha: r.object.sha };
  }

  async function commit(args: CommitArgs): Promise<CommitResult> {
    // 1) Conflict check — refuse if the branch moved since fetch.
    const headSha = await getRefSha(args.branch);
    if (headSha !== args.parentSha) {
      throw new ProviderError(
        "github",
        `Branch '${args.branch}' moved upstream since the catalog was fetched`,
        "Pull the latest tokens (Refresh in the plugin) and re-apply your edits, then retry the commit."
      );
    }

    // 2) Find the parent commit's tree SHA — base for the new tree.
    const parentCommit = await gh<GhCommitResponse>(
      `/repos/${repo}/git/commits/${args.parentSha}`
    );
    const baseTreeSha = parentCommit.tree.sha;

    // 3) Create blobs for every file in parallel.
    const blobs = await Promise.all(
      args.files.map(async (f) => {
        const r = await gh<GhBlobResponse>(
          `/repos/${repo}/git/blobs`,
          {
            method: "POST",
            body: JSON.stringify({
              content: f.contents,
              encoding: "utf-8",
            }),
          }
        );
        return { path: f.path, sha: r.sha };
      })
    );

    // 4) Build the tree entries. Deletes use a null sha to remove a path
    // relative to base_tree (GitHub's documented sentinel).
    const treeEntries: Array<Record<string, unknown>> = blobs.map((b) => ({
      path: b.path,
      mode: "100644",
      type: "blob",
      sha: b.sha,
    }));
    for (const path of args.deletes ?? []) {
      treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    }

    const newTree = await gh<GhTreeResponse>(
      `/repos/${repo}/git/trees`,
      {
        method: "POST",
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      }
    );

    // 5) Create the commit.
    const newCommit = await gh<GhNewCommitResponse>(
      `/repos/${repo}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({
          message: args.message,
          tree: newTree.sha,
          parents: [args.parentSha],
        }),
      }
    );

    // 6) Update the branch ref. force=false lets GitHub itself reject
    // any non-fast-forward push that snuck in during the race window
    // between getRefSha (step 1) and now. Translate the resulting 422
    // into the same friendly conflict error our pre-check raises so the
    // user always sees the same message regardless of which side caught
    // the race.
    try {
      await gh(
        `/repos/${repo}/git/refs/heads/${encodeURIComponent(args.branch)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ sha: newCommit.sha, force: false }),
        }
      );
    } catch (err) {
      if (err instanceof ProviderError && /422/.test(err.message)) {
        throw new ProviderError(
          "github",
          `Branch '${args.branch}' moved upstream while we were writing the commit`,
          "Pull (Refresh in the plugin) and re-stage your edits, then retry — your commit is on GitHub but unreferenced."
        );
      }
      throw err;
    }

    return { sha: newCommit.sha };
  }

  return { getRefSha, createBranch, commit };
}

registerWritable("github", makeGitHubWritable);

// Make the helper exportable so commit_and_push can pre-compute file paths.
export type { CommittableFile };
