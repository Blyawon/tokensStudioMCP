/**
 * MCP stdio server — all tool registrations and bridge handler wiring.
 * This file owns the `McpServer` instance, the `toolError` helper, and
 * every `server.tool()` call. Business logic lives in separate modules
 * (apply-theme, apply-remap, figma-helpers, resolve-storage).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getBridge } from "./bridge/server.js";
import type { RemapPlan } from "./remap/types.js";
import { collectNodeUses } from "./remap/collect.js";
import { ingestTokenSet } from "./remap/ingest.js";
import { proposeRemap } from "./remap/matcher.js";
import { compileRules, applyRules, type RenameRule } from "./remap/rename.js";
import {
  suggestTokens,
  flattenCatalogToSummaries,
  collectNearbyTokens,
  parseVariantAxesFromName,
} from "./remap/suggest.js";
import { makeSkipPredicate, extractTokens } from "./tokens.js";
import { renderMetadataXml, renderSingleNodeTokens } from "./xml.js";
import { renderCompactTree, renderTokensList } from "./render-tree.js";
import {
  fetchCatalog,
  invalidateCatalogCache,
} from "./storage/index.js";
import { listSecretStatus, resolveSecret } from "./storage/secrets.js";
import {
  ensureWorkingCatalog,
  snapshotWorkingCopy,
  discardWorkingCopy,
  addEdit,
  buildFlushPlan,
  markCommitted,
} from "./storage/working-copy.js";
import { getWritable } from "./storage/writable.js";
import "./storage/github-write.js";

import {
  getClient,
  loadNode,
  parseFigmaTargetOrPinned,
  getLoadedConfig,
  findNodeById,
  findEnclosingVariantName,
} from "./figma-helpers.js";
import { resolveStorageConfig } from "./resolve-storage.js";
import { applyTheme, clearFingerprintCache } from "./apply-theme.js";
import { applyTokenRemap, applyToVariants } from "./apply-remap.js";
import { toolError, validateTokenPath, debugLog } from "./tools/shared.js";
import { registerBridgeHandlers } from "./bridge/handlers/index.js";
import { handleInspectNodeRequest } from "./bridge/handlers/inspect-node.js";

// --------------------------------------------------------------------------
// Version — read from package.json so it's always in sync.
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// --------------------------------------------------------------------------
// Server instance
// --------------------------------------------------------------------------

const server = new McpServer({
  name: "tokens-studio-mcp",
  version: PKG_VERSION,
});

// --------------------------------------------------------------------------
// Reading tools
// --------------------------------------------------------------------------

server.tool(
  "get_metadata_with_tokens",
  "STEP 2 of the recommended flow (call `list_tokens` first to see which " +
    "tokens exist before fetching the whole tree). Returns a Figma MCP-style " +
    "get_metadata XML tree for a Figma file or node, decorated with Tokens " +
    "Studio applied tokens on every node. Every element gets a <tokens .../> " +
    'child; nodes without applied tokens emit <tokens applied="none"/>. The ' +
    'root element carries a token-coverage="<withTokens>/<total>" attribute. ' +
    "Nodes with visual styling (shared styles, raw fills/strokes/effects) but " +
    'no covering token get an untokenized="fill,stroke,…" attribute on their ' +
    "tokens element. x/y/w/h are omitted by default — pass layout=true if you " +
    "need them. Composition tokens are stripped by default (they duplicate " +
    "individual property tokens); pass includeComposition=true to include them.",
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
    depth: z.number().int().positive().optional(),
    onlyWithTokens: z.boolean().optional(),
    onlyGaps: z.boolean().optional(),
    layout: z.boolean().optional(),
    includeComposition: z.boolean().optional(),
    withComponents: z.boolean().optional(),
    withVectors: z.boolean().optional(),
  },
  async (args) => {
    try {
      const target = parseFigmaTargetOrPinned(args);
      const client = getClient();
      const node = await loadNode(client, target, args.depth);
      const baseConfig = getLoadedConfig().config;
      const config = {
        ...baseConfig,
        ignoreComponents: args.withComponents ? false : baseConfig.ignoreComponents,
        ignoreVectorsWithoutFill: args.withVectors ? false : baseConfig.ignoreVectorsWithoutFill,
      };
      const skipNode = makeSkipPredicate(config);
      const result = renderMetadataXml(node, {
        onlyWithTokens: args.onlyWithTokens ?? config.onlyWithTokens,
        onlyGaps: args.onlyGaps,
        layout: args.layout,
        warnStyleGaps: config.warnStyleGaps,
        includeComposition:
          args.includeComposition ?? config.includeComposition,
        skipNode,
      });
      return { content: [{ type: "text" as const, text: result.xml }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "get_node_tokens",
  "Return just the Tokens Studio applied tokens for a single Figma node, as a " +
    'tiny XML snippet. Untokenized nodes come back as <tokens applied="none"/>.',
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
  },
  async (args) => {
    try {
      const target = parseFigmaTargetOrPinned(args);
      if (!target.nodeId) {
        throw new Error(
          "get_node_tokens needs a node id. Pass nodeId or a URL with ?node-id=…"
        );
      }
      const client = getClient();
      const node = await loadNode(client, target, 1);
      return { content: [{ type: "text" as const, text: renderSingleNodeTokens(node) }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "inspect_node",
  "Deep-inspect a Figma node (or its subtree) against the current token " +
    "catalog: returns every applied token with its resolved value, flags broken " +
    "references (unresolved / missing set / cycle / literal 'none'), and " +
    "attaches the top remap suggestions for each broken token plus any style " +
    "gaps. Pass scope='subtree' to walk descendants. Backs the plugin's " +
    "Inspect tab; use it in chat when you need to audit a frame's token " +
    "coverage end-to-end without assembling the pieces yourself.",
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
    scope: z.enum(["node", "subtree"]).optional(),
    themeName: z.string().optional(),
    maxSuggestions: z.number().int().min(1).max(10).optional(),
  },
  async (args) => {
    try {
      const target = parseFigmaTargetOrPinned(args);
      if (!target.nodeId) {
        throw new Error(
          "inspect_node needs a node id. Pass nodeId or a URL with ?node-id=…"
        );
      }
      const result = await handleInspectNodeRequest({
        fileKey: target.fileKey,
        nodeId: target.nodeId,
        scope: args.scope,
        themeName: args.themeName,
        maxSuggestions: args.maxSuggestions,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "list_tokens",
  "START HERE for any question about which design tokens a Figma frame uses. " +
    "Cheap pre-flight: returns the unique Tokens Studio tokens applied anywhere " +
    "in a subtree, grouped by property (fill, spacing, typography, …), with the " +
    "layer names that use each value and a style-gap report at the bottom. " +
    "Much smaller than `get_metadata_with_tokens` — call this first to decide " +
    "whether you actually need the full tree. If the subtree relies on " +
    "`composition` tokens the response surfaces a one-line hint so you don't " +
    "get silent empty output; pass includeComposition=true to include them.",
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
    depth: z.number().int().positive().optional(),
    includeComposition: z.boolean().optional(),
    withComponents: z.boolean().optional(),
    withVectors: z.boolean().optional(),
  },
  async (args) => {
    try {
      const target = parseFigmaTargetOrPinned(args);
      const client = getClient();
      const node = await loadNode(client, target, args.depth);
      const baseConfig = getLoadedConfig().config;
      const config = {
        ...baseConfig,
        ignoreComponents: args.withComponents ? false : baseConfig.ignoreComponents,
        ignoreVectorsWithoutFill: args.withVectors ? false : baseConfig.ignoreVectorsWithoutFill,
      };
      const skipNode = makeSkipPredicate(config);
      const text = renderTokensList(node, {
        skipNode,
        warnStyleGaps: config.warnStyleGaps,
        includeComposition:
          args.includeComposition ?? config.includeComposition,
      });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --------------------------------------------------------------------------
// Token remapping tools
// --------------------------------------------------------------------------

const RemapPlanSchema = z
  .object({
    byProperty: z.record(
      z.array(
        z.object({
          oldToken: z.string(),
          chosen: z.string().nullable().optional(),
          candidates: z.array(z.unknown()).optional(),
          nodes: z
            .array(
              z.object({
                id: z.string(),
                name: z.string().optional(),
                type: z.string().optional(),
              })
            )
            .optional(),
        })
      )
    ),
  })
  .passthrough();

server.tool(
  "propose_token_remap",
  "Plan a token remap for a Figma subtree against a NEW token set the user " +
    "pasted as JSON. Read-only — does NOT touch the Figma file. Returns " +
    "candidate new tokens (with scores + reasoning) for every old token " +
    "currently applied in the subtree, plus an `ambiguous` list where the " +
    "agent should pick. Pass the returned plan to `apply_token_remap` once " +
    "you've resolved ambiguity. Accepts any reasonable shape for `newTokens` " +
    "(Tokens Studio export, single-set object, DTCG, or a flat list of paths).",
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
    depth: z.number().int().positive().optional(),
    newTokens: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]),
    hints: z.record(z.string()).optional(),
    preferredTheme: z.string().optional(),
  },
  async (args) => {
    try {
      const target = parseFigmaTargetOrPinned(args);
      const client = getClient();
      const node = await loadNode(client, target, args.depth);
      const config = getLoadedConfig().config;
      const skipNode = makeSkipPredicate(config);
      const uses = collectNodeUses(node, skipNode);
      const catalog = ingestTokenSet(args.newTokens);
      const plan = proposeRemap(uses, catalog, {
        hints: args.hints,
        preferredTheme: args.preferredTheme,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(plan, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "apply_token_remap",
  "Apply a remap plan to the live Figma file via the companion plugin. " +
    "Requires the 'Tokens Studio MCP Bridge' Figma plugin to be running and " +
    "connected — call `bridge_status` first if unsure. Pass the plan you got " +
    "back from `propose_token_remap`, after deciding `chosen` for any " +
    "ambiguous entries. `dryRun: true` runs validation but skips the write. " +
    "The whole batch is wrapped in a single Figma undo entry — Cmd-Z reverts " +
    "the entire remap.",
  {
    plan: RemapPlanSchema,
    dryRun: z.boolean().optional(),
    planId: z.string().optional(),
  },
  async (args) => {
    try {
      const result = await applyTokenRemap(args.plan as unknown as RemapPlan, {
        dryRun: args.dryRun ?? false,
        planId: args.planId,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --------------------------------------------------------------------------
// Catalog & theme tools
// --------------------------------------------------------------------------

server.tool(
  "get_token_storage_config",
  "Auto-discover Tokens Studio's sync provider config from the live Figma " +
    "file (via the companion plugin). Returns the storageType blob (provider, " +
    "id, branch, filePath, ...) plus themes / activeTheme / tokenFormat / " +
    "version metadata. Credentials are NOT returned — they live in env vars " +
    "on the MCP server. Pair with `get_token_catalog` to actually fetch the " +
    "tokens. Returns null storageType when the file has only a local cache " +
    "(use `get_token_catalog` with no override to read it).",
  {},
  async () => {
    try {
      const bridge = getBridge();
      await bridge.start();
      const cfg = (await bridge.request("getStorageConfig", {})) as Record<
        string,
        unknown
      >;
      const secrets = listSecretStatus();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...cfg, secrets }, null, 2),
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "get_token_catalog",
  "Fetch the canonical Tokens Studio token catalog from its sync source " +
    "(GitHub, GitLab, Bitbucket, ADO, JSONBin, URL, Tokens Studio SaaS, " +
    "Supernova) — or from the file's local cache when no remote sync. " +
    "By default auto-discovers the storage config from the live file via " +
    "the plugin; pass `override` to point at a different repo / branch / " +
    "file path. Returns the parsed token tree, themes, and metadata. " +
    "Credentials come from env vars (TOKENS_STUDIO_<PROVIDER>_TOKEN); call " +
    "`get_token_storage_config` first to see which secrets are configured.",
  {
    override: z
      .object({
        provider: z.string(),
        id: z.string().optional(),
        branch: z.string().optional(),
        filePath: z.string().optional(),
        baseUrl: z.string().optional(),
        username: z.string().optional(),
        orgId: z.string().optional(),
        designSystemUrl: z.string().optional(),
        mapping: z.string().optional(),
        additionalHeaders: z.record(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    secret: z.string().optional(),
  },
  async (args) => {
    try {
      const config = await resolveStorageConfig(args.override);
      const catalog = await fetchCatalog(config, { secret: args.secret });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(catalog, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "list_themes",
  "List the themes defined in the active token catalog (auto-fetched if " +
    "needed). Each theme reports its enabled token sets so the agent can " +
    "decide which one to apply. Pair with `apply_theme` to switch the " +
    "file's active theme and (optionally) write resolved values to nodes.",
  {},
  async () => {
    try {
      const config = await resolveStorageConfig(undefined);
      const catalog = await fetchCatalog(config);
      const themes = Array.isArray(catalog.themes)
        ? (catalog.themes as Array<{
            name: string;
            id?: string;
            group?: string;
            selectedTokenSets?: Record<string, string>;
          }>)
        : [];
      const summary = themes.map((t) => {
        const enabled = Object.entries(t.selectedTokenSets ?? {})
          .filter(([, v]) => v === "enabled" || v === "source")
          .map(([k]) => k);
        return {
          name: t.name,
          id: t.id,
          group: t.group,
          enabledSetCount: enabled.length,
          enabledSets: enabled,
        };
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { source: catalog.source, count: themes.length, themes: summary },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "apply_theme",
  "Switch the file to a theme and resolve every applied token to its " +
    "concrete value. Sets the file's `activeTheme` + `usedTokenSet` shared " +
    "plugin data (so Tokens Studio recognizes the switch), then walks the " +
    "subtree and writes resolved values directly via the plugin — no need to " +
    "click 'Apply' in Tokens Studio. " +
    "Supports color (fill/stroke), spacing/padding (all 4 axes), border " +
    "radius/width, opacity, sizing, **composition** (auto-expanded into " +
    "their constituent property writes), **typography** (font family / " +
    "weight / size / line-height / letter-spacing — pre-loads fonts in " +
    "parallel), and **shadow** (drop / inner via the effects array). " +
    "Math expressions like `{base.size.4} * 2` are evaluated; references " +
    "are followed (cycle-protected at depth 16). " +
    "Hidden nodes are skipped by default for both performance and intent. " +
    "Pass `dryRun: true` to see what would be written without touching the file.",
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
    themeName: z.string(),
    skipHidden: z.boolean().optional(),
    onlyColor: z.boolean().optional(),
    bindingMode: z.enum(["auto", "always", "never"]).optional(),
    setActive: z.boolean().optional(),
    scope: z.enum(["auto", "currentPage", "selection", "document"]).optional(),
    dryRun: z.boolean().optional(),
  },
  async (args) => {
    try {
      const target = args.url || args.fileKey || args.nodeId
        ? parseFigmaTargetOrPinned(args)
        : (getBridge().pinnedTarget
            ? { fileKey: getBridge().pinnedTarget!.fileKey, nodeId: getBridge().pinnedTarget!.nodeId ?? undefined }
            : { fileKey: "", nodeId: undefined });
      const result = await applyTheme(target, {
        themeName: args.themeName,
        skipHidden: args.skipHidden ?? true,
        onlyColor: args.onlyColor ?? false,
        bindingMode: args.bindingMode ?? "auto",
        setActive: args.setActive ?? true,
        scope: args.scope ?? "auto",
        dryRun: args.dryRun ?? false,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --------------------------------------------------------------------------
// Token authoring tools
// --------------------------------------------------------------------------

server.tool(
  "bulk_rename_tokens",
  "Rename tokens by exact path or wildcard pattern, in two scopes: " +
    "**live** (rewrite applied references on Figma nodes via apply_token_remap) " +
    "and/or **files** (stage `rename_token` edits on the catalog working copy). " +
    "`scope: \"both\"` (default) does both. `dryRun: true` returns counts " +
    "without modifying anything. Pattern syntax: `*` captures one path " +
    "segment, referenced as `$1` in replacement (e.g. `colors.brand.* → " +
    "color.accent.$1`).",
  {
    rules: z.array(z.union([
      z.object({ from: z.string(), to: z.string() }),
      z.object({ fromPattern: z.string(), replacement: z.string() }),
    ])),
    scope: z.enum(["live", "files", "both"]).optional(),
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
    dryRun: z.boolean().optional(),
  },
  async (args) => {
    try {
      const compiled = compileRules(args.rules as RenameRule[]);
      const scope = args.scope ?? "both";
      const dryRun = args.dryRun ?? false;
      const out: {
        scope: string;
        dryRun: boolean;
        live?: { matched: number; nodes: number; planByProperty: Record<string, number> };
        files?: { matched: number; ruleHits: Array<{ from: string; to: string }> };
      } = { scope, dryRun };

      if (scope === "live" || scope === "both") {
        const target = parseFigmaTargetOrPinned({
          url: args.url,
          fileKey: args.fileKey,
          nodeId: args.nodeId,
        });
        const client = getClient();
        const root = await loadNode(client, target);
        const config = getLoadedConfig().config;
        const skipNode = makeSkipPredicate(config);

        const writes: Array<{ nodeId: string; nodeName: string; nodeType: string; prop: string; oldToken: string; newToken: string }> = [];
        function walk(n: import("./figma-client.js").FigmaNode, isRoot: boolean): void {
          if (!isRoot && skipNode?.(n)) return;
          const tokens = extractTokens(n);
          for (const [prop, tokenPath] of Object.entries(tokens)) {
            const newPath = applyRules(compiled, tokenPath);
            if (newPath && newPath !== tokenPath) {
              writes.push({
                nodeId: n.id,
                nodeName: n.name || "(unnamed)",
                nodeType: n.type,
                prop,
                oldToken: tokenPath,
                newToken: newPath,
              });
            }
          }
          for (const c of n.children ?? []) walk(c, false);
        }
        walk(root, true);

        const grouped: Record<string, Map<string, { newToken: string; nodes: Array<{ id: string; name: string; type: string }> }>> = {};
        for (const w of writes) {
          if (!grouped[w.prop]) grouped[w.prop] = new Map();
          const key = w.oldToken;
          let entry = grouped[w.prop].get(key);
          if (!entry) {
            entry = { newToken: w.newToken, nodes: [] };
            grouped[w.prop].set(key, entry);
          }
          entry.nodes.push({ id: w.nodeId, name: w.nodeName, type: w.nodeType });
        }
        const planByProperty: Record<string, number> = {};
        for (const [prop, m] of Object.entries(grouped)) planByProperty[prop] = m.size;

        out.live = {
          matched: writes.length,
          nodes: new Set(writes.map((w) => w.nodeId)).size,
          planByProperty,
        };

        if (!dryRun && writes.length > 0) {
          const byProperty: Record<string, Array<{ oldToken: string; chosen: string; nodes: Array<{ id: string; name: string; type: string }> }>> = {};
          for (const [prop, m] of Object.entries(grouped)) {
            byProperty[prop] = Array.from(m.entries()).map(([oldToken, v]) => ({
              oldToken,
              chosen: v.newToken,
              nodes: v.nodes,
            }));
          }
          await applyTokenRemap(
            { byProperty } as unknown as RemapPlan,
            { dryRun: false }
          );
        }
      }

      if (scope === "files" || scope === "both") {
        const config = await resolveStorageConfig(undefined);
        await ensureWorkingCatalog(config);
        const catalog = await fetchCatalog(config);
        const summaries = flattenCatalogToSummaries(catalog.values, null);
        const ruleHits: Array<{ from: string; to: string }> = [];
        const invalidHits: Array<{ from: string; to: string; reason: string }> = [];
        for (const t of summaries) {
          const newPath = applyRules(compiled, t.path);
          if (newPath && newPath !== t.path) {
            try {
              validateTokenPath(newPath);
            } catch (err) {
              invalidHits.push({
                from: t.path,
                to: newPath,
                reason: err instanceof Error ? err.message : String(err),
              });
              continue;
            }
            ruleHits.push({ from: t.path, to: newPath });
            if (!dryRun) {
              addEdit({ kind: "rename", from: t.path, to: newPath, set: t.set, updateRefs: true });
            }
          }
        }
        if (invalidHits.length > 0) {
          throw new Error(
            `Rename rules produced ${invalidHits.length} invalid token path(s). Fix your rules and retry:\n` +
              invalidHits.map((h) => `  - '${h.from}' → '${h.to}': ${h.reason}`).join("\n")
          );
        }
        out.files = { matched: ruleHits.length, ruleHits };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "create_branch",
  "Create a new branch on the active token source's remote. Defaults to " +
    "branching from the current active branch. Optionally switch the " +
    "plugin's saved override to the new branch so subsequent edits + " +
    "applies target it. Currently supports GitHub only; other providers " +
    "will return a 'not implemented' error.",
  {
    name: z.string(),
    from: z.string().optional(),
    switchTo: z.boolean().optional(),
  },
  async (args) => {
    try {
      const config = await resolveStorageConfig(undefined);
      const secret = await resolveSecret(config.provider);
      const writer = getWritable(config, secret);
      const fromBranch = args.from ?? (config as { branch?: string }).branch ?? "main";
      const fromSha = await writer.getRefSha(fromBranch);
      await writer.createBranch(args.name, fromSha);

      let switched = false;
      if (args.switchTo) {
        const newOverride: Record<string, unknown> = {
          ...(config as unknown as Record<string, unknown>),
          branch: args.name,
        };
        delete newOverride.internalId;
        delete newOverride.name;
        try {
          await getBridge().request("setStorageOverride", { override: newOverride });
          discardWorkingCopy();
          switched = true;
        } catch {
          switched = false;
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              created: args.name,
              from: { branch: fromBranch, sha: fromSha },
              switched,
              switchToHint: args.switchTo && !switched
                ? "Branch created on the remote, but the plugin override switch failed (bridge / plugin out of sync?). Switch via the plugin's branch dropdown."
                : undefined,
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "set_token",
  "Stage a token write. Adds (or replaces) a token at `path` in the " +
    "named `set` of the active catalog's working copy. Edit accumulates " +
    "until you call `commit_and_push`. Use `type` to give Tokens Studio " +
    "the correct token type (color / spacing / borderRadius / ...); " +
    "we'll infer from value shape if omitted.",
  {
    path: z.string(),
    value: z.union([z.string(), z.number(), z.record(z.unknown()), z.array(z.unknown())]),
    type: z.string().optional(),
    set: z.string(),
  },
  async (args) => {
    try {
      validateTokenPath(args.path);
      const config = await resolveStorageConfig(undefined);
      await ensureWorkingCatalog(config);
      addEdit({ kind: "set", path: args.path, value: args.value, type: args.type, set: args.set });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(snapshotWorkingCopy(), null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "delete_token",
  "Stage a token deletion. Removes the token at `path` from the named " +
    "`set` in the working copy. Accumulates until `commit_and_push`.",
  {
    path: z.string(),
    set: z.string(),
  },
  async (args) => {
    try {
      const config = await resolveStorageConfig(undefined);
      await ensureWorkingCatalog(config);
      addEdit({ kind: "delete", path: args.path, set: args.set });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(snapshotWorkingCopy(), null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "rename_token",
  "Stage a token rename. Moves a token from one path to another. By " +
    "default also rewrites every other token's `value` reference from " +
    "`{from}` to `{to}` so dependent tokens keep resolving — pass " +
    "`updateReferences: false` to disable.",
  {
    from: z.string(),
    to: z.string(),
    set: z.string().optional(),
    updateReferences: z.boolean().optional(),
  },
  async (args) => {
    try {
      const config = await resolveStorageConfig(undefined);
      await ensureWorkingCatalog(config);
      addEdit({
        kind: "rename",
        from: args.from,
        to: args.to,
        set: args.set,
        updateRefs: args.updateReferences ?? true,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(snapshotWorkingCopy(), null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "list_pending_edits",
  "Show what's staged in the working copy: branch, base commit SHA, " +
    "source description, and the full edit log. Returns null when no " +
    "edits have been staged yet.",
  {},
  async () => {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(snapshotWorkingCopy(), null, 2) },
      ],
    };
  }
);

server.tool(
  "discard_pending_edits",
  "Throw away every staged edit and reset the working copy to the last " +
    "fetched base catalog. Useful when you want to start over.",
  {},
  async () => {
    discardWorkingCopy();
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, discarded: true }, null, 2) }],
    };
  }
);

server.tool(
  "commit_and_push",
  "Flush every staged edit as a single commit on the configured branch " +
    "(or a new one via `branch` / `asNewBranch`). Conflict-checked: " +
    "refuses if the remote head moved since the working copy was loaded — " +
    "pull (Refresh in plugin) and re-stage edits, then retry. " +
    "Currently supports GitHub only.",
  {
    message: z.string(),
    branch: z.string().optional(),
    asNewBranch: z.boolean().optional(),
  },
  async (args) => {
    try {
      const snap = snapshotWorkingCopy();
      if (!snap || snap.editCount === 0) {
        throw new Error("No staged edits — call set_token / delete_token / rename_token first.");
      }
      const config = await resolveStorageConfig(undefined);
      const secret = await resolveSecret(config.provider);
      const writer = getWritable(config, secret);

      const parentSha = snap.baseSha;
      if (!parentSha) {
        throw new Error(
          `Can't commit: the working copy has no base revision to commit against. ` +
            `Write-back only works when the catalog was loaded from a writable provider (currently: github). ` +
            `Re-fetch the catalog from a supported source (e.g. get_token_catalog after configuring a GitHub sync), then try commit_and_push again.`
        );
      }

      let targetBranch = args.branch ?? snap.branch;
      if (args.asNewBranch && args.branch) {
        await writer.createBranch(args.branch, parentSha);
        targetBranch = args.branch;
      }

      const filePathPrefix = (config as { filePath?: string }).filePath ?? "";
      const plan = buildFlushPlan(filePathPrefix);

      const commitResult = await writer.commit({
        branch: targetBranch,
        message: args.message,
        files: plan.files,
        deletes: plan.deletes,
        parentSha,
      });

      markCommitted(commitResult.sha);
      invalidateCatalogCache(config);
      clearFingerprintCache();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              branch: targetBranch,
              commit: commitResult.sha,
              touchedSets: plan.touchedSets,
              filesWritten: plan.files.length,
              filesDeleted: plan.deletes.length,
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --------------------------------------------------------------------------
// Suggest & variant tools
// --------------------------------------------------------------------------

server.tool(
  "suggest_tokens",
  "Suggest tokens from the loaded catalog that fit a Figma node, ranked. " +
    "Reads the node + nearby context (name, type, parent variant axes, " +
    "tokens already applied to siblings) and scores every catalog token " +
    "of compatible type. Returns the top N with reasoning per candidate. " +
    "Use this when the design system's naming convention isn't obvious or " +
    "when the user just says 'tokenize this' without spelling out paths.",
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
    propertyKey: z.string().optional(),
    max: z.number().int().positive().optional(),
  },
  async (args) => {
    try {
      const target = parseFigmaTargetOrPinned(args);
      if (!target.nodeId) {
        throw new Error(
          "suggest_tokens needs a nodeId — pass nodeId or a URL containing ?node-id=…"
        );
      }
      const client = getClient();
      const root = await loadNode(client, target, 5);
      const targetNode = findNodeById(root, target.nodeId) ?? root;

      const variantAxes = parseVariantAxesFromName(
        findEnclosingVariantName(root, target.nodeId) ?? ""
      );
      const siblingTokens = collectNearbyTokens(root, target.nodeId);

      const config = await resolveStorageConfig(undefined);
      const catalog = await fetchCatalog(config);
      const summaries = flattenCatalogToSummaries(catalog.values, null);

      const suggestions = suggestTokens(summaries, {
        node: targetNode,
        variantAxes,
        siblingTokens,
        propertyKey: args.propertyKey,
      }, args.max ?? 10);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              node: { id: targetNode.id, name: targetNode.name, type: targetNode.type },
              variantAxes,
              propertyKey: args.propertyKey,
              suggestions,
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "apply_to_variants",
  "Bulk-apply tokens to every variant of a Figma component_set in a single " +
    "call, using a token-path TEMPLATE with `{axis}` placeholders. Solves " +
    "the 'tab bar / button / chip / icon-set' shape: 24+ variants, each with " +
    "a per-variant token derived from the component's variant axes (variant, " +
    "active, state, density, …). Works for ANY naming convention — you " +
    "supply the template that matches your design system's path shape. " +
    "Targets descendants by `layerName` (and optional `layerType`), so the " +
    "token lands on the actual shape layer / instance / wrapper, not the " +
    "variant frame. Optional `clearProperties` removes other token property " +
    "keys on the same nodes (useful for fixing earlier wrong writes). " +
    "`dryRun: true` returns the full plan without writing.",
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
    property: z.string(),
    template: z.string(),
    layerName: z.string(),
    layerType: z.string().optional(),
    clearProperties: z.array(z.string()).optional(),
    dryRun: z.boolean().optional(),
  },
  async (args) => {
    try {
      const target = parseFigmaTargetOrPinned(args);
      const client = getClient();
      const node = await loadNode(client, target, 10);
      const result = await applyToVariants(node, {
        property: args.property,
        template: args.template,
        layerName: args.layerName,
        layerType: args.layerType,
        clearProperties: args.clearProperties ?? [],
        dryRun: args.dryRun ?? false,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --------------------------------------------------------------------------
// Bridge status & target tools
// --------------------------------------------------------------------------

server.tool(
  "bridge_status",
  "Diagnostic: is the local WebSocket bridge running and is the companion " +
    "Figma plugin connected? Returns the connected file's key/name when " +
    "known. If the plugin is not connected, make sure the 'Tokens Studio " +
    "MCP Bridge' plugin is open in Figma.",
  {},
  async () => {
    try {
      const bridge = getBridge();
      await bridge.start();
      const status = bridge.status();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...status,
              hint: !status.connected
                ? "Plugin not connected. Open the 'Tokens Studio MCP Bridge' plugin in Figma to establish the connection."
                : undefined,
            }, null, 2),
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "get_current_target",
  "Returns the designer's currently pinned target (if any) and live selection " +
    "from the connected Figma plugin. Use when the user says 'this', 'here', " +
    "'the current selection', or doesn't specify a URL. Prefer `pinned` if present.",
  {},
  async () => {
    try {
      const bridge = getBridge();
      await bridge.start();
      const pinned = bridge.pinnedTarget;
      let live = null;
      if (bridge.isConnected()) {
        try {
          const r = (await bridge.request("getLiveTarget", {}, { timeoutMs: 5000 })) as {
            target: { fileKey: string; nodeId: string | null; name: string | null; url: string } | null;
          };
          live = r.target;
        } catch (err) {
          // Older plugin builds don't expose getLiveTarget; treat as null.
          debugLog("getLiveTarget", err);
        }
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ pinned, live }, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "inspect_bound_variables",
  "Diagnostic: dump the per-node state that can override raw writes — " +
    "`boundVariables` (bound Figma Variables take visual precedence over " +
    "any raw fill/stroke/effect/numeric value), `fillStyleId`/`strokeStyleId`/" +
    "`effectStyleId`/`textStyleId` (attached Figma Styles), and `insideInstance` " +
    "(non-overridable instance sublayers silently reject writes). Use this to " +
    "figure out WHY a specific layer visually doesn't re-theme even though " +
    "`apply_theme` reports the write as applied.",
  {
    nodeIds: z.array(z.string()).optional()
      .describe("Explicit node ids to inspect. If omitted, uses current selection."),
    scope: z.enum(["selection", "self-and-descendants"]).optional()
      .describe("'selection' inspects each listed node only. 'self-and-descendants' walks each node's full subtree."),
  },
  async ({ nodeIds, scope }) => {
    try {
      const bridge = getBridge();
      await bridge.start();
      if (!bridge.isConnected()) {
        return toolError(new Error("Plugin not connected. Open the 'Tokens Studio MCP Bridge' plugin."));
      }
      const result = await bridge.request(
        "inspectBoundVariables",
        { nodeIds, scope: scope ?? "selection" },
        { timeoutMs: 60_000 }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "debug_resolve_token",
  "Diagnostic: resolve a specific token path under a given theme and return " +
    "the full resolved value tree. Useful for debugging why a composition " +
    "token doesn't produce the expected writes — if a sub-property is " +
    "missing from the resolved entries, that reference couldn't be found " +
    "in the theme's enabled sets.",
  {
    tokenPath: z.string().describe("e.g. 'styles.navigationButton.label.variant:secondary.size:lg.active:false.initial'"),
    themeName: z.string().describe("theme name, e.g. 'siemens-dark'"),
  },
  async ({ tokenPath, themeName }) => {
    try {
      const { fetchCatalog } = await import("./storage/index.js");
      const { makeResolver } = await import("./remap/resolver.js");
      const { resolveStorageConfig } = await import("./resolve-storage.js");
      const config = await resolveStorageConfig(undefined);
      const catalog = await fetchCatalog(config);
      const themes = (catalog.themes as Array<{
        name: string;
        selectedTokenSets?: Record<string, string>;
      }>) ?? [];
      const theme = themes.find((t) => t.name.toLowerCase() === themeName.toLowerCase());
      if (!theme) {
        return toolError(new Error(`Theme '${themeName}' not found`));
      }
      const selectedTokenSets = theme.selectedTokenSets ?? {};
      const enabledSets = Object.entries(selectedTokenSets)
        .filter(([, v]) => v === "enabled" || v === "source")
        .map(([k]) => k);
      const metadata = catalog.metadata as { tokenSetOrder?: string[] } | undefined;
      const canonicalOrder = Array.isArray(metadata?.tokenSetOrder) ? metadata!.tokenSetOrder : null;
      if (canonicalOrder) {
        const orderIndex = new Map(canonicalOrder.map((name, i) => [name, i]));
        enabledSets.sort((a, b) => {
          const ai = orderIndex.has(a) ? orderIndex.get(a)! : Number.MAX_SAFE_INTEGER;
          const bi = orderIndex.has(b) ? orderIndex.get(b)! : Number.MAX_SAFE_INTEGER;
          return ai - bi;
        });
      }
      const values = (catalog.values && typeof catalog.values === "object")
        ? (catalog.values as Record<string, unknown>) : {};
      const { resolve, index } = makeResolver(values, enabledSets, selectedTokenSets);
      const resolved = resolve(tokenPath);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            tokenPath,
            themeName,
            enabledSetsCount: enabledSets.length,
            pathInIndex: index.has(tokenPath),
            leaf: index.get(tokenPath) ?? null,
            resolved,
          }, null, 2),
        }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --------------------------------------------------------------------------
// Bridge handler registrations
// --------------------------------------------------------------------------

registerBridgeHandlers();

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export async function runStdioServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
