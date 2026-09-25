/**
 * The committed create-only snapshot (issue #3718): the fixtures'
 * `createOnlyPropertyPaths`, shipped as `create-only-snapshot.generated.ts` and
 * resolved by `getCreateOnlyPropertyPaths` only when the live DescribeType
 * lookup fails.
 *
 * Three relations, each of which can drift on its own:
 *  - every fixture carries the field (a fixture without it would silently
 *    fall back to "no create-only properties" at runtime);
 *  - its top-level projection equals the older `createOnlyProperties` field,
 *    so the two captures of one schema cannot disagree;
 *  - the generated module equals the fixtures (CI's gen:all-matrices diff
 *    catches staleness too; this names the type that drifted).
 */

import { describe, it, expect } from 'vite-plus/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';
import { parseCreateOnlyPropertyPointers } from '../../../src/provisioning/create-only-paths.js';
import { renderCreateOnlySnapshot } from '../../../scripts/gen-property-coverage.js';
import { extractCreateOnlyPropertyPaths } from '../../../scripts/refresh-cfn-schemas.mjs';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/cfn-schemas'
);

interface Fixture {
  resourceType: string;
  createOnlyProperties: string[];
  createOnlyPropertyPaths?: unknown;
}

const fixtures: Array<{ file: string; fixture: Fixture }> = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((file) => ({
    file,
    fixture: JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as Fixture,
  }));

describe('fixture createOnlyPropertyPaths', () => {
  it('reads the real corpus, including nested paths', () => {
    expect(fixtures.length, 'the fixtures path is wrong').toBeGreaterThan(100);
    const nested = fixtures.filter(({ fixture }) =>
      (fixture.createOnlyPropertyPaths as string[][] | undefined)?.some((p) => p.length > 1)
    );
    // A floor per SHAPE: a corpus with no nested path could not show the field
    // carries more than `createOnlyProperties` does.
    expect(nested.length).toBeGreaterThan(0);
  });

  it('every fixture carries it as an array of non-empty string paths', () => {
    const bad = fixtures
      .filter(({ fixture }) => {
        const paths = fixture.createOnlyPropertyPaths;
        return (
          !Array.isArray(paths) ||
          !paths.every(
            (p) =>
              Array.isArray(p) &&
              p.length > 0 &&
              p.every((s) => typeof s === 'string' && s.length > 0)
          )
        );
      })
      .map(({ file }) => file);
    expect(bad).toEqual([]);
  });

  it('its top-level projection equals createOnlyProperties', () => {
    const mismatched = fixtures
      .filter(({ fixture }) => {
        const topLevel = (fixture.createOnlyPropertyPaths as string[][])
          .filter((p) => p.length === 1)
          .map((p) => p[0]!)
          .sort();
        return JSON.stringify(topLevel) !== JSON.stringify([...fixture.createOnlyProperties].sort());
      })
      .map(({ file }) => file);
    expect(mismatched).toEqual([]);
  });
});

describe('extractCreateOnlyPropertyPaths (the producer)', () => {
  it('is the live parse, sorted — nested pointers kept, escapes decoded', () => {
    const pointers = [
      '/properties/Zed',
      '/properties/Foo/Bar',
      '/properties/A~1B',
      '/properties/Foo',
      '/notproperties/X',
    ];
    const produced = extractCreateOnlyPropertyPaths(
      JSON.stringify({ createOnlyProperties: pointers })
    );
    expect(produced).toEqual([['A/B'], ['Foo'], ['Foo', 'Bar'], ['Zed']]);
    // Same SET as the runtime parser, only the order differs.
    expect([...produced].map((p) => p.join('\0')).sort()).toEqual(
      parseCreateOnlyPropertyPointers(pointers)
        .map((p) => p.join('\0'))
        .sort()
    );
  });

  it('emits [] for a schema declaring none', () => {
    expect(extractCreateOnlyPropertyPaths(JSON.stringify({}))).toEqual([]);
  });
});

describe('create-only-snapshot.generated.ts', () => {
  it('equals the fixtures, type for type', () => {
    const fromFixtures = new Map(
      fixtures.map(({ fixture }) => [fixture.resourceType, fixture.createOnlyPropertyPaths])
    );
    expect([...CREATE_ONLY_PATHS_SNAPSHOT.keys()].sort()).toEqual([...fromFixtures.keys()].sort());
    const drifted = [...CREATE_ONLY_PATHS_SNAPSHOT]
      .filter(([type, paths]) => JSON.stringify(paths) !== JSON.stringify(fromFixtures.get(type)))
      .map(([type]) => type);
    expect(drifted).toEqual([]);
  });

  it('the generator REFUSES a fixture without the field rather than skipping it', () => {
    expect(() =>
      renderCreateOnlySnapshot([
        {
          file: 'AWS-Old-Type.json',
          fixture: {
            resourceType: 'AWS::Old::Type',
            generatedAt: '2026-01-01',
            properties: [],
            readOnlyProperties: [],
          },
        },
      ])
    ).toThrow('AWS-Old-Type.json');
  });

  it('the generator renders nested and empty entries', () => {
    const out = renderCreateOnlySnapshot([
      {
        file: 'b.json',
        fixture: {
          resourceType: 'AWS::B::T',
          generatedAt: '2026-01-01',
          properties: [],
          readOnlyProperties: [],
          createOnlyPropertyPaths: [['X', 'Y']],
        },
      },
      {
        file: 'a.json',
        fixture: {
          resourceType: 'AWS::A::T',
          generatedAt: '2026-01-01',
          properties: [],
          readOnlyProperties: [],
          createOnlyPropertyPaths: [],
        },
      },
    ]);
    expect(out).toContain('["X","Y"]');
    expect(out.indexOf('"AWS::A::T"')).toBeLessThan(out.indexOf('"AWS::B::T"'));
    expect(out).toMatch(/"AWS::A::T",\n\s+\[\],/);
  });
});
