/**
 * State schema v12 (go-to-k/cdkd#4852), the nested-stack carriers of
 * reference provenance through the real `NestedStackProvider`:
 *
 * - the row's `Outputs.<Key>` token takes the child's own
 *   `outputReferenceProvenance` for that output, into the row's bag on the
 *   `read` route, so the parent persists it beside the attribute;
 * - the child engine is handed a SNAPSHOT of the row's provenance
 *   (`inheritedReferenceProvenance`), always set so a grandchild never
 *   inherits its grandparent's.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import type { StackState } from '../../../src/types/state.js';
import { withCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import {
  passProvenanceFor,
  recordReferenceResolution,
} from '../../../src/deployment/secret-redaction/reference-provenance.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation(() => ({
    deploy: vi.fn(async (stackName: string) => ({
      stackName,
      created: 1,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      durationMs: 1,
      outputs: {},
    })),
  })),
  DEFAULT_RESOURCE_WARN_AFTER_MS: 5 * 60 * 1000,
  DEFAULT_RESOURCE_TIMEOUT_MS: 30 * 60 * 1000,
}));
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: vi.fn(),
}));

const REGION = 'us-east-1';
const NAME = 'topic-4849-nested-name';
const TOPIC_ARN = `arn:aws:sns:us-east-1:123456789012:${NAME}`;

function childState(outputs: unknown, opts: { omitOutputs?: boolean } = {}): StackState {
  const state: StackState = {
    version: 9,
    stackName: 'Parent~Child',
    region: REGION,
    resources: {
      Foo: { physicalId: TOPIC_ARN, resourceType: 'AWS::SNS::Topic', properties: {} },
      Other: { physicalId: 'other-id', resourceType: 'AWS::SQS::Queue', properties: {} },
    },
    outputs: outputs as StackState['outputs'],
    lastModified: 1,
  };
  if (opts.omitOutputs) delete (state as Partial<StackState>).outputs;
  return state;
}

function templatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-v12-nested-'));
  const file = join(dir, 'child.nested.template.json');
  writeFileSync(
    file,
    JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: { Foo: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b1' } } },
    })
  );
  return file;
}

function makeContext(
  state: StackState,
  extra: Partial<NestedStackProviderContext> = {}
): NestedStackProviderContext {
  return {
    stateBackend: {
      getState: vi.fn(async () => ({ state, etag: 'e' })),
    } as unknown as NestedStackProviderContext['stateBackend'],
    lockManager: {} as NestedStackProviderContext['lockManager'],
    providerRegistry: {} as NestedStackProviderContext['providerRegistry'],
    parentStackName: 'Parent',
    parentRegion: REGION,
    accountId: '123456789012',
    awsClients: {} as NestedStackProviderContext['awsClients'],
    stateBucket: 'cdkd-state-test',
    dagBuilder: {} as NestedStackProviderContext['dagBuilder'],
    diffCalculator: {} as NestedStackProviderContext['diffCalculator'],
    options: { concurrency: 1 },
    nestedTemplates: { Child: templatePath() },
    ...extra,
  };
}

const create = async (
  state: StackState,
  bag: RecordedSecretValues | undefined
): Promise<{ attributes: Record<string, unknown> }> => {
  const provider = new NestedStackProvider();
  const run = () =>
    provider.create('Child', 'AWS::CloudFormation::Stack', {
      TemplateURL: 'https://example.com/child.json',
    });
  return (await withNestedStackContext(makeContext(state), () =>
    bag === undefined ? run() : withCurrentResourceSecrets(bag, run)
  )) as { attributes: Record<string, unknown> };
};

const TOKEN = '{{resolve:secretsmanager:app:SecretString:name::}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';

describe('NestedStackProvider carries reference provenance (state schema v12, go-to-k/cdkd#4852)', () => {
  beforeEach(() => vi.clearAllMocks());

  it("the row's Outputs.<Key> token takes the child's output provenance, on the read route", async () => {
    const bag: RecordedSecretValues = new Map();
    const child = childState({ ArnOut: `arn:aws:sqs:us-east-1:1:${TOKEN}`, Plain: 'x' });
    child.outputReferenceProvenance = {
      ArnOut: { [TOKEN]: { region: 'us-west-2', versions: [V1] } },
    };
    const { attributes } = await create(child, bag);
    expect(attributes['Outputs.ArnOut']).toBe(`arn:aws:sqs:us-east-1:1:${TOKEN}`);
    expect(passProvenanceFor(bag, TOKEN)).toEqual({
      region: 'us-west-2',
      versions: [V1],
      readVersions: [V1],
    });
  });

  it("a child with no output provenance (written before v12) adds nothing to the row's bag", async () => {
    const bag: RecordedSecretValues = new Map();
    await create(childState({ ArnOut: `arn:${TOKEN}` }), bag);
    expect(passProvenanceFor(bag, TOKEN)).toBeUndefined();
  });

  it("a malformed child entry is read as absent, never carried", async () => {
    const bag: RecordedSecretValues = new Map();
    const child = childState({ ArnOut: `arn:${TOKEN}` });
    (child as { outputReferenceProvenance: unknown }).outputReferenceProvenance = {
      ArnOut: { [TOKEN]: { versions: [V1], readVersions: ['not-a-member'] } },
    };
    await create(child, bag);
    expect(passProvenanceFor(bag, TOKEN)).toBeUndefined();
  });

  it('the child engine is handed a frozen snapshot of the row provenance, and always the option', async () => {
    const bag: RecordedSecretValues = new Map();
    recordReferenceResolution(bag, TOKEN, { region: 'us-east-1', version: V1, route: 'literal' });
    await create(childState({}), bag);
    const options = vi.mocked(DeployEngine).mock.calls.at(-1)?.[5] as {
      inheritedReferenceProvenance?: ReadonlyMap<string, unknown>;
    };
    expect(Object.hasOwn(options, 'inheritedReferenceProvenance')).toBe(true);
    expect(options.inheritedReferenceProvenance?.get(TOKEN)).toEqual({
      region: 'us-east-1',
      versions: [V1],
    });
    await create(childState({}), new Map());
    const second = vi.mocked(DeployEngine).mock.calls.at(-1)?.[5] as Record<string, unknown>;
    expect(Object.hasOwn(second, 'inheritedReferenceProvenance')).toBe(true);
    expect(second['inheritedReferenceProvenance']).toBeUndefined();
  });
});
