import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// go-to-k/cdkd#7070: an invariant over EVERY spec-replacement candidate with a
// measured verdict, driven through the real diff and the real create-only
// resolver. DescribeType answers each type with its committed registry
// snapshot, so the only thing that can add a replacement is the generated
// table: a `replace` row must replace (or its hand rule decides), and an
// `update` row must stay in place.

const SNAPSHOT = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/cfn-registry-create-only-paths.json'), 'utf8')
) as { types: Record<string, string[][]> };

const mockSend = vi.fn(async (command: { input?: { TypeName?: string } }) => {
  const type = command.input?.TypeName ?? '';
  const paths = SNAPSHOT.types[type] ?? [];
  return {
    Schema: JSON.stringify({ createOnlyProperties: paths.map((p) => `/properties/${p.join('/')}`) }),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ cloudFormation: { send: mockSend } }),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...quiet, child: () => quiet }) };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { REPLACEMENT_EVIDENCE } from '../../../src/analyzer/replacement-rules/evidence.js';
import { SPEC_REPLACEMENT_PATHS } from '../../../src/analyzer/replacement-rules/spec-replacement-properties.generated.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
import type { StackState } from '../../../src/types/state.js';
import {
  candidateKey,
  loadSpecReplacementCandidates,
} from '../../../scripts/spec-replacement-candidates.ts';

/** A property bag holding `leaf` at `path`. */
function bagAt(path: readonly string[], leaf: string): Record<string, unknown> {
  let value: unknown = leaf;
  for (const segment of [...path].reverse()) value = { [segment]: value };
  return value as Record<string, unknown>;
}

/** Whether changing only the value at `path` makes the diff replace the resource. */
async function replacesOnChange(type: string, path: readonly string[]): Promise<boolean> {
  const state: StackState = {
    version: 1,
    stackName: 'S',
    resources: {
      R: { physicalId: 'p', resourceType: type, properties: bagAt(path, 'old'), attributes: {} },
    },
    outputs: {},
    lastModified: 0,
  };
  const template = { Resources: { R: { Type: type, Properties: bagAt(path, 'new') } } };
  const changes = await new DiffCalculator().calculateDiff(state, template);
  const change = changes.get('R')?.propertyChanges?.find((c) => c.path === path[0]);
  expect(change, candidateKey(type, path)).toBeDefined();
  return change!.requiresReplacement;
}

describe('spec-replacement table (go-to-k/cdkd#7070)', () => {
  const registry = new ReplacementRulesRegistry();
  const { candidates } = loadSpecReplacementCandidates();
  const measured = candidates.filter((c) => {
    const verdict = REPLACEMENT_EVIDENCE.get(candidateKey(c.type, c.path))?.verdict;
    return verdict === 'replace' || verdict === 'update';
  });

  beforeEach(() => {
    clearCreateOnlyPropertiesCache();
  });

  it('the table is exactly the candidates measured as replacing', () => {
    const rows = [...SPEC_REPLACEMENT_PATHS].flatMap(([type, paths]) =>
      paths.map((p) => candidateKey(type, p))
    );
    // A hand rule decides its own candidates, so they stay out of the table
    // (readers that consult no hand rule would otherwise see them).
    const replacing = measured
      .filter((c) => REPLACEMENT_EVIDENCE.get(candidateKey(c.type, c.path))!.verdict === 'replace')
      .filter((c) => !registry.isClassified(c.type, c.path[0]!))
      .map((c) => candidateKey(c.type, c.path));
    expect(rows.sort()).toEqual(replacing.sort());
    // Floors: the #7070 and #7083 seeds, so an empty table or population cannot pass.
    expect(rows).toEqual(
      expect.arrayContaining([
        'AWS::Route53Resolver::ResolverRule#DomainName',
        'AWS::AppConfig::ConfigurationProfile#Type',
      ])
    );
    expect(measured.length).toBeGreaterThanOrEqual(90);
  });

  it('no table row is one a hand rule decides', () => {
    const handDecided = [...SPEC_REPLACEMENT_PATHS]
      .flatMap(([type, paths]) => paths.map((p) => [type, p] as const))
      .filter(([type, p]) => registry.isClassified(type, p[0]!))
      .map(([type, p]) => candidateKey(type, p));
    expect(handDecided).toEqual([]);
  });

  it('every measured candidate gets its verdict from the diff', async () => {
    const wrong: string[] = [];
    for (const c of measured) {
      const key = candidateKey(c.type, c.path);
      const top = c.path[0]!;
      const expected = registry.isClassified(c.type, top)
        ? registry.requiresReplacement(c.type, top, bagAt(c.path, 'old')[top], bagAt(c.path, 'new')[top])
        : REPLACEMENT_EVIDENCE.get(key)!.verdict === 'replace';
      if ((await replacesOnChange(c.type, c.path)) !== expected) wrong.push(key);
    }
    expect(wrong).toEqual([]);
  });

  // go-to-k/cdkd#7100: CloudFormation reshards online under UseOnlineResharding
  // (same physical id) and replaces without it, so the policy keeps the diff
  // in place, and only for the two shard properties.
  it('UseOnlineResharding keeps a shard change in place, and nothing else', async () => {
    const TYPE = 'AWS::ElastiCache::ReplicationGroup';
    const diff = async (
      updatePolicy: Record<string, unknown> | undefined,
      prop: string,
      from: unknown,
      to: unknown
    ) => {
      const state: StackState = {
        version: 1,
        stackName: 'S',
        resources: {
          R: { physicalId: 'p', resourceType: TYPE, properties: { [prop]: from }, attributes: {} },
        },
        outputs: {},
        lastModified: 0,
      };
      const template = {
        Resources: {
          R: {
            Type: TYPE,
            ...(updatePolicy === undefined ? {} : { UpdatePolicy: updatePolicy }),
            Properties: { [prop]: to },
          },
        },
      };
      const changes = await new DiffCalculator().calculateDiff(state, template);
      return changes.get('R')!.propertyChanges!.find((c) => c.path === prop)!.requiresReplacement;
    };
    const ngc = (n: number) => [{ NodeGroupId: '0001', ReplicaCount: n }];
    expect(await diff(undefined, 'NumNodeGroups', 1, 2)).toBe(true);
    expect(await diff({ UseOnlineResharding: false }, 'NumNodeGroups', 1, 2)).toBe(true);
    expect(await diff({ UseOnlineResharding: true }, 'NumNodeGroups', 1, 2)).toBe(false);
    expect(await diff({ UseOnlineResharding: 'true' }, 'NumNodeGroups', 1, 2)).toBe(false);
    expect(await diff(undefined, 'NodeGroupConfiguration', ngc(1), ngc(2))).toBe(true);
    expect(await diff({ UseOnlineResharding: true }, 'NodeGroupConfiguration', ngc(1), ngc(2))).toBe(false);
    // A schema create-only property still replaces under the policy.
    expect(await diff({ UseOnlineResharding: true }, 'Port', 6379, 6380)).toBe(true);
  });

  // go-to-k/cdkd#7126: CloudFormation replaces a SageMaker domain on a VpcId
  // change (measured), while a subnet or network-access change in the same VPC
  // applied in place.
  it('a SageMaker domain replaces on VpcId only', async () => {
    const TYPE = 'AWS::SageMaker::Domain';
    expect(await replacesOnChange(TYPE, ['VpcId'])).toBe(true);
    expect(await replacesOnChange(TYPE, ['SubnetIds'])).toBe(false);
    expect(await replacesOnChange(TYPE, ['AppNetworkAccessType'])).toBe(false);
  });

  // go-to-k/cdkd#7130: CloudFormation replaces an Elasticsearch domain on a
  // version change without EnableVersionUpgrade and upgrades it in place under
  // the policy; a KmsKeyId change replaces whatever the policy says.
  it('EnableVersionUpgrade keeps an Elasticsearch version change in place, and nothing else', async () => {
    const TYPE = 'AWS::Elasticsearch::Domain';
    const diff = async (
      updatePolicy: Record<string, unknown> | undefined,
      from: Record<string, unknown>,
      to: Record<string, unknown>,
      prop: string
    ) => {
      const state: StackState = {
        version: 1,
        stackName: 'S',
        resources: { R: { physicalId: 'p', resourceType: TYPE, properties: from, attributes: {} } },
        outputs: {},
        lastModified: 0,
      };
      const template = {
        Resources: {
          R: {
            Type: TYPE,
            ...(updatePolicy === undefined ? {} : { UpdatePolicy: updatePolicy }),
            Properties: to,
          },
        },
      };
      const changes = await new DiffCalculator().calculateDiff(state, template);
      return changes.get('R')!.propertyChanges!.find((c) => c.path === prop)!.requiresReplacement;
    };
    const v = (version: string) => ({ ElasticsearchVersion: version });
    const V = 'ElasticsearchVersion';
    expect(await diff(undefined, v('7.9'), v('7.10'), V)).toBe(true);
    expect(await diff({ EnableVersionUpgrade: false }, v('7.9'), v('7.10'), V)).toBe(true);
    expect(await diff({ EnableVersionUpgrade: { 'Fn::If': ['C', true, false] } }, v('7.9'), v('7.10'), V)).toBe(true);
    expect(await diff({ EnableVersionUpgrade: true }, v('7.9'), v('7.10'), V)).toBe(false);
    expect(await diff({ EnableVersionUpgrade: 'true' }, v('7.9'), v('7.10'), V)).toBe(false);
    // The AWS-managed key (no KmsKeyId) -> a customer key, as measured, and
    // one customer key -> another; the policy does not cover either.
    const enc = (kms?: string) => ({
      EncryptionAtRestOptions: { Enabled: true, ...(kms === undefined ? {} : { KmsKeyId: kms }) },
    });
    const E = 'EncryptionAtRestOptions';
    expect(await diff(undefined, enc(), enc('k1'), E)).toBe(true);
    expect(await diff(undefined, enc('k1'), enc('k2'), E)).toBe(true);
    expect(await diff({ EnableVersionUpgrade: true }, enc('k1'), enc('k2'), E)).toBe(true);
    // Enabled alone applies in place (measured on #7083).
    expect(
      await diff(undefined, { [E]: { Enabled: false } }, { [E]: { Enabled: true } }, E)
    ).toBe(false);
  });

  // go-to-k/cdkd#7083: FSx file systems have no Cloud Control handlers; each
  // member below was measured with a CloudFormation A/B chain (new file system
  // id), while PerUnitStorageThroughput applied in place.
  it('an FSx file system replaces on the members CloudFormation replaces on', async () => {
    const TYPE = 'AWS::FSx::FileSystem';
    for (const path of [
      ['LustreConfiguration', 'CopyTagsToBackups'],
      ['LustreConfiguration', 'ImportedFileChunkSize'],
      ['OpenZFSConfiguration', 'RootVolumeConfiguration', 'RecordSizeKiB'],
      ['OntapConfiguration', 'EndpointIpAddressRange'],
      ['WindowsConfiguration', 'DeploymentType'],
      ['WindowsConfiguration', 'SelfManagedActiveDirectoryConfiguration', 'DomainName'],
    ]) {
      expect(await replacesOnChange(TYPE, path), path.join('.')).toBe(true);
    }
    expect(await replacesOnChange(TYPE, ['LustreConfiguration', 'PerUnitStorageThroughput'])).toBe(
      false
    );
  });

  // go-to-k/cdkd#7083 slice 5: CloudFormation A/B chains. An EKS compute
  // environment's EksConfiguration replaced it (a new ARN); the EMR Serverless
  // image and KafkaConnect connector members applied in place.
  it('a Batch EKS compute environment replaces on EksConfiguration, the in-place rows stay', async () => {
    expect(await replacesOnChange('AWS::Batch::ComputeEnvironment', ['EksConfiguration'])).toBe(
      true
    );
    for (const [type, path] of [
      ['AWS::EMRServerless::Application', ['ImageConfiguration', 'ImageUri']],
      ['AWS::EMRServerless::Application', ['WorkerTypeSpecifications']],
      ['AWS::KafkaConnect::Connector', ['ConnectorConfiguration']],
      ['AWS::KafkaConnect::Connector', ['Plugins']],
      ['AWS::KafkaConnect::Connector', ['WorkerConfiguration']],
    ] as const) {
      expect(await replacesOnChange(type, [...path]), `${type}#${path.join('.')}`).toBe(false);
    }
  });

  // The rename CloudFormation fails rather than replaces stays the provider's
  // refusal (#3750), not a replacement of a stateful database.
  it('a nested measured update stays in place', async () => {
    expect(await replacesOnChange('AWS::Glue::Database', ['DatabaseInput', 'Name'])).toBe(false);
  });
});
