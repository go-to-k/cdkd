import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #3750: a Glue Table / Connection rename through the NESTED name is a
// REPLACEMENT, matching CloudFormation (measured on the #3750 thread); a
// Database rename is deliberately NOT (CloudFormation's update fails).
// Only the DescribeType-backed createOnly lookup is stubbed, and it answers
// with cdkd's own committed snapshot, so the real rules and the real
// path-granular comparison decide.
const mockGetCreateOnly = vi.fn();
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return {
    ...actual,
    getCreateOnlyPropertyPaths: (resourceType: string) => mockGetCreateOnly(resourceType),
  };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  ReplacementRulesRegistry,
  glueTableNameChanged,
} from '../../../src/analyzer/replacement-rules.js';
import {
  recordSetGroupRecordZoneChanged,
  route53ZoneReferenceChanged,
} from '../../../src/analyzer/replacement-rules/predicates.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

describe('glueTableNameChanged (issue #3750)', () => {
  it.each([
    ['a rename', { Name: 'a' }, { Name: 'b' }, true],
    ['the same name', { Name: 'a' }, { Name: 'a' }, false],
    ['a case-only difference (Glue folds)', { Name: 'orders' }, { Name: 'ORDERS' }, false],
    // Wider than the provider's ASCII fold on purpose: a doubt must answer false.
    ['a non-ASCII case difference', { Name: 'café' }, { Name: 'CAFÉ' }, false],
    ['another TableInput member only', { Name: 'a', Description: 'x' }, { Name: 'a', Description: 'y' }, false],
    ['an absent old name', { Description: 'x' }, { Name: 'b' }, false],
    ['an absent new name', { Name: 'a' }, { Description: 'x' }, false],
    ['an unresolved intrinsic name', { Name: 'a' }, { Name: { Ref: 'P' } }, false],
    ['a non-object block', 'junk', { Name: 'b' }, false],
    ['an array block', [], { Name: 'b' }, false],
  ])('%s -> %s', (_label, oldValue, newValue, expected) => {
    expect(glueTableNameChanged(oldValue, newValue)).toBe(expected);
  });

  it('is the registry rule for AWS::Glue::Table TableInput, and only TableInput is classified', () => {
    const rules = new ReplacementRulesRegistry();
    expect(rules.requiresReplacement('AWS::Glue::Table', 'TableInput', { Name: 'a' }, { Name: 'b' })).toBe(true);
    expect(rules.isClassified('AWS::Glue::Table', 'TableInput')).toBe(true);
    // The schema fallback must keep deciding the top-level createOnly keys.
    for (const key of ['CatalogId', 'DatabaseName', 'Name']) {
      expect(rules.isClassified('AWS::Glue::Table', key)).toBe(false);
    }
    // No rule for the Connection (schema path) or the Database (no replacement).
    expect(rules.isClassified('AWS::Glue::Connection', 'ConnectionInput')).toBe(false);
    expect(rules.isClassified('AWS::Glue::Database', 'DatabaseInput')).toBe(false);
  });
});

describe('recordSetGroupRecordZoneChanged (go-to-k/cdkd#6530)', () => {
  const rs = (zone: Record<string, unknown>) => [{ Name: 'a.example.com.', Type: 'A', ...zone }];
  const noGroupZone = { oldProperties: {}, newProperties: {} };

  it.each([
    ['a record HostedZoneId changes', rs({ HostedZoneId: 'Z1' }), rs({ HostedZoneId: 'Z2' }), noGroupZone, true],
    ['a record HostedZoneName changes', rs({ HostedZoneName: 'a.com.' }), rs({ HostedZoneName: 'b.com.' }), noGroupZone, true],
    ['unchanged record zone', rs({ HostedZoneId: 'Z1' }), rs({ HostedZoneId: 'Z1' }), noGroupZone, false],
    ['group zone on the old side', rs({ HostedZoneId: 'Z1' }), rs({ HostedZoneId: 'Z2' }), { oldProperties: { HostedZoneId: 'Z1' }, newProperties: {} }, false],
    ['group zone on the new side', rs({ HostedZoneId: 'Z1' }), rs({ HostedZoneId: 'Z2' }), { oldProperties: {}, newProperties: { HostedZoneName: 'x.' } }, false],
  ])('%s', (_label, oldValue, newValue, siblings, expected) => {
    expect(recordSetGroupRecordZoneChanged(oldValue, newValue, siblings)).toBe(expected);
  });

  it('is the registry rule for AWS::Route53::RecordSetGroup RecordSets', () => {
    const rules = new ReplacementRulesRegistry();
    const siblings = { oldProperties: {}, newProperties: {} };
    expect(
      rules.requiresReplacement('AWS::Route53::RecordSetGroup', 'RecordSets', rs({ HostedZoneId: 'Z1' }), rs({ HostedZoneId: 'Z2' }), siblings)
    ).toBe(true);
    expect(
      rules.requiresReplacement('AWS::Route53::RecordSetGroup', 'RecordSets', rs({ HostedZoneId: 'Z1' }), rs({ HostedZoneId: 'Z1', TTL: 60 }), siblings)
    ).toBe(false);
  });
});

describe('route53ZoneReferenceChanged (go-to-k/cdkd#6537)', () => {
  const sib = (o: Record<string, unknown>, n: Record<string, unknown>) => ({
    oldProperties: o,
    newProperties: n,
  });

  it.each([
    ['name -> id switch', { HostedZoneName: 'a.com.' }, { HostedZoneId: 'Z1' }, false],
    ['id -> name switch', { HostedZoneId: 'Z1' }, { HostedZoneName: 'a.com.' }, false],
    ['two different ids', { HostedZoneId: 'Z1' }, { HostedZoneId: 'Z2' }, true],
    ['same id, /hostedzone/ spelling differs', { HostedZoneId: '/hostedzone/Z1' }, { HostedZoneId: 'Z1' }, false],
    ['two different names', { HostedZoneName: 'a.com.' }, { HostedZoneName: 'b.com.' }, true],
    ['same name', { HostedZoneName: 'a.com.' }, { HostedZoneName: 'a.com.' }, false],
    ['a non-string (intrinsic object) id', { HostedZoneId: 'Z1' }, { HostedZoneId: { Ref: 'X' } }, true],
    ['a non-string (intrinsic object) name on the other side', { HostedZoneName: { Ref: 'X' } }, { HostedZoneId: 'Z1' }, true],
  ])('%s', (_label, o, n, expected) => {
    expect(route53ZoneReferenceChanged(undefined, undefined, sib(o, n))).toBe(expected);
  });

  it('replaces when there are no siblings to read', () => {
    expect(route53ZoneReferenceChanged('Z1', 'Z1')).toBe(true);
  });

  describe.each(['AWS::Route53::RecordSet', 'AWS::Route53::RecordSetGroup'])('registry: %s', (type) => {
    const rules = new ReplacementRulesRegistry();
    const check = (key: 'HostedZoneId' | 'HostedZoneName', o: Record<string, unknown>, n: Record<string, unknown>) =>
      rules.requiresReplacement(type, key, o[key], n[key], sib(o, n));

    it('a name -> id switch does not replace, on either key', () => {
      const o = { HostedZoneName: 'a.com.' };
      const n = { HostedZoneId: 'Z1' };
      expect(check('HostedZoneName', o, n)).toBe(false);
      expect(check('HostedZoneId', o, n)).toBe(false);
    });

    it('an id -> name switch does not replace, on either key', () => {
      const o = { HostedZoneId: 'Z1' };
      const n = { HostedZoneName: 'a.com.' };
      expect(check('HostedZoneName', o, n)).toBe(false);
      expect(check('HostedZoneId', o, n)).toBe(false);
    });

    it('a different id replaces', () => {
      expect(check('HostedZoneId', { HostedZoneId: 'Z1' }, { HostedZoneId: 'Z2' })).toBe(true);
    });

    it('a different name replaces', () => {
      expect(check('HostedZoneName', { HostedZoneName: 'a.com.' }, { HostedZoneName: 'b.com.' })).toBe(true);
    });
  });
});

describe('Route 53 zone switch through the diff (go-to-k/cdkd#6537)', () => {
  beforeEach(() => {
    mockGetCreateOnly.mockReset();
    mockGetCreateOnly.mockImplementation(async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? []);
  });

  const diffOf = async (
    type: string,
    recorded: Record<string, unknown>,
    desired: Record<string, unknown>
  ) => {
    const state: StackState = {
      version: 1,
      stackName: 'S',
      resources: { R: { physicalId: 'p', resourceType: type, properties: recorded, attributes: {} } },
      outputs: {},
      lastModified: 0,
    };
    const template: CloudFormationTemplate = { Resources: { R: { Type: type, Properties: desired } } };
    return (await new DiffCalculator().calculateDiff(state, template)).get('R');
  };
  const replaces = (change: Awaited<ReturnType<typeof diffOf>>) =>
    change?.propertyChanges?.some((c) => c.requiresReplacement) ?? false;

  const record = (zone: Record<string, unknown>) => ({
    ...zone,
    Name: 'a.example.com.',
    Type: 'A',
    TTL: '300',
    ResourceRecords: ['192.0.2.1'],
  });
  const group = (zone: Record<string, unknown>) => ({
    ...zone,
    RecordSets: [{ Name: 'a.example.com.', Type: 'A', TTL: '300', ResourceRecords: ['192.0.2.1'] }],
  });

  it('the RecordSet type carries a create-only schema path for the zone (the fallback is real)', () => {
    const paths = CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::Route53::RecordSet') ?? [];
    expect(paths.some((p) => p[0] === 'HostedZoneId' || p[0] === 'HostedZoneName')).toBe(true);
  });

  it.each([
    ['AWS::Route53::RecordSet', record],
    ['AWS::Route53::RecordSetGroup', group],
  ])('%s: name -> id and id -> name are in-place UPDATEs', async (type, mk) => {
    const a = await diffOf(type, mk({ HostedZoneName: 'example.com.' }), mk({ HostedZoneId: 'Z1' }));
    expect(a?.changeType).toBe('UPDATE');
    expect(replaces(a)).toBe(false);
    const b = await diffOf(type, mk({ HostedZoneId: 'Z1' }), mk({ HostedZoneName: 'example.com.' }));
    expect(b?.changeType).toBe('UPDATE');
    expect(replaces(b)).toBe(false);
  });

  it.each([
    ['AWS::Route53::RecordSet', record],
    ['AWS::Route53::RecordSetGroup', group],
  ])('%s: a different id, or a different name, still replaces', async (type, mk) => {
    expect(replaces(await diffOf(type, mk({ HostedZoneId: 'Z1' }), mk({ HostedZoneId: 'Z2' })))).toBe(true);
    expect(
      replaces(await diffOf(type, mk({ HostedZoneName: 'a.com.' }), mk({ HostedZoneName: 'b.com.' })))
    ).toBe(true);
  });
});

describe('Glue nested-name rename through the diff (issue #3750)', () => {
  beforeEach(() => {
    mockGetCreateOnly.mockReset();
    mockGetCreateOnly.mockImplementation(async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? []);
  });

  const diffOf = async (
    type: string,
    recorded: Record<string, unknown>,
    desired: Record<string, unknown>
  ) => {
    const state: StackState = {
      version: 1,
      stackName: 'S',
      resources: { R: { physicalId: 'p', resourceType: type, properties: recorded, attributes: {} } },
      outputs: {},
      lastModified: 0,
    };
    const template: CloudFormationTemplate = { Resources: { R: { Type: type, Properties: desired } } };
    return (await new DiffCalculator().calculateDiff(state, template)).get('R');
  };
  const replaces = (change: Awaited<ReturnType<typeof diffOf>>) =>
    change?.propertyChanges?.some((c) => c.requiresReplacement) ?? false;

  const table = (name: string, extra: Record<string, unknown> = {}) => ({
    CatalogId: '111111111111',
    DatabaseName: 'db',
    TableInput: { Name: name, TableType: 'EXTERNAL_TABLE', ...extra },
  });
  const conn = (name: string, extra: Record<string, unknown> = {}) => ({
    CatalogId: '111111111111',
    ConnectionInput: { Name: name, ConnectionType: 'JDBC', ...extra },
  });
  const db = (name: string, extra: Record<string, unknown> = {}) => ({
    CatalogId: '111111111111',
    DatabaseInput: { Name: name, ...extra },
  });

  it('the committed schema snapshot carries the Connection nested-name createOnly path', () => {
    expect(CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::Glue::Connection')).toContainEqual([
      'ConnectionInput',
      'Name',
    ]);
  });

  it('a Table TableInput.Name rename is a replacement', async () => {
    expect(replaces(await diffOf('AWS::Glue::Table', table('a'), table('b')))).toBe(true);
  });

  it('a Table case-only rename, and any other TableInput edit, stay in place', async () => {
    const caseOnly = await diffOf('AWS::Glue::Table', table('orders'), table('ORDERS'));
    expect(caseOnly?.changeType).toBe('UPDATE');
    expect(replaces(caseOnly)).toBe(false);
    const other = await diffOf('AWS::Glue::Table', table('a'), table('a', { Description: 'new' }));
    expect(other?.changeType).toBe('UPDATE');
    expect(replaces(other)).toBe(false);
  });

  it('a Table CatalogId change is still decided by the schema fallback', async () => {
    const change = await diffOf('AWS::Glue::Table', table('a'), {
      ...table('a'),
      CatalogId: '222222222222',
    });
    expect(replaces(change)).toBe(true);
  });

  it('a Connection ConnectionInput.Name rename is a replacement', async () => {
    expect(replaces(await diffOf('AWS::Glue::Connection', conn('a'), conn('b')))).toBe(true);
  });

  it('a Connection case-only rename IS a replacement (connection names are not folded)', async () => {
    expect(replaces(await diffOf('AWS::Glue::Connection', conn('a'), conn('A')))).toBe(true);
  });

  it('an unrelated ConnectionInput change does NOT replace the Connection', async () => {
    const change = await diffOf(
      'AWS::Glue::Connection',
      conn('a'),
      conn('a', { ConnectionProperties: { JDBC_CONNECTION_URL: 'jdbc:x' } })
    );
    expect(change?.changeType).toBe('UPDATE');
    expect(replaces(change)).toBe(false);
  });

  it('a Database DatabaseInput.Name rename stays an UPDATE (the provider refuses it)', async () => {
    const change = await diffOf('AWS::Glue::Database', db('a'), db('b'));
    expect(change?.changeType).toBe('UPDATE');
    expect(replaces(change)).toBe(false);
  });
});
