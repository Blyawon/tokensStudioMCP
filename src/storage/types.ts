/**
 * Storage provider types — mirror the union Tokens Studio defines in
 * https://github.com/tokens-studio/figma-plugin
 *   (packages/tokens-studio-for-figma/src/types/StorageType.ts)
 *
 * We keep our copy minimal — only the fields a fetcher needs. Tokens Studio
 * stores extra UI-only fields (`name`, `internalId`) we ignore.
 *
 * Credentials never travel over the bridge — they're loaded server-side
 * from env vars (see src/storage/secrets.ts).
 */

export type StorageProvider =
  | "local"
  | "url"
  | "jsonbin"
  | "github"
  | "gitlab"
  | "bitbucket"
  | "ado"
  | "tokensStudio"
  | "tokensStudioOAuth"
  | "supernova"
  | "file";

export interface BaseStorageConfig {
  provider: StorageProvider;
}

export interface UrlConfig extends BaseStorageConfig {
  provider: "url";
  id: string; // the URL
  /** Optional headers JSON for authenticated URLs. */
  additionalHeaders?: Record<string, string>;
}

export interface JsonBinConfig extends BaseStorageConfig {
  provider: "jsonbin";
  id: string; // bin id
}

export interface GitHubConfig extends BaseStorageConfig {
  provider: "github";
  id: string;            // "owner/repo"
  branch: string;
  filePath: string;      // single file or directory
  baseUrl?: string;      // self-hosted GHE
}

export interface GitLabConfig extends BaseStorageConfig {
  provider: "gitlab";
  id: string;            // numeric project id or "group/project"
  branch: string;
  filePath: string;
  baseUrl?: string;
}

export interface BitbucketConfig extends BaseStorageConfig {
  provider: "bitbucket";
  id: string;            // "workspace/repo_slug"
  username: string;
  branch: string;
  filePath: string;
  baseUrl?: string;
}

export interface AdoConfig extends BaseStorageConfig {
  provider: "ado";
  baseUrl: string;       // https://dev.azure.com/<org>
  id: string;            // "project/repo"
  branch: string;
  filePath: string;
}

export interface TokensStudioConfig extends BaseStorageConfig {
  provider: "tokensStudio" | "tokensStudioOAuth";
  orgId: string;
  id: string;            // project id
  branch?: string;
  baseUrl?: string;
}

export interface SupernovaConfig extends BaseStorageConfig {
  provider: "supernova";
  designSystemUrl: string;
  mapping: string;
}

export interface LocalConfig extends BaseStorageConfig {
  provider: "local" | "file";
}

export type AnyStorageConfig =
  | UrlConfig
  | JsonBinConfig
  | GitHubConfig
  | GitLabConfig
  | BitbucketConfig
  | AdoConfig
  | TokensStudioConfig
  | SupernovaConfig
  | LocalConfig;

/**
 * Catalog produced by every provider. The shape is whatever Tokens Studio
 * exports — single set or multi-set with `$themes`/`$metadata` — we hand
 * it straight through to the existing ingester (src/remap/ingest.ts) so
 * the matcher can use it.
 *
 * `themes` and `metadata` are surfaced separately when the provider
 * splits them across files (most do — `$themes.json`, `$metadata.json`).
 */
export interface FetchedCatalog {
  values: unknown;          // the token tree (single object, possibly multi-set)
  themes?: unknown;         // $themes blob if separately fetched
  metadata?: unknown;       // $metadata blob
  source: {
    provider: StorageProvider;
    description: string;    // human-readable: "github://org/repo@main/tokens.json"
    filesFetched: number;
  };
}

export interface FetchOptions {
  /**
   * Allow callers to pass an explicit secret instead of relying on
   * env-based discovery. Useful for the Settings-tab "test" button.
   */
  secret?: string;
  /**
   * Optional progress hook — called by fetchers that pull many files.
   * Receives running counters; callers can render a progress bar.
   * Fetchers that complete in a single round-trip don't call this.
   */
  onProgress?: (info: { current: number; total: number; message?: string }) => void;
}

export interface ProviderFetcher {
  fetch(config: AnyStorageConfig, opts?: FetchOptions): Promise<FetchedCatalog>;
}

export class ProviderError extends Error {
  constructor(
    public provider: StorageProvider,
    message: string,
    public hint?: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
