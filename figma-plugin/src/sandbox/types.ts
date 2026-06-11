/// <reference types="@figma/plugin-typings" />

/**
 * Shared type definitions for the plugin sandbox modules.
 * Wire shapes mirror src/bridge/protocol.ts on the server side.
 */

export const TOKENS_NAMESPACE = "tokens";
export const PLUGIN_VERSION = "0.2.0";

/**
 * Node types we attempt to read tokens from and apply visual writes to.
 * Mirrors Tokens Studio's `ValidNodeTypes` including `SLOT` — a newer
 * Figma node type that some runtimes / findAllWithCriteria defaults omit.
 * Without listing SLOT explicitly, descendants of slot nodes can be
 * silently skipped during discovery.
 */
export const VALID_NODE_TYPES: NodeType[] = [
  "BOOLEAN_OPERATION",
  "COMPONENT",
  "COMPONENT_SET",
  "ELLIPSE",
  "FRAME",
  "GROUP",
  "INSTANCE",
  "LINE",
  "POLYGON",
  "RECTANGLE",
  "SLOT" as NodeType, // Not yet in @figma/plugin-typings across all versions.
  "TEXT",
  "VECTOR",
  "STAR",
];
export const OVERRIDE_KEY = "tokens-studio-mcp-bridge:storage-override";
export const SECRET_KEY_PREFIX = "tokens-studio-mcp-bridge:secret:";
export const APPLY_PREFS_KEY = "tokens-studio-mcp-bridge:apply-prefs";
export const APPLY_PREFS_DEFAULTS = { skipHidden: true, useVariables: true };
export const UNDO_INDEX_KEY = "tokens-studio-mcp-bridge:undo-index";
export const UNDO_OP_PREFIX = "tokens-studio-mcp-bridge:undo:";
export const UNDO_RING_SIZE = 50;
export const TOKENS_NOISE_KEYS = new Set(["hash", "version"]);

export function secretKey(provider: string): string {
  return SECRET_KEY_PREFIX + String(provider).trim().replace(/[^a-z0-9]/gi, "");
}

export interface RequestFrame {
  kind: "request";
  id: string;
  method: string;
  params: unknown;
}

export interface ResponseFrame {
  kind: "response";
  id: string;
  result?: unknown;
  error?: { message: string; code?: string };
}

export interface VisualWriteIn {
  nodeId: string;
  kind: string;
  value?: string | number;
  payload?: unknown;
}

export interface ApplyVisualWritesParams {
  writes?: VisualWriteIn[];
  opSummary?: string;
  skipUndoLog?: boolean;
  themeContext?: {
    themeId: string | null;
    themeGroup: string;
    themeName: string;
    previousActiveTheme: string | null;
    previousUsedTokenSet: string | null;
  } | null;
  deferUndo?: boolean;
}

export interface NodeRemap {
  nodeId: string;
  set?: Record<string, string>;
  clear?: string[];
}

export interface TypographyPayload {
  fontFamily?: string;
  fontFamilies?: string;
  fontWeight?: string | number;
  fontWeights?: string | number;
  fontSize?: string | number;
  fontSizes?: string | number;
  lineHeight?: string | number;
  lineHeights?: string | number;
  letterSpacing?: string | number;
  letterSpacings?: string | number;
  paragraphSpacing?: string | number;
  // 9-field parity with upstream Tokens Studio: paragraphIndent,
  // textCase, textDecoration are all real Figma TextNode properties.
  paragraphIndent?: string | number;
  textCase?: string;
  textDecoration?: string;
  textAlign?: string;
  __resolvedFontName?: FontName;
}

export function isRequestFrame(x: unknown): x is RequestFrame {
  return (
    !!x &&
    typeof x === "object" &&
    (x as { kind?: string }).kind === "request" &&
    typeof (x as { id?: unknown }).id === "string" &&
    typeof (x as { method?: unknown }).method === "string"
  );
}
