import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  IDENTIFIERS_FILE,
  MAPPING_TABLES,
  REF_SEGMENT_DISPOSITIONS,
  SDK_COMPOUND_ID_TYPES,
  buildReport,
  buildSnapshot,
  findGaps,
  loadReport,
  orderedPrimaryIdentifier,
  parseMappedTypes,
  serializeSnapshot,
  tableEntriesOf,
  type IdentifierSnapshot,
} from '../../../scripts/gen-ref-segment-coverage.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
// The two files the generator reads, concatenated the way it reads them.
const REF_VALUES =
  readFileSync(resolve(ROOT, 'src/deployment/intrinsic-resolver/ref-values.ts'), 'utf8') +
  '\n' +
  readFileSync(resolve(ROOT, 'src/deployment/intrinsic-resolver/ref-values/type-refs.ts'), 'utf8');

const snapshotOf = (ids: Record<string, string[]>, absent: string[] = []): IdentifierSnapshot => ({
  source: 'test',
  generatedAt: '2026-11-19',
  primaryIdentifiers: ids,
  absentFromBundle: absent,
});

describe('gen-ref-segment-coverage: classification (issue #6612)', () => {
  const tiers = { tier1: ['AWS::A::Sdk'], tier2: ['AWS::A::Mapped', 'AWS::A::Doc', 'AWS::A::Gap', 'AWS::A::Single'] };
  const snapshot = snapshotOf({
    'AWS::A::Sdk': ['Id'],
    'AWS::A::Mapped': ['P', 'C'],
    'AWS::A::Doc': ['P', 'C'],
    'AWS::A::Gap': ['P', 'C'],
    'AWS::A::Single': ['Id'],
  });

  it('classifies mapped, recorded and unrecorded compound types, and skips single-field ones', () => {
    const report = buildReport({
      tiers,
      snapshot,
      mapped: new Map([['AWS::A::Mapped', 'REF_RETURNS_SEGMENT_AFTER_PIPE']]),
      dispositions: new Map([['AWS::A::Doc', { kind: 'compound', source: 'docs' }]]),
      sdkCompoundIdTypes: ['AWS::A::Sdk'],
    });
    const status = Object.fromEntries(report.types.map((r) => [r.resourceType, r.status]));
    expect(status).toEqual({
      'AWS::A::Doc': 'compound',
      'AWS::A::Gap': 'gap',
      'AWS::A::Mapped': 'mapped',
      'AWS::A::Sdk': 'gap',
    });
    expect(findGaps(report)).toEqual(['AWS::A::Gap [P, C]', 'AWS::A::Sdk [Id]']);
    expect(report.summary).toMatchObject({ types: 4, mapped: 1, compound: 1, gap: 2 });
  });

  it('reports a disposition for a mapped type, or one outside the universe, as stale', () => {
    const report = buildReport({
      tiers,
      snapshot,
      mapped: new Map([['AWS::A::Mapped', 'case']]),
      dispositions: new Map([
        ['AWS::A::Mapped', { kind: 'compound', source: 'x' }],
        ['AWS::A::Single', { kind: 'no-ref', source: 'x' }],
        ['AWS::A::Doc', { kind: 'unverified', source: 'x' }],
      ]),
      sdkCompoundIdTypes: [],
    });
    expect(report.staleDispositions).toEqual(['AWS::A::Mapped', 'AWS::A::Single']);
  });

  it('reports a tier type the snapshot does not cover, but not one recorded as absent from the bundle', () => {
    const report = buildReport({
      tiers: { tier1: [], tier2: ['AWS::A::New', 'AWS::A::Absent'] },
      snapshot: snapshotOf({}, ['AWS::A::Absent']),
      mapped: new Map(),
      dispositions: new Map(),
      sdkCompoundIdTypes: [],
    });
    expect(report.missingFromSnapshot).toEqual(['AWS::A::New']);
  });
});

describe('gen-ref-segment-coverage: parsing ref-values.ts', () => {
  it('finds every mapping table with entries (a reshape would yield an empty list)', () => {
    for (const table of MAPPING_TABLES) {
      expect(tableEntriesOf(REF_VALUES, table).length, table).toBeGreaterThan(0);
    }
    expect(tableEntriesOf(REF_VALUES, 'REF_RETURNS_SEGMENT_AFTER_PIPE').length).toBeGreaterThanOrEqual(25);
    expect(tableEntriesOf(REF_VALUES, 'REF_RETURNS_SEGMENT_BEFORE_FIRST_PIPE').length).toBeGreaterThanOrEqual(7);
  });

  it("reads cfnRefValueFromPhysicalId's per-type arms", () => {
    const mapped = parseMappedTypes(REF_VALUES);
    for (const t of ['AWS::Logs::LogStream', 'AWS::Glue::Table', 'AWS::WAFv2::WebACL', 'AWS::S3Tables::Namespace']) {
      expect(mapped.get(t), t).toBe('case');
    }
    expect(mapped.get('AWS::SSM::MaintenanceWindowTarget')).toBe('REF_RETURNS_SEGMENT_AFTER_PIPE');
    expect(mapped.get('AWS::Route53::RecordSetGroup')).toBe('REF_RETURNS_SEGMENT_AT_INDEX');
    expect(mapped.get('AWS::ApplicationAutoScaling::ScalingPolicy')).toBe('REF_FROM_PHYSICAL_ID_HELPERS');
  });

  it('counts an `if (resourceType === ...)` arm, never a comment mentioning one', () => {
    const src = [
      'export function cfnRefValueFromPhysicalId(resourceType: string) {',
      "  // resourceType === 'AWS::A::Comment' is only mentioned here",
      "  if (resourceType === 'AWS::A::Arm') {",
      '    return 1;',
      '  }',
      '  if (',
      "    resourceType === 'AWS::A::First' ||",
      "    resourceType === 'AWS::A::Second'",
      '  ) {',
      '    return 2;',
      '  }',
      '}',
      '',
    ].join('\n');
    expect([...parseMappedTypes(src).keys()].sort()).toEqual(['AWS::A::Arm', 'AWS::A::First', 'AWS::A::Second']);
  });

  it('a type removed from a table becomes a gap on the real tree', () => {
    const removed = REF_VALUES.replace("  'AWS::SSM::MaintenanceWindowTask',\n", '');
    expect(removed).not.toBe(REF_VALUES);
    const real = loadReport();
    const coverage = JSON.parse(
      readFileSync(resolve(ROOT, 'docs/_generated/provider-coverage.json'), 'utf8')
    ) as { tier1: string[]; tier2: string[] };
    const snapshot = JSON.parse(readFileSync(IDENTIFIERS_FILE, 'utf8')) as IdentifierSnapshot;
    const report = buildReport({ tiers: coverage, snapshot, mapped: parseMappedTypes(removed) });
    expect(findGaps(report)).toEqual(['AWS::SSM::MaintenanceWindowTask [WindowId, WindowTaskId]']);
    expect(findGaps(real)).toEqual([]);
  });
});

describe('gen-ref-segment-coverage: the committed tree', () => {
  const report = loadReport();

  it('has no gap, no stale disposition and a snapshot covering every tier type', () => {
    expect(findGaps(report)).toEqual([]);
    expect(report.staleDispositions).toEqual([]);
    expect(report.missingFromSnapshot).toEqual([]);
  });

  it('classifies a universe of the expected size (floors per bucket)', () => {
    expect(report.summary.types).toBeGreaterThanOrEqual(300);
    expect(report.summary.mapped).toBeGreaterThanOrEqual(50);
    expect(report.summary.compound).toBeGreaterThanOrEqual(80);
    expect(report.summary['no-ref']).toBeGreaterThanOrEqual(30);
  });

  it('brings the SDK compound-id types in although their schema identifier is one field', () => {
    for (const t of SDK_COMPOUND_ID_TYPES) {
      expect(report.types.some((r) => r.resourceType === t), t).toBe(true);
    }
  });

  it('gives every disposition a source', () => {
    for (const [t, disposition] of REF_SEGMENT_DISPOSITIONS) {
      expect(disposition.source.length, t).toBeGreaterThan(5);
    }
  });

  it('matches the committed docs/_generated/ref-segment-coverage.json', () => {
    const committed = JSON.parse(
      readFileSync(resolve(ROOT, 'docs/_generated/ref-segment-coverage.json'), 'utf8')
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(report)));
  });
});

describe('gen-ref-segment-coverage: snapshot capture', () => {
  it('keeps the schema ORDER of the identifier (the committed fixtures sort it)', () => {
    const schema = JSON.stringify({ primaryIdentifier: ['/properties/WindowId', '/properties/A'] });
    expect(orderedPrimaryIdentifier(schema)).toEqual(['WindowId', 'A']);
  });

  it('records a type the bundle lacks as absent, never as an empty identifier', () => {
    const snap = buildSnapshot(
      { tier1: ['AWS::X::Y'], tier2: ['AWS::X::Z'] },
      new Map([['aws-x-z.json', JSON.stringify({ primaryIdentifier: ['/properties/B', '/properties/A'] })]]),
      (t) => t.toLowerCase().replace(/::/g, '-') + '.json',
      '2026-11-19'
    );
    expect(snap.primaryIdentifiers).toEqual({ 'AWS::X::Z': ['B', 'A'] });
    expect(snap.absentFromBundle).toEqual(['AWS::X::Y']);
    expect(JSON.parse(serializeSnapshot(snap))).toEqual(snap);
  });

  it('the committed snapshot round-trips through the serializer byte for byte', () => {
    const text = readFileSync(IDENTIFIERS_FILE, 'utf8');
    expect(serializeSnapshot(JSON.parse(text) as IdentifierSnapshot)).toBe(text);
  });
});
