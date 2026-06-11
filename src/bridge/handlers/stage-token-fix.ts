/**
 * Stage a fix for a broken token by aliasing it to the suggested
 * replacement. Appends a `set` edit to the working copy that creates
 * `brokenPath: "{suggestedPath}"` in the chosen set, so any node still
 * referencing `brokenPath` resolves through the alias.
 *
 * The edit stays pending until the user runs `commit_and_push` — the
 * Inspect tab can show "staged" status and point the user at the usual
 * list_pending_edits / discard_pending_edits tools for review.
 */

import { resolveStorageConfig } from "../../resolve-storage.js";
import {
  addEdit,
  ensureWorkingCatalog,
  snapshotWorkingCopy,
} from "../../storage/working-copy.js";
import { fetchCatalog, ProviderError } from "../../storage/index.js";
import { ingestTokenSet } from "../../remap/ingest.js";

interface StageFixParams {
  brokenPath: string;
  suggestedPath: string;
  set?: string;
  type?: string;
}

export async function handleStageTokenFixRequest(params: unknown): Promise<unknown> {
  const args = (params ?? {}) as StageFixParams;
  if (!args.brokenPath || !args.suggestedPath) {
    return {
      ok: false,
      error: { message: "stageTokenFix requires { brokenPath, suggestedPath }" },
    };
  }

  try {
    const config = await resolveStorageConfig(undefined);
    await ensureWorkingCatalog(config);

    // Pick a target set. Prefer the set the suggested replacement lives in
    // so aliases stay near their source; fall back to the first set in the
    // catalog; final fallback is "global".
    let targetSet = args.set;
    if (!targetSet) {
      const fetched = await fetchCatalog(config);
      const catalog = ingestTokenSet(fetched.values);
      const suggestedToken = catalog.tokens.find((t) => t.path === args.suggestedPath);
      if (suggestedToken?.set) {
        targetSet = suggestedToken.set;
      } else if (fetched.values && typeof fetched.values === "object") {
        const keys = Object.keys(fetched.values as Record<string, unknown>).filter(
          (k) => !k.startsWith("$")
        );
        targetSet = keys[0] ?? "global";
      } else {
        targetSet = "global";
      }
    }

    const aliasValue = `{${args.suggestedPath}}`;
    addEdit({
      kind: "set",
      path: args.brokenPath,
      value: aliasValue,
      type: args.type,
      set: targetSet,
    });

    const snap = snapshotWorkingCopy();
    return {
      ok: true,
      set: targetSet,
      editCount: snap?.editCount ?? 0,
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      return { ok: false, error: { message: err.message, hint: err.hint } };
    }
    return {
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}
