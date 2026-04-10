/**
 * Minimal Figma REST client, scoped to what the MCP server needs:
 * fetching file trees (or single-node subtrees) with shared plugin data
 * so Tokens Studio's applied tokens come along for the ride.
 */

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  characters?: string;
  children?: FigmaNode[];
  sharedPluginData?: Record<string, Record<string, string>>;
  // Figma returns other properties we don't care about.
  [key: string]: unknown;
}

export interface FigmaFileResponse {
  document: FigmaNode;
  name?: string;
  lastModified?: string;
}

export interface FigmaNodesResponse {
  nodes: Record<
    string,
    {
      document: FigmaNode;
    } | null
  >;
}

export interface FigmaClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export class FigmaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: FigmaClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.figma.com";
  }

  async fetchFile(
    fileKey: string,
    opts: { depth?: number } = {}
  ): Promise<FigmaFileResponse> {
    const url = new URL(`/v1/files/${encodeURIComponent(fileKey)}`, this.baseUrl);
    url.searchParams.set("plugin_data", "shared");
    if (opts.depth != null) url.searchParams.set("depth", String(opts.depth));
    return this.request<FigmaFileResponse>(url);
  }

  async fetchNodes(
    fileKey: string,
    nodeIds: string[],
    opts: { depth?: number } = {}
  ): Promise<FigmaNodesResponse> {
    if (nodeIds.length === 0) {
      throw new Error("fetchNodes called with an empty nodeIds list.");
    }
    const url = new URL(
      `/v1/files/${encodeURIComponent(fileKey)}/nodes`,
      this.baseUrl
    );
    url.searchParams.set("ids", nodeIds.join(","));
    url.searchParams.set("plugin_data", "shared");
    if (opts.depth != null) url.searchParams.set("depth", String(opts.depth));
    return this.request<FigmaNodesResponse>(url);
  }

  private async request<T>(url: URL): Promise<T> {
    const res = await fetch(url, {
      headers: {
        "X-Figma-Token": this.apiKey,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Figma API ${res.status} ${res.statusText} for ${url.pathname}${url.search}: ${body}`
      );
    }

    return (await res.json()) as T;
  }
}
