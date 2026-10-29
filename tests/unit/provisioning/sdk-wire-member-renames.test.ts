import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vite-plus/test';
import { MEMBER_RENAMES } from './sdk-wire-member-renames.js';

/**
 * Fences around the sdk-wire suites' inputs that no single case file sees
 * (go-to-k/cdkd#3723).
 */

const DIR = new URL('.', import.meta.url);
const FIXTURES = new URL('../../fixtures/cfn-schemas/', import.meta.url);

/** Every resource type the wire case and suite files name. */
function wireTypes(): Set<string> {
  const files = readdirSync(DIR).filter(
    (f) => /^sdk-wire-cases.*\.ts$/.test(f) || /^sdk-wire-coverage.*\.test\.ts$/.test(f)
  );
  const types = new Set<string>();
  for (const f of files) {
    const text = readFileSync(new URL(f, DIR), 'utf8');
    for (const m of text.matchAll(/'(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)'/g)) types.add(m[1]!);
  }
  return types;
}

describe('sdk-wire inputs', () => {
  it('names only cased resource types in MEMBER_RENAMES', () => {
    // Each type's entries are read by that type's own suite, so a key no
    // suite runs (a typo, a retired case) is never checked for staleness.
    const types = wireTypes();
    expect(types.size).toBeGreaterThan(100);
    expect(Object.keys(MEMBER_RENAMES).filter((t) => !types.has(t))).toEqual([]);
  });

  it('reads a real nested-path population from the fixtures', () => {
    // `its bags carry every nested path the schema lists` passes vacuously
    // when a fixture has no `nestedPropertyPaths` (the capture omits an empty
    // one), so a capture regression would empty it with nothing red: what
    // `gen-nested-key-coverage.ts`'s `minNestedKeys` floor caught. A LITERAL
    // floor, measured 2026-10-30 at 110 types and 4647 paths.
    let typesWithPaths = 0;
    let pathCount = 0;
    for (const t of wireTypes()) {
      const file = new URL(`${t.replaceAll('::', '-')}.json`, FIXTURES);
      if (!existsSync(file)) continue;
      const nested = (
        JSON.parse(readFileSync(file, 'utf8')) as { nestedPropertyPaths?: Record<string, string[]> }
      ).nestedPropertyPaths;
      if (nested === undefined || Object.keys(nested).length === 0) continue;
      typesWithPaths++;
      pathCount += Object.values(nested).reduce((n, p) => n + p.length, 0);
    }
    expect(typesWithPaths).toBeGreaterThanOrEqual(100);
    expect(pathCount).toBeGreaterThanOrEqual(4000);
  });
});
