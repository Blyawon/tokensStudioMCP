/**
 * Shared types for the remapping pipeline. Kept in their own file so the
 * ingester, matcher, and tool layer can import without pulling each other in.
 */

export interface CatalogToken {
  /** Dot-joined reference path, e.g. `color.accent.default`. */
  path: string;
  /** Tokens Studio token type (`color`, `spacing`, `typography`, …). */
  type?: string;
  /** Resolved value when present (`#3B82F6`, `16`, `{ fontFamily, ... }`). */
  value?: unknown;
  /** Tokens Studio set name (`global`, `light`, …) when known. */
  set?: string;
}

export interface CatalogTheme {
  name: string;
  selectedTokenSets: Record<string, string>;
}

export interface TokenCatalog {
  tokens: CatalogToken[];
  themes: CatalogTheme[];
  /** Soft warnings — never throws on unrecognised shape. */
  warnings: string[];
}

export interface RemapCandidate {
  newToken: string;
  score: number;
  reason: string;
}

export interface RemapEntry {
  oldToken: string;
  candidates: RemapCandidate[];
  /** Set when a single candidate dominates and confidence is high. */
  chosen?: string;
  /** Layers (collapsed instance ids) where this old token currently appears. */
  nodes: Array<{ id: string; name: string; type: string }>;
}

export interface RemapPlan {
  /** Property key (`fill`, `spacing`, …) → list of entries to remap. */
  byProperty: Record<string, RemapEntry[]>;
  unmapped: Array<{ oldToken: string; property: string; reason: string }>;
  ambiguous: Array<{ oldToken: string; property: string; candidates: string[] }>;
  /** Soft warnings from the ingester / matcher. */
  warnings: string[];
}
