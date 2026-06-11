/**
 * WritableProvider — symmetric counterpart to ProviderFetcher for the
 * push-back path. v1 ships GitHub via the Git Data API; other providers
 * throw a clear "not yet supported" so callers can surface it cleanly.
 */

import type { AnyStorageConfig, StorageProvider } from "./types.js";
import { ProviderError } from "./types.js";

export interface CommittableFile {
  /** Path relative to the repo root (e.g. "tokens/base.json"). */
  path: string;
  /** Full file contents as UTF-8 string. */
  contents: string;
}

export interface CommitArgs {
  branch: string;
  message: string;
  files: CommittableFile[];
  /** Paths to delete from the tree (relative to repo root). */
  deletes?: string[];
  /**
   * Expected parent commit SHA. The provider refuses if the ref's
   * current head doesn't match — this prevents silently overwriting
   * upstream work. Required for safety.
   */
  parentSha: string;
}

export interface CommitResult {
  sha: string;
}

export interface WritableProvider {
  /** Resolve current head commit sha for a branch. */
  getRefSha(branch: string): Promise<string>;
  /** Create a new branch pointing at `fromSha`. */
  createBranch(name: string, fromSha: string): Promise<{ sha: string }>;
  /** Atomic multi-file commit (single commit, single ref update). */
  commit(args: CommitArgs): Promise<CommitResult>;
}

export type ProviderFactory = (config: AnyStorageConfig, secret: string | undefined) => WritableProvider;

const FACTORIES: Partial<Record<StorageProvider, ProviderFactory>> = {};

export function registerWritable(provider: StorageProvider, factory: ProviderFactory): void {
  FACTORIES[provider] = factory;
}

export function getWritable(config: AnyStorageConfig, secret: string | undefined): WritableProvider {
  const factory = FACTORIES[config.provider];
  if (!factory) {
    throw new ProviderError(
      config.provider,
      `Write-back for ${config.provider} isn't implemented yet`,
      "v1 ships with GitHub only. The matching factory needs to be registered before commit_and_push."
    );
  }
  return factory(config, secret);
}
