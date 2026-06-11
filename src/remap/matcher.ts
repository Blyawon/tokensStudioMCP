/**
 * Matching engine: take the OLD applied-tokens usage from a Figma subtree,
 * the NEW token catalog the user pasted, and produce a remap plan with
 * candidate scores + rationale.
 *
 * The matcher deliberately doesn't try to be the LLM. When two candidates
 * tie, we surface BOTH (with reasoning) and let the calling agent decide
 * — the agent has the layer names, component variants, and conversation
 * context that the matcher does not.
 */

import type { NodeUseMap } from "./collect.js";
import type {
  CatalogToken,
  RemapCandidate,
  RemapEntry,
  RemapPlan,
  TokenCatalog,
} from "./types.js";

/**
 * Tokens Studio applied-property key → set of token TYPES that are
 * legitimate covers for that property. A `fill` property must be covered
 * by a `color` token, etc. Wrong-type candidates are forced to score 0
 * regardless of name similarity.
 *
 * Properties absent from this map are handled with a permissive policy
 * (no type filter) so an unknown plugin extension key doesn't silently
 * suppress all candidates.
 */
const PROPERTY_TO_TOKEN_TYPES: Record<string, string[]> = {
  fill: ["color"],
  borderColor: ["color"],
  spacing: ["spacing", "dimension", "number"],
  horizontalPadding: ["spacing", "dimension", "number"],
  verticalPadding: ["spacing", "dimension", "number"],
  paddingTop: ["spacing", "dimension", "number"],
  paddingRight: ["spacing", "dimension", "number"],
  paddingBottom: ["spacing", "dimension", "number"],
  paddingLeft: ["spacing", "dimension", "number"],
  itemSpacing: ["spacing", "dimension", "number"],
  borderRadius: ["borderRadius", "dimension", "number"],
  borderRadiusTopLeft: ["borderRadius", "dimension", "number"],
  borderRadiusTopRight: ["borderRadius", "dimension", "number"],
  borderRadiusBottomLeft: ["borderRadius", "dimension", "number"],
  borderRadiusBottomRight: ["borderRadius", "dimension", "number"],
  borderWidth: ["borderWidth", "dimension", "number"],
  borderWidthTop: ["borderWidth", "dimension", "number"],
  borderWidthRight: ["borderWidth", "dimension", "number"],
  borderWidthBottom: ["borderWidth", "dimension", "number"],
  borderWidthLeft: ["borderWidth", "dimension", "number"],
  sizing: ["sizing", "dimension", "number"],
  width: ["sizing", "dimension", "number"],
  height: ["sizing", "dimension", "number"],
  fontSize: ["fontSize", "dimension", "number"],
  fontFamily: ["fontFamily", "fontFamilies"],
  fontWeight: ["fontWeight", "fontWeights"],
  lineHeight: ["lineHeight", "lineHeights", "dimension", "number"],
  letterSpacing: ["letterSpacing", "letterSpacings", "dimension"],
  paragraphSpacing: ["paragraphSpacing", "dimension", "number"],
  typography: ["typography"],
  boxShadow: ["boxShadow"],
  opacity: ["opacity", "number"],
  asset: ["asset"],
  composition: ["composition"],
  dimension: ["dimension", "number"],
};

/** Score above which a single dominant candidate is auto-`chosen`. */
const AUTO_CHOICE_THRESHOLD = 0.95;
/** Tied-candidate window: anything within this of the top score is shown. */
const TIE_WINDOW = 0.1;

export interface ProposeOptions {
  /** Optional explicit hints `{ "old.path": "new.path" }`. */
  hints?: Record<string, string>;
  /** Tokens Studio theme name the user wants to target (biases candidates from its sets). */
  preferredTheme?: string;
}

export function proposeRemap(
  uses: NodeUseMap,
  catalog: TokenCatalog,
  opts: ProposeOptions = {}
): RemapPlan {
  const warnings = [...catalog.warnings];
  const byProperty: Record<string, RemapEntry[]> = {};
  const unmapped: RemapPlan["unmapped"] = [];
  const ambiguous: RemapPlan["ambiguous"] = [];

  // Index the catalog by path for fast hint lookup.
  const catalogByPath = new Map<string, CatalogToken>();
  for (const tok of catalog.tokens) catalogByPath.set(tok.path, tok);

  // Resolve preferred theme to a set of token-set names that should win ties.
  const preferredSets = resolvePreferredSets(catalog, opts.preferredTheme);

  for (const [property, byValue] of uses) {
    const entries: RemapEntry[] = [];

    for (const [oldToken, useList] of byValue) {
      const nodes = useList.map((u) => ({ id: u.id, name: u.name, type: u.type }));

      // Hint short-circuit: user explicitly told us what this maps to.
      const hint = opts.hints?.[oldToken];
      if (hint) {
        const candidate: RemapCandidate = catalogByPath.has(hint)
          ? { newToken: hint, score: 1, reason: "explicit hint" }
          : { newToken: hint, score: 0.9, reason: "explicit hint (path not in pasted catalog)" };
        entries.push({
          oldToken,
          candidates: [candidate],
          chosen: hint,
          nodes,
        });
        continue;
      }

      const candidates = scoreCandidates(
        oldToken,
        property,
        catalog.tokens,
        preferredSets
      );

      if (candidates.length === 0) {
        unmapped.push({
          oldToken,
          property,
          reason: noCandidatesReason(property, catalog),
        });
        entries.push({ oldToken, candidates: [], nodes });
        continue;
      }

      const top = candidates[0];
      const tied = candidates.filter((c) => top.score - c.score <= TIE_WINDOW);

      if (top.score >= AUTO_CHOICE_THRESHOLD && tied.length === 1) {
        entries.push({ oldToken, candidates: tied, chosen: top.newToken, nodes });
      } else if (tied.length === 1) {
        // Single best but not high confidence — still show it as the plan,
        // just don't auto-`chosen`. The agent decides whether to apply.
        entries.push({ oldToken, candidates: tied, nodes });
      } else {
        ambiguous.push({
          oldToken,
          property,
          candidates: tied.map((c) => c.newToken),
        });
        entries.push({ oldToken, candidates: tied, nodes });
      }
    }

    byProperty[property] = entries;
  }

  return { byProperty, unmapped, ambiguous, warnings };
}

export function scoreCandidates(
  oldToken: string,
  property: string,
  catalog: CatalogToken[],
  preferredSets: Set<string> | null
): RemapCandidate[] {
  const allowedTypes = PROPERTY_TO_TOKEN_TYPES[property];
  const oldParts = oldToken.split(".");
  const oldLeaf = oldParts[oldParts.length - 1];

  const out: RemapCandidate[] = [];

  for (const cand of catalog) {
    // Type filter (only when the token has a known type AND the property has a constraint).
    if (allowedTypes && cand.type && !allowedTypes.includes(cand.type)) continue;

    let score = 0;
    let reason = "";

    if (cand.path === oldToken) {
      score = 1;
      reason = "exact path match";
    } else {
      const newParts = cand.path.split(".");
      const newLeaf = newParts[newParts.length - 1];
      const sharedSuffix = countSharedSuffix(oldParts, newParts);

      if (sharedSuffix > 0) {
        // Scale by how much of the path matches.
        const ratio = (2 * sharedSuffix) / (oldParts.length + newParts.length);
        score = Math.min(0.85, 0.4 + ratio * 0.5);
        reason = `${sharedSuffix}-segment suffix match`;
      } else if (oldLeaf && newLeaf && oldLeaf.toLowerCase() === newLeaf.toLowerCase()) {
        score = 0.55;
        reason = "leaf name match";
      } else if (oldLeaf && newLeaf && containsTokenStem(oldLeaf, newLeaf)) {
        score = 0.4;
        reason = "shared name stem";
      } else {
        continue;
      }

      // Type-compat bonus (when both sides have type info).
      if (allowedTypes && cand.type && allowedTypes.includes(cand.type)) {
        score = Math.min(1, score + 0.05);
        reason += "; type compatible";
      }

      // Preferred-theme bias.
      if (preferredSets && cand.set && preferredSets.has(cand.set)) {
        score = Math.min(1, score + 0.05);
        reason += "; in preferred theme";
      }
    }

    out.push({ newToken: cand.path, score: round(score), reason });
  }

  out.sort((a, b) => b.score - a.score);
  // Cap the candidate list — beyond ~5 the agent gets noise, not signal.
  return out.slice(0, 5);
}

function countSharedSuffix(a: string[], b: string[]): number {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[a.length - 1 - i].toLowerCase() === b[b.length - 1 - i].toLowerCase()
  ) {
    i++;
  }
  return i;
}

/**
 * "shared name stem" — both leaves contain a substantial common token
 * (length ≥ 3). Used as a weak last-resort signal so e.g.
 * `colors.brand-primary` still surfaces `color.brand.primary` even if
 * neither suffix nor leaf-name match cleanly.
 */
function containsTokenStem(a: string, b: string): boolean {
  const stems = a.toLowerCase().split(/[-_./]/).filter((s) => s.length >= 3);
  const lower = b.toLowerCase();
  return stems.some((s) => lower.includes(s));
}

function resolvePreferredSets(
  catalog: TokenCatalog,
  preferredTheme: string | undefined
): Set<string> | null {
  if (!preferredTheme) return null;
  const theme = catalog.themes.find(
    (t) => t.name.toLowerCase() === preferredTheme.toLowerCase()
  );
  if (!theme) return null;
  const sets = new Set<string>();
  for (const [setName, status] of Object.entries(theme.selectedTokenSets)) {
    if (status === "enabled" || status === "source") sets.add(setName);
  }
  return sets;
}

function noCandidatesReason(property: string, catalog: TokenCatalog): string {
  if (catalog.tokens.length === 0) {
    return "the pasted token catalog was empty";
  }
  const allowedTypes = PROPERTY_TO_TOKEN_TYPES[property];
  if (allowedTypes) {
    const anyOfType = catalog.tokens.some(
      (t) => t.type && allowedTypes.includes(t.type)
    );
    if (!anyOfType) {
      return `no tokens of type ${allowedTypes.join("/")} in the pasted catalog`;
    }
  }
  return "no candidates with a shared path suffix or leaf name";
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
