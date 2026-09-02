import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { AccessPointAlreadyExists } from '@aws-sdk/client-efs';

const { mockSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('@aws-sdk/client-efs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-efs')>();
  return {
    ...actual,
    EFSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  isMarkedNonRetryable,
  isNameCollisionError,
} from '../../../src/deployment/retryable-errors.js';
import {
  InterruptedWaitError,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * An AWS-AUTHORED failure, i.e. one carrying the `@smithy/smithy-client`
 * marker fields. `describeAwsFailure` keys on exactly these to decide whether
 * a message was written by AWS and must therefore be withheld from a thrown
 * (and so persisted) string. A fixture that omits them is classified
 * cdkd-authored and passes straight through, so a redaction assertion written
 * against a bare `new Error(...)` would hold vacuously.
 */
const awsAuthored = (name: string, message: string, statusCode = 400): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: statusCode >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: statusCode, requestId: 'req-0123456789' },
  });

/** The shape `isTransientServerError` classifies as retryable (issue #2026). */
const transient500 = (): Error =>
  Object.assign(new Error('We encountered an internal error. Please try again.'), {
    name: 'InternalError',
    $metadata: { httpStatusCode: 500 },
  });

interface FakeAccessPoint {
  AccessPointId: string;
  AccessPointArn: string;
  FileSystemId: string;
  ClientToken: string | undefined;
}

/**
 * A fake EFS that models the two behaviours the fix depends on, and nothing
 * else: inside the replay window a `CreateAccessPoint` carrying a `ClientToken`
 * AWS has already seen returns the access point that token minted, and outside
 * it the same token is refused with `AccessPointAlreadyExists`.
 *
 * `created` is the discriminator issue #2080's acceptance item 2 asks for. It
 * counts RESOURCES, not calls — a retry is ALLOWED to repeat the call, and a
 * fixture that counted calls would fail the correct implementation while
 * passing anything that duplicates on a replay with a fresh token.
 */
class FakeEfs {
  /** One entry per access point that actually came into being. */
  readonly created: FakeAccessPoint[] = [];
  /** One entry per `CreateAccessPoint` CALL, in order. */
  readonly clientTokens: (string | undefined)[] = [];
  /** The full input of every `CreateAccessPoint` CALL, in order. */
  readonly createInputs: Record<string, unknown>[] = [];
  /** `Date.now()` at every `CreateAccessPoint` CALL, in order. */
  readonly createTimes: number[] = [];
  /** How many `DescribeAccessPoints` read-backs were attempted. */
  describeCalls = 0;
  private readonly byToken = new Map<string, FakeAccessPoint>();
  private nextId = 1;

  /**
   * A seen token either REPLAYS or is refused with `AccessPointAlreadyExists`.
   * EFS documents no retirement period for a `CreateAccessPoint` `ClientToken`
   * (the one minute in the EFS User Guide is about file-system CREATION
   * tokens), so this flag selects the arm rather than modelling a duration.
   * Flipping it is how the adopt arm is reached.
   */
  replayWindowClosed = false;
  /** The next create provisions the access point and then loses its response. */
  loseNextResponse = false;
  /** `DescribeAccessPoints` throws this instead of answering. */
  describeError: Error | undefined;
  /** Fail the next N read-backs with a transient 5xx, then answer normally. */
  describeTransientFailures = 0;
  /** Fail the next N read-backs with a THROTTLE, then answer normally. */
  describeThrottleFailures = 0;
  /** What `DescribeAccessPoints` reports as the access point's `ClientToken`. */
  describeTokenOverride: string | undefined;
  /** What `DescribeAccessPoints` reports as the access point's `FileSystemId`. */
  describeFileSystemOverride: string | undefined;
  /** Drop the id + ARN from the read-back, as a partial description would. */
  describeWithoutIds = false;
  /** Drop ONLY the ARN, so an `||` collapsed to `&&` is caught. */
  describeWithoutArn = false;
  /** What `DescribeAccessPoints` reports as the access point's lifecycle state. */
  describeLifeCycleOverride: string | undefined;
  /** Answer the read-back with an EMPTY list, as a vanished access point would. */
  describeReturnsEmpty = false;
  /** Drop `AccessPointId` from the conflict error, as an older API version might. */
  omitAccessPointIdOnConflict = false;
  /**
   * Throw the conflict as a BARE object carrying only `name` + `AccessPointId`,
   * with no `$fault` / `$metadata`. This is the only shape that reaches the
   * `name ===` fallback: smithy's `ServiceException[Symbol.hasInstance]` matches
   * on `$fault && $metadata && name === this.name`, so any SDK-shaped error --
   * including one from a DUPLICATE `@aws-sdk/client-efs` copy -- already
   * satisfies `instanceof`.
   */
  conflictAsBareShape = false;

  private conflict(existing: FakeAccessPoint): never {
    if (this.conflictAsBareShape) {
      throw Object.assign(new Error('Access point already exists with creation token'), {
        name: 'AccessPointAlreadyExists',
        AccessPointId: this.omitAccessPointIdOnConflict ? undefined : existing.AccessPointId,
      });
    }
    throw new AccessPointAlreadyExists({
      $metadata: { httpStatusCode: 409 },
      message: `Access point already exists with creation token ${String(existing.ClientToken)}`,
      ErrorCode: 'AccessPointAlreadyExists',
      AccessPointId: this.omitAccessPointIdOnConflict ? undefined : existing.AccessPointId,
    });
  }

  private createAccessPoint(input: Record<string, unknown>): FakeAccessPoint {
    const token = input['ClientToken'] as string | undefined;
    this.clientTokens.push(token);
    this.createInputs.push(input);
    this.createTimes.push(Date.now());

    if (token !== undefined) {
      const existing = this.byToken.get(token);
      if (existing !== undefined) {
        if (this.replayWindowClosed) {
          this.conflict(existing);
        }
        return existing;
      }
    }

    const id = `fsap-${String(this.nextId++).padStart(3, '0')}`;
    const accessPoint: FakeAccessPoint = {
      AccessPointId: id,
      AccessPointArn: `arn:aws:elasticfilesystem:us-east-1:111122223333:access-point/${id}`,
      FileSystemId: input['FileSystemId'] as string,
      ClientToken: token,
    };
    this.created.push(accessPoint);
    if (token !== undefined) {
      this.byToken.set(token, accessPoint);
    }
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw transient500();
    }
    return accessPoint;
  }

  send = (command: { constructor: { name: string }; input: Record<string, unknown> }): unknown => {
    switch (command.constructor.name) {
      case 'CreateAccessPointCommand':
        return Promise.resolve(this.createAccessPoint(command.input));
      case 'DescribeAccessPointsCommand': {
        this.describeCalls++;
        if (this.describeTransientFailures > 0) {
          this.describeTransientFailures--;
          return Promise.reject(transient500());
        }
        if (this.describeThrottleFailures > 0) {
          this.describeThrottleFailures--;
          return Promise.reject(
            Object.assign(new Error('Rate exceeded'), {
              name: 'ThrottlingException',
              $fault: 'client',
              $metadata: { httpStatusCode: 400 },
            })
          );
        }
        if (this.describeError) {
          return Promise.reject(this.describeError);
        }
        const wanted = command.input['AccessPointId'] as string | undefined;
        const found = this.describeReturnsEmpty
          ? undefined
          : this.created.find((ap) => ap.AccessPointId === wanted);
        return Promise.resolve({
          AccessPoints: found
            ? [
                {
                  ...found,
                  ...(this.describeTokenOverride !== undefined
                    ? { ClientToken: this.describeTokenOverride }
                    : {}),
                  ...(this.describeFileSystemOverride !== undefined
                    ? { FileSystemId: this.describeFileSystemOverride }
                    : {}),
                  ...(this.describeWithoutIds
                    ? { AccessPointId: undefined, AccessPointArn: undefined }
                    : {}),
                  ...(this.describeWithoutArn ? { AccessPointArn: undefined } : {}),
                  ...(this.describeLifeCycleOverride !== undefined
                    ? { LifeCycleState: this.describeLifeCycleOverride }
                    : {}),
                },
              ]
            : [],
        });
      }
      default:
        return Promise.resolve({});
    }
  };
}

/**
 * The retry's sleep, with the CLOCK ADVANCED — issue #2080's acceptance item 3,
 * measured on the #2039 lane rather than hypothesised. With the sleep stubbed
 * to a no-op both attempts land in the same millisecond, so a `Date.now()`-
 * derived token would match by coincidence and a broken implementation would
 * pass the very probe written to catch it.
 */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

const ACCESS_POINT_PROPS = {
  FileSystemId: 'fs-0123456789abcdef0',
  PosixUser: { Uid: 1000, Gid: 1000, SecondaryGids: [2000] },
  RootDirectory: {
    Path: '/data',
    CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '755' },
  },
  AccessPointTags: [{ Key: 'Name', Value: 'cdkd-ap' }],
};

describe('EFSProvider CreateAccessPoint idempotency token (issue #2080)', () => {
  let provider: EFSProvider;
  let aws: FakeEfs;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetIdempotencyTokensForTests();
    aws = new FakeEfs();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    debugSpy.mockReset();
    provider = new EFSProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createAccessPoint = (logicalId = 'AccessPoint'): Promise<{ physicalId: string }> =>
    withRetry(
      () => provider.create(logicalId, 'AWS::EFS::AccessPoint', { ...ACCESS_POINT_PROPS }),
      logicalId,
      { sleep: advancingSleep }
    );

  it('sends a non-empty ClientToken on an ordinary create', async () => {
    await createAccessPoint();

    expect(aws.clientTokens).toHaveLength(1);
    expect(aws.clientTokens[0]).toBeDefined();
    expect(aws.clientTokens[0]).not.toBe('');
    // 64 ASCII characters is the documented ceiling on the field.
    expect((aws.clientTokens[0] as string).length).toBeLessThanOrEqual(64);
  });

  it('still sends the whole access-point payload beside the token', async () => {
    // The fix REWROTE the `CreateAccessPointCommand` literal into
    // `createOrAdoptAccessPoint`; without this, deleting any mapped field from
    // the request leaves the suite green.
    await createAccessPoint();

    expect(aws.createInputs).toHaveLength(1);
    const sent = aws.createInputs[0]!;
    expect(sent['FileSystemId']).toBe('fs-0123456789abcdef0');
    expect(sent['PosixUser']).toEqual({ Uid: 1000, Gid: 1000, SecondaryGids: [2000] });
    expect(sent['RootDirectory']).toEqual({
      Path: '/data',
      CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '755' },
    });
    expect(sent['Tags']).toEqual([{ Key: 'Name', Value: 'cdkd-ap' }]);
  });

  it('a retried create whose 500 hid a successful CreateAccessPoint produces exactly ONE access point', async () => {
    aws.loseNextResponse = true;

    const result = await createAccessPoint();

    expect(aws.clientTokens).toHaveLength(2);
    expect(aws.created.map((ap) => ap.AccessPointId)).toEqual(['fsap-001']);
    expect(result.physicalId).toBe('fsap-001');
  });

  it('sends the SAME ClientToken on both attempts', async () => {
    aws.loseNextResponse = true;

    await createAccessPoint();

    const [first, second] = aws.clientTokens;
    expect(first).toBeDefined();
    expect(first).not.toBe('');
    expect(second).toBe(first);

    // Acceptance item 3 is only MET if the clock really moved between the two
    // attempts. If `setSystemTime` ever no-ops, both land in the same
    // millisecond, a `Date.now()`-derived token matches by coincidence, and
    // the mutation probe written to catch that implementation passes. Fence
    // the fixture's own precondition rather than trusting it.
    expect(aws.createTimes).toHaveLength(2);
    expect(aws.createTimes[1]!).toBeGreaterThan(aws.createTimes[0]!);
  });

  it('mints a FRESH token for a re-create after a successful one, so a replaced access point is not re-adopted', async () => {
    await createAccessPoint();
    await createAccessPoint();

    expect(aws.clientTokens[1]).not.toBe(aws.clientTokens[0]);
    expect(aws.created.map((ap) => ap.AccessPointId)).toEqual(['fsap-001', 'fsap-002']);
  });

  it('gives two access points on ONE file system distinct tokens', async () => {
    await createAccessPoint('AccessPointA');
    await createAccessPoint('AccessPointB');

    expect(aws.clientTokens[1]).not.toBe(aws.clientTokens[0]);
    expect(aws.created).toHaveLength(2);
  });

  describe('past the replay window, where the token conflicts instead of replaying', () => {
    beforeEach(() => {
      aws.replayWindowClosed = true;
    });

    it('ADOPTS the access point the lost response described instead of failing the deploy', async () => {
      aws.loseNextResponse = true;

      const result = await createAccessPoint();

      expect(aws.clientTokens).toHaveLength(2);
      expect(aws.created.map((ap) => ap.AccessPointId)).toEqual(['fsap-001']);
      expect(result.physicalId).toBe('fsap-001');
      expect(warnSpy.mock.calls.flat().join('\n')).toContain('adopting the access point fsap-001');
    });

    it('returns the adopted access point ARN, not a fabricated one', async () => {
      aws.loseNextResponse = true;

      const result = (await createAccessPoint()) as unknown as {
        attributes: Record<string, unknown>;
      };

      expect(result.attributes['Arn']).toBe(
        'arn:aws:elasticfilesystem:us-east-1:111122223333:access-point/fsap-001'
      );
      expect(result.attributes['AccessPointId']).toBe('fsap-001');
    });

    it.each([
      [
        'the read-back reports a different ClientToken',
        () => {
          aws.describeTokenOverride = 'somebody-elses-token';
        },
        /carries a different ClientToken/,
      ],
      [
        'the read-back reports a different FileSystemId',
        () => {
          aws.describeFileSystemOverride = 'fs-somebody-else';
        },
        /belongs to a different file system/,
      ],
      [
        'the read-back has no id',
        () => {
          aws.describeWithoutIds = true;
        },
        /without an id/,
      ],
      [
        'the read-back has an id but no ARN',
        () => {
          aws.describeWithoutArn = true;
        },
        /without an ARN/,
      ],
      [
        'the read-back reports the access point as deleting',
        () => {
          aws.describeLifeCycleOverride = 'deleting';
        },
        /is deleting rather than usable/,
      ],
      [
        'the read-back reports the access point as deleted',
        () => {
          aws.describeLifeCycleOverride = 'deleted';
        },
        /is deleted rather than usable/,
      ],
      [
        'the read-back reports the access point in error',
        () => {
          aws.describeLifeCycleOverride = 'error';
        },
        /is error rather than usable/,
      ],
      [
        'the read-back comes back empty',
        () => {
          aws.describeReturnsEmpty = true;
        },
        /could not be read back/,
      ],
      [
        'the read-back itself fails',
        () => {
          aws.describeError = awsAuthored(
            'AccessDeniedException',
            'User is not authorized to perform: elasticfilesystem:DescribeAccessPoints'
          );
        },
        /reading access point fsap-001 back failed/,
      ],
    ])('DECLINES to adopt when %s, and says why', async (_label, arrange, reason) => {
      aws.loseNextResponse = true;
      arrange();

      // ONE call, both assertions on the SAME error. Calling twice to read the
      // message re-ran the create with `loseNextResponse` already spent, so the
      // discriminating `reason` was checked against a decline reached on the
      // FIRST attempt while the headline regex -- identical across every row --
      // was the only thing covering the retry-replay route this block exists
      // to exercise.
      const message = await createAccessPoint().then(
        () => '<resolved, expected a rejection>',
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );

      // Every decline names the TOKEN collision as the headline; a read-back
      // failure in particular must not replace the diagnosis with its own
      // AccessDenied, or the next reader chases a permissions problem.
      expect(message).toMatch(/idempotency token cdkd sent is already bound/);
      expect(message).toMatch(reason);
      // STARTS WITH, not merely contains: the decline is the diagnosis, so the
      // outer catch must not re-wrap it as `Failed to create EFS AccessPoint
      // ...: EFS refused ...`. A `toMatch` alone is a substring of that
      // double-wrapped string, so it passed with the guard deleted.
      expect(message.startsWith('EFS refused CreateAccessPoint')).toBe(true);
      expect(aws.created).toHaveLength(1);
      // The AccessDenied rows must NOT be retried -- the grant is absent, not
      // propagating. Widening `isRetryable` is otherwise caught only by a
      // vitest timeout, whose message points nowhere near the cause.
      if (aws.describeError !== undefined) {
        expect(aws.describeCalls).toBe(1);
      }
      expect(warnSpy.mock.calls.flat().join('\n')).toContain('declined to adopt it');
    });

    it('WITHHOLDS the AWS failure text from the thrown message, routing it to debug', async () => {
      aws.loseNextResponse = true;
      aws.describeError = awsAuthored(
        'AccessDeniedException',
        'User: arn:aws:sts::111122223333:assumed-role/DeployRole/session is not authorized to perform: elasticfilesystem:DescribeAccessPoints'
      );

      const message = await createAccessPoint().then(
        () => '<resolved, expected a rejection>',
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );

      // The thrown message reaches the durable `deployments/{runId}.jsonl`
      // store, so AWS's own words -- which name the account, the role and the
      // session -- must not be in it. It also must not carry
      // `not authorized to perform`, an IAM-propagation retry pattern: with it,
      // a permanently missing grant retried 27 times.
      expect(message).not.toContain('111122223333');
      expect(message).not.toContain('assumed-role/DeployRole');
      expect(message).not.toContain('not authorized to perform');
      expect(message).toContain('AccessDeniedException');
      // Nothing is LOST: the withheld half is reachable at debug.
      expect(debugSpy.mock.calls.flat().join('\n')).toContain('not authorized to perform');
    });

    it.each(['available', 'creating', 'updating'])(
      'ADOPTS an access point reported as %s -- the deny-list must not over-reach',
      async (state) => {
        // The positive control for the lifecycle guard. Without it, widening the
        // deny-list to every state would go unnoticed: the decline rows would
        // all still pass, because they only assert that BAD states are refused.
        aws.loseNextResponse = true;
        aws.describeLifeCycleOverride = state;

        const result = await createAccessPoint();

        expect(result.physicalId).toBe('fsap-001');
        expect(aws.created).toHaveLength(1);
      }
    );

    it('does NOT release the token when it DECLINES, so a retry cannot duplicate', async () => {
      // The negative twin of the release-on-adopt test. Moving `release()` into
      // a `finally` passes every other case, but would hand the decline path a
      // fresh token -- and a fresh token creates a SECOND access point beside
      // the one cdkd just refused to adopt.
      aws.loseNextResponse = true;
      aws.describeTokenOverride = 'somebody-elses-token';
      await createAccessPoint().catch(() => undefined);
      const declinedToken = aws.clientTokens.at(-1);

      aws.describeTokenOverride = undefined;
      await createAccessPoint().catch(() => undefined);

      expect(aws.clientTokens.at(-1)).toBe(declinedToken);
    });

    it('adopts via the `name ===` fallback when the conflict is not SDK-shaped', async () => {
      // The `instanceof` arm cannot cover this: smithy's `Symbol.hasInstance`
      // requires `$fault` + `$metadata`, so an error carrying only the right
      // `name` -- a re-thrown plain object, a non-SDK transport wrapper --
      // reaches the adopt path ONLY through the string comparison. Without this
      // case, deleting that clause passes the whole suite.
      aws.loseNextResponse = true;
      aws.conflictAsBareShape = true;

      const result = await createAccessPoint();

      expect(result.physicalId).toBe('fsap-001');
      expect(aws.created).toHaveLength(1);
    });

    it('lets an INTERRUPT escape the read-back instead of re-labelling it a decline', async () => {
      // `withRetry` throws `InterruptedWaitError` out of its backoff sleep, and
      // that lands in the same catch as a lookup failure. `decline` sets `cause`
      // to the CreateAccessPoint conflict, which would ERASE the interrupt from
      // the chain `isInterruptedWaitError` walks -- so `deploy-engine` would
      // miss it and automatically roll the whole stack back on Ctrl-C. That is
      // the outcome the interrupt machinery exists to prevent, and threading the
      // interrupt is what created the window.
      aws.loseNextResponse = true;
      aws.describeError = new InterruptedWaitError('EFS AccessPoint (adoption read-back)');

      const error = (await createAccessPoint().catch((e: unknown) => e)) as Error;

      // Assert the ENGINE's own predicate, not the concrete class: the outer
      // `createAccessPoint` catch still wraps, but it threads the interrupt as
      // `cause`, and `isInterruptedWaitError` walks the chain. What must never
      // happen is `decline` replacing that cause with the conflict.
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(error.message).not.toMatch(/idempotency token cdkd sent is already bound/);
    });

    it('marks the decline NON-RETRYABLE rather than relying on its wording', async () => {
      // The message interpolates a user-chosen logical id, and
      // `RETRYABLE_ERROR_MESSAGE_PATTERNS` holds whitespace-free entries, so a
      // logical id containing one would flip this terminal decline back to
      // retryable. The marker is what makes the terminality independent of the
      // text.
      aws.loseNextResponse = true;
      aws.describeTokenOverride = 'somebody-elses-token';

      const error = await createAccessPoint().catch((e: unknown) => e);

      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('RETRIES a THROTTLED confirmation read -- it strands the same orphan a 5xx would', async () => {
      // A modeled `@throws` list is not exhaustive: `DescribeAccessPoints`
      // models no throttle at all, yet AWS returns one on any operation, by
      // NAME or as HTTP 429. Neither is a `TRANSIENT_SERVER_ERROR_STATUS_CODES`
      // entry, so a 5xx-only predicate declines it and leaves the access point
      // the first attempt created live and unrecorded.
      aws.loseNextResponse = true;
      aws.describeThrottleFailures = 1;

      const result = await createAccessPoint();

      expect(result.physicalId).toBe('fsap-001');
      expect(aws.describeCalls).toBe(2);
      expect(aws.created).toHaveLength(1);
    });

    it('RETRIES a transient 5xx on the confirmation read rather than declining', async () => {
      // Declining here is the worst decline in the method: the access point the
      // first attempt created is already live, so a blip on the CONFIRMATION
      // would fail the deploy AND leave exactly the orphan the token exists to
      // prevent. The outer engine retry cannot cover it -- `isTransientServerError`
      // walks `.cause`, which holds the 409 conflict, not this 503.
      aws.loseNextResponse = true;
      aws.describeTransientFailures = 1;

      const result = await createAccessPoint();

      expect(result.physicalId).toBe('fsap-001');
      expect(aws.describeCalls).toBe(2);
      // Two CREATE attempts, not three: `describeCalls === 2` alone would also
      // hold if the outer create had been re-run instead of the read-back
      // being retried in place.
      expect(aws.clientTokens).toHaveLength(2);
      expect(aws.created).toHaveLength(1);
    });

    it('releases the token after ADOPTING, so a later create does not reuse it', async () => {
      aws.loseNextResponse = true;
      await createAccessPoint();
      const adoptedToken = aws.clientTokens[0];

      // A second create of the same logical id must mint a FRESH token: the
      // adopted access point is in state now, and answering a later create
      // with the same token would hand back the resource it just recorded.
      aws.replayWindowClosed = false;
      aws.loseNextResponse = false;
      await createAccessPoint();

      expect(aws.clientTokens.at(-1)).not.toBe(adoptedToken);
      expect(aws.created).toHaveLength(2);
    });

    it('DECLINES, without attempting a read-back, when the conflict names no AccessPointId', async () => {
      aws.loseNextResponse = true;
      aws.omitAccessPointIdOnConflict = true;

      await expect(createAccessPoint()).rejects.toThrow(/named no AccessPointId to read back/);
      // Load-bearing: asserting only the rejection passes when the `!existingId`
      // clause is deleted, because the read-back then returns an empty list and
      // a LATER clause rethrows the same way. The discriminator is that no
      // read-back was attempted at all.
      expect(aws.describeCalls).toBe(0);
      expect(aws.created).toHaveLength(1);
    });

    it('keeps the AWS conflict as `cause` while making the message not read as a NAME collision', async () => {
      aws.loseNextResponse = true;
      aws.describeTokenOverride = 'somebody-elses-token';

      interface Chained extends Error {
        cause?: Chained;
      }
      const error = (await createAccessPoint().catch((e: unknown) => e)) as Chained;

      // `DeployEngine`'s replacement path classifies a failed create-first
      // attempt on the TOP-LEVEL message alone. The raw AWS wording matches
      // `isNameCollisionError`, so a bare rethrow would make the engine treat an
      // idempotency-token collision as a physical-NAME collision -- and under
      // `--replace` fall back to deleting the OLD access point.
      expect(isNameCollisionError(error.message)).toBe(false);
      // The control: the AWS wording this replaces DOES match, so the assertion
      // above is about the fix rather than about the predicate being inert.
      expect(isNameCollisionError('Access point already exists with creation token x')).toBe(true);
      // Nothing is lost -- the AWS error is still reachable.
      const chain = [error.message, error.cause?.message, error.cause?.cause?.message].join(' | ');
      expect(chain).toContain('already exists with creation token');
    });
  });
});
