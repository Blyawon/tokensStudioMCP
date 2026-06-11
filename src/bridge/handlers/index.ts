/**
 * Register every plugin-initiated bridge handler. Called once at server
 * startup from mcp-server.ts.
 */

import { getBridge } from "../server.js";
import { handlePullCatalogRequest } from "./pull-catalog.js";
import { handleListBranchesRequest } from "./list-branches.js";
import { handleListThemesFromUIRequest } from "./list-themes-ui.js";
import { handleApplyThemeFromUIRequest } from "./apply-theme-ui.js";
import { handleInspectNodeRequest } from "./inspect-node.js";
import { handleStageTokenFixRequest } from "./stage-token-fix.js";

export function registerBridgeHandlers(): void {
  const bridge = getBridge();
  bridge.register("pullCatalog", handlePullCatalogRequest);
  bridge.register("listBranches", handleListBranchesRequest);
  bridge.register("listThemesFromUI", handleListThemesFromUIRequest);
  bridge.register("applyThemeFromUI", handleApplyThemeFromUIRequest);
  bridge.register("inspectNode", handleInspectNodeRequest);
  bridge.register("stageTokenFix", handleStageTokenFixRequest);
  bridge.register("setPinnedTarget", (params) => {
    const p = params as {
      target: { fileKey: string; nodeId: string | null; name: string | null; url: string } | null;
    };
    bridge.pinnedTarget = p.target;
    return { ok: true as const };
  });
}
