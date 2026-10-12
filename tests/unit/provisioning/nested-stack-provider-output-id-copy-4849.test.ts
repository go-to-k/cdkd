/**
 * go-to-k/cdkd#4849, the nested-stack carry: a child output holding a child
 * resource's physical id (an ARN exported up) is a copy of that id. The row's
 * bag records it as one, so the parent's record keeps `Outputs.<Key>` as
 * written even when the row passed the child a `NoEcho` value the id embeds,
 * and a parent `Fn::GetAtt` reader of it still resolves.
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
import {
  attributeIdCopiesOf,
  physicalNameCopiesOf,
  recordNoEchoParameterFreshValue,
  redactSecretsForState,
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-4849-nested-'));
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

describe("NestedStackProvider records a child output copying a child's id (go-to-k/cdkd#4849)", () => {
  beforeEach(() => vi.clearAllMocks());

  /** The row's bag: it passed the child the NoEcho value the topic is named from. */
  const rowBag = (): RecordedSecretValues => {
    const bag: RecordedSecretValues = new Map();
    recordNoEchoParameterFreshValue(NAME, bag);
    return bag;
  };

  it("records the copied id, so the row's record keeps the output as written", async () => {
    const bag = rowBag();
    const { attributes } = await create(
      childState({ TopicArnOut: TOPIC_ARN, NameOut: '***', Plain: 'plain-value' }),
      bag
    );
    expect(attributes['Outputs.TopicArnOut']).toBe(TOPIC_ARN);
    expect([...(attributeIdCopiesOf.get(bag) ?? [])]).toEqual([TOPIC_ARN]);
    // What the parent's persist then stores for the row.
    const saved = scrubResourceRecord(
      { physicalId: 'arn:aws:cloudformation:stack/child', properties: {}, attributes },
      bag
    );
    expect(saved.attributes?.['Outputs.TopicArnOut']).toBe(TOPIC_ARN);
  });

  it('negative control: an output that only embeds the value, copying no child id, stays masked', async () => {
    const bag = rowBag();
    const { attributes } = await create(childState({ Note: `note-${NAME}` }), bag);
    expect(attributeIdCopiesOf.get(bag)).toBeUndefined();
    expect(redactSecretsForState(attributes, bag)['Outputs.Note']).toBe('***');
  });

  it("scopes the copy to the row's attributes: its Parameters keep their reference form", async () => {
    // A row passing a SecureString-named value: the child's topic is named
    // from it, and the row's `Parameters` spell the reference.
    const ref = '{{resolve:ssm-secure:/p/name}}';
    const bag: RecordedSecretValues = new Map([[NAME, ref]]);
    const { attributes } = await create(childState({ TopicArnOut: TOPIC_ARN }), bag);
    expect(physicalNameCopiesOf.get(bag)).toBeUndefined();
    const saved = scrubResourceRecord(
      {
        physicalId: 'arn:aws:cloudformation:stack/child',
        properties: { Parameters: { TopicName: NAME } },
        attributes,
      },
      bag
    );
    expect(saved.properties['Parameters']).toEqual({ TopicName: ref });
    expect(saved.attributes?.['Outputs.TopicArnOut']).toBe(TOPIC_ARN);
  });

  it('records nothing without a bound row bag, and reads a non-object resources bag as no ids', async () => {
    const { attributes } = await create(childState({ TopicArnOut: TOPIC_ARN }), undefined);
    expect(attributes['Outputs.TopicArnOut']).toBe(TOPIC_ARN);
    const bag = rowBag();
    const torn = childState({ TopicArnOut: TOPIC_ARN });
    (torn as { resources: unknown }).resources = null;
    await create(torn, bag);
    expect(attributeIdCopiesOf.get(bag)).toBeUndefined();
  });
});
