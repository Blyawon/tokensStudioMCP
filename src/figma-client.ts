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
  // Layout / visual metadata Figma's REST API returns by default. Typed so
  // the design-context renderer can surface them — these are what lets an
  // agent rebuild a component without a second Figma MCP.
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  layoutWrap?: string;
  layoutGrow?: number;
  layoutPositioning?: string;
  constraints?: { horizontal?: string; vertical?: string };
  fills?: unknown[];
  strokes?: unknown[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects?: unknown[];
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  opacity?: number;
  blendMode?: string;
  clipsContent?: boolean;
  rotation?: number;
  visible?: boolean;
  componentId?: string;
  componentProperties?: Record<string, unknown>;
  style?: Record<string, unknown>;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        headers: { "X-Figma-Token": this.apiKey },
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "(no response body)");
        throw new Error(formatFigmaApiError(res.status, res.statusText, url, body));
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(
          `Figma API request timed out after 30 s for ${url.pathname}${url.search}. ` +
            "Check your network connection and try again."
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function formatFigmaApiError(status: number, statusText: string, url: URL, body: string): string {
  const trimmed = body.length > 400 ? body.slice(0, 400) + "…" : body;
  const hintByStatus: Record<number, string> = {
    401: "Your FIGMA_API_KEY was rejected. Run `ft setup` to store a working personal access token.",
    403: "FIGMA_API_KEY doesn't have access to this file. Check the token's scope, or ask the file owner to add you.",
    404: "File or node not found. Double-check the URL — fileKey or node-id may be wrong, or the file may have been deleted.",
    429: "Figma is rate-limiting this token. Wait a minute and try again, or slow down parallel requests.",
  };
  let hint = hintByStatus[status];
  if (!hint && status >= 500) hint = "Figma's API is having trouble. Retry in a bit; if it keeps failing, check status.figma.com.";
  const main = `Figma API returned ${status}${statusText ? " " + statusText : ""} for ${url.pathname}${url.search}.`;
  return hint ? `${main}\n${hint}\n(raw: ${trimmed})` : `${main}\n(raw: ${trimmed})`;
}
