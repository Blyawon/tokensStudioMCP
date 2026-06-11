# tokens-studio-mcp

Design token bridge between Figma (via Tokens Studio) and AI code generation. Dual-mode: CLI tool (`ft`) for terminal use + MCP stdio server for Claude Code.

## Quick Reference

```bash
npm run build          # TypeScript → dist/
npm run build:plugin   # Figma plugin → figma-plugin/dist/
npm test               # Node test runner (188 tests)
npm run dev            # tsx hot-reload (CLI)
```

## Architecture

```
┌────────────┐    REST     ┌────────────┐
│  Figma API │◄───────────►│  ft CLI    │
└────────────┘             │  MCP Server│
                           └─────┬──────┘
                          WS:3055│
                           ┌─────┴──────┐
                           │   Bridge    │ (localhost WebSocket)
                           └─────┬──────┘
                           ┌─────┴──────┐
                           │ Plugin UI  │ (iframe, vanilla JS)
                           │ Plugin Code│ (Figma sandbox)
                           └────────────┘
```

**Data flow for theme apply:**
1. Claude calls `apply_theme` MCP tool
2. MCP server resolves tokens from catalog (GitHub/GitLab/etc.)
3. Server sends `applyVisualWrites` to plugin via bridge
4. Plugin writes fills/spacing/typography/shadows to Figma nodes

## Source Structure

### MCP Server (`src/`)

| File | Purpose |
|------|---------|
| `index.ts` | Entry point: .env loading, CLI router, clipboard |
| `cli-commands.ts` | All CLI subcommands (tree, tokens, coverage, node, config, setup, help) |
| `mcp-server.ts` | MCP server + all 38 tool registrations + bridge handlers |
| `design-context.ts` | Markdown design-context renderer (layout + visual + typography + tokens per node) |
| `apply-theme.ts` | Theme orchestration: catalog → resolve → write dispatch |
| `apply-remap.ts` | Token remap + variant bulk-apply |
| `figma-helpers.ts` | Shared: Figma client, node loading, target resolution |
| `resolve-storage.ts` | Storage config resolution (plugin → override → auto-discover) |
| `figma-client.ts` | Minimal Figma REST client (30s timeout) |
| `parse-url.ts` | Figma URL parser (fileKey, nodeId extraction) |
| `tokens.ts` | Token extraction from sharedPluginData, gap detection |
| `render-tree.ts` | ASCII tree + token dictionary renderer |
| `xml.ts` | Figma MCP-style XML output |
| `json-output.ts` | JSON output builders |
| `config.ts` | Config loader (~/.ftrc.json, ft.config.json) |
| `cli-ui.ts` | Terminal UI: spinner, splash, progress bar, colors |

### Token Engine (`src/remap/`)

| File | Purpose |
|------|---------|
| `resolver.ts` | Token value resolution (references, math, composition, typography, shadow) |
| `matcher.ts` | Remap scoring: old token → new candidates |
| `ingest.ts` | Tolerant JSON parser for user-pasted token sets |
| `collect.ts` | Collect token usage from Figma nodes |
| `suggest.ts` | Context-aware token suggestions for a node |
| `rename.ts` | Pattern-based token path renaming |
| `types.ts` | Shared remap types |

### Storage Providers (`src/storage/`)

| File | Purpose |
|------|---------|
| `index.ts` | Provider dispatcher + catalog cache (60s TTL) |
| `github.ts` | GitHub read (Git Data API) |
| `github-write.ts` | GitHub write (blob → tree → commit → ref) |
| `gitlab.ts` | GitLab read |
| `bitbucket.ts` | Bitbucket read |
| `ado.ts` | Azure DevOps read |
| `tokens-studio.ts` | Tokens Studio SaaS API |
| `supernova.ts` | Supernova design system |
| `jsonbin.ts` | JSONBin.io |
| `url.ts` | Plain HTTP GET |
| `local.ts` | Plugin's local cache (via bridge) |
| `working-copy.ts` | Staging area for token edits (set/delete/rename) |
| `writable.ts` | Abstract write provider interface |
| `branches.ts` | Branch listing |
| `secrets.ts` | Credential resolution (env → plugin → bridge) |
| `cache.ts` | In-memory catalog cache with dedup |
| `types.ts` | Storage type definitions |

### Figma Plugin (`figma-plugin/`)

| File | Purpose |
|------|---------|
| `ui.html` | Self-contained UI (CSS + JS inlined, Figma requirement) |
| `manifest.json` | Plugin metadata (network access: localhost:3055) |
| `build.mjs` | esbuild: bundles sandbox modules, copies UI |
| **`src/sandbox/`** | **Modular sandbox code (bundled → dist/code.js)** |
| `src/sandbox/index.ts` | Entry: UI init, message router, event listeners |
| `src/sandbox/types.ts` | Constants, interfaces, frame type guards |
| `src/sandbox/discovery.ts` | Node enumeration (findAllWithCriteria + walk fallback) |
| `src/sandbox/storage.ts` | Storage config, secrets, prefs, remap application |
| `src/sandbox/visual-writes.ts` | Batched visual writes, undo log, typography, shadow |
| `src/sandbox/color.ts` | Color parsing (#hex, rgb, hsl), paint cache, numeric helpers |
| `src/sandbox/eval.ts` | Sandboxed JS execution (`figma_eval`) with timeout + result sanitization |
| `src/sandbox/node-ops.ts` | Structured canvas ops: create/edit nodes, actions, live tree, find, export, variables |

### Bridge Protocol (`src/bridge/`)

| File | Purpose |
|------|---------|
| `protocol.ts` | Zod-validated wire schemas (request/response/progress frames) |
| `server.ts` | WebSocket server (singleton, localhost:3055, one plugin connection) |

## Canvas Authoring (figma-cli parity)

The bridge exposes two generic plugin methods — `evalCode` (arbitrary JS in
the sandbox) and `nodeOp` (structured op dispatcher) — surfaced as MCP tools:
`figma_eval`, `create_node` (recursive `children` builds whole trees),
`set_node_properties`, `node_action`, `get_canvas_tree`, `find_nodes`,
`export_node_image`, `figma_variables` (incl. exportCss/exportTailwind),
`create_icon` (Iconify), `create_image_from_url`, `canvas_audit` (WCAG
contrast/touch/text), `analyze_design` (color/typography/spacing usage),
`dev_resources`. FigJam files get `sticky` / `connector` / `shape` node
types. These operate on whatever file the plugin is open in (any tab,
drafts included) — no REST key or fileKey needed. Adding a new structured
op = one `case` in `node-ops.ts:opNodeOp`; no protocol change.

## Agent-facing Output

- `get_design_context` returns a compact markdown tree with full layout
  metadata (auto-layout, constraints, fills/effects as hex, typography,
  component props) + applied tokens — designed so agents can build
  components from Figma without a second Figma MCP.
- `get_metadata_with_tokens` accepts `format: "tree"` for a ~50% smaller
  markdown tree instead of XML.
- Big JSON payloads (catalog, working copy) are compact-printed; token
  edit tools return a summary, not the full edit log.

## Key Design Decisions

- **Set precedence**: SOURCE sets processed first, then ENABLED (ENABLED always wins). See `resolver.ts:flattenSets`.
- **Fingerprint cache**: 5-min TTL keyed on `themeName + catalogSource + nodeIds + tokenPaths`. Prevents redundant applies.
- **Concurrency lock**: `applyThemeLock` in `mcp-server.ts` serializes rapid theme switches to prevent write interleaving.
- **enabledSets fallback**: If a theme has no "enabled"/"source" sets, falls back to ALL sets (matches Tokens Studio behavior).
- **Plugin undo**: Each apply-theme batch wraps in a single `figma.commitUndo()` — Cmd-Z reverts the whole thing.
- **No framework in plugin UI**: Vanilla JS. Figma requires self-contained HTML; frameworks add bundle size for little benefit at this scale.

## Environment Variables

```bash
FIGMA_API_KEY=figd_...                    # Required: Figma PAT (read scope)
TOKENS_STUDIO_GITHUB_TOKEN=ghp_...        # GitHub (read+write)
TOKENS_STUDIO_GITLAB_TOKEN=glpat-...      # GitLab
TOKENS_STUDIO_BITBUCKET_TOKEN=...         # Bitbucket
TOKENS_STUDIO_ADO_TOKEN=...               # Azure DevOps
TOKENS_STUDIO_API_KEY=...                 # Tokens Studio SaaS
TOKENS_STUDIO_SUPERNOVA_KEY=...           # Supernova
TOKENS_STUDIO_JSONBIN_KEY=...             # JSONBin
TOKENS_STUDIO_URL_TOKEN=...              # URL provider bearer token
```

## Testing

Tests use Node's native test runner. Run with:
```bash
npm test
# or individually:
npx tsx --test src/tokens.test.ts
npx tsx --test src/render-tree.test.ts
npx tsx --test src/config.test.ts
npx tsx --test src/json-output.test.ts
```

## Common Tasks

**Add a new MCP tool:** Edit `src/mcp-server.ts`, add `server.tool(...)` registration.

**Add a new storage provider:** Create `src/storage/<provider>.ts`, register in `src/storage/index.ts` dispatcher.

**Modify theme application:** Edit `src/apply-theme.ts` (server-side orchestration) or `figma-plugin/src/sandbox/visual-writes.ts` (plugin-side writes).

**Edit plugin UI:** Edit `figma-plugin/ui.html` directly. CSS is in `<style>`, JS in `<script>`. Run `npm run build:plugin` to copy to dist.

**Edit plugin sandbox:** Edit files in `figma-plugin/src/sandbox/`. Run `npm run build:plugin` — esbuild bundles all modules into one `dist/code.js`.
