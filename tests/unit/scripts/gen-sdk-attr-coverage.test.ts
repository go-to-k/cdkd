import { describe, it, expect } from 'vite-plus/test';
import {
  collectStoredAttributeKeys,
  collectConstructAttributeTypes,
  classifyType,
  buildReport,
  findGaps,
  loadAllFixtures,
  SDK_ATTR_ALLOW_LIST,
  type AllowListEntry,
} from '../../../scripts/gen-sdk-attr-coverage.js';
import { parseProviderSource } from '../../../scripts/gen-property-coverage.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('collectStoredAttributeKeys', () => {
  it('collects object-literal keys, shorthand, and element-access assignment keys', () => {
    const src = `
      class P {
        create() {
          const attributes: Record<string, unknown> = { AgentRuntimeArn: x, 'AgentRuntimeId': y };
          attributes['AgentRuntimeVersion'] = z;
          const shorthand = { Status };
          return { physicalId: id, attributes };
        }
      }
    `;
    const keys = collectStoredAttributeKeys(src);
    expect(keys.has('AgentRuntimeArn')).toBe(true);
    expect(keys.has('AgentRuntimeId')).toBe(true);
    expect(keys.has('AgentRuntimeVersion')).toBe(true);
    expect(keys.has('Status')).toBe(true);
  });

  it('does NOT collect a `case` label / comparison literal (the #1179 precision)', () => {
    // The pre-#1179 shape: getAttribute COMPARES against 'AgentRuntimeArn' but
    // create stores the ARN under the wrong key `Arn`. The ARN name must NOT be
    // collected from the comparison, so the classifier still flags the gap.
    const src = `
      class P {
        create() { return { physicalId: id, attributes: { Arn: arn } }; }
        getAttribute(_id, _t, name) {
          if (name === 'AgentRuntimeArn') return this.fetchArn();
          switch (name) { case 'OtherArn': return 1; }
        }
      }
    `;
    const keys = collectStoredAttributeKeys(src);
    expect(keys.has('Arn')).toBe(true); // the (wrong) stored key
    expect(keys.has('AgentRuntimeArn')).toBe(false); // comparison, not stored
    expect(keys.has('OtherArn')).toBe(false); // case label, not stored
  });

  it('ignores camelCase SDK-input keys (they never collide with PascalCase CFn ARN names)', () => {
    const src = `class P { create() { const input = {}; input['agentRuntimeName'] = n; return { attributes: {} }; } }`;
    const keys = collectStoredAttributeKeys(src);
    expect(keys.has('agentRuntimeName')).toBe(true); // collected but harmless
    expect([...keys].some((k) => k.endsWith('Arn'))).toBe(false);
  });
});

describe('collectConstructAttributeTypes', () => {
  it('extracts AWS::X::Y literals from the constructAttribute method body only', () => {
    const src = `
      class R {
        private async constructAttribute(resource, name) {
          if (resource.resourceType === 'AWS::EC2::Instance') return this.ip();
          if (resource.resourceType === 'AWS::EC2::LaunchTemplate') return this.ver();
        }
        private other() { const t = 'AWS::S3::Bucket'; return t; }
      }
    `;
    const types = collectConstructAttributeTypes(src);
    expect(types.has('AWS::EC2::Instance')).toBe(true);
    expect(types.has('AWS::EC2::LaunchTemplate')).toBe(true);
    // A literal in a DIFFERENT method must not count.
    expect(types.has('AWS::S3::Bucket')).toBe(false);
  });

  it('returns an empty set when there is no constructAttribute method', () => {
    expect(collectConstructAttributeTypes('class X { foo() {} }').size).toBe(0);
  });
});

describe('classifyType', () => {
  const EMPTY = new Map<string, AllowListEntry>();

  it('flags an Arn readOnly that is neither cached nor constructAttribute-covered (the #1179 gap)', () => {
    const c = classifyType(
      'AWS::BedrockAgentCore::Runtime',
      ['AgentRuntimeArn', 'Status'],
      [],
      new Set(['Arn', 'AgentRuntimeId']), // wrong key cached, ARN missing
      new Set(), // not in constructAttribute
      EMPTY
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['AgentRuntimeArn']);
  });

  it('marks cached when the provider records the ARN under its CFn name', () => {
    const c = classifyType(
      'AWS::BedrockAgentCore::Runtime',
      ['AgentRuntimeArn'],
      [],
      new Set(['AgentRuntimeArn']),
      new Set(),
      EMPTY
    );
    expect(c.bucket).toBe('covered');
    expect(c.arnAttributes[0].status).toBe('cached');
  });

  it('marks construct-attribute when the resolver handles the type', () => {
    const c = classifyType('AWS::Foo::Bar', ['FooArn'], [], new Set(), new Set(['AWS::Foo::Bar']), EMPTY);
    expect(c.bucket).toBe('covered');
    expect(c.arnAttributes[0].status).toBe('construct-attribute');
  });

  it('excludes a primaryIdentifier ARN (physicalId fallback resolves it)', () => {
    const c = classifyType('AWS::Foo::Bar', ['FooArn'], ['FooArn'], new Set(), new Set(), EMPTY);
    expect(c.bucket).toBe('no-arn-attr');
    expect(c.arnAttributes).toEqual([]);
  });

  it('respects the allow-list', () => {
    const allow = new Map<string, AllowListEntry>([
      ['AWS::SNS::Subscription', { attributes: ['Arn'], rationale: 'Arn == physicalId' }],
    ]);
    const c = classifyType('AWS::SNS::Subscription', ['Arn'], [], new Set(), new Set(), allow);
    expect(c.bucket).toBe('covered');
    expect(c.arnAttributes[0].status).toBe('allow-listed');
  });

  it('classifies a type with only non-ARN/URL readOnly attributes as no-arn-attr', () => {
    const c = classifyType('AWS::Foo::Bar', ['Id', 'Status'], [], new Set(), new Set(), EMPTY);
    expect(c.bucket).toBe('no-arn-attr');
  });

  it('treats a *Url attribute the same as *Arn', () => {
    const c = classifyType('AWS::Foo::Bar', ['ServiceUrl'], [], new Set(), new Set(), EMPTY);
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['ServiceUrl']);
  });
});

describe('buildReport / findGaps', () => {
  it('only classifies SDK-backed types and surfaces gaps', () => {
    const fixtures = [
      { resourceType: 'AWS::Sdk::Ok', readOnlyProperties: ['ThingArn'] },
      { resourceType: 'AWS::Sdk::Gap', readOnlyProperties: ['ThingArn'] },
      { resourceType: 'AWS::Cc::Only', readOnlyProperties: ['ThingArn'] }, // no SDK provider
    ];
    const report = buildReport(
      fixtures,
      new Set(['AWS::Sdk::Ok', 'AWS::Sdk::Gap']),
      new Map([['AWS::Sdk::Ok', new Set(['ThingArn'])]]),
      new Set()
    );
    expect(report.summary.classifiedCount).toBe(2); // pure-CC type excluded
    const gaps = findGaps(report);
    expect(gaps.map((g) => g.resourceType)).toEqual(['AWS::Sdk::Gap']);
  });
});

// The "a checker must prove it sees its input" guard (rules/testing.md): pin
// that the real generator actually parses providers + fixtures and lands the
// known allow-list entries, so a parser regression fails loudly instead of
// silently classifying nothing.
describe('real repo coverage (regression floor)', () => {
  const repoRoot = join(import.meta.dirname, '../../..');

  it('classifies a substantial number of SDK-backed types with an Arn/Url attribute', () => {
    const fixtures = loadAllFixtures(join(repoRoot, 'tests/fixtures/cfn-schemas'));
    const providersDir = join(repoRoot, 'src/provisioning/providers');
    const sdkBacked = new Set<string>();
    const cached = new Map<string, Set<string>>();
    for (const file of readdirSync(providersDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
      const src = readFileSync(join(providersDir, file), 'utf8');
      const parsed = parseProviderSource(src, file);
      if (parsed.handled.size === 0) continue;
      const keys = collectStoredAttributeKeys(src, file);
      for (const type of parsed.handled.keys()) {
        sdkBacked.add(type);
        const t = cached.get(type) ?? new Set<string>();
        for (const k of keys) t.add(k);
        cached.set(type, t);
      }
    }
    const ctorTypes = collectConstructAttributeTypes(
      readFileSync(join(repoRoot, 'src/deployment/intrinsic-function-resolver.ts'), 'utf8')
    );
    const report = buildReport(fixtures, sdkBacked, cached, ctorTypes);

    // Floors: the generator must actually see providers + fixtures.
    expect(report.summary.classifiedCount).toBeGreaterThan(100);
    const withArn = report.types.filter((t) => t.arnAttributes.length > 0);
    expect(withArn.length).toBeGreaterThan(30);
    // With the shipped allow-list, there must be zero un-allow-listed gaps
    // (the critic's green state).
    expect(findGaps(report)).toEqual([]);
  });

  it('carries the two known allow-list entries', () => {
    expect(SDK_ATTR_ALLOW_LIST.get('AWS::SNS::Subscription')?.attributes).toContain('Arn');
    expect(SDK_ATTR_ALLOW_LIST.get('AWS::Lambda::EventSourceMapping')?.attributes).toContain(
      'EventSourceMappingArn'
    );
  });
});
