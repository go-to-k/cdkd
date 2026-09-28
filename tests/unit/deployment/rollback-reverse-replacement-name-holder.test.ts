import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue #3979: the rollback's reverse-replacement arm deletes the NEW resource
 * first when re-creating the old one collides — which frees the name only when
 * the new resource HOLDS it. A collision with anything else (an orphan an
 * earlier failed create left behind, an SDK-level replay, an out-of-band
 * resource) used to delete a live resource that never held the name, after
 * which the re-create collided again.
 *
 * Driven through the REAL `replayRollback` and the REAL providers; only the
 * SDK clients' `send` is stubbed. The genuine case (Route 53's TypeSwapRecord,
 * the route53 integ's Phase 2.7c) is the negative control: there the new
 * record holds the DNS name, and delete-new-first must still run.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { getLogger: () => logger };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const route53Send = vi.fn();
vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({
      send: route53Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

import { KinesisClient } from '@aws-sdk/client-kinesis';

import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function ctxFor(provider: ResourceProvider): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
}

function res(resourceType: string, overrides: Partial<ResourceState>): ResourceState {
  return {
    physicalId: 'phys',
    resourceType,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function failureLines(): string[] {
  return vi
    .mocked(silentLogger.warn)
    .mock.calls.map((c) => String(c[0]))
    .filter((l) => l.includes('Rollback failed for'));
}

beforeEach(() => {
  vi.clearAllMocks();
  route53Send.mockReset();
  vi.stubEnv('AWS_REGION', 'us-east-1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ─── Kinesis: the #3972 orphan on a re-run of `cdkd rollback` ─────────────

const KINESIS = 'AWS::Kinesis::Stream';
const OLD_STREAM = { Name: 'stream', ShardCount: 1 };
/** Kinesis's own wording for a stream name that is taken. */
const KINESIS_COLLISION = 'Stream stream under account 123456789012 already exists.';

/** `outcomes[i]` is what the i-th `CreateStream` does. Returns the command log. */
function stubKinesis(outcomes: Array<'ok' | 'collide'>): string[] {
  const sent: string[] = [];
  let creates = 0;
  vi.spyOn(
    KinesisClient.prototype as unknown as { send: (c: unknown) => Promise<unknown> },
    'send'
  ).mockImplementation(async (command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    sent.push(name);
    if (name === 'CreateStreamCommand') {
      if ((outcomes[creates++] ?? 'collide') === 'collide') {
        throw awsSdkError(KINESIS_COLLISION, 'ResourceInUseException');
      }
      return {};
    }
    if (name === 'DescribeStreamCommand') {
      return {
        StreamDescription: {
          StreamStatus: 'ACTIVE',
          StreamARN: 'arn:aws:kinesis:us-east-1:123456789012:stream/stream',
        },
      };
    }
    return {};
  });
  return sent;
}

describe('a collision with a resource the new one does not hold refuses delete-new-first (#3979)', () => {
  it('Kinesis: an orphan holding the old name does not cost the live new stream', async () => {
    // The issue's shape: the deploy renamed the stream (stream -> stream-new);
    // an earlier rollback attempt left a `stream` orphan (#1710), so re-running
    // `cdkd rollback` collides on its FIRST create, unmarked. The live
    // `stream-new` never held `stream`. The second outcome is what a pre-fix
    // run's re-create after its delete meets, so that arm completes.
    const sent = stubKinesis(['collide', 'ok']);
    const provider = new KinesisStreamProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    const op: CompletedOperation = {
      logicalId: 'Stream',
      changeType: 'UPDATE',
      resourceType: KINESIS,
      physicalId: 'stream-new',
      previousState: res(KINESIS, { physicalId: 'stream', properties: { ...OLD_STREAM } }),
    };
    const state: Record<string, ResourceState> = {
      Stream: res(KINESIS, {
        physicalId: 'stream-new',
        properties: { ...OLD_STREAM, Name: 'stream-new' },
      }),
    };

    const result = await replayRollback([op], state, 'CdkdX', ctxFor(provider));

    // THE DISCRIMINATOR, first: before #3979 the collision arm deleted it.
    expect(del).not.toHaveBeenCalled();
    expect(sent.filter((c) => c === 'CreateStreamCommand')).toHaveLength(1);
    expect(result.failures).toBe(1);
    expect(state['Stream']?.physicalId).toBe('stream-new');
    const failed = failureLines();
    expect(failed).toHaveLength(1);
    // The refusal names the colliding name and what the new resource holds.
    expect(failed[0]).toContain('Name "stream"');
    expect(failed[0]).toContain('"stream-new"');
    expect(failed[0]).toContain('another resource holds the colliding name');
    expect(failed[0]).toContain('Nothing was deleted');
    expect(failed[0]).toContain(KINESIS_COLLISION);
  });
});

// ─── Route 53: TypeSwapRecord (route53 integ Phase 2.7c) ──────────────────

const RECORD = 'AWS::Route53::RecordSet';
const ZONE = 'Z1234567890';
const ZONE_NAME = 'cdkd-3979.internal';
/** Measured us-east-1 (issue #3741): a CNAME beside a live record of the same name. */
const CNAME_BESIDE_A = `[RRSet of type CNAME with DNS name swap.${ZONE_NAME}. is not permitted as it conflicts with other records with the same DNS name in zone ${ZONE_NAME}.]`;

function recordProps(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    HostedZoneId: ZONE,
    Name: `swap.${ZONE_NAME}`,
    Type: 'A',
    TTL: '300',
    ResourceRecords: ['198.51.100.7'],
    ...overrides,
  };
}

const CNAME_PROPS = recordProps({ Type: 'CNAME', ResourceRecords: ['target.example.com'] });
const CNAME_ID = `${ZONE}|swap.${ZONE_NAME}|CNAME`;

/** The first CREATE hits the CNAME conflict; every later call succeeds. */
function stubRoute53(): void {
  let creates = 0;
  route53Send.mockImplementation(async (command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const action = (
      command as { input?: { ChangeBatch?: { Changes?: Array<{ Action?: string }> } } }
    ).input?.ChangeBatch?.Changes?.[0]?.Action;
    if (name === 'ChangeResourceRecordSetsCommand' && action === 'CREATE' && creates++ === 0) {
      throw Object.assign(new Error(CNAME_BESIDE_A), {
        name: 'InvalidChangeBatch',
        $metadata: { httpStatusCode: 400 },
      });
    }
    return { ChangeInfo: { Id: 'C1', Status: 'INSYNC' } };
  });
}

function swapOp(newId: string): CompletedOperation {
  return {
    logicalId: 'TypeSwapRecord',
    changeType: 'UPDATE',
    resourceType: RECORD,
    physicalId: newId,
    previousState: res(RECORD, { physicalId: CNAME_ID, properties: { ...CNAME_PROPS } }),
  };
}

describe('Route 53 TypeSwapRecord (the genuine holder, and its orphan twin) (#3979)', () => {
  it('NEGATIVE CONTROL: the new A holds the DNS name, so it is deleted and the CNAME restored', async () => {
    stubRoute53();
    const provider = new Route53Provider();
    const calls: string[] = [];
    const del = vi.spyOn(provider, 'delete').mockImplementation(async () => {
      calls.push('delete');
      return undefined;
    });
    const newId = `${ZONE}|swap.${ZONE_NAME}|A`;
    const state: Record<string, ResourceState> = {
      TypeSwapRecord: res(RECORD, { physicalId: newId, properties: recordProps({}) }),
    };

    const result = await replayRollback([swapOp(newId)], state, 'CdkdX', ctxFor(provider));

    expect(result.failures).toBe(0);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[1]).toBe(newId);
    expect(state['TypeSwapRecord']?.physicalId).toBe(CNAME_ID);
  });

  it('an A record at ANOTHER name does not hold it: nothing is deleted', async () => {
    // The deploy renamed the record AND swapped its type; something outside the
    // stack now holds `swap`, so the CNAME's re-create conflicts with THAT.
    stubRoute53();
    const provider = new Route53Provider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    const newId = `${ZONE}|other.${ZONE_NAME}|A`;
    const state: Record<string, ResourceState> = {
      TypeSwapRecord: res(RECORD, {
        physicalId: newId,
        properties: recordProps({ Name: `other.${ZONE_NAME}` }),
      }),
    };

    const result = await replayRollback([swapOp(newId)], state, 'CdkdX', ctxFor(provider));

    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(state['TypeSwapRecord']?.physicalId).toBe(newId);
    const failed = failureLines();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(`swap.${ZONE_NAME}`);
    expect(failed[0]).toContain('Nothing was deleted');
  });
});

// ─── The refusal itself ──────────────────────────────────────────────────

describe('the unproven-holder refusal (#3979)', () => {
  function collidingProvider(): { provider: ResourceProvider; del: ReturnType<typeof vi.fn> } {
    const del = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists'));
    return { provider: { create, delete: del } as unknown as ResourceProvider, del };
  }

  it('a re-create that names nothing is refused with the remedy line, nothing deleted', async () => {
    // An identity provider has no generation rule, so a bag without its
    // ProviderName names nothing the records could compare.
    const IDP = 'AWS::Cognito::UserPoolIdentityProvider';
    const { provider, del } = collidingProvider();
    const op: CompletedOperation = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: IDP,
      physicalId: 'idp-new',
      previousState: res(IDP, { physicalId: 'idp-old', properties: { a: 1 } }),
    };
    const state = { Q: res(IDP, { physicalId: 'idp-new', properties: { a: 2 } }) };

    const result = await replayRollback([op], state, 'CdkdX', ctxFor(provider));

    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    const failed = failureLines();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('named no ProviderName');
    // Undecided, so it says so rather than claiming another holder.
    expect(failed[0]).toContain('cannot show that the new resource holds the colliding name');
    expect(failed[0]).toMatch(/\nTo orphan it: cdkd rollback --orphan Q$/);
  });

  it('runs AHEAD of the Retain refusal, whose text presumes the new resource holds the name', async () => {
    const { provider, del } = collidingProvider();
    const op: CompletedOperation = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'q-new',
      previousState: res('AWS::SQS::Queue', { physicalId: 'q-old', properties: { QueueName: 'q' } }),
    };
    const state = {
      Q: res('AWS::SQS::Queue', {
        physicalId: 'q-new',
        properties: { QueueName: 'q-new' },
        updateReplacePolicy: 'Retain',
      }),
    };

    await replayRollback([op], state, 'CdkdX', ctxFor(provider));

    expect(del).not.toHaveBeenCalled();
    const failed = failureLines();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('another resource holds the colliding name');
    expect(failed[0]).not.toContain('UpdateReplacePolicy: Retain pins');
  });

  it('reads the new resource OBSERVED name when its record holds none', async () => {
    // A generated name is never recorded; a readback that observed it proves
    // the holder even where the physical id is opaque.
    const calls: string[] = [];
    let seen = 0;
    const provider = {
      create: vi.fn(async () => {
        calls.push('create');
        if (seen++ === 0) throw awsSdkError('Queue already exists');
        return { physicalId: 'q-restored', attributes: {} };
      }),
      delete: vi.fn(async () => {
        calls.push('delete');
        return undefined;
      }),
    } as unknown as ResourceProvider;
    const op: CompletedOperation = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'opaque-new',
      previousState: res('AWS::SQS::Queue', { physicalId: 'q-old', properties: { QueueName: 'q' } }),
    };
    const state = {
      Q: res('AWS::SQS::Queue', {
        physicalId: 'opaque-new',
        properties: {},
        observedProperties: { QueueName: 'q' },
      }),
    };

    const result = await replayRollback([op], state, 'CdkdX', ctxFor(provider));

    expect(calls).toEqual(['create', 'delete', 'create']);
    expect(result.failures).toBe(0);
  });

  it('a nested stack row is refused: its child name is a state key no AWS collision can hold', async () => {
    const NESTED = 'AWS::CloudFormation::Stack';
    const { provider, del } = collidingProvider();
    const op: CompletedOperation = {
      logicalId: 'Child',
      changeType: 'UPDATE',
      resourceType: NESTED,
      physicalId: 'child-new',
      previousState: res(NESTED, { physicalId: 'child-old', properties: { TemplateURL: 'a.json' } }),
    };
    const state = { Child: res(NESTED, { physicalId: 'child-new', properties: { TemplateURL: 'b.json' } }) };

    const result = await replayRollback([op], state, 'CdkdX', ctxFor(provider));

    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(failureLines()[0]).toContain('cdkd has no name property to compare');
  });

  it('a GENERATED name an SDK provider mints is proven through the new ELBv2 ARN', async () => {
    // An unnamed target group: the SDK provider mints `<stack>-<logicalId>` on
    // both the forward create and the replay, so the recorded bags hold no
    // name. The name the replay asks for is the mirrored generation, and the
    // live new target group's ARN carries it: a genuine holder.
    const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
    const calls: string[] = [];
    let seen = 0;
    const provider = {
      create: vi.fn(async () => {
        calls.push('create');
        if (seen++ === 0) {
          throw Object.assign(
            new Error("A target group with the same name 'CdkdX-Tg' exists, but with different settings"),
            { name: 'DuplicateTargetGroupNameException' }
          );
        }
        return { physicalId: 'arn-restored', attributes: {} };
      }),
      delete: vi.fn(async () => {
        calls.push('delete');
        return undefined;
      }),
    } as unknown as ResourceProvider;
    const newArn =
      'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/CdkdX-Tg/0123456789abcdef';
    const op: CompletedOperation = {
      logicalId: 'Tg',
      changeType: 'UPDATE',
      resourceType: TG,
      physicalId: newArn,
      previousState: res(TG, { physicalId: 'arn-old', properties: { Port: 80 } }),
    };
    const state = { Tg: res(TG, { physicalId: newArn, properties: { Port: 81 } }) };

    const result = await withStackName('CdkdX', () =>
      replayRollback([op], state, 'CdkdX', ctxFor(provider))
    );

    expect(calls).toEqual(['create', 'delete', 'create']);
    expect(result.failures).toBe(0);
    expect(state['Tg']?.physicalId).toBe('arn-restored');
  });

  it('a non-string logical id reaches the refusal instead of throwing in the name generator', async () => {
    // The deploy engine's in-process rollback hands the executor ops no
    // journal parser checked; the name mirror must not coerce such an id.
    const { provider, del } = collidingProvider();
    const op: CompletedOperation = {
      logicalId: 123 as unknown as string,
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'q-new',
      previousState: res('AWS::SQS::Queue', { physicalId: 'q-old', properties: { a: 1 } }),
    };
    const state = { '123': res('AWS::SQS::Queue', { physicalId: 'q-new', properties: { a: 2 } }) };

    const result = await replayRollback([op], state, 'CdkdX', ctxFor(provider));

    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    const failed = failureLines();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('Cannot reverse the replacement of');
    expect(failed[0]).toContain("--orphan '<id>'");
  });
});
