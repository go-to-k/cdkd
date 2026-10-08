import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { clearReplicationProbeCache } from '../../../src/state/s3-replication-purge-gap.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `retire-cfn-stack.ts` slice: a handler that stringified its caught value
 * with `x instanceof Error ? x.message : String(x)` threw from inside itself
 * when the value could not be converted -- `String(Object.create(null))`
 * throws `TypeError: Cannot convert object to primitive value`.
 *
 * Every case rejects with exactly that value and asserts what the handler
 * exists to preserve (the retire still succeeds, the caught value is rethrown
 * as itself, the cleanups still travel, the lookup still falls through), plus
 * the placeholder where the handler reports the failure.
 */

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  }),
}));

const waitUpdateMock = vi.hoisted(() => vi.fn(async () => undefined));
const waitDeleteMock = vi.hoisted(() => vi.fn(async () => undefined));

type FakeCommand = { readonly _name: string; readonly input: Record<string, unknown> };

const commands = vi.hoisted(() => {
  class Fake {
    constructor(
      public readonly _name: string,
      public readonly input: Record<string, unknown>
    ) {}
  }
  const named = (name: string) =>
    class extends Fake {
      constructor(input: Record<string, unknown>) {
        super(name, input);
      }
    };
  return {
    DescribeStacksCommand: named('DescribeStacks'),
    DescribeStackResourcesCommand: named('DescribeStackResources'),
    GetTemplateCommand: named('GetTemplate'),
    UpdateStackCommand: named('UpdateStack'),
    DeleteStackCommand: named('DeleteStack'),
    PutObjectCommand: named('PutObject'),
    DeleteObjectCommand: named('DeleteObject'),
    ListObjectVersionsCommand: named('ListObjectVersions'),
    DeleteObjectsCommand: named('DeleteObjects'),
    GetBucketReplicationCommand: named('GetBucketReplication'),
  };
});

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: vi.fn(),
  DescribeStacksCommand: commands.DescribeStacksCommand,
  DescribeStackResourcesCommand: commands.DescribeStackResourcesCommand,
  GetTemplateCommand: commands.GetTemplateCommand,
  UpdateStackCommand: commands.UpdateStackCommand,
  DeleteStackCommand: commands.DeleteStackCommand,
  waitUntilStackUpdateComplete: waitUpdateMock,
  waitUntilStackDeleteComplete: waitDeleteMock,
}));

const s3SendMock = vi.hoisted(() => vi.fn(async (_cmd: FakeCommand): Promise<unknown> => ({})));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: s3SendMock, destroy: vi.fn() })),
  PutObjectCommand: commands.PutObjectCommand,
  DeleteObjectCommand: commands.DeleteObjectCommand,
  ListObjectVersionsCommand: commands.ListObjectVersionsCommand,
  DeleteObjectsCommand: commands.DeleteObjectsCommand,
  GetBucketReplicationCommand: commands.GetBucketReplicationCommand,
}));

vi.mock('../../../src/utils/aws-region-resolver.js', () => ({
  resolveBucketRegion: vi.fn(async () => 'eu-west-1'),
}));

import {
  retireCloudFormationStack,
  injectRetainPoliciesRecursive,
  tryGetCloudFormationResourceMap,
  RecursiveRetainInjectionError,
  type CfnStackResourceTree,
} from '../../../src/cli/commands/retire-cfn-stack.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

function cfnClient(responses: Record<string, unknown | (() => unknown)>): {
  send: ReturnType<typeof vi.fn>;
} {
  return {
    send: vi.fn(async (cmd: FakeCommand) => {
      const r = responses[cmd._name];
      if (typeof r === 'function') return (r as () => unknown)();
      if (r === undefined) throw new Error(`Unexpected CFn command: ${cmd._name}`);
      return r;
    }),
  };
}

/** Over the 51,200-byte inline limit, so the retire uploads it and must drain the upload. */
const BIG_TEMPLATE = JSON.stringify({
  Resources: Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [
      `R${i}`,
      { Type: 'AWS::S3::Bucket', Properties: { Tag: 'x'.repeat(400) } },
    ])
  ),
});

const SMALL_TEMPLATE = JSON.stringify({
  Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
});

beforeEach(() => {
  vi.clearAllMocks();
  clearReplicationProbeCache();
  s3SendMock.mockImplementation(async () => ({}));
});

describe('retire-cfn-stack (#3361)', () => {
  it('a transient-upload DELETE rejecting with an unconvertible value still retires the stack, and warns', async () => {
    // `drainTemplateUploads` turns a failed cleanup into a warn so a leaked
    // transient object cannot turn a successful retire into a failure. Its
    // `String(cleanupErr)` threw instead, out of the post-UpdateStack
    // `finally`, and the retire rejected after CloudFormation had succeeded.
    s3SendMock.mockImplementation(async (cmd: FakeCommand) => {
      if (cmd._name === 'DeleteObject') throw unconvertible();
      return {};
    });
    const client = cfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: BIG_TEMPLATE },
      UpdateStack: { StackId: 'arn:stack' },
      DeleteStack: {},
    });

    const result = await retireCloudFormationStack({
      cfnStackName: 'BigStack',
      cfnClient: client as never,
      yes: true,
      stateBucket: 'state-bucket',
    });

    expect(result.outcome).toBe('retired');
    expect(waitDeleteMock).toHaveBeenCalledTimes(1);
    const drainWarn = warnings().filter((w) => w.includes('Failed to delete'));
    expect(drainWarn).toHaveLength(1);
    expect(drainWarn[0]).toContain(PLACEHOLDER);
  });

  it('an UpdateStack rejecting with an unconvertible value is rethrown as itself, not as a TypeError', async () => {
    // The catch reads the message only to recognise CloudFormation's "No
    // updates are to be performed" and rethrows everything else. Its
    // `String(err)` threw first, so the caller received the converter's
    // TypeError in place of what UpdateStack rejected with.
    const rejection = unconvertible();
    const client = cfnClient({
      DescribeStacks: { Stacks: [{ StackStatus: 'CREATE_COMPLETE', Capabilities: [] }] },
      GetTemplate: { TemplateBody: SMALL_TEMPLATE },
      UpdateStack: () => {
        throw rejection;
      },
      DeleteStack: {},
    });

    await expect(
      retireCloudFormationStack({
        cfnStackName: 'S',
        cfnClient: client as never,
        yes: true,
        stateBucket: 'state-bucket',
      })
    ).rejects.toBe(rejection);
    expect(client.send.mock.calls.map((c) => (c[0] as FakeCommand)._name)).not.toContain(
      'DeleteStack'
    );
  });

  it('a mid-walk rejection with an unconvertible value still throws RecursiveRetainInjectionError carrying the cleanups', async () => {
    // The wrapper exists to carry the uploads made before the failure out to
    // the caller's drain. Building its message with `String(err)` threw
    // first, so the TypeError escaped WITHOUT the cleanups and the uploaded
    // child template was never deleted.
    const child1Arn = 'arn:aws:cloudformation:us-east-1:111111111111:stack/C1/u1';
    const child2Arn = 'arn:aws:cloudformation:us-east-1:111111111111:stack/C2/u2';
    const parentBody = JSON.stringify({
      Resources: {
        C1: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
        C2: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'y' } },
      },
    });
    const leaf = (arn: string): CfnStackResourceTree => ({
      stackName: arn,
      physicalId: arn,
      resources: new Map(),
      nested: new Map(),
    });
    const tree: CfnStackResourceTree = {
      stackName: 'P',
      physicalId: 'P',
      resources: new Map([
        ['C1', child1Arn],
        ['C2', child2Arn],
      ]),
      nested: new Map([
        ['C1', leaf(child1Arn)],
        ['C2', leaf(child2Arn)],
      ]),
    };
    let getTemplateCalls = 0;
    const send = vi.fn(async (cmd: FakeCommand) => {
      if (cmd._name !== 'GetTemplate') throw new Error(`unexpected ${cmd._name}`);
      getTemplateCalls++;
      if (getTemplateCalls === 1) return { TemplateBody: SMALL_TEMPLATE };
      throw unconvertible();
    });

    let thrown: unknown;
    try {
      await injectRetainPoliciesRecursive(parentBody, 'P', tree, {
        cfnClient: { send } as never,
        stateBucket: 'state-bucket',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RecursiveRetainInjectionError);
    const err = thrown as RecursiveRetainInjectionError;
    // C1's upload, made before C2 failed -- exactly one.
    expect(err.cleanups).toHaveLength(1);
    expect(err.message).toBe(PLACEHOLDER);
  });

  it('a DescribeStackResources rejecting with an unconvertible value still falls through to null, and warns', async () => {
    // "NO failure is fatal": the lookup is an optimisation and degrades to
    // the per-provider lookups. Its `String(err)` threw instead, aborting the
    // import it was meant to speed up.
    const client = { send: vi.fn(() => Promise.reject(unconvertible())) };

    await expect(tryGetCloudFormationResourceMap('MyStack', client as never)).resolves.toBeNull();

    const lookupWarn = warnings().filter((w) => w.includes('to resolve physical IDs'));
    expect(lookupWarn).toHaveLength(1);
    expect(lookupWarn[0]).toContain(PLACEHOLDER);
  });
});
