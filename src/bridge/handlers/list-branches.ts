/**
 * Plugin-initiated branch list. Exposes the provider's branches to the
 * plugin UI so users can pick a non-default branch when editing.
 */

import { resolveStorageConfig } from "../../resolve-storage.js";
import { listBranches as listProviderBranches } from "../../storage/branches.js";

export async function handleListBranchesRequest(_params: unknown): Promise<unknown> {
  try {
    const config = await resolveStorageConfig(undefined);
    return await listProviderBranches(config);
  } catch (err) {
    return {
      ok: false,
      provider: "unknown",
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}
