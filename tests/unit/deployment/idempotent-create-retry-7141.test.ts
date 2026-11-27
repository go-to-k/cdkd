/**
 * go-to-k/cdkd#7141: an AMBIGUOUS socket error (`ECONNRESET`, "socket hang
 * up", a client-side `TimeoutError`) on a create stopped the engine's retry
 * loop, so a create that may have landed is not made twice. For a create its
 * provider declares IDEMPOTENT (`idempotentCreateTypes`: one put of the whole
 * document keyed by the parent) the replay converges instead, so it is
 * replayed within the same budget. Every other create keeps the no-replay rule.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetBucketPolicyCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';

const { mockSend, mockSqsSend } = vi.hoisted(() => ({ mockSend: vi.fn(), mockSqsSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sqs: { send: mockSqsSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { replaysAmbiguousCreate } from '../../../src/deployment/idempotent-create.js';
import { createWithRollbackRetry } from '../../../src/deployment/rollback-executor/replay-retry.js';
import { isAmbiguousSocketError } from '../../../src/deployment/retryable-errors/transient.js';
import {
  createdBeforeFailure,
  markCreatedBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { priorAttemptLookup, withPriorAttempts } from '../../../src/deployment/prior-attempt-scope.js';
import { S3BucketPolicyProvider } from '../../../src/provisioning/providers/s3-bucket-policy-provider.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

/** The SDK's shape in the issue's run: "socket hang up", `TimeoutError`, `ECONNRESET`. */
const socketHangUp = (): Error =>
  Object.assign(new Error('socket hang up'), {
    name: 'TimeoutError',
    code: 'ECONNRESET',
    $metadata: { attempts: 3 },
  });
/** A bare Node socket error: the code alone, no SDK name. */
const bareReset = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
/** `@smithy/node-http-handler`'s socket-inactivity timeout: the name alone, no code. */
const codelessTimeout = (): Error =>
  Object.assign(
    new Error('the request socket timed out after 30000 ms of inactivity'),
    { name: 'TimeoutError' }
  );

const quiet = { debug: () => {}, warn: () => {} };
const noSleep = async (): Promise<void> => {};

describe('isAmbiguousSocketError (go-to-k/cdkd#7141)', () => {
  it('reads the socket arms down the cause chain, and not a 5xx or a throttle', () => {
    expect(isAmbiguousSocketError(socketHangUp())).toBe(true);
    expect(isAmbiguousSocketError(bareReset())).toBe(true);
    expect(isAmbiguousSocketError(codelessTimeout())).toBe(true);
    expect(
      isAmbiguousSocketError(
        Object.assign(new Error('x'), { $retryable: { throttling: true }, cause: bareReset() })
      )
    ).toBe(false);
    expect(isAmbiguousSocketError(new Error('wrapped', { cause: bareReset() }))).toBe(true);
    for (const code of ['EPIPE', 'ETIMEDOUT', 'EADDRNOTAVAIL']) {
      expect(isAmbiguousSocketError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    expect(isAmbiguousSocketError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      false
    );
    expect(
      isAmbiguousSocketError(
        Object.assign(new Error('InternalError'), { $metadata: { httpStatusCode: 500 } })
      )
    ).toBe(false);
    expect(
      isAmbiguousSocketError(
        Object.assign(new Error('slow'), { name: 'ThrottlingException', cause: bareReset() })
      )
    ).toBe(false);
    expect(isAmbiguousSocketError(new Error('MalformedPolicy'))).toBe(false);
  });
});

describe('withRetry replayAmbiguousSocketError (go-to-k/cdkd#7141)', () => {
  for (const [label, make] of [
    ['an SDK TimeoutError', socketHangUp],
    ['a bare ECONNRESET', bareReset],
    ['a code-less TimeoutError', codelessTimeout],
  ] as const) {
    it(`replays ${label} only when the caller declared it safe`, async () => {
      const declared = vi.fn().mockRejectedValueOnce(make()).mockResolvedValue('done');
      await expect(
        withRetry(declared, 'Policy', {
          replayAmbiguousSocketError: true,
          sleep: noSleep,
          logger: quiet,
        })
      ).resolves.toBe('done');
      expect(declared).toHaveBeenCalledTimes(2);

      const undeclared = vi.fn().mockRejectedValueOnce(make()).mockResolvedValue('done');
      await expect(withRetry(undeclared, 'Queue', { sleep: noSleep, logger: quiet })).rejects.toThrow(
        make().message
      );
      expect(undeclared).toHaveBeenCalledTimes(1);
    });
  }

  it('stays inside the existing budget, and says so when it gives up', async () => {
    const op = vi.fn().mockRejectedValue(socketHangUp());
    const warn = vi.fn();
    await expect(
      withRetry(op, 'Policy', {
        replayAmbiguousSocketError: true,
        sleep: noSleep,
        logger: { debug: () => {}, warn },
      })
    ).rejects.toThrow('socket hang up');
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain(
      'gave up after 8 socket-reset retries of an idempotent create'
    );
    // The generic 8 retries after the first attempt.
    expect(op).toHaveBeenCalledTimes(9);
  });

  it('keeps the IAM-propagation budget it interrupts (the issue run)', async () => {
    // MalformedPolicy (IAM propagation) past the generic budget of 8, a socket
    // reset, then success: only the latched 26-retry budget reaches it.
    const propagation = () => new Error('MalformedPolicy: Invalid principal in policy');
    const op = vi.fn();
    for (let i = 0; i < 10; i++) op.mockRejectedValueOnce(propagation());
    op.mockRejectedValueOnce(socketHangUp()).mockResolvedValue('done');
    await expect(
      withRetry(op, 'Policy', { replayAmbiguousSocketError: true, sleep: noSleep, logger: quiet })
    ).resolves.toBe('done');
    expect(op).toHaveBeenCalledTimes(12);
  });
});

describe('a replay that writes fewer targets keeps the earlier ones journaled (go-to-k/cdkd#7141)', () => {
  const TYPE = 'AWS::SQS::QueuePolicy';
  const marked = (error: Error, written: string): Error =>
    markCreatedBeforeFailure(error, 'Policy', TYPE, written);

  it('the thrown mark is the union when the two share a member', async () => {
    // Attempt 1 wrote qA and qB, then a reset on qC; the replay wrote qA, then
    // failed for good on qB. Both qA and qB hold this create's policy.
    const op = vi
      .fn()
      .mockRejectedValueOnce(marked(socketHangUp(), 'qA,qB'))
      .mockRejectedValueOnce(marked(new Error('AccessDenied'), 'qA'));
    const thrown = await withRetry(op, 'Policy', {
      replayAmbiguousSocketError: true,
      sleep: noSleep,
      logger: quiet,
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(op).toHaveBeenCalledTimes(2);
    expect(createdBeforeFailure(thrown, 'Policy', TYPE)).toBe('qA,qB');
  });

  it('a later mark naming every earlier member is left as it is', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(marked(socketHangUp(), 'qA'))
      .mockRejectedValueOnce(marked(new Error('AccessDenied'), 'qA,qB'));
    const thrown = await withRetry(op, 'Policy', {
      replayAmbiguousSocketError: true,
      sleep: noSleep,
      logger: quiet,
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(createdBeforeFailure(thrown, 'Policy', TYPE)).toBe('qA,qB');
  });
});

describe('replaysAmbiguousCreate (go-to-k/cdkd#7141)', () => {
  it('needs both a create (a type) and the provider declaring that type', () => {
    const p = { idempotentCreateTypes: new Set(['AWS::S3::BucketPolicy']) };
    expect(replaysAmbiguousCreate(p, 'AWS::S3::BucketPolicy')).toBe(true);
    expect(replaysAmbiguousCreate(p, 'AWS::S3::Bucket')).toBe(false);
    expect(replaysAmbiguousCreate(p, undefined)).toBe(false);
    expect(replaysAmbiguousCreate({}, 'AWS::S3::BucketPolicy')).toBe(false);
    expect(replaysAmbiguousCreate(undefined, 'AWS::S3::BucketPolicy')).toBe(false);
  });
});

describe('S3BucketPolicyProvider: a socket reset on a Put that landed converges (go-to-k/cdkd#7141)', () => {
  const TYPE = 'AWS::S3::BucketPolicy';
  const BUCKET = 'my-bucket';
  const DOC = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: 'arn:aws:iam::123456789012:role/r' },
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${BUCKET}/*`,
      },
    ],
  };

  beforeEach(() => {
    mockSend.mockReset();
  });

  it('the engine-shaped retry replays the create and accepts its own policy', async () => {
    let landed = false;
    let puts = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof GetBucketPolicyCommand) {
        return landed
          ? Promise.resolve({ Policy: JSON.stringify(DOC) })
          : Promise.reject(
              Object.assign(new Error('The bucket policy does not exist'), {
                name: 'NoSuchBucketPolicy',
                $metadata: { httpStatusCode: 404 },
              })
            );
      }
      if (command instanceof PutBucketPolicyCommand) {
        puts++;
        landed = true;
        return puts === 1 ? Promise.reject(socketHangUp()) : Promise.resolve({});
      }
      return Promise.reject(new Error('unexpected command'));
    });
    const provider = new S3BucketPolicyProvider();

    const result = await withPriorAttempts(
      priorAttemptLookup('Policy', () => Promise.resolve([])),
      () =>
        withRetry(() => provider.create('Policy', TYPE, { Bucket: BUCKET, PolicyDocument: DOC }), 'Policy', {
          ...(replaysAmbiguousCreate(provider, TYPE) && { replayAmbiguousSocketError: true }),
          sleep: noSleep,
          logger: quiet,
        })
    );

    expect(result.physicalId).toBe(BUCKET);
    expect(puts).toBe(2);
  });
});

describe('SQSQueuePolicyProvider: a reset on the second queue converges (go-to-k/cdkd#7141)', () => {
  it('the replay rewrites both queues and resolves', async () => {
    const { SQSQueuePolicyProvider } = await import(
      '../../../src/provisioning/providers/sqs-queue-policy-provider.js'
    );
    const { SetQueueAttributesCommand } = await import('@aws-sdk/client-sqs');
    const sent: string[] = [];
    let q2Calls = 0;
    mockSqsSend.mockReset();
    mockSqsSend.mockImplementation((command: unknown) => {
      if (!(command instanceof SetQueueAttributesCommand)) {
        return Promise.reject(new Error('unexpected command'));
      }
      const url = command.input.QueueUrl!;
      sent.push(url);
      if (url.endsWith('/q2') && q2Calls++ === 0) return Promise.reject(socketHangUp());
      return Promise.resolve({});
    });
    const provider = new SQSQueuePolicyProvider();
    const TYPE = 'AWS::SQS::QueuePolicy';
    const queues = [
      'https://sqs.us-east-1.amazonaws.com/123456789012/q1',
      'https://sqs.us-east-1.amazonaws.com/123456789012/q2',
    ];

    const result = await withRetry(
      () =>
        provider.create('Policy', TYPE, {
          Queues: queues,
          PolicyDocument: { Version: '2012-10-17', Statement: [] },
        }),
      'Policy',
      {
        ...(replaysAmbiguousCreate(provider, TYPE) && { replayAmbiguousSocketError: true }),
        sleep: noSleep,
        logger: quiet,
      }
    );

    expect(result.physicalId).toBe(queues[0]);
    expect(sent).toEqual([queues[0], queues[1], queues[0], queues[1]]);
  });
});

describe('the deploy engine CREATE replays a socket reset only for a declared type (go-to-k/cdkd#7141)', () => {
  const TEMPLATE = {
    Resources: { Res: { Type: 'AWS::S3::BucketPolicy', Properties: {} } },
  } as unknown as CloudFormationTemplate;

  function engineWith(provider: ResourceProvider): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      {
        getState: vi.fn(),
        saveState: vi.fn().mockResolvedValue('etag'),
        loadRollbackJournal: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      {},
      'us-east-1'
    );
  }

  const provider = (declared: ReadonlySet<string> | undefined): ResourceProvider => ({
    create: vi
      .fn()
      .mockRejectedValueOnce(socketHangUp())
      .mockResolvedValue({ physicalId: 'my-bucket', attributes: {} }),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
    ...(declared !== undefined && { idempotentCreateTypes: declared }),
  });

  const change = (resourceType: string): ResourceChange =>
    ({
      logicalId: 'Res',
      changeType: 'CREATE',
      resourceType,
      desiredProperties: {},
    }) as unknown as ResourceChange;

  it('a declared type is replayed and converges', async () => {
    const p = provider(new Set(['AWS::S3::BucketPolicy']));
    await provisionResource(
      engineWith(p),
      'Res',
      change('AWS::S3::BucketPolicy'),
      {},
      'MyStack',
      TEMPLATE
    );
    expect(p.create).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('a type the provider did not declare (SQS CreateQueue) is not replayed', async () => {
    const p = provider(undefined);
    await expect(
      provisionResource(engineWith(p), 'Res', change('AWS::SQS::Queue'), {}, 'MyStack', {
        Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: {} } },
      } as unknown as CloudFormationTemplate)
    ).rejects.toThrow('Failed to create resource Res');
    expect(p.create).toHaveBeenCalledTimes(1);
  });

  it('a provider declaring ANOTHER of its types does not replay this one', async () => {
    const p = provider(new Set(['AWS::S3::BucketPolicy']));
    await expect(
      provisionResource(engineWith(p), 'Res', change('AWS::Lambda::Function'), {}, 'MyStack', {
        Resources: { Res: { Type: 'AWS::Lambda::Function', Properties: {} } },
      } as unknown as CloudFormationTemplate)
    ).rejects.toThrow('Failed to create resource Res');
    expect(p.create).toHaveBeenCalledTimes(1);
  });
});

describe('the rollback re-create replays a socket reset only for a declared type (go-to-k/cdkd#7141)', () => {
  const run = (declared: boolean) => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(socketHangUp())
      .mockResolvedValue({ physicalId: 'q', attributes: {} });
    const p = {
      ...(declared && { idempotentCreateTypes: new Set(['AWS::SQS::QueuePolicy']) }),
    } as unknown as ResourceProvider;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const promise = createWithRollbackRetry(p, create, 'Res', logger as never, undefined, (t) => t, {
      // The outer classifier refuses everything, so only the inner loop can replay.
      isRetryable: () => false,
      interruptedMessage: 'interrupted',
      resourceType: 'AWS::SQS::QueuePolicy',
    });
    return { create, promise };
  };

  it('declared: replayed', async () => {
    const { create, promise } = run(true);
    await expect(promise).resolves.toEqual({ physicalId: 'q', attributes: {} });
    expect(create).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('undeclared: not replayed', async () => {
    const { create, promise } = run(false);
    await expect(promise).rejects.toThrow('socket hang up');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

/** Every `.ts` file under `dir`, recursively. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** The text of the call opened at `openParen` (an index of `(`), balanced. */
function callText(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  throw new Error('unbalanced call');
}

describe('the marked set is deliberate (go-to-k/cdkd#7141)', () => {
  it('pins every type a provider declares idempotent', () => {
    const declared: string[] = [];
    for (const file of tsFiles('src/provisioning')) {
      const source = readFileSync(file, 'utf8');
      const uses = source.split('idempotentCreateTypes').length - 1;
      if (uses === 0) continue;
      const literal = [
        ...source.matchAll(
          /readonly idempotentCreateTypes: ReadonlySet<string> = new Set\(\[([^\]]*)\]\);/g
        ),
      ];
      // Any other spelling (a computed set, a mutation) fails closed.
      expect({ file, uses }).toEqual({ file, uses: literal.length });
      for (const m of literal) {
        declared.push(...[...m[1]!.matchAll(/'([^']+)'/g)].map((t) => t[1]!));
      }
    }
    // Adding a type here is a decision: its create must be ONE put of the whole
    // document keyed by the parent, with no generated id, and its replay must
    // pass any look-before-create the provider does.
    expect(declared.sort()).toEqual([
      'AWS::Lambda::EventInvokeConfig',
      'AWS::S3::BucketPolicy',
      'AWS::SNS::TopicPolicy',
      'AWS::SQS::QueuePolicy',
    ]);
  });

  it('the provider instance carries the declaration the engine reads', () => {
    expect([...new S3BucketPolicyProvider().idempotentCreateTypes]).toEqual([
      'AWS::S3::BucketPolicy',
    ]);
  });

  it('every engine site wrapping a provider create passes the created type', () => {
    let engineSites = 0;
    let rollbackSites = 0;
    for (const file of tsFiles('src/deployment')) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/\b(?:engine|deps)\.withRetry\(/g)) {
        const call = callText(source, m.index + m[0].length - 1);
        if (!/[A-Za-z.]*[Pp]rovider\.create\(/.test(call)) continue;
        engineSites++;
        // The last argument is the created type (`createOfType`).
        expect({ file, last: /,\s*(?:\/\/[^\n]*\n\s*)*resourceType\s*\)$/.test(call) }).toEqual({
          file,
          last: true,
        });
      }
      for (const m of source.matchAll(/\bcreateWithRollbackRetry\(/g)) {
        if (/export async function createWithRollbackRetry\($/.test(source.slice(0, m.index + m[0].length).split('\n').pop()!)) continue;
        const call = callText(source, m.index + m[0].length - 1);
        rollbackSites++;
        // The type passed is the one the wrapped `create(` is called with.
        const created = /\.create\(\s*[\w.]+,\s*(\w+)/.exec(call)?.[1];
        expect({ file, created: created !== undefined }).toEqual({ file, created: true });
        expect({ file, typed: new RegExp(`\\bresourceType: ${created}\\b`).test(call) }).toEqual({
          file,
          typed: true,
        });
      }
    }
    // Floors: a rename that hides the sites from this scan fails here.
    expect(engineSites).toBeGreaterThanOrEqual(6);
    expect(rollbackSites).toBeGreaterThanOrEqual(3);
  });
});
