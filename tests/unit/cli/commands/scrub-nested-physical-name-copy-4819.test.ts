/**
 * `cdkd scrub` of a nested child keeps a parent-passed physical id as the id
 * is, as the deploy does (issue
 * [#4819](https://github.com/go-to-k/cdkd/issues/4819)): the parent row passed
 * only `Ref Queue`, so its bag holds the URL as a copy and no secret, and the
 * child's queue policy spells the queue name's secret reference itself.
 * Without the copy, scrub rewrote the policy's `Queues` URL into
 * `https://sqs.../{{resolve:...}}`, which the next destroy sent to AWS.
 *
 * Drives `scrubStack`'s nested-child entry and the REAL resolver. The control
 * (a parent row that read no physical id) still rewrites the URL.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import {
  recordPhysicalNameCopy,
  type RecordedSecretValues,
} from '../../../../src/deployment/secret-redaction.js';

const NAME = 'sdin-q-1';
const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${NAME}`;

vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    secretsManager: {
      send: vi.fn(async () => ({ SecretString: JSON.stringify({ queue: NAME }) })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return { SecretString: JSON.stringify({ queue: NAME }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const LITERAL_ARN = `arn:aws:sqs:us-east-1:123456789012:${REF}`;

async function scrubChild(parent: RecordedSecretValues): Promise<StackState> {
  const template = {
    Parameters: { QueueUrl: { Type: 'String' } },
    Resources: {
      Policy: {
        Type: 'AWS::SQS::QueuePolicy',
        Properties: {
          Queues: [{ Ref: 'QueueUrl' }],
          PolicyDocument: { Statement: [{ Resource: LITERAL_ARN }] },
        },
      },
    },
    Outputs: {},
  } as unknown as CloudFormationTemplate;
  const state = {
    version: 11,
    region: 'us-east-1',
    stackName: 'MyStack~Child',
    resources: {
      Policy: {
        physicalId: 'policy',
        resourceType: 'AWS::SQS::QueuePolicy',
        // A save that kept the URL, and a document leaf in plaintext for
        // scrub to rewrite (so it saves).
        properties: {
          Queues: [URL],
          PolicyDocument: { Statement: [{ Resource: LITERAL_ARN.replace(REF, NAME) }] },
        },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const saveState = vi.fn().mockResolvedValue('etag-2');
  await scrubStack(
    { stackName: 'MyStack~Child', template } as never,
    'us-east-1',
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
      saveState,
      purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn().mockResolvedValue([]),
    } as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      dryRun: false,
      logger,
      nestedChild: {
        logicalId: 'Child',
        stackName: 'MyStack~Child',
        input: { parameters: { QueueUrl: URL }, inheritedSecrets: parent },
      },
    } as never
  );
  expect(saveState).toHaveBeenCalled();
  return saveState.mock.calls.at(-1)![2] as StackState;
}

describe('cdkd scrub of a nested child keeps a parent-passed physical id (#4819)', () => {
  it("keeps the URL when the parent row read it, though the row holds no secret", async () => {
    const parent: RecordedSecretValues = new Map();
    recordPhysicalNameCopy(parent, URL);
    const saved = await scrubChild(parent);
    expect(saved.resources['Policy']!.properties).toEqual({
      Queues: [URL],
      PolicyDocument: { Statement: [{ Resource: LITERAL_ARN }] },
    });
  });

  it('control: a parent row that read no physical id still has the URL rewritten', async () => {
    const saved = await scrubChild(new Map());
    expect(saved.resources['Policy']!.properties?.['Queues']).toEqual([URL.replace(NAME, REF)]);
  });
});
