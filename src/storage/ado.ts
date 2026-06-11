/**
 * Azure DevOps provider. Auth: Basic auth with empty username + PAT in
 * `TOKENS_STUDIO_ADO_TOKEN`. Tokens Studio's ADO config has shape
 * `{ baseUrl: "https://dev.azure.com/<org>", id: "<project>/<repo>", ... }`.
 */

import type {
  AdoConfig,
  FetchOptions,
  FetchedCatalog,
  ProviderFetcher,
} from "./types.js";
import { ProviderError } from "./types.js";
import { getSecret } from "./secrets.js";

interface AdoItem {
  path: string;
  isFolder?: boolean;
  url: string;
}

export const adoFetcher: ProviderFetcher = {
  async fetch(rawConfig, opts = {}): Promise<FetchedCatalog> {
    if (rawConfig.provider !== "ado") {
      throw new ProviderError("ado", `wrong provider: ${rawConfig.provider}`);
    }
    const config = rawConfig as AdoConfig;
    const token = opts.secret ?? getSecret("ado");
    if (!token) {
      throw new ProviderError(
        "ado",
        "Missing PAT",
        "Set TOKENS_STUDIO_ADO_TOKEN to an Azure DevOps personal access token with Code (read) scope."
      );
    }
    const auth = "Basic " + Buffer.from(`:${token}`).toString("base64");
    const [project, repo] = config.id.split("/");
    if (!project || !repo) {
      throw new ProviderError("ado", `Bad id "${config.id}" — expected "project/repo".`);
    }
    const apiBase = `${config.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
    const description = `ado://${config.id}@${config.branch}/${config.filePath}`;

    const tree = await listItems(apiBase, config, auth).catch(() => null);
    if (tree && tree.length > 0) {
      const files = tree.filter((e) => !e.isFolder && e.path.endsWith(".json"));
      if (files.length === 0) {
        throw new ProviderError(
          "ado",
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
          json: await readItem(apiBase, f.path, config.branch, auth),
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
        source: { provider: "ado", description, filesFetched: fetched.length },
      };
    }

    const json = await readItem(apiBase, config.filePath, config.branch, auth);
    return {
      values: json,
      source: { provider: "ado", description, filesFetched: 1 },
    };
  },
};

async function listItems(
  apiBase: string,
  config: AdoConfig,
  auth: string
): Promise<AdoItem[]> {
  const url = new URL(`${apiBase}/items`);
  url.searchParams.set("api-version", "7.0");
  url.searchParams.set("scopePath", config.filePath);
  url.searchParams.set("recursionLevel", "OneLevel");
  url.searchParams.set("versionDescriptor.version", config.branch);
  url.searchParams.set("versionDescriptor.versionType", "branch");
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (res.status === 404) return [];
  if (!res.ok) throw new ProviderError("ado", `tree ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { value: AdoItem[] };
  // First item is usually the scope itself — drop folders + scope.
  return body.value.filter((i) => i.path !== config.filePath);
}

async function readItem(
  apiBase: string,
  path: string,
  branch: string,
  auth: string
): Promise<unknown> {
  const url = new URL(`${apiBase}/items`);
  url.searchParams.set("api-version", "7.0");
  url.searchParams.set("path", path);
  url.searchParams.set("$format", "json");
  url.searchParams.set("includeContent", "true");
  url.searchParams.set("versionDescriptor.version", branch);
  url.searchParams.set("versionDescriptor.versionType", "branch");
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) {
    throw new ProviderError(
      "ado",
      `ADO ${res.status} ${res.statusText} for ${path}`,
      res.status === 401 ? "Auth failed — check TOKENS_STUDIO_ADO_TOKEN." : undefined
    );
  }
  const body = (await res.json()) as { content?: string };
  if (!body.content) {
    throw new ProviderError("ado", `Empty content for ${path}`);
  }
  return JSON.parse(body.content);
}
