import { describe, it, expect } from 'vite-plus/test';
import {
  findMissingCoverageTypes,
  parseProviderSource,
} from '../../../scripts/gen-property-coverage.js';

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
