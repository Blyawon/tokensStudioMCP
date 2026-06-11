/**
 * Wire protocol shared between the MCP server (WS server) and the Figma
 * companion plugin (WS client). Tiny JSON-RPC-ish framing — every frame has
 * an `id` so async responses can be matched to their requests.
 *
 * The plugin imports the runtime-free TYPES from this module (the bundler
 * tree-shakes the zod imports out of the plugin build), so the wire shape
 * cannot drift between the two sides.
 */

import { z } from "zod";

// --------------------------------------------------------------------------
// Methods the MCP server can call on the plugin
// --------------------------------------------------------------------------

export const PingParams = z.object({}).strict();
export const PingResult = z.object({
  ok: z.literal(true),
  fileKey: z.string().nullable(),
  fileName: z.string().nullable(),
  currentPage: z.string().nullable(),
});

export const GetSelectionParams = z.object({}).strict();
export const GetSelectionResult = z.object({
  selection: z.array(
    z.object({ id: z.string(), name: z.string(), type: z.string() })
  ),
});

export const GetNodeTokensParams = z.object({ nodeId: z.string() }).strict();
export const GetNodeTokensResult = z.object({
  nodeId: z.string(),
  tokens: z.record(z.string()),
});

/**
 * One node's worth of remap work. `set` maps property key (`fill`,
 * `spacing`, …) to the new token reference path. `clear` is the list of
 * property keys to remove entirely.
 */
export const NodeRemap = z.object({
  nodeId: z.string(),
  set: z.record(z.string()).default({}),
  clear: z.array(z.string()).default([]),
});
export type NodeRemap = z.infer<typeof NodeRemap>;

export const ApplyRemapParams = z
  .object({
    nodes: z.array(NodeRemap),
    /**
     * Identifies the propose call this plan came from. The plugin echoes
     * it back in the result so the server can correlate logs.
     */
    planId: z.string().optional(),
  })
  .strict();

export const ApplyRemapResult = z.object({
  applied: z.number().int().nonnegative(),
  skipped: z.array(
    z.object({ nodeId: z.string(), reason: z.string() })
  ),
  errors: z.array(
    z.object({ nodeId: z.string(), property: z.string().optional(), message: z.string() })
  ),
  planId: z.string().optional(),
});

// --------------------------------------------------------------------------
// Storage config + local catalog — auto-discovery from the file's Tokens
// Studio shared plugin data. Credentials NEVER come back over this channel
// (Tokens Studio doesn't store them on the file either).
// --------------------------------------------------------------------------

export const GetStorageConfigParams = z.object({}).strict();
export const GetStorageConfigResult = z.object({
  /**
   * Raw `storageType` blob as Tokens Studio writes it. Shape varies per
   * provider — see https://github.com/tokens-studio/figma-plugin
   * src/types/StorageType.ts for the union. `null` means the file has
   * never been synced (LOCAL only).
   */
  storageType: z.unknown().nullable(),
  themes: z.unknown().nullable(),
  usedTokenSet: z.unknown().nullable(),
  activeTheme: z.unknown().nullable(),
  tokenFormat: z.unknown().nullable(),
  version: z.string().nullable(),
  updatedAt: z.string().nullable(),
  fileName: z.string().nullable(),
  fileKey: z.string().nullable(),
});

export const GetLocalCatalogParams = z.object({}).strict();
export const GetLocalCatalogResult = z.object({
  hasLocalValues: z.boolean(),
  isCompressed: z.boolean(),
  values: z.unknown().nullable(),
  parseError: z.string().nullable(),
});

/**
 * Storage override the designer typed into the plugin's Settings tab.
 * Persisted in the plugin's clientStorage, so it survives Figma restarts
 * and is per-user (NOT stored on the file). Returned as `null` when the
 * designer hasn't set one — the server then falls back to auto-discovery.
 */
export const GetStorageOverrideParams = z.object({}).strict();
export const GetStorageOverrideResult = z.object({
  override: z.unknown().nullable(),
});

/**
 * Programmatic override write — used by `create_branch { switchTo: true }`
 * so a freshly-created branch becomes active without the designer having
 * to switch via the plugin's dropdown.
 */
export const SetStorageOverrideParams = z.object({
  override: z.unknown().nullable(),
}).strict();
export const SetStorageOverrideResult = z.object({
  ok: z.literal(true),
});

/**
 * Per-provider secret saved by the designer in the Settings tab. Lives in
 * the user's local Figma clientStorage; never written to the file or
 * persisted on the MCP server. The server consults this BEFORE its env-var
 * fallback so a designer can override .env on a per-Figma-user basis.
 *
 * The wire is localhost-only but the value still leaves the plugin sandbox,
 * so we only ship it on demand (one fetch's worth, not a periodic push).
 */
export const GetSecretParams = z.object({ provider: z.string() }).strict();
export const GetSecretResult = z.object({
  provider: z.string(),
  secret: z.string().nullable(),
});

/**
 * Set the file's active theme + the matching enabled token sets, so
 * Tokens Studio's plugin (and our own resolver) treats this theme as
 * authoritative when looking up token references.
 *
 * Tokens Studio stores `activeTheme` as `JSON.stringify({ [group]: id })`
 * — `themeId` is the SHA-like identifier from `$themes.json`, NOT the
 * human-readable name. `themeGroup` defaults to "" for ungrouped themes.
 * `themeName` is kept for the in-editor toast only.
 */
export const SetActiveThemeParams = z.object({
  themeName: z.string(),
  themeId: z.string().optional(),
  themeGroup: z.string().optional(),
  enabledSets: z.array(z.string()),
  /**
   * Full set-status map (enabled/disabled/source) — preserved so the
   * plugin can write an accurate `usedTokenSet` blob instead of marking
   * every enabled set as plain "enabled". The server has always sent
   * this; the schema previously omitted it (strict-mode drift).
   */
  selectedTokenSets: z.record(z.string()).optional(),
}).strict();
export const SetActiveThemeResult = z.object({
  ok: z.literal(true),
  themeName: z.string(),
  /** Previous activeTheme blob — used by the undo log to restore on revert. */
  previousActiveTheme: z.string().nullable().optional(),
  previousUsedTokenSet: z.string().nullable().optional(),
});

/**
 * Apply concrete visual values to a list of nodes — bypasses the
 * Tokens Studio plugin entirely. Each write picks the property to mutate
 * based on `kind` (color/spacing/borderRadius/opacity/sizing/...). Sent
 * in chunks of ~200 to keep the plugin sandbox responsive.
 */
export const VisualWrite = z.object({
  nodeId: z.string(),
  /**
   * What kind of value this is — drives which Figma property to set.
   * Primitive kinds carry their value in `value`; composite kinds
   * (typography, shadow, bindings) carry a structured `payload`.
   */
  kind: z.enum([
    "color-fill",
    "color-stroke",
    "spacing",
    "horizontalPadding",
    "verticalPadding",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderRadius",
    "borderWidth",
    "opacity",
    "sizing-width",
    "sizing-height",
    "typography",
    "shadow",
    "bind-variable",
    "bind-style",
  ]),
  /**
   * Primitive value — string for colors (#RRGGBB / #RRGGBBAA), number
   * for dimensions. Required for primitive kinds, ignored for composites.
   */
  value: z.union([z.string(), z.number()]).optional(),
  /**
   * Structured payload for composite writes:
   *   typography: { fontFamily, fontWeight, fontSize, lineHeight, letterSpacing, paragraphSpacing }
   *   shadow:     [{ type, color, x, y, blur, spread }, ...]
   *   bind-variable: { variableId, field } (field e.g. "fills" / "opacity")
   *   bind-style:    { styleId, slot } (slot e.g. "fillStyleId" / "textStyleId")
   */
  payload: z.unknown().optional(),
});
export type VisualWrite = z.infer<typeof VisualWrite>;

export const ApplyVisualWritesParams = z.object({
  writes: z.array(VisualWrite),
  /** Optional human label for the undo log entry. */
  opSummary: z.string().optional(),
  /** Set when called from a revert — suppresses cascading undo entries. */
  skipUndoLog: z.boolean().optional(),
  /** Theme metadata captured for full-fidelity revert (server includes on the first chunk only). */
  themeContext: z.unknown().optional(),
  /**
   * When true, the plugin skips its `figma.commitUndo()` call. The
   * server uses this for every chunk EXCEPT the last so the whole
   * multi-chunk apply lands as one Cmd-Z entry instead of N.
   */
  deferUndo: z.boolean().optional(),
}).strict();
export const ApplyVisualWritesResult = z.object({
  applied: z.number().int().nonnegative(),
  skipped: z.array(z.object({ nodeId: z.string(), kind: z.string(), reason: z.string() })),
  errors: z.array(z.object({ nodeId: z.string(), kind: z.string(), message: z.string() })),
  readback: z.array(z.object({
    nodeId: z.string(),
    kind: z.string(),
    nodeType: z.string(),
    nodeName: z.string(),
    intended: z.string(),
    actual: z.string(),
    match: z.boolean(),
  })).optional(),
});

/**
 * Plugin-side traversal of nodes-with-applied-tokens. Avoids the slow
 * REST round-trip AND works when figma.fileKey is null (drafts, branches,
 * org files where the plugin API doesn't expose a fileKey).
 */
export const EnumerateTokenizedNodesParams = z.object({
  scope: z.enum(["currentPage", "selection", "document"]),
  skipHidden: z.boolean().optional(),
}).strict();
export const EnumerateTokenizedNodesResult = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    /** propertyKey → token reference path (already JSON-decoded by the plugin). */
    tokens: z.record(z.string()),
    locked: z.boolean().optional(),
  })),
  scopeDescription: z.string(),
});

/**
 * Diagnostic: dump per-node state that might override raw writes (Figma
 * Variable bindings + attached style ids + instance-nesting). Used to
 * figure out why a specific layer visually doesn't re-theme even though
 * the plugin reports the write as applied.
 */
export const InspectBoundVariablesParams = z.object({
  nodeIds: z.array(z.string()).optional(),
  scope: z.enum(["selection", "self-and-descendants"]).optional(),
}).strict();
export const InspectBoundVariablesResult = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    insideInstance: z.boolean(),
    locked: z.boolean().optional(),
    boundVariables: z.record(z.unknown()).nullable(),
    fillsBindings: z.array(z.record(z.unknown())).nullable(),
    strokesBindings: z.array(z.record(z.unknown())).nullable(),
    effectsBindings: z.array(z.record(z.unknown())).nullable(),
    fillStyleId: z.string().nullable(),
    strokeStyleId: z.string().nullable(),
    effectStyleId: z.string().nullable(),
    textStyleId: z.string().nullable(),
  })),
});

// --------------------------------------------------------------------------
// Canvas authoring ops — figma-cli parity through the long-lived plugin.
// --------------------------------------------------------------------------

/**
 * Execute arbitrary JavaScript inside the plugin sandbox (full `figma`
 * plugin API). Localhost bridge only; same trust level as the plugin
 * itself. Results are sanitized JSON (nodes → {id,name,type} stubs).
 */
export const EvalCodeParams = z.object({
  code: z.string(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
export const EvalCodeResult = z.object({ result: z.unknown() });

/**
 * Structured node operation dispatcher. `op` selects the operation
 * (createNode / setNodeProps / nodeAction / getNodeTree / findNodes /
 * exportNode / variables); `args` is op-specific and validated by the
 * sandbox implementation. Kept loose here on purpose — one wire method
 * instead of seven keeps the protocol (and version-skew surface) small.
 */
export const NodeOpParams = z.object({
  op: z.string(),
  args: z.record(z.unknown()).optional(),
}).strict();
export const NodeOpResult = z.unknown();

// --------------------------------------------------------------------------
// SERVER-handled methods — called by the plugin UI's "Test & pull" controls.
// --------------------------------------------------------------------------

/**
 * Test the configured token source and return a summary. Either uses
 * `config` directly (for in-flight form values that haven't been saved yet)
 * or falls back to the standard resolution chain (saved override →
 * auto-discovered → local cache). `secret` overrides everything for this
 * single call so users can verify a token they just typed.
 */
export const PullCatalogParams = z
  .object({
    config: z.unknown().optional(),
    secret: z.string().optional(),
  })
  .strict();
export const PullCatalogResult = z.object({
  ok: z.boolean(),
  source: z
    .object({
      provider: z.string(),
      description: z.string(),
      filesFetched: z.number(),
    })
    .optional(),
  summary: z
    .object({
      sets: z.array(z.string()),
      tokenCount: z.number(),
      themeCount: z.number(),
    })
    .optional(),
  error: z
    .object({ message: z.string(), hint: z.string().optional() })
    .optional(),
  fetchedAt: z.string().optional(),
});

/**
 * List branches available on the current storage source. v1 only
 * supports git-style providers (github / gitlab / bitbucket / ado).
 * For non-git providers (jsonbin / url / supernova / tokensStudio), the
 * server returns `ok: false` with a message — the UI should hide the
 * branch selector for those.
 */
export const ListBranchesParams = z.object({}).strict();
export const ListBranchesResult = z.object({
  ok: z.boolean(),
  provider: z.string().optional(),
  branches: z.array(z.string()).optional(),
  active: z.string().nullable().optional(),
  error: z.object({ message: z.string(), hint: z.string().optional() }).optional(),
});

/**
 * Apply preferences saved in the plugin's clientStorage. The server reads
 * these via `getApplyPrefs` so the designer's choices in the Settings tab
 * govern every apply call (UI- or MCP-initiated) — explicit args still win.
 */
export const ApplyPrefs = z.object({
  skipHidden: z.boolean().default(true),
  useVariables: z.boolean().default(true),
});
export type ApplyPrefs = z.infer<typeof ApplyPrefs>;

export const GetApplyPrefsParams = z.object({}).strict();
export const GetApplyPrefsResult = z.object({
  prefs: ApplyPrefs,
});

/**
 * Server-handled theme operations called by the plugin's Themes tab —
 * mirror the MCP tools but emit progress frames so the UI can show a bar.
 */
export const ApplyThemeFromUIParams = z.object({
  themeName: z.string(),
  /** Optional override; default: whole document. */
  nodeId: z.string().optional(),
  /** Scope: selection, currentPage, or document. */
  scope: z.enum(["selection", "currentPage", "document"]).optional(),
  /** Override the saved apply prefs for this single call. */
  skipHidden: z.boolean().optional(),
  bindingMode: z.enum(["auto", "always", "never"]).optional(),
  dryRun: z.boolean().optional(),
}).strict();
export const ApplyThemeFromUIResult = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string(), hint: z.string().optional() }).optional(),
});

export const ListThemesFromUIParams = z.object({}).strict();
export const ListThemesFromUIResult = z.object({
  ok: z.boolean(),
  themes: z.array(z.object({
    name: z.string(),
    id: z.string().optional(),
    group: z.string().optional(),
    enabledSetCount: z.number(),
  })).optional(),
  activeTheme: z.string().nullable().optional(),
  error: z.object({ message: z.string(), hint: z.string().optional() }).optional(),
});

// --------------------------------------------------------------------------
// Target pinning — "Pick current target" in the plugin UI
// --------------------------------------------------------------------------

export const TargetShape = z.object({
  fileKey: z.string(),
  nodeId: z.string().nullable(),
  name: z.string().nullable(),
  url: z.string(),
}).strict();
export type TargetShape = z.infer<typeof TargetShape>;

export const GetLiveTargetParams = z.object({}).strict();
export const GetLiveTargetResult = z.object({ target: TargetShape.nullable() });

export const SetPinnedTargetParams = z.object({ target: TargetShape.nullable() }).strict();
export const SetPinnedTargetResult = z.object({ ok: z.literal(true) });

// --------------------------------------------------------------------------
// Inspect — Inspect tab in the plugin UI
// --------------------------------------------------------------------------

/**
 * Deep-inspect scope controls how many nodes the handler walks:
 *   - `node`     : just the selected node
 *   - `subtree`  : selected node + descendants (capped at MAX_INSPECT_NODES)
 */
export const InspectScope = z.enum(["node", "subtree"]);
export type InspectScope = z.infer<typeof InspectScope>;

export const InspectNodeParams = z.object({
  fileKey: z.string(),
  nodeId: z.string(),
  scope: InspectScope.optional(),
  themeName: z.string().optional(),
  maxSuggestions: z.number().int().min(1).max(10).optional(),
}).strict();

export const InspectSuggestion = z.object({
  newToken: z.string(),
  score: z.number(),
  reason: z.string(),
  set: z.string().optional(),
});

export const InspectRow = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  nodeType: z.string(),
  property: z.string(),
  tokenPath: z.string(),
  tokenType: z.string().optional(),
  set: z.string().optional(),
  /** Resolved primitive value (string or number) when the token resolves. */
  resolvedValue: z.union([z.string(), z.number()]).optional(),
  /** Discriminator for composite kinds (composition/typography/shadow). */
  resolvedKind: z.enum(["primitive", "composition", "typography", "shadow"]).optional(),
  trail: z.array(z.string()).optional(),
  broken: z.boolean(),
  failureReason: z.string().optional(),
  suggestions: z.array(InspectSuggestion).optional(),
});

export const InspectGap = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  property: z.string(),
  suggestions: z.array(InspectSuggestion).optional(),
});

export const InspectNodeResult = z.object({
  rootNodeId: z.string(),
  rootNodeName: z.string(),
  rootNodeType: z.string(),
  summary: z.object({
    tokens: z.number().int().nonnegative(),
    broken: z.number().int().nonnegative(),
    gaps: z.number().int().nonnegative(),
    nodesInspected: z.number().int().nonnegative(),
  }),
  themeName: z.string().optional(),
  enabledSets: z.array(z.string()),
  variantAxes: z.record(z.string()).optional(),
  rows: z.array(InspectRow),
  gaps: z.array(InspectGap),
});

/**
 * Stage a fix for a broken token by writing an alias into the active
 * working copy. Creates `brokenPath: "{suggestedPath}"` so the node's
 * existing reference resolves. Appears in `list_pending_edits` and is
 * shipped to Git by `commit_and_push`.
 */
export const StageTokenFixParams = z.object({
  brokenPath: z.string(),
  suggestedPath: z.string(),
  /** Target set to add the alias into. Defaults to the first enabled set. */
  set: z.string().optional(),
  /** Tokens Studio token type for the alias (e.g. "color"). Inferred if omitted. */
  type: z.string().optional(),
}).strict();
export const StageTokenFixResult = z.object({
  ok: z.boolean(),
  set: z.string().optional(),
  editCount: z.number().int().nonnegative().optional(),
  error: z.object({ message: z.string(), hint: z.string().optional() }).optional(),
});

// --------------------------------------------------------------------------
// Frame schema
// --------------------------------------------------------------------------

/**
 * Method registry — the discriminator for request / response routing.
 * Adding a new method = add an entry here AND a handler in the plugin.
 */
/**
 * Methods the plugin handles (server-initiated requests). The MCP server
 * sends these over the wire, the plugin sandbox executes them.
 */
export const PLUGIN_METHODS = [
  "ping",
  "getSelection",
  "getNodeTokens",
  "applyRemap",
  "getStorageConfig",
  "getLocalCatalog",
  "getStorageOverride",
  "setStorageOverride",
  "getSecret",
  "setActiveTheme",
  "applyVisualWrites",
  "getApplyPrefs",
  "enumerateTokenizedNodes",
  "getLiveTarget",
  "inspectBoundVariables",
  "evalCode",
  "nodeOp",
] as const;

/**
 * Methods the SERVER handles (plugin-initiated requests). The plugin's UI
 * iframe sends these — used for the Settings tab's Test/Pull controls so
 * the user can validate a config without going through chat.
 */
export const SERVER_METHODS = [
  "pullCatalog",
  "listBranches",
  "applyThemeFromUI",
  "listThemesFromUI",
  "setPinnedTarget",
  "inspectNode",
  "stageTokenFix",
] as const;

export const METHODS = [...PLUGIN_METHODS, ...SERVER_METHODS] as const;
export type Method = (typeof METHODS)[number];
export type PluginMethod = (typeof PLUGIN_METHODS)[number];
export type ServerMethod = (typeof SERVER_METHODS)[number];

export const RequestFrame = z.object({
  kind: z.literal("request"),
  id: z.string(),
  method: z.enum(METHODS),
  params: z.unknown(),
});
export type RequestFrame = z.infer<typeof RequestFrame>;

export const ResponseFrame = z.object({
  kind: z.literal("response"),
  id: z.string(),
  result: z.unknown().optional(),
  error: z
    .object({ message: z.string(), code: z.string().optional() })
    .optional(),
});
export type ResponseFrame = z.infer<typeof ResponseFrame>;

/**
 * Progress update for an in-flight request. Carries the same `id` as the
 * RequestFrame it relates to; multiple may arrive before the final
 * ResponseFrame. The plugin UI's `uiRequest` matches by id and calls an
 * onProgress hook without resolving the promise.
 */
export const ProgressFrame = z.object({
  kind: z.literal("progress"),
  id: z.string(),
  current: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  message: z.string().optional(),
});
export type ProgressFrame = z.infer<typeof ProgressFrame>;

export const Frame = z.discriminatedUnion("kind", [
  RequestFrame,
  ResponseFrame,
  ProgressFrame,
]);
export type Frame = z.infer<typeof Frame>;

/**
 * The plugin echoes a `hello` once on connect so the server learns the
 * fileKey without needing a follow-up round trip.
 */
export const HelloFrame = z.object({
  kind: z.literal("hello"),
  fileKey: z.string().nullable(),
  fileName: z.string().nullable(),
  pluginVersion: z.string(),
});
export type HelloFrame = z.infer<typeof HelloFrame>;

/** Anything from the wire — server validates with this. */
export const AnyFrame = z.union([Frame, HelloFrame]);

// --------------------------------------------------------------------------
// Per-method param/result schema lookup — used by the plugin to validate
// inbound params before handing them to its handler, and by the server to
// validate results before resolving the request.
// --------------------------------------------------------------------------

export const SCHEMAS: Record<
  Method,
  { params: z.ZodTypeAny; result: z.ZodTypeAny }
> = {
  ping: { params: PingParams, result: PingResult },
  getSelection: { params: GetSelectionParams, result: GetSelectionResult },
  getNodeTokens: { params: GetNodeTokensParams, result: GetNodeTokensResult },
  applyRemap: { params: ApplyRemapParams, result: ApplyRemapResult },
  getStorageConfig: { params: GetStorageConfigParams, result: GetStorageConfigResult },
  getLocalCatalog: { params: GetLocalCatalogParams, result: GetLocalCatalogResult },
  getStorageOverride: { params: GetStorageOverrideParams, result: GetStorageOverrideResult },
  setStorageOverride: { params: SetStorageOverrideParams, result: SetStorageOverrideResult },
  getSecret: { params: GetSecretParams, result: GetSecretResult },
  setActiveTheme: { params: SetActiveThemeParams, result: SetActiveThemeResult },
  applyVisualWrites: { params: ApplyVisualWritesParams, result: ApplyVisualWritesResult },
  enumerateTokenizedNodes: { params: EnumerateTokenizedNodesParams, result: EnumerateTokenizedNodesResult },
  getApplyPrefs: { params: GetApplyPrefsParams, result: GetApplyPrefsResult },
  pullCatalog: { params: PullCatalogParams, result: PullCatalogResult },
  listBranches: { params: ListBranchesParams, result: ListBranchesResult },
  applyThemeFromUI: { params: ApplyThemeFromUIParams, result: ApplyThemeFromUIResult },
  listThemesFromUI: { params: ListThemesFromUIParams, result: ListThemesFromUIResult },
  getLiveTarget: { params: GetLiveTargetParams, result: GetLiveTargetResult },
  setPinnedTarget: { params: SetPinnedTargetParams, result: SetPinnedTargetResult },
  inspectNode: { params: InspectNodeParams, result: InspectNodeResult },
  stageTokenFix: { params: StageTokenFixParams, result: StageTokenFixResult },
  inspectBoundVariables: { params: InspectBoundVariablesParams, result: InspectBoundVariablesResult },
  evalCode: { params: EvalCodeParams, result: EvalCodeResult },
  nodeOp: { params: NodeOpParams, result: NodeOpResult },
};

export const DEFAULT_BRIDGE_PORT = 3055;
export const PLUGIN_VERSION = "0.1.0";
