import { describe, it, expect, vi } from 'vite-plus/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// go-to-k/cdkd#7024: a hand-listed `replacementProperties` entry wins over the
// registry schema, so an entry CloudFormation updates in place deletes a
// resource CloudFormation keeps (#7023: EC2 Instance `EbsOptimized`, listed
// "unmeasured", terminated the instance and its root volume). Every entry must
// therefore be a whole-property create-only path in the committed schema
// fixture, or appear below with the reason CloudFormation replaces too.

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

const FIXTURES = join(__dirname, '../../fixtures/cfn-schemas');

/** Measured live 2026-11-26: create-only in `DescribeType`, no committed fixture. */
const LIVE_CREATE_ONLY = 'create-only in the live registry schema; the type has no committed fixture';

/**
 * `<Type>#<Property>` -> why CloudFormation replaces it although the committed
 * fixture does not list it as a whole-property create-only path. A reason is
 * a measured CloudFormation A/B, an AWS API with no update member, or
 * CloudFormation's documented "Update requires: Replacement". "Unmeasured" is
 * not a reason.
 */
const REPLACES_BEYOND_SCHEMA: ReadonlyMap<string, string> = new Map([
  ['AWS::AppSync::GraphQLApi#ApiType', 'AWS: cannot be changed after creation; UpdateGraphqlApi has no member (#5359)'],
  ['AWS::AppSync::GraphQLApi#Visibility', 'AWS: cannot be changed after creation; UpdateGraphqlApi has no member (#5359)'],
  ['AWS::CertificateManager::Certificate#ValidationMethod', 'CloudFormation docs: Update requires: Replacement; ACM has no call that changes it (#6513)'],
  ['AWS::DynamoDB::Table#KeySchema', 'CloudFormation docs: Update requires: Replacement; UpdateTable has no KeySchema member'],
  ['AWS::Events::Rule#EventBusName', 'CloudFormation docs: Update requires: Replacement; a rule belongs to one bus'],
  ['AWS::RDS::DBProxyEndpoint#TargetRole', 'ModifyDBProxyEndpoint accepts only the name and VpcSecurityGroupIds'],
  ['AWS::EC2::Volume#AvailabilityZone', 'ModifyVolume cannot change it; the schema lists no create-only property (#1356)'],
  ['AWS::EC2::Volume#AvailabilityZoneId', 'ModifyVolume cannot change it; the schema lists no create-only property (#1356)'],
  ['AWS::EC2::Volume#Encrypted', 'ModifyVolume cannot change it; the schema lists no create-only property (#1356)'],
  ['AWS::EC2::Volume#KmsKeyId', 'ModifyVolume cannot change it; the schema lists no create-only property (#1356)'],
  ['AWS::EC2::Volume#OutpostArn', 'ModifyVolume cannot change it; the schema lists no create-only property (#1356)'],
  ['AWS::EC2::Volume#SnapshotId', 'ModifyVolume cannot change it; the schema lists no create-only property (#1356)'],
  ['AWS::ElasticLoadBalancingV2::ListenerRule#ListenerArn', LIVE_CREATE_ONLY],
  ['AWS::Lambda::Version#CodeSha256', LIVE_CREATE_ONLY],
  ['AWS::Lambda::Version#Description', LIVE_CREATE_ONLY],
  ['AWS::Lambda::Version#FunctionName', LIVE_CREATE_ONLY],
  ['AWS::Lambda::Version#ProvisionedConcurrencyConfig', LIVE_CREATE_ONLY],
  ['AWS::Lambda::Version#RuntimePolicy', LIVE_CREATE_ONLY],
  ['AWS::SSM::Document#Name', LIVE_CREATE_ONLY],
  ['AWS::SSM::Document#DocumentType', LIVE_CREATE_ONLY],
]);

/** The whole-property create-only names of a type, or undefined without a fixture. */
function fixtureCreateOnly(type: string): Set<string> | undefined {
  const file = join(FIXTURES, `${type.replace(/::/g, '-')}.json`);
  if (!existsSync(file)) return undefined;
  const fixture = JSON.parse(readFileSync(file, 'utf8')) as {
    createOnlyPropertyPaths?: string[][];
  };
  return new Set(
    (fixture.createOnlyPropertyPaths ?? []).filter((p) => p.length === 1).map((p) => p[0])
  );
}

describe('hand-listed replacement properties (go-to-k/cdkd#7024)', () => {
  const registry = new ReplacementRulesRegistry();
  const entries = [...registry.rules].flatMap(([type, rule]) =>
    [...rule.replacementProperties].map((prop) => ({ type, prop }))
  );

  it('reads every rule (a floor, so an empty registry cannot pass)', () => {
    expect(registry.rules.size).toBeGreaterThanOrEqual(43);
    expect(entries.length).toBeGreaterThanOrEqual(98);
  });

  it('every entry is create-only in the committed fixture, or names why CloudFormation replaces it', () => {
    const unexplained = entries
      .filter(({ type, prop }) => !fixtureCreateOnly(type)?.has(prop))
      .map(({ type, prop }) => `${type}#${prop}`)
      .filter((key) => !REPLACES_BEYOND_SCHEMA.has(key));
    expect(unexplained).toEqual([]);
  });

  it('every allow-table row is still needed (no stale row hides a new entry)', () => {
    const listed = new Set(entries.map(({ type, prop }) => `${type}#${prop}`));
    const stale = [...REPLACES_BEYOND_SCHEMA.keys()].filter((key) => {
      if (!listed.has(key)) return true;
      const [type, prop] = key.split('#');
      return fixtureCreateOnly(type)?.has(prop) === true;
    });
    expect(stale).toEqual([]);
  });
});
