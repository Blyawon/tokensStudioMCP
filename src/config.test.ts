import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { DEFAULT_CONFIG, loadConfig, unfilteredConfig } from "./config.js";

test("loadConfig returns defaults when no files exist", () => {
  // Point at a temp cwd with nothing in it.
  const dir = mkdtempSync(resolve(tmpdir(), "ft-cfg-"));
  try {
    const loaded = loadConfig(dir);
    // User-level .ftrc.json might still exist in homedir for the dev running
    // this test — just assert the shape and known keys exist.
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      assert.ok(key in loaded.config, `missing config key ${key}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig picks up a project ft.config.json", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ft-cfg-"));
  try {
    writeFileSync(
      resolve(dir, "ft.config.json"),
      JSON.stringify({ ignoreComponents: false, warnStyleGaps: false })
    );
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.ignoreComponents, false);
    assert.equal(loaded.config.warnStyleGaps, false);
    // Unset keys fall back to defaults.
    assert.equal(loaded.config.ignoreVectorsWithoutFill, DEFAULT_CONFIG.ignoreVectorsWithoutFill);
    assert.equal(loaded.config.onlyWithTokens, DEFAULT_CONFIG.onlyWithTokens);
    assert.ok(loaded.sources.some((s) => s.endsWith("ft.config.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig ignores non-boolean fields in the config file", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "ft-cfg-"));
  try {
    writeFileSync(
      resolve(dir, "ft.config.json"),
      JSON.stringify({ ignoreComponents: "yes", warnStyleGaps: 1 })
    );
    const loaded = loadConfig(dir);
    // Non-booleans are silently ignored — we don't corrupt the config.
    assert.equal(loaded.config.ignoreComponents, DEFAULT_CONFIG.ignoreComponents);
    assert.equal(loaded.config.warnStyleGaps, DEFAULT_CONFIG.warnStyleGaps);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unfilteredConfig disables every filter and opts into composition", () => {
  const u = unfilteredConfig();
  assert.equal(u.ignoreComponents, false);
  assert.equal(u.ignoreVectorsWithoutFill, false);
  assert.equal(u.warnStyleGaps, false);
  assert.equal(u.onlyWithTokens, false);
  assert.equal(u.includeComposition, true);
});

test("DEFAULT_CONFIG hides composition tokens by default", () => {
  assert.equal(DEFAULT_CONFIG.includeComposition, false);
});
