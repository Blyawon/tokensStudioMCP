# Changelog

All notable changes to `tokens-studio-mcp` / `ft`.

## 0.2.0

A ground-up pass on CLI ergonomics, output size, and composition
token handling. The MCP tool surface stays backward compatible —
existing Claude Code configs keep working.

### Added

- **`ft tokens <url>`** — grouped token dictionary with layer usage
  and a style-gap report. The recommended first call for any "what
  tokens does this frame use?" question.
- **`list_tokens` MCP tool** — same behaviour exposed to Claude Code
  as a cheap pre-flight before `get_metadata_with_tokens`.
- **Compact ASCII tree** is the new default `ft <url>` output.
  Box-drawing prefixes, adjacent-sibling deduplication with `(×N)`
  markers, no coordinates, instance-path ids collapsed. Typically
  5–10× smaller than the v0.1 XML output.
- **`ft coverage`** — progress-bar summary of how much of a subtree
  is tokenized (`[█████████░░] 1735 / 2903  (60%)`).
- **`ft node`** — single-node tokens snippet for when you already
  know the node id.
- **`ft config`** — prints the effective config and which file each
  value came from.
- **Config file support** — `~/.ftrc.json` (global) and
  `./ft.config.json` (per-project). Keys: `ignoreVectorsWithoutFill`,
  `ignoreComponents`, `warnStyleGaps`, `onlyWithTokens`,
  `includeComposition`. CLI flags override file config.
- **Style-gap detection** — nodes with visual styling (fills,
  strokes, effects, shared styles) but no covering Tokens Studio
  token get flagged with an `untokenized="fill,stroke,…"` attribute
  in XML output and counted in the `ft tokens` gap report.
- **CLI flags**: `--xml`, `--layout`, `--no-dedupe`, `--depth N`,
  `--node 1:2`, `--only-with-tokens` / `--all-layers`, `--gaps`,
  `--with-components`, `--with-vectors`, `--with-composition`,
  `--no-warn`, `--all`.
- **TTY-gated CLI polish** — ANSI Shadow "FT" splash with a
  bright-cyan → magenta gradient and row-by-row reveal, Braille
  spinner during Figma fetches, colour-coded help/setup output.
  Every effect degrades to plain text on non-TTYs so piped output,
  CI logs, and MCP stdio stay clean.
- **`maybeWarnAboutShellSplit`** — detects the "zsh ate my URL"
  pattern (Figma URL with query params but no `node-id`) and prints
  a soft hint telling the user to single-quote or use clipboard
  mode. No silent truncation.
- **zsh `noglob` alias wrapper** in `npm run alias` so bare `?` in
  Figma URLs no longer triggers filename globbing.

### Changed

- **Composition token handling** — fixed a bug where composition
  tokens were stripped across the board, causing composition-only
  nodes to be counted as untokenized:
  - Coverage counts composition tokens as tokens.
  - Style-gap detection trusts composition tokens to cover all
    visual properties (no false positives on composition-only
    nodes).
  - `onlyWithTokens` keeps branches that contain composition
    tokens.
  - The compact tree shows `composition=…` as a placeholder by
    default; `--with-composition` prints the full value.
- **Legacy XML output** (`--xml` / `get_metadata_with_tokens`)
  strips noise: plugin-internal `hash=…` / `version=…` attributes
  removed, instance-path ids (`I94:774;93:4034;…;214:7220`)
  collapsed to their last segment for display, `x/y/w/h` off by
  default (opt in with `--layout`). Same tool name, same top-level
  XML shape — only noise is gone.
- **`ft setup`** — rewritten with plain-English prompts and clear
  token-scope guidance.
- **Help text** — rewritten in a normal tone of voice, grouped by
  intent (commands / what to show / how to show it / config /
  quoting / example), fits one terminal screen.
- **Clipboard mode is the headline** — `ft` with no arguments reads
  from `pbpaste`; the help text and README lead with it because
  it's the only flow that dodges every shell-quoting footgun.

### Fixed

- Composition-only nodes no longer report as "untokenized" in
  coverage or `onlyWithTokens` pruning.
- `padEnd` column alignment in the help output no longer counts
  ANSI escape bytes (colour is applied after padding).
- Dedup content hash now mixes every descendant's token signature,
  so two instances that differ only by a leaf-level token override
  are kept separate.

### Compatibility notes

- `get_metadata_with_tokens` and `get_node_tokens` keep their tool
  names, schemas, and top-level XML shape. The XML body is
  smaller because of the noise removals above. Claude Code setups
  don't need to change.
- The v0.1 `figtokens` / `ft` aliases still work. Re-running
  `npm run alias` bumps them to the v2 block (with `noglob` on
  zsh).

---

## 0.1.0

Initial release.

- Figma REST client with `plugin_data=shared`.
- `renderMetadataXml` — Figma-MCP-style XML tree decorated with
  Tokens Studio applied tokens on every node.
- MCP stdio server exposing `get_metadata_with_tokens` and
  `get_node_tokens`.
- `figtokens` / `ft` CLI aliases and one-command setup via
  `npm run setup`.
- Verified end-to-end against a real GENESIS design file
  (`resultpage_lg` component, 1735 / 2903 nodes tokenized).
