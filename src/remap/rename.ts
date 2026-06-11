/**
 * Bulk rename rules. Two flavours:
 *   - exact:    `{ from: "colors.brand.primary", to: "color.accent.primary" }`
 *   - pattern:  `{ fromPattern: "colors.brand.*", replacement: "color.accent.$1" }`
 *
 * Pattern syntax: `*` captures one path segment; multiple `*`s capture
 * positionally and can be referenced as `$1`, `$2` in `replacement`.
 * Literal text passes through unchanged.
 */

export type RenameRule =
  | { from: string; to: string }
  | { fromPattern: string; replacement: string };

export interface CompiledRule {
  /** Either a literal `from` (high-precedence exact match) or a regex. */
  matcher:
    | { kind: "exact"; from: string; to: string }
    | { kind: "regex"; re: RegExp; replacement: string };
}

export function compileRules(rules: RenameRule[]): CompiledRule[] {
  return rules.map((r) => {
    if ("from" in r) {
      return { matcher: { kind: "exact" as const, from: r.from, to: r.to } };
    }
    // Build a regex that matches the whole token path. Each `*` becomes
    // a capture group of `[^.]+` (one segment) so adjacent literals still
    // anchor to dot boundaries naturally.
    const escaped = r.fromPattern
      .split("*")
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("([^.]+)");
    const re = new RegExp("^" + escaped + "$");
    return { matcher: { kind: "regex" as const, re, replacement: r.replacement } };
  });
}

/**
 * Try every compiled rule against a path. First-match-wins; rules
 * earlier in the list have priority. Returns the rewritten path or null
 * when no rule matches.
 */
export function applyRules(rules: CompiledRule[], path: string): string | null {
  for (const r of rules) {
    if (r.matcher.kind === "exact") {
      if (r.matcher.from === path) return r.matcher.to;
    } else {
      const m = path.match(r.matcher.re);
      if (m) {
        let out = r.matcher.replacement;
        for (let i = 1; i < m.length; i++) {
          out = out.split(`$${i}`).join(m[i]);
        }
        return out;
      }
    }
  }
  return null;
}
