# ft — Tokens Studio applied tokens, one command

`ft` reads the design tokens applied by the
[Tokens Studio for Figma](https://www.figma.com/community/plugin/843461159747178978/tokens-studio-for-figma)
plugin and prints them next to the layers that use them. Paste a Figma
URL into your terminal and you get back an annotated layer tree, a
grouped token dictionary, or a style-gap report — whichever one you
asked for.

```bash
# Copy a Figma frame URL in your browser, then:
ft
```

That's it. No quoting, no setup beyond a one-time Figma token, no
Figma desktop app. `ft` also runs as an **MCP stdio server** so Claude
Code can read applied tokens without leaving the chat.

---

## Why this exists

Figma's official Dev Mode MCP server exposes layer metadata (ids,
names, types, coordinates) but **not** the Tokens Studio data —
because that data lives in `sharedPluginData` on every node, under
the `tokens` namespace, and is invisible to most REST consumers.

The result: an LLM code agent can see the layers but not which
tokens drive which properties, so generated code falls back to
hard-coded colours and spacings.

`ft` closes that gap. One REST call with `plugin_data=shared`, one
walk of the returned tree, and every node comes back labelled with
its Tokens Studio tokens — ready for the next `ft tokens` or for
Claude Code to consume over MCP.

---

## Install

```bash
git clone https://github.com/Blyawon/tokensStudioMCP.git
cd tokensStudioMCP
npm run setup
source ~/.zshrc   # or restart your terminal
```

`npm run setup` runs the whole chain:

1. `npm install`
2. `npm run build` — compiles TypeScript to `dist/`.
3. `npm run alias` — installs `ft` and `figtokens` aliases in
   `~/.zshrc` (or `~/.bashrc`). On zsh they're wrapped in `noglob`
   so `?` in URLs doesn't trigger globbing.
4. `node dist/index.js setup` — prompts for your Figma personal
   access token and saves it to `.env` (`chmod 600`).

**Get a token** at <https://www.figma.com/developers/api#access-tokens>
with scope **File content: Read-only**. The setup step links you
there and walks you through it.

Requires **Node.js ≥ 18** (native `fetch`).

---

## Quick start

The fastest path is clipboard mode — no quoting, no shell gotchas:

```bash
# 1. Copy any Figma frame URL in your browser.
# 2. Run:
ft
```

With no arguments, `ft` reads the URL from your clipboard
(macOS `pbpaste`). You can also pass a URL directly:

```bash
ft 'https://www.figma.com/design/abc/File?node-id=1-2'
```

### Sample output

```
resultpage_lg  COMPONENT 2007:102481  coverage=1735/2903
└─ .appShell  INSTANCE 94:774  fill=page.background.100
   ├─ .navigation  INSTANCE 93:3974
   │  └─ .collapseButton  INSTANCE 20:814  sizing=dimension.2xl
   │     └─ buttonAction  INSTANCE 19:792  composition=…
   └─ .sectionList  INSTANCE 101:222718
      └─ items  SLOT 101:214831  itemSpacing=section.spacing.prominent.md
         ├─ (×4) container  INSTANCE 102:269769  composition=…
         └─ footer  INSTANCE 102:269770  fill=colors.surface.default
```

- One line per node: `<name>  <TYPE> <id>  <tokens…>`.
- Adjacent siblings with identical structure + tokens collapse into
  `(×N)`.
- Untokenized nodes show no trailing token cluster — absence is the
  default.
- The root carries `coverage=<with>/<total>` so you see how tokenized
  the selection is at a glance.
- `composition=…` marks nodes that use a composition token; see
  [Composition tokens](#composition-tokens) below.

---

## Commands

```bash
ft                     # clipboard URL → compact tree (same as `ft <url>`)
ft <url>               # compact tree of a frame with applied tokens
ft tree <url>          # same as `ft <url>` (explicit)
ft tokens <url>        # grouped token dictionary + style-gap report
ft coverage <url>      # % of nodes that have tokens, with a progress bar
ft node <url>          # tokens applied to one node
ft config              # show the effective config and where it came from
ft setup               # save or replace your Figma access token
ft help                # cheat sheet with every flag
ft mcp                 # run as an MCP stdio server (Claude Code uses this)
```

### `ft tokens` — the cheap pre-flight

Ask "which tokens does this frame actually use?" before fetching
the full tree. Output is grouped by property key (`fill`, `spacing`,
`typography`, `composition`, …), values sorted alphabetically, each
value annotated with the layer names that use it.

```
47 unique tokens across 8 properties

fill (3)
  colors.border.subtle   used by: .divider ×4, .card ×2
  colors.text.primary    used by: .title, .body ×6
  page.background.100    used by: .appShell

spacing (5)
  section.spacing.prominent.md
  spacing.lg
  spacing.sm
  …

composition (27)
  ecommerce.container.base.size:lg
  styles.buttonAction.base.variant:control.size:sm.hover
  …

▸ 12 nodes have visual styling with no covering token
```

The trailing style-gap line is a count of nodes that have visual
styling (fills, strokes, effects, shared styles) but no Tokens
Studio token covering that property. `--no-warn` silences it.

### `ft coverage` — fast sanity check

```
[█████████████░░░░░░░] 1735 / 2903  (60%)
```

Use it to sanity-check whether a file is tokenized at all before
you start processing anything. Prints a plain text line instead of
the bar when stdout isn't a TTY.

### `ft node` — one-node snippet

```bash
ft node 'https://www.figma.com/design/abc/File?node-id=1-2'
```

Returns a single-node XML snippet with just the `<tokens …/>` child.
Useful when you already know the node id and want the smallest
possible answer.

---

## Flags

Every CLI command accepts the same flag set. Grouped by intent:

### What to show

| Flag | What |
|---|---|
| `-o, --only-with-tokens` | Hide branches that contain no tokens anywhere |
| `--all-layers` | Show every layer, even untokenized ones (overrides config) |
| `-g, --gaps` | Hide branches that contain no style gaps |
| `--with-components` | Include `COMPONENT` / `COMPONENT_SET` nodes (hidden by default) |
| `--with-vectors` | Include vector nodes that have no fill (hidden by default) |
| `--with-composition` | Show composition tokens inline instead of the `…` placeholder |
| `--no-warn` | Don't flag untokenized visual styling |
| `--all` | Turn off every filter for this run |

### How to show it

| Flag | What |
|---|---|
| `-d, --depth N` | Cap subtree depth |
| `-n, --node 1:2` | Supply a node id when the URL doesn't have one |
| `--layout` | Append `[x,y w×h]` to each line |
| `--xml` | Emit legacy Figma-MCP-style XML instead of the compact tree |
| `--no-dedupe` | Don't collapse repeated sibling groups |

Example:

```bash
ft 'https://www.figma.com/design/abc/File?node-id=1-2' --depth 3 -o
```

---

## Composition tokens

Tokens Studio lets you apply a single **composition token** to a
node that bundles multiple property styles at once (e.g.
`button.primary.hover` → fill + border + padding + typography).
That's great for design maintenance but terrible for automatic
codegen — a composition token's value is an opaque string.

`ft` handles composition tokens this way:

- **Coverage counts them.** A node with only a composition token is
  counted as tokenized. It does **not** show up as a gap.
- **Display strips them by default.** The compact tree shows
  `composition=…` as a placeholder so you know one is present
  without drowning the output in long composition paths. Pass
  `--with-composition` (or `includeComposition: true` in config,
  or the MCP tool parameter) to see the full value.
- **Gap detection trusts them.** Because a composition token can
  cover fill/stroke/spacing/typography all at once, nodes with a
  composition token applied never report style gaps. This is the
  right default for the common Tokens Studio workflow.

`ft tokens` surfaces a one-line note when composition tokens are
present, so you're never guessing why a visually-styled frame looks
"empty".

---

## Config file

Put persistent defaults in `~/.ftrc.json` (global) or
`./ft.config.json` (per-project). Any key is optional.

```json
{
  "ignoreVectorsWithoutFill": true,
  "ignoreComponents": true,
  "warnStyleGaps": true,
  "onlyWithTokens": false,
  "includeComposition": false
}
```

Project config wins over global config; CLI flags win over both.
`ft config` prints the effective config and shows which file each
value came from.

`--all` bypasses the config entirely for one run — handy when you
want to see everything, once, without editing a file.

---

## Shell quoting (zsh + bash)

Figma URLs contain `?` and `&`, both of which are shell
metacharacters:

- **zsh**: `?` triggers filename globbing, `&` triggers job control.
- **bash**: same story for `&`; `?` is usually safe unless `failglob`
  is set.

`npm run setup` installs the `ft` alias wrapped in `noglob` on zsh,
so **bare `?` is safe** even without quotes. `&` still splits the
command line (job control is not part of filename expansion and
can't be disabled by `noglob`), so URLs containing `&` still need
single quotes.

```bash
# zsh:
ft https://www.figma.com/design/abc/File?node-id=1-2          # ok (noglob)
ft 'https://www.figma.com/design/abc/File?node-id=1-2&t=xyz'  # ok (single-quoted)

# bash:
ft 'https://www.figma.com/design/abc/File?node-id=1-2'        # always single-quote
```

**The easy way to sidestep all of this:** copy the URL in your
browser and just run `ft`.

`ft` detects the classic "zsh ate my URL" pattern (a Figma URL with
query params but no `node-id`) and prints a soft warning to stderr
telling you to either single-quote the URL or use clipboard mode —
no silent failures.

---

## Use it from Claude Code

```bash
claude mcp add tokens-studio node "$PWD/dist/index.js"
```

(No subcommand — `node dist/index.js` with no args and a non-TTY
stdin runs the MCP server.)

Three tools are exposed:

| Tool | What it does |
|---|---|
| **`list_tokens`** | **START HERE.** Unique tokens grouped by property, with layer usage and a style-gap report. Cheap pre-flight — call this first to decide whether you actually need the full tree. |
| **`get_metadata_with_tokens`** | Figma-MCP-style XML tree decorated with applied tokens on every node. Instance-path ids collapsed, `hash`/`version` noise stripped, `x/y/w/h` off by default (pass `layout: true` if you need them). |
| **`get_node_tokens`** | Tokens for a single node as a tiny XML snippet. |

All three accept any combination of `url`, `fileKey`, and `nodeId`,
so you can point them at a whole file or a specific frame. All three
respect your config file and the `includeComposition` parameter.

In any chat, ask:

> Use tokens-studio to list the tokens applied in
> `<paste figma url>`, then show me the frame tree only for the
> components that use `colors.brand.primary`.

Claude Code will call `list_tokens` first, see what's there, then
call `get_metadata_with_tokens` with the right filters.

---

## How it works

- Figma's REST API supports `?plugin_data=shared`, which returns
  every node's `sharedPluginData`.
- Tokens Studio stores applied tokens under the `tokens` namespace
  on each node, keyed by the property they target (`fill`,
  `borderRadius`, `spacing`, `typography`, `composition`, …).
- `ft` walks the returned tree and renders it either as a compact
  ASCII tree (default) or a Figma-MCP-style XML tree (`--xml`).
- Dedupe is content-hash based: the hash mixes every descendant's
  `type + name + tokens signature + recursive child hash`. Two
  instances that differ only by a leaf-level token override hash
  differently and are kept separate.
- No Figma desktop app needed. Headless. Your token stays in `.env`
  on your machine.

---

## Project layout

```
src/
├── index.ts          # CLI router + MCP stdio server + tool definitions
├── cli-ui.ts         # Spinner, splash, progress bar, colour helpers (TTY-gated)
├── figma-client.ts   # Minimal REST client with plugin_data=shared
├── parse-url.ts      # Figma URL → { fileKey, nodeId? }
├── tokens.ts         # extractTokens / extractDisplayTokens / style-gap logic
├── xml.ts            # Legacy XML renderer (get_metadata_with_tokens)
├── render-tree.ts    # Compact ASCII tree renderer + token dictionary
├── config.ts         # ~/.ftrc.json + ./ft.config.json loader
├── tokens.test.ts    # Node test runner suite
└── render-tree.test.ts
```

Run the tests with:

```bash
npx tsx --test src/tokens.test.ts src/render-tree.test.ts
```

---

## Scope

- **Read only.** `ft` never writes tokens back to Figma.
- Returns token **names** (reference paths like
  `colors.primary.500`) — not resolved values. Composition token
  values are shown as full reference paths when
  `--with-composition` is on.
- Node 18+ (native `fetch`).

See [CHANGELOG.md](./CHANGELOG.md) for the v0.1 → v0.2 history.

---

## License

MIT — see [LICENSE](./LICENSE).
