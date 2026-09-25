import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import {
  findMissingCoverageTypes,
  parseCcBrokenTypes,
  parseProviderSource,
} from '../../../scripts/gen-property-coverage.js';
import { STICKY_CC_MIGRATION_EXEMPT } from '../../../src/provisioning/provider-registry.js';

const TYPE = 'AWS::Example::Thing';

function providerSource(handledInitializer: string): string {
  return `
export class ExampleProvider {
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['${TYPE}', ${handledInitializer}],
  ]);
}
`;
}

describe('parseProviderSource — handledProperties Set shapes', () => {
  it('parses a populated array-literal Set', () => {
    const { handled } = parseProviderSource(
      providerSource("new Set<string>(['Alpha', 'Beta'])")
    );
    expect([...(handled.get(TYPE) ?? [])].sort()).toEqual(['Alpha', 'Beta']);
  });

  it('parses an explicit empty array literal as an empty set', () => {
    const { handled } = parseProviderSource(providerSource('new Set<string>([])'));
    expect(handled.has(TYPE)).toBe(true);
    expect(handled.get(TYPE)?.size).toBe(0);
  });

  it('parses an ARGLESS new Set<string>() as an empty set (issue #1034 regression)', () => {
    // Before the fix this shape was silently dropped from the combined map,
    // shrinking the generated PROPERTY_COVERAGE_BY_TYPE by one type with no
    // error anywhere.
    const { handled } = parseProviderSource(providerSource('new Set<string>()'));
    expect(handled.has(TYPE)).toBe(true);
    expect(handled.get(TYPE)?.size).toBe(0);
  });

  it('parses an argless untyped new Set() as an empty set', () => {
    const { handled } = parseProviderSource(providerSource('new Set()'));
    expect(handled.has(TYPE)).toBe(true);
    expect(handled.get(TYPE)?.size).toBe(0);
  });

  it('still skips a non-literal Set argument (unparseable shape)', () => {
    // A spread from a variable cannot be statically resolved — the entry is
    // skipped here, and the registry cross-check turns the gap into a hard
    // error at generation time instead of a silent shrink.
    const { handled } = parseProviderSource(providerSource('new Set<string>(SOME_CONST)'));
    expect(handled.has(TYPE)).toBe(false);
  });

  it('still extracts unhandledByDesign rationale maps', () => {
    const source = `
export class ExampleProvider {
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['${TYPE}', new Set(['Alpha'])],
  ]);
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    ['${TYPE}', new Map([['Beta', 'declarative-only convenience']])],
  ]);
}
`;
    const { byDesign } = parseProviderSource(source);
    expect(byDesign.get(TYPE)?.get('Beta')).toBe('declarative-only convenience');
  });
});

describe('findMissingCoverageTypes — registry-vs-output cross-check', () => {
  const fixtures = new Set(['AWS::A::One', 'AWS::B::Two', 'AWS::C::Three']);
  const hasFixture = (t: string) => fixtures.has(t);

  it('reports a registered type with a fixture that is absent from the output, sorted', () => {
    const registered = new Set(['AWS::B::Two', 'AWS::A::One', 'AWS::C::Three']);
    const output = new Set(['AWS::C::Three']);
    expect(findMissingCoverageTypes(registered, hasFixture, output)).toEqual([
      'AWS::A::One',
      'AWS::B::Two',
    ]);
  });

  it('exempts registered types without a schema fixture', () => {
    const registered = new Set(['AWS::NoFixture::Type']);
    expect(findMissingCoverageTypes(registered, hasFixture, new Set())).toEqual([]);
  });

  it('returns empty when every registered fixture-backed type is in the output', () => {
    const registered = new Set(['AWS::A::One', 'AWS::B::Two']);
    const output = new Set(['AWS::A::One', 'AWS::B::Two']);
    expect(findMissingCoverageTypes(registered, hasFixture, output)).toEqual([]);
  });
});

describe('parseProviderSource — disableCcApiFallback (issue #3713)', () => {
  it('flags every handledProperties type of a class declaring it true', () => {
    const { ccFallbackDisabled } = parseProviderSource(`
export class ExampleProvider {
  readonly disableCcApiFallback = true;
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['${TYPE}', new Set(['Alpha'])],
    ['AWS::Example::Other', new Set(['Beta'])],
  ]);
}
`);
    expect([...ccFallbackDisabled].sort()).toEqual(['AWS::Example::Other', TYPE].sort());
  });

  it('does not flag a class declaring it false, or a sibling class in the same file', () => {
    const { ccFallbackDisabled, handled } = parseProviderSource(`
export class Off {
  readonly disableCcApiFallback = false;
  handledProperties = new Map<string, ReadonlySet<string>>([['AWS::Example::Off', new Set()]]);
}
export class On {
  readonly disableCcApiFallback = true;
  handledProperties = new Map<string, ReadonlySet<string>>([['${TYPE}', new Set()]]);
}
export class Plain {
  handledProperties = new Map<string, ReadonlySet<string>>([['AWS::Example::Plain', new Set()]]);
}
`);
    // Parsed input floor: all three classes were seen.
    expect(handled.size).toBe(3);
    expect([...ccFallbackDisabled]).toEqual([TYPE]);
  });
});

/** A `provider-registry.ts`-shaped exemption table around `entries`. */
function exemptTable(entries: string): string {
  return `
export const STICKY_CC_MIGRATION_EXEMPT: ReadonlyMap<string, StickyExemptEntry> = new Map([
${entries}
]);

export function wouldReturnToSdkProvider() {}
`;
}

const CC_BROKEN_ENTRY = `  [
    'AWS::Example::Broken',
    {
      // a comment mentioning mode: 'sdk-coverage' in prose
      mode: 'cc-broken' as const,
      physicalIdForm: 'x',
    },
  ],`;
const SDK_COVERAGE_ENTRY = `  [
    'AWS::Example::Slow',
    {
      mode: 'sdk-coverage' as const,
      physicalIdForm: 'mentions cc-broken in prose only',
    },
  ],`;

describe('parseCcBrokenTypes (issue #3713)', () => {
  it("returns only the 'cc-broken' entries, whichever order they come in", () => {
    // Parsed-input floor per shape: both entries were seen (the sdk-coverage
    // one is rejected on its mode, not skipped), in either position.
    expect([...parseCcBrokenTypes(exemptTable(`${CC_BROKEN_ENTRY}\n${SDK_COVERAGE_ENTRY}`))]).toEqual([
      'AWS::Example::Broken',
    ]);
    expect([...parseCcBrokenTypes(exemptTable(`${SDK_COVERAGE_ENTRY}\n${CC_BROKEN_ENTRY}`))]).toEqual([
      'AWS::Example::Broken',
    ]);
    expect([...parseCcBrokenTypes(exemptTable(SDK_COVERAGE_ENTRY))]).toEqual([]);
    // A comment quoting the mode must not flag an sdk-coverage entry.
    const commented = SDK_COVERAGE_ENTRY.replace(
      "mode: 'sdk-coverage' as const,",
      "// unlike mode: 'cc-broken', this one is slow only\n      mode: 'sdk-coverage' as const,"
    );
    expect(commented).toContain("// unlike mode: 'cc-broken'");
    expect([...parseCcBrokenTypes(exemptTable(commented))]).toEqual([]);
  });

  it('refuses a source with no exemption table', () => {
    expect(() => parseCcBrokenTypes('export const SOMETHING_ELSE = new Map([]);')).toThrow(
      /could not read STICKY_CC_MIGRATION_EXEMPT/
    );
  });

  it('refuses a table that parses to zero entries', () => {
    expect(() => parseCcBrokenTypes(exemptTable(''))).toThrow(/parsed to zero entries/);
  });

  it('refuses an entry whose key is not a string literal', () => {
    const constKeyed = `  [
    SCHEDULER_TYPE,
    { mode: 'cc-broken' as const },
  ],`;
    expect(() => parseCcBrokenTypes(exemptTable(`${CC_BROKEN_ENTRY}\n${constKeyed}`))).toThrow(
      /unparseable STICKY_CC_MIGRATION_EXEMPT entry/
    );
  });

  it('reads exactly the runtime cc-broken set out of the REAL provider-registry.ts', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../src/provisioning/provider-registry.ts'),
      'utf8'
    );
    const runtime = [...STICKY_CC_MIGRATION_EXEMPT]
      .filter(([, entry]) => entry.mode === 'cc-broken')
      .map(([type]) => type)
      .sort();
    expect(runtime.length).toBeGreaterThanOrEqual(1);
    expect([...parseCcBrokenTypes(source)].sort()).toEqual(runtime);
  });
});
