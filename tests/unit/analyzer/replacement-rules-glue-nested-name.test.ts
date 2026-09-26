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
