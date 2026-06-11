/**
 * Per-process working copy for token edits. Edits accumulate as
 * PendingEdits; `flushAsCommit` applies them to a deep clone of the
 * base catalog, serializes back to per-set JSON files, and hands the
 * file list to a WritableProvider.
 *
 * State is module-singleton (one working copy per MCP server process).
 * Loaded lazily on first edit so no fetches happen unless the agent
 * actually starts editing.
 */

import { fetchCatalog, normaliseStorageConfig, type AnyStorageConfig, type FetchedCatalog } from "./index.js";
import { resolveSecret } from "./secrets.js";
import { getWritable, type CommittableFile } from "./writable.js";

export type PendingEdit =
  | { kind: "set"; path: string; value: unknown; type?: string; set: string }
  | { kind: "delete"; path: string; set: string }
  | { kind: "rename"; from: string; to: string; set?: string; updateRefs: boolean };

export interface WorkingCatalogSnapshot {
  branch: string;
  baseSha: string | null;
  source: { provider: string; description: string };
  editCount: number;
  edits: PendingEdit[];
}

interface WorkingCatalog {
  base: FetchedCatalog;
  baseSha: string | null;
  config: AnyStorageConfig;
  branch: string;
  edits: PendingEdit[];
}

let CURRENT: WorkingCatalog | null = null;
/**
 * In-flight init promise. Two parallel `set_token` calls used to race
 * here: both saw `CURRENT == null`, both fetched, both wrote `CURRENT`,
 * and the first call's edits got lost. The promise cache deduplicates
 * concurrent initialisations to a single fetch.
 */
let INIT_PROMISE: Promise<WorkingCatalog> | null = null;

/**
 * Lazy-init the working copy from the active storage config + a fresh
 * fetch. If a WC already exists for the same source + branch, reuse it
 * so edits accumulate across tool calls.
 */
export async function ensureWorkingCatalog(
  resolvedConfig: AnyStorageConfig
): Promise<WorkingCatalog> {
  if (CURRENT && sameSource(CURRENT.config, resolvedConfig)) return CURRENT;
  if (INIT_PROMISE) return INIT_PROMISE;
  INIT_PROMISE = initWorkingCatalog(resolvedConfig).finally(() => {
    INIT_PROMISE = null;
  });
  return INIT_PROMISE;
}

async function initWorkingCatalog(resolvedConfig: AnyStorageConfig): Promise<WorkingCatalog> {
  const base = await fetchCatalog(resolvedConfig);
  // baseSha discovery is provider-specific; for v1 we ask the writable
  // side (which knows how to read it). Branch comes from the config.
  const branch = (resolvedConfig as { branch?: string }).branch ?? "main";
  const secret = await resolveSecret(resolvedConfig.provider);
  let baseSha: string | null = null;
  try {
    const wp = getWritable(resolvedConfig, secret);
    baseSha = await wp.getRefSha(branch);
  } catch {
    // Provider doesn't support write, or auth missing — that's fine for
    // staging edits; commit_and_push will surface the same error later.
    baseSha = null;
  }
  CURRENT = { base, baseSha, config: resolvedConfig, branch, edits: [] };
  return CURRENT;
}

/** Bump baseSha after a successful commit so subsequent edits start clean. */
export function getCurrentConfig(): AnyStorageConfig | null {
  return CURRENT?.config ?? null;
}

function sameSource(a: AnyStorageConfig, b: AnyStorageConfig): boolean {
  if (a.provider !== b.provider) return false;
  const aId = (a as { id?: string }).id;
  const bId = (b as { id?: string }).id;
  if (aId !== bId) return false;
  const aBranch = (a as { branch?: string }).branch;
  const bBranch = (b as { branch?: string }).branch;
  return aBranch === bBranch;
}

export function snapshotWorkingCopy(): WorkingCatalogSnapshot | null {
  if (!CURRENT) return null;
  return {
    branch: CURRENT.branch,
    baseSha: CURRENT.baseSha,
    source: { provider: CURRENT.base.source.provider, description: CURRENT.base.source.description },
    editCount: CURRENT.edits.length,
    edits: CURRENT.edits,
  };
}

export function discardWorkingCopy(): void {
  CURRENT = null;
}

export function addEdit(edit: PendingEdit): void {
  if (!CURRENT) throw new Error("Working copy not initialised — call ensureWorkingCatalog first");
  CURRENT.edits.push(edit);
}

/**
 * Apply every pending edit to a DEEP CLONE of the base catalog, then
 * serialize each top-level set back to its `<setName>.json`. Themes /
 * metadata get their `$themes.json` / `$metadata.json` companions when
 * present in the base.
 */
export interface FlushPlan {
  /** Files to write (after edits applied). */
  files: CommittableFile[];
  /** Paths whose set was deleted entirely (delete blob from tree). */
  deletes: string[];
  /** Touched set names — useful for the commit message default. */
  touchedSets: string[];
}

export function buildFlushPlan(filePathPrefix: string): FlushPlan {
  if (!CURRENT) throw new Error("Working copy not initialised");
  const tree = deepClone(CURRENT.base.values) as Record<string, unknown>;

  const touchedSets = new Set<string>();
  for (const edit of CURRENT.edits) {
    if (edit.kind === "set") {
      ensureSet(tree, edit.set);
      writeAtPath(tree[edit.set] as Record<string, unknown>, edit.path, {
        value: edit.value,
        type: edit.type ?? inferTypeFromValue(edit.value),
      });
      touchedSets.add(edit.set);
    } else if (edit.kind === "delete") {
      if (edit.set in tree) {
        deleteAtPath(tree[edit.set] as Record<string, unknown>, edit.path);
        touchedSets.add(edit.set);
      }
    } else if (edit.kind === "rename") {
      const sets = edit.set ? [edit.set] : Object.keys(tree);
      for (const setName of sets) {
        const setTree = tree[setName] as Record<string, unknown> | undefined;
        if (!setTree) continue;
        const oldLeaf = readAtPath(setTree, edit.from);
        if (!oldLeaf) continue;
        deleteAtPath(setTree, edit.from);
        writeAtPath(setTree, edit.to, oldLeaf);
        touchedSets.add(setName);
      }
      if (edit.updateRefs) {
        const replaced = rewriteReferences(tree, edit.from, edit.to);
        for (const s of replaced) touchedSets.add(s);
      }
    }
  }

  const prefix = filePathPrefix.replace(/^\/+|\/+$/g, "");
  const files: CommittableFile[] = [];
  const deletes: string[] = [];

  for (const setName of touchedSets) {
    const setTree = tree[setName];
    const fullPath = prefix ? `${prefix}/${setName}.json` : `${setName}.json`;
    if (!setTree) {
      deletes.push(fullPath);
      continue;
    }
    files.push({
      path: fullPath,
      contents: JSON.stringify(setTree, null, 2) + "\n",
    });
  }

  // Carry $themes / $metadata through unchanged when they exist —
  // otherwise GitHub's tree replace would drop them.
  if (CURRENT.base.themes !== undefined) {
    const fullPath = prefix ? `${prefix}/$themes.json` : "$themes.json";
    files.push({
      path: fullPath,
      contents: JSON.stringify(CURRENT.base.themes, null, 2) + "\n",
    });
  }
  if (CURRENT.base.metadata !== undefined) {
    const fullPath = prefix ? `${prefix}/$metadata.json` : "$metadata.json";
    files.push({
      path: fullPath,
      contents: JSON.stringify(CURRENT.base.metadata, null, 2) + "\n",
    });
  }

  return { files, deletes, touchedSets: Array.from(touchedSets) };
}

/**
 * After a successful commit, drop the staged edits and refresh baseSha
 * to the new commit's sha so subsequent edits start from fresh ground.
 */
export function markCommitted(newSha: string): void {
  if (!CURRENT) return;
  CURRENT.edits = [];
  CURRENT.baseSha = newSha;
}

// --------------------------------------------------------------------------
// Tree manipulation helpers
// --------------------------------------------------------------------------

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function ensureSet(tree: Record<string, unknown>, setName: string): void {
  if (!(setName in tree) || !tree[setName] || typeof tree[setName] !== "object") {
    tree[setName] = {};
  }
}

function writeAtPath(setTree: Record<string, unknown>, path: string, leaf: unknown): void {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = setTree;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!(k in cursor) || !cursor[k] || typeof cursor[k] !== "object" || Array.isArray(cursor[k])) {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = leaf;
}

function deleteAtPath(setTree: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = setTree;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!(k in cursor) || !cursor[k] || typeof cursor[k] !== "object") return;
    cursor = cursor[k] as Record<string, unknown>;
  }
  delete cursor[parts[parts.length - 1]];
}

function readAtPath(setTree: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cursor: unknown = setTree;
  for (const k of parts) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[k];
  }
  return cursor;
}

/**
 * Walk every leaf and rewrite `{from}` → `{to}` references in `value`
 * strings. Returns the set names that contained at least one rewrite.
 */
function rewriteReferences(
  tree: Record<string, unknown>,
  from: string,
  to: string
): Set<string> {
  const touched = new Set<string>();
  const fromRef = `{${from}}`;
  const toRef = `{${to}}`;
  function walk(node: unknown, setName: string): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    if ("value" in obj || "$value" in obj) {
      const key = "value" in obj ? "value" : "$value";
      const v = obj[key];
      if (typeof v === "string" && v.includes(fromRef)) {
        obj[key] = v.split(fromRef).join(toRef);
        touched.add(setName);
      }
      return;
    }
    for (const k of Object.keys(obj)) {
      if (k.startsWith("$")) continue;
      walk(obj[k], setName);
    }
  }
  for (const setName of Object.keys(tree)) walk(tree[setName], setName);
  return touched;
}

function inferTypeFromValue(value: unknown): string {
  if (typeof value === "number") return "number";
  if (typeof value === "string") {
    const v = value.trim();
    if (/^#[0-9a-f]{3,8}$/i.test(v)) return "color";
    if (/^(rgb|hsl)a?\s*\(/i.test(v)) return "color";
    if (/(px|rem|em)\s*$/i.test(v)) return "dimension";
    // Bare numeric string ("16", "1.5", "-4") — treat as number, not "other".
    if (Number.isFinite(Number(v))) return "number";
    return "other";
  }
  return "other";
}
