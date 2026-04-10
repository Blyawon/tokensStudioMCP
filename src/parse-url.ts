export interface FigmaTarget {
  fileKey: string;
  nodeId?: string;
}

/**
 * Parses a Figma URL, a bare file key, or an explicit (fileKey, nodeId) pair
 * into a canonical {fileKey, nodeId?} target.
 *
 * Accepted inputs:
 *   https://www.figma.com/design/<fileKey>/<slug>?node-id=1-2
 *   https://www.figma.com/file/<fileKey>/<slug>?node-id=1-2
 *   https://www.figma.com/board/<fileKey>/...
 *   <fileKey>                                 (22+ char alphanumeric)
 *
 * Node IDs in URLs use the `1-2` form. The REST API uses `1:2`. This
 * function always returns the REST form so the caller can pass it straight
 * to the Figma client.
 */
export function parseFigmaTarget(input: {
  url?: string;
  fileKey?: string;
  nodeId?: string;
}): FigmaTarget {
  let fileKey = input.fileKey?.trim() || "";
  let nodeId = input.nodeId?.trim() || undefined;

  if (input.url) {
    const parsed = parseFigmaUrl(input.url);
    fileKey = fileKey || parsed.fileKey;
    nodeId = nodeId || parsed.nodeId;
  }

  if (!fileKey) {
    throw new Error(
      "No Figma file key resolved. Pass either a Figma URL or a fileKey."
    );
  }

  if (!/^[A-Za-z0-9]{10,}$/.test(fileKey)) {
    throw new Error(
      `Invalid Figma file key: "${fileKey}". Expected an alphanumeric key from the URL.`
    );
  }

  return {
    fileKey,
    nodeId: nodeId ? normalizeNodeId(nodeId) : undefined,
  };
}

function parseFigmaUrl(url: string): { fileKey: string; nodeId?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Could not parse URL: ${url}`);
  }

  // Path shapes: /design/<key>/..., /file/<key>/..., /board/<key>/...
  const segments = parsed.pathname.split("/").filter(Boolean);
  const keyIndex = segments.findIndex((s) =>
    ["design", "file", "board", "proto"].includes(s)
  );
  if (keyIndex === -1 || !segments[keyIndex + 1]) {
    throw new Error(
      `URL does not look like a Figma file URL: ${url}`
    );
  }

  const fileKey = segments[keyIndex + 1];
  const nodeIdParam = parsed.searchParams.get("node-id") || undefined;

  return { fileKey, nodeId: nodeIdParam };
}

/** Figma REST API expects `1:2`. URLs use `1-2`. Normalize to `:`. */
export function normalizeNodeId(id: string): string {
  const trimmed = id.trim();
  // Preserve existing `:` separator; otherwise swap the first `-` for `:`.
  if (trimmed.includes(":")) return trimmed;
  return trimmed.replace("-", ":");
}
