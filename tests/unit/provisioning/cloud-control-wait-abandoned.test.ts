/**
 * `waitForOperation`'s transport fence (issue
 * [#3236](https://github.com/go-to-k/cdkd/issues/3236)).
 *
 * Before the fix, a `GetResourceRequestStatus` that failed for ANY reason
 * propagated out of the poll loop and took the `RequestToken` with it. The
 * Cloud Control operation kept running server-side, so a CREATE AWS went on to
 * complete left a live resource with NO state record — invisible to rollback,
 * to `cdkd destroy`, and to `cleanupFailedCreateRemnant` (whose first guard
 * admits only a `CloudControlOperationFailedError`, which a transport failure
 * never is). The reporter's `AWS::RDS::DBInstance` reached `available` in AWS
 * and then blocked the deletion of five tracked resources for ~50 minutes.
 *
 * Two discriminators run through this file, and neither is "the happy path
 * still happens":
 *
 *  - the retry must re-poll the SAME request token, not restart anything;
 *  - when cdkd does give up, the token must LEAVE the function on the error.
 *
 * The clock is driven by a stubbed `sleep`, so the REAL backoff schedule
 * (1s -> 1.5s -> ... -> 10s) and the REAL two-minute grace are exercised
 * rather than shortened for the test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockCloudControlConfigRegion = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerDebug = vi.fn();

// `AWS::RDS::DBInstance` is the reporter's own type, so the recovered-CREATE
// case runs `enrichResourceAttributes`' RDS branch — which constructs
// `new RDSClient({})` INSIDE the provider and therefore ignores the
// `aws-clients.js` factory mock entirely. Without this package mock the
// enrichment reaches real AWS and `tests/setup.ts`'s fence reds the file.
const mockRdsSend = vi.fn();

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn(() => ({ send: mockRdsSend })),
  DescribeDBClustersCommand: vi.fn((input: unknown) => ({ __type: 'DescribeDBClusters', input })),
  DescribeDBInstancesCommand: vi.fn((input: unknown) => ({ __type: 'DescribeDBInstances', input })),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: mockCloudControlConfigRegion },
    },
    cloudFormation: { send: vi.fn() },
    dynamoDB: { send: vi.fn() },
    apiGateway: { send: vi.fn() },
    cloudFront: { send: vi.fn() },
    lambda: { send: vi.fn() },
    eventBridge: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: mockLoggerDebug,
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return {
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  },
}));

import {
  CloudControlProvider,
  CloudControlOperationFailedError,
  CloudControlWaitAbandonedError,
  isTransientPollFailure,
} from '../../../src/provisioning/cloud-control-provider.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import { isWaitAbandonedError } from '../../../src/provisioning/wait-abandoned.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { displaySafe } from '../../../src/utils/display-safe.js';

/** The grace `waitForOperation` allows one unbroken run of failures. */
const GRACE_MS = 2 * 60 * 1000;

/**
 * The phrases the FOUR already-deleted classifiers substring-match to decide a
 * DELETE failure means "already gone" — at which point they DROP the state row.
 *
 * The union of all four, not three: `destroy-runner.ts:1676` and
 * `deploy-engine.ts:7290` also match `No policy found`; `deploy-engine.ts:6772`
 * matches a BARE `NotFound`, strictly wider than `NotFoundException`; and the
 * fourth consumer is `delete()`'s OWN catch in
 * `src/provisioning/cloud-control-provider.ts`, which the first cut of this
 * list never named. A three-consumer list is how this fence shipped with two
 * live phrases missing.
 *
 * Copied as literals rather than imported, on purpose: the point is to catch a
 * message drifting into a shape those call sites read, and importing their
 * list would move with it.
 *
 * NOTE this is only HALF the protection, and the weaker half. The message
 * interpolates the LOGICAL ID, which the user chooses, so no wording rule can
 * keep every rendering clear of these phrases — see the `PageNotFound` case
 * below for the structural guard that does.
 */
const ALREADY_DELETED_PHRASES = [
  'does not exist',
  'was not found',
  'not found',
  'No policy found',
  'NoSuchEntity',
  'NotFound',
  'NotFoundException',
  'ResourceNotFoundException',
];

/**
 * A socket error shaped the way the SDK actually delivers one.
 *
 * `$metadata` is the load-bearing part and an earlier revision omitted it.
 * `@smithy/core`'s retry middleware stamps `{attempts, totalRetryDelay}` onto
 * EVERY error it gives up on, socket errors included — measured against a real
 * `CloudControlClient` pointed at a closed port:
 *
 *     name 'Error', code 'ECONNREFUSED', $fault undefined,
 *     message 'connect ECONNREFUSED 127.0.0.1:1',
 *     $metadata { attempts: 3, totalRetryDelay: 58 }
 *
 * Without it the fixture is more naive than production in exactly the place the
 * redaction decision reads, and a revision that redacted every transport error
 * passed its own "inverted control". Note `name` is `'Error'`, NOT the code —
 * so a reduction to `name` leaves no discriminator at all.
 */
function transportError(message: string, code: string): Error {
  return Object.assign(new Error(message), {
    code,
    $metadata: { attempts: 3, totalRetryDelay: 58 },
  });
}

/**
 * A poll entry that must be REJECTED with a value that is not an `Error`.
 *
 * The wire helpers below reject `instanceof Error` and RESOLVE everything else
 * as a ProgressEvent body, which is convenient and which made the whole
 * non-`Error` cause arm structurally unreachable from this file: every mutation
 * of it stayed green, including one that swapped the withheld summary for the
 * raw value. This sentinel is the seam that lets a case reach it. Production
 * shape: `isTransientPollFailure` duck-types `code` / `name` / `message` off
 * ANY object, so a duck-typed throw from a custom handler or credential
 * provider is admitted, spends the grace, and arrives here.
 */
class RawRejection {
  constructor(readonly value: unknown) {}
}

function rejectWith(value: unknown): RawRejection {
  return new RawRejection(value);
}

function commandName(call: unknown[]): string {
  return (call[0] as { constructor?: { name?: string } })?.constructor?.name ?? '';
}

function statusTokens(): string[] {
  return mockCloudControlSend.mock.calls
    .filter((c) => commandName(c) === 'GetResourceRequestStatusCommand')
    .map((c) => (c[0] as { input: { RequestToken: string } }).input.RequestToken);
}

function commandNames(): string[] {
  return mockCloudControlSend.mock.calls.map(commandName);
}

describe('CloudControlProvider.waitForOperation transport fence (#3236)', () => {
  let provider: CloudControlProvider;
  let now: number;
  let sleeps: number[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudControlConfigRegion.mockResolvedValue('ap-northeast-1');
    mockRdsSend.mockResolvedValue({ DBInstances: [] });
    provider = new CloudControlProvider();

    now = 1_780_000_000_000;
    sleeps = [];
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // Advancing the clock INSIDE the stubbed sleep is what makes the grace and
    // the wall-clock budget reachable without real time passing, and it keeps
    // the provider's own backoff schedule as the thing being measured.
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockImplementation((ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Wire a CREATE whose submit succeeds and whose status polls follow `statuses`
   * in order — an entry that is an Error is REJECTED, anything else resolves as
   * the ProgressEvent body.
   */
  function wireCreate(token: string, statuses: unknown[]): void {
    let poll = 0;
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'CreateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: token } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        const next = statuses[Math.min(poll, statuses.length - 1)];
        poll++;
        if (next instanceof RawRejection) return Promise.reject(next.value);
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve({ ProgressEvent: next });
      }
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-cleanup' } });
      }
      return Promise.resolve({});
    });
  }

  function wireDelete(token: string, statuses: unknown[]): void {
    let poll = 0;
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: token } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        const next = statuses[Math.min(poll, statuses.length - 1)];
        poll++;
        if (next instanceof RawRejection) return Promise.reject(next.value);
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve({ ProgressEvent: next });
      }
      return Promise.resolve({});
    });
  }

  describe('the poll is retried, on the SAME token', () => {
    it('recovers a CREATE whose status poll died with ECONNREFUSED', async () => {
      // The reporter's exact wording and error shape.
      wireCreate('tok-rds', [
        transportError('connect ECONNREFUSED 100.72.0.178:443', 'ECONNREFUSED'),
        { OperationStatus: 'SUCCESS', Identifier: 'dash-bench-dev-dbwriter9b286e50' },
      ]);

      const result = await provider.create('Dbwriter9B286E50', 'AWS::RDS::DBInstance', {
        Engine: 'aurora-postgresql',
      });

      expect(result.physicalId).toBe('dash-bench-dev-dbwriter9b286e50');
      // THE discriminator: the second poll carried the token the first one had.
      // A fix that restarted anything would show a different token here, and a
      // fix that merely swallowed the error would show only one poll.
      expect(statusTokens()).toEqual(['tok-rds', 'tok-rds']);
      // Exactly one CreateResource — never a replay (go-to-k/cdkd#2039).
      expect(commandNames().filter((n) => n === 'CreateResourceCommand')).toHaveLength(1);
      expect(sleeps).toEqual([1000]);
    });

    it('recovers a DELETE whose status poll died in transit', async () => {
      wireDelete('tok-del', [
        transportError('socket hang up', 'ECONNRESET'),
        { OperationStatus: 'SUCCESS' },
      ]);

      await expect(
        provider.delete('Queue', 'my-queue', 'AWS::SQS::Queue', {}, { expectedRegion: 'ap-northeast-1' })
      ).resolves.toBeUndefined();

      expect(statusTokens()).toEqual(['tok-del', 'tok-del']);
      expect(commandNames().filter((n) => n === 'DeleteResourceCommand')).toHaveLength(1);
    });

    it.each([
      ['DNS failure of a dropped VPN', transportError('getaddrinfo EAI_AGAIN host', 'EAI_AGAIN')],
      ['no route to host', transportError('connect EHOSTUNREACH 10.0.0.1:443', 'EHOSTUNREACH')],
      [
        'SDK request timeout (name, no code)',
        Object.assign(new Error('Request did not complete before the request timeout'), {
          name: 'TimeoutError',
        }),
      ],
      [
        // The production shape: a real `ThrottlingException` carries `$fault`
        // AND a status code. An earlier revision omitted both, which made the
        // fixture more naive than production in exactly the field the
        // redaction decision reads — the same defect the transport fixture had.
        'throttle',
        Object.assign(new Error('Rate exceeded'), {
          name: 'ThrottlingException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400, attempts: 1 },
        }),
      ],
      [
        'transient 5xx',
        Object.assign(new Error('Service Unavailable'), {
          $metadata: { httpStatusCode: 503 },
        }),
      ],
      [
        'a socket error one hop down the cause chain',
        Object.assign(new Error('wrapped'), {
          cause: transportError('connect ECONNREFUSED 10.1.2.3:443', 'ECONNREFUSED'),
        }),
      ],
      [
        'a code that only survived in the message text',
        new Error('connect ECONNREFUSED 100.72.0.170:443'),
      ],
    ])('re-polls after %s', async (_label, thrown) => {
      wireCreate('tok-x', [thrown, { OperationStatus: 'SUCCESS', Identifier: 'made-it' }]);

      await expect(
        provider.create('R', 'AWS::SQS::Queue', {})
      ).resolves.toMatchObject({ physicalId: 'made-it' });
      expect(statusTokens()).toEqual(['tok-x', 'tok-x']);
    });

    it.each([
      [
        'RequestTokenNotFoundException',
        Object.assign(new Error('Request token not found'), {
          name: 'RequestTokenNotFoundException',
        }),
      ],
      [
        'AccessDeniedException',
        Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' }),
      ],
      ['a bare Error with nothing transport-shaped', new Error('something went sideways')],
    ])('does NOT re-poll after %s — the fence fails closed', async (_label, thrown) => {
      wireCreate('tok-y', [thrown, { OperationStatus: 'SUCCESS', Identifier: 'never' }]);

      await expect(provider.create('R', 'AWS::SQS::Queue', {})).rejects.toThrow();
      // ONE poll: the wait aborted exactly as it did before #3236.
      expect(statusTokens()).toEqual(['tok-y']);
    });

    it('...but STILL carries the token out on a non-transient poll failure', async () => {
      // Round-4 review. Failing closed is right for deciding whether to
      // RE-POLL — an `AccessDeniedException` on `GetResourceRequestStatus` can
      // only be re-derived — but aborting BARE discarded the request token,
      // which is #3236's defect arriving from a permissions error instead of a
      // socket error: a least-privilege role granted `cloudcontrol:CreateResource`
      // and not the status read submits a CREATE, cannot watch it, and AWS
      // completes it anyway.
      wireCreate('tok-denied', [
        Object.assign(new Error('User is not authorized to perform: cloudcontrol:GetResource'), {
          name: 'AccessDeniedException',
        }),
      ]);

      const error = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as CloudControlWaitAbandonedError;

      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      expect(error.requestToken).toBe('tok-denied');
      expect(error.message).toContain('--request-token tok-denied');
      expect(error.message).toContain('not retryable');
      // Still exactly ONE poll: carrying the token out must not turn into a
      // retry of something a retry cannot fix.
      expect(statusTokens()).toEqual(['tok-denied']);
      expect(sleeps).toEqual([]);
      // CREATE stays non-retryable, as on the other two abandonment arms.
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('REDUCES an AWS-authored cause to its wire code, so no caller identity is persisted', async () => {
      // The message is copied verbatim into `deployments/{runId}.jsonl` by
      // `extractDeploymentEventError`, a store restricted to error-plus-metadata
      // that outlives the run. AWS words a 403 as
      // `User: arn:aws:sts::<acct>:assumed-role/<role>/<session> is not
      // authorized to perform: ...`, so keeping it raw writes the account id,
      // the role NAME and the SESSION name into that store — issue
      // go-to-k/cdkd#2302's class, which round 3 had cleared here only because
      // no 403 could then reach this builder.
      const denied = Object.assign(
        new Error(
          'User: arn:aws:sts::123456789012:assumed-role/DeployRole/ci-build-4821 is not authorized to perform: cloudcontrol:GetResourceRequestStatus'
        ),
        { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }
      );
      wireCreate('tok-403', [denied]);

      const error = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

      // The identity is GONE from the persisted message...
      expect(error.message).not.toContain('123456789012');
      expect(error.message).not.toContain('DeployRole');
      expect(error.message).not.toContain('ci-build-4821');
      expect(error.message).not.toContain('is not authorized to perform');
      // ...while the discriminator an operator needs survives, so the split
      // costs no diagnosis. A fix that simply dropped the cause would pass the
      // assertions above and fail this one.
      expect(error.message).toContain('AccessDeniedException');
      // The raw error is still reachable for a --verbose reader — asserted, not
      // assumed. The `detail` half is what makes a reduction safe rather than a
      // deletion, so a split whose detail nothing pins can silently become one.
      expect((error as { cause?: unknown }).cause).toBe(denied);
      const debugged = mockLoggerDebug.mock.calls.map((c) => String(c[0])).join('\n');
      expect(debugged).toContain("the abandoned operation's underlying failure was");
      expect(debugged).toContain('is not authorized to perform');
      expect(debugged).toContain('123456789012');
    });

    it('stamps markRedactedCause ONLY when the chain carries the withheld text', async () => {
      // `aws-failure-text.ts` states the precondition: stamp only when the
      // chain actually CARRIES what was withheld, because
      // `retryClassificationText` reads the chain on that marker's say-so and
      // "stamping without the second is worse than not stamping at all".
      //
      // It matters here beyond hygiene: the retry classifiers match by
      // SUBSTRING, and reducing `AccessDeniedException` to its wire code
      // removes the `not authorized to perform` wording the IAM-propagation
      // grid keys on. Without the marker that text is unreachable; with it on
      // an empty chain, an unrelated wrapper's whole message is fed to the
      // classifiers instead.
      const denied = Object.assign(new Error('User: arn:aws:sts::1:assumed-role/R/S is not authorized to perform: x'), {
        name: 'AccessDeniedException',
        $metadata: { httpStatusCode: 403 },
      });
      wireCreate('tok-mark', [denied]);
      const redacted = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;
      expect(hasRedactedCause(redacted)).toBe(true);
      // The premise: the chain really does carry the withheld wording.
      expect(((redacted as { cause?: Error }).cause)?.message).toContain('not authorized to perform');

      // The inverse. A transport failure is NOT reduced, so there is nothing
      // withheld and nothing to mark — and marking it would hand the
      // classifiers a chain read they never asked for.
      vi.clearAllMocks();
      mockCloudControlConfigRegion.mockResolvedValue('ap-northeast-1');
      wireCreate('tok-nomark', [transportError('connect ECONNREFUSED 10.0.0.1:443', 'ECONNREFUSED')]);
      const plain = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;
      expect(hasRedactedCause(plain)).toBe(false);
    });

    it('reduces a cause carrying $fault but NO status code', async () => {
      // The `$fault` half of the discriminator, which was untested: deleting
      // that disjunct left the whole suite green. It is the half that matters
      // for a service rejection the SDK could not deserialize a status from —
      // `$fault` is set by `withBaseException` before the status is read back.
      const faulted = Object.assign(
        new Error('User: arn:aws:sts::123456789012:assumed-role/Deployer/sess-9 is not authorized'),
        { name: 'AccessDeniedException', $fault: 'client', $metadata: { attempts: 1 } }
      );
      wireCreate('tok-fault', [faulted]);

      const error = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

      expect(error.message).not.toContain('123456789012');
      expect(error.message).not.toContain('Deployer');
      expect(error.message).toContain('AccessDeniedException');
    });

    it('reduces a CREDENTIAL-resolution failure, which carries neither signal', async () => {
      // Credential resolution runs OUTSIDE the retry middleware, so a
      // `CredentialsProviderError` has no `$fault` and no `$metadata` at all —
      // and its message interpolates the `credential_process` helper's ARGV and
      // its stderr. Measured through a real client, that is where a vault token
      // ends up. It is named explicitly in the predicate for exactly this.
      const credFailure = Object.assign(
        new Error(
          'Command failed: /bin/sh -c \'echo "vault: token hvs.SUPERSECRET rejected" >&2; exit 1\'\nvault: token hvs.SUPERSECRET rejected\n'
        ),
        { name: 'CredentialsProviderError' }
      );
      wireCreate('tok-cred', [credFailure]);

      const error = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

      expect(error.message).not.toContain('hvs.SUPERSECRET');
      expect(error.message).not.toContain('/bin/sh');
      expect(error.message).toContain('CredentialsProviderError');
      // WITHHELD, not deleted: the operator who needs the helper's own stderr
      // to fix their credentials can still get it with `--verbose`.
      const debugged = mockLoggerDebug.mock.calls.map((c) => String(c[0])).join('\n');
      expect(debugged).toContain('/bin/sh');
      expect(debugged).toContain('hvs.SUPERSECRET');
    });

    it('leaves a TRANSPORT cause unreduced — the reporter needs that wording', async () => {
      // The inverted control, and the one that caught a real regression. The
      // discriminator is a SERVICE signal (`$fault`, or a numeric
      // `$metadata.httpStatusCode`), NOT the presence of `$metadata` — which
      // the SDK's retry middleware puts on socket errors too. `transportError`
      // now carries the real `{attempts, totalRetryDelay}` shape, so a
      // revision reducing on `$metadata` presence reds here instead of passing
      // vacuously.
      wireCreate('tok-sock', [
        transportError('connect ECONNREFUSED 100.72.0.178:443', 'ECONNREFUSED'),
      ]);

      const error = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

      expect(error.message).toContain('connect ECONNREFUSED 100.72.0.178:443');
      // ...and specifically NOT the degenerate reduction: a socket error's
      // `name` is `Error`, so reducing it yields a token carrying nothing.
      expect(error.message).not.toContain('Error. Re-run with --verbose');
    });

    it('says nothing about a cause on a PLAIN wall-clock timeout', async () => {
      // The deadline arm passes `undefined` whenever every poll was answered —
      // the ordinary slow-resource timeout, and the most common abandonment
      // there is. Feeding that to the AWS-failure describer answered
      // `a non-Error value of type undefined. Re-run with --verbose for AWS's
      // own message.`, i.e. nonsense in AWS's voice on the path that least
      // deserves it, plus a `markRedactedCause` stamp over an empty chain.
      wireCreate('tok-plain', [{ OperationStatus: 'IN_PROGRESS' }]);

      const error = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

      expect(error.message).toContain('timeout for R after');
      expect(error.message).not.toContain('non-Error value');
      expect(error.message).not.toContain(VERBOSE_POINTER);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      // ...and NO redaction marker, because nothing was withheld. Stamping one
      // over an empty chain is what `aws-failure-text.ts` calls "worse than not
      // stamping at all": `retryClassificationText` would then join a chain
      // that carries nothing, feeding an unrelated wrapper's whole message to
      // the retry classifiers.
      expect(hasRedactedCause(error)).toBe(false);
    });

    it("does not swallow the loop's OWN throws — a FAILED event still reaches remnant cleanup", async () => {
      wireCreate('tok-f', [
        {
          OperationStatus: 'FAILED',
          StatusMessage: 'stabilization failed',
          Identifier: 'cdkd-remnant',
          TypeName: 'AWS::Synthetics::Canary',
          ErrorCode: 'GeneralServiceException',
        },
      ]);

      const error = await provider
        .create('Canary', 'AWS::Synthetics::Canary', {})
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(error).toBeInstanceOf(CloudControlOperationFailedError);
      // Remnant cleanup fired: it issued the delete of the materialized id.
      expect(commandNames()).toContain('DeleteResourceCommand');
    });

    it('fails a FAILED event whose own StatusMessage names a socket error, instead of re-polling it', async () => {
      // THE scoping fence for the `try`, and the case that makes the scoping
      // load-bearing rather than stylistic. A widened `try` around the loop
      // body would catch this deliberate throw, and `isTransientPollFailure`
      // reads the MESSAGE — which here is the resource handler's own report of
      // ITS downstream connection failure. The wait would then spin on a
      // settled, FAILED operation until the deadline and report the wrong
      // error. Scoped to the `send` expression alone, the throw is never seen
      // by the catch at all.
      //
      // The case that first stood here (`stabilization failed`) could not see
      // this: under a widened `try` it classifies non-transient and is
      // re-thrown unchanged, so the test passed either way.
      wireCreate('tok-handler-econn', [
        {
          OperationStatus: 'FAILED',
          StatusMessage: 'Resource handler returned message: "connect ECONNREFUSED 10.0.3.4:5432"',
          TypeName: 'AWS::RDS::DBInstance',
          ErrorCode: 'GeneralServiceException',
        },
      ]);

      const error = await provider
        .create('Db', 'AWS::RDS::DBInstance', {})
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(error).toBeInstanceOf(CloudControlOperationFailedError);
      expect(error).not.toBeInstanceOf(CloudControlWaitAbandonedError);
      // ONE poll. A widened `try` shows many, and the elapsed clock shows the
      // full budget rather than nothing.
      expect(statusTokens()).toEqual(['tok-handler-econn']);
      expect(sleeps).toEqual([]);
    });

    it('resets the grace on an answered poll, so a FLAKY link is not killed by an accumulated total', async () => {
      // Alternating failure / IN_PROGRESS for well over the 2-minute grace.
      // Under a naive "total failures" or "first failure ever" budget this
      // would abandon; under a one-unbroken-run budget it must survive.
      //
      // 20 pairs is bounded on BOTH sides, and the upper bound is load-bearing:
      // at the capped 10s backoff, 40 sleeps spend ~370s, comfortably past the
      // 120s grace and comfortably inside the 900s wall-clock budget. A longer
      // run abandons at the DEADLINE instead — which would still be a red test,
      // but for the wrong reason, and would stop discriminating the grace reset.
      const alternating: unknown[] = [];
      for (let i = 0; i < 20; i++) {
        alternating.push(transportError('connect ECONNRESET', 'ECONNRESET'));
        alternating.push({ OperationStatus: 'IN_PROGRESS' });
      }
      alternating.push({ OperationStatus: 'SUCCESS', Identifier: 'survived' });
      wireCreate('tok-flaky', alternating);

      const result = await provider.create('R', 'AWS::SQS::Queue', {});

      expect(result.physicalId).toBe('survived');
      // The run really did outlast the grace in wall-clock terms.
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThan(GRACE_MS);
    });

    it('announces each re-poll at DEFAULT verbosity, naming the cause and the next poll', async () => {
      // Titled for what it pins, after review caught the earlier title
      // claiming `docs/troubleshooting.md` quotes this wording. It does not:
      // the page quotes the ABANDONMENT message
      // (`cdkd could not reach Cloud Control API for 121s: connect ...`), which
      // a sibling case pins. This warn is the line a user sees FIRST, while the
      // retry is still running, and nothing outside this file asserts it.
      // #3253 item 3. `mockLoggerWarn` was wired and never read, so the only
      // line a user sees while cdkd is silently re-polling had no pin at all —
      // and the `cdkd could not reach Cloud Control API for Ns` reason is
      // quoted verbatim in the troubleshooting page's worked example, the
      // shape `.claude/rules/testing.md` calls out under "A fixture that greps
      // cdkd's OWN output".
      wireCreate('tok-warn', [
        transportError('connect ECONNREFUSED 100.72.0.178:443', 'ECONNREFUSED'),
        { OperationStatus: 'SUCCESS', Identifier: 'made-it' },
      ]);

      await provider.create('R', 'AWS::SQS::Queue', {});

      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0]));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('could not read the Cloud Control operation status');
      expect(warned[0]).toContain('connect ECONNREFUSED 100.72.0.178:443');
      expect(warned[0]).toContain('re-polling the same request token');
      // HEDGED, matching the error it precedes: the poll failed, so cdkd does
      // not know the operation is still running. A mutation to "is still
      // running" reds here.
      expect(warned[0]).toContain('may still be running');
    });

    it('renders the grace reason in the wording the troubleshooting page quotes', async () => {
      wireCreate('tok-reason', [transportError('connect ECONNREFUSED 10.0.0.1:443', 'ECONNREFUSED')]);

      const error = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

      expect(error.message).toMatch(/cdkd could not reach Cloud Control API for \d+s/);
    });
  });

  describe('when cdkd gives up, the RequestToken leaves on the error', () => {
    /** An outage that never clears. */
    function neverClears(message = 'connect ECONNREFUSED 100.72.0.178:443', code = 'ECONNREFUSED') {
      return transportError(message, code);
    }

    it('throws CloudControlWaitAbandonedError carrying the token and a resume command', async () => {
      wireCreate('tok-abandon-me', [neverClears()]);

      const error = (await provider
        .create('Dbwriter9B286E50', 'AWS::RDS::DBInstance', {})
        .then(
          () => undefined,
          (e: unknown) => e
        )) as CloudControlWaitAbandonedError;

      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      expect(error.requestToken).toBe('tok-abandon-me');
      expect(error.ccOperation).toBe('CREATE');
      expect(error.message).toContain(
        'aws cloudcontrol get-resource-request-status --request-token tok-abandon-me --region ap-northeast-1'
      );
      // It gave up at the grace, not at the 15-minute budget.
      const elapsed = sleeps.reduce((a, b) => a + b, 0);
      expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS);
      expect(elapsed).toBeLessThan(GRACE_MS * 2);
    });

    it('is NOT a CloudControlOperationFailedError, so remnant cleanup cannot delete by a half-seen id', async () => {
      // An IN_PROGRESS event named the resource before the link died. That
      // identifier is reported, and deliberately NOT acted on: the create may
      // be about to succeed, and deleting by it would destroy the very resource
      // the user is about to be told about.
      wireCreate('tok-seen', [
        { OperationStatus: 'IN_PROGRESS', Identifier: 'db-half-seen' },
        neverClears(),
      ]);

      const error = (await provider
        .create('Db', 'AWS::RDS::DBInstance', {})
        .then(
          () => undefined,
          (e: unknown) => e
        )) as CloudControlWaitAbandonedError;

      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      expect(error).not.toBeInstanceOf(CloudControlOperationFailedError);
      expect(error.lastSeenIdentifier).toBe('db-half-seen');
      expect(error.message).toContain('db-half-seen');
      expect(commandNames()).not.toContain('DeleteResourceCommand');
    });

    it('marks a CREATE abandonment non-retryable, so the outer withRetry cannot duplicate the create', async () => {
      // The measured hazard, and the reason the marker exists. Without it the
      // deploy engine's withRetry would re-invoke create() against a resource
      // already being created — go-to-k/cdkd#2039's duplicate-create.
      //
      // The fixture carries the PRODUCTION shape (`$fault` + a status code).
      // That matters for the premise below: an earlier revision asserted the
      // message contains AWS's own `Rate exceeded`, which was true only of a
      // naive fixture — a real throttle is `serviceAuthored`, so the cause is
      // REDUCED to its wire code and that wording is gone. The marker is still
      // load-bearing, by the other route the classifier offers.
      wireCreate('tok-throttled', [
        Object.assign(new Error('Rate exceeded'), {
          name: 'ThrottlingException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400, attempts: 1 },
        }),
      ]);

      const error = (await provider
        .create('R', 'AWS::SQS::Queue', {})
        .then(
          () => undefined,
          (e: unknown) => e
        )) as Error;

      // The premise, restated to what is actually true at this head: the
      // message no longer carries the throttle wording, and the error is
      // nonetheless one the classifier would accept — via `isThrottlingError`'s
      // chain walk over the threaded cause.
      expect(error.message).not.toContain('Rate exceeded');
      expect(error.message).toContain('ThrottlingException');
      expect(isRetryableTransientError(error, error.message)).toBe(false);
      expect(isMarkedNonRetryable(error)).toBe(true);
      // ...and the non-vacuity that proves the marker is what refuses it: strip
      // the marker and the same error classifies retryable again.
      const unmarked = Object.assign(new Error(error.message), {
        cause: (error as { cause?: unknown }).cause,
      });
      expect(isRetryableTransientError(unmarked, unmarked.message)).toBe(true);
    });

    it('leaves a DELETE abandonment RETRYABLE — a second DeleteResource is idempotent', async () => {
      wireDelete('tok-del-abandon', [neverClears()]);

      const error = (await provider
        .delete('Queue', 'my-queue', 'AWS::SQS::Queue', {}, { expectedRegion: 'ap-northeast-1' })
        .then(
          () => undefined,
          (e: unknown) => e
        )) as CloudControlWaitAbandonedError;

      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      expect(error.ccOperation).toBe('DELETE');
      expect(isMarkedNonRetryable(error)).toBe(false);
    });

    it.each([
      ['transport', transportError('getaddrinfo ENOTFOUND cloudcontrolapi.ap-northeast-1.amazonaws.com', 'ENOTFOUND')],
      [
        'throttle',
        Object.assign(new Error('Rate exceeded'), {
          name: 'ThrottlingException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400, attempts: 1 },
        }),
      ],
      [
        '5xx',
        Object.assign(new Error('Service Unavailable'), { $metadata: { httpStatusCode: 503 } }),
      ],
    ])(
      'renders a DELETE abandonment with none of the already-deleted phrases (%s cause)',
      async (_label, thrown) => {
        // A DELETE failure carrying one of these is read by the destroy runner
        // and the deploy engine as idempotent success, and the state row is
        // DROPPED — over a resource this error says may still exist. The cause
        // text is interpolated, so the assertion runs over the RENDERED message
        // rather than over the template. `ENOTFOUND` is here because the
        // consumers match case-sensitively, so a future lowercasing of the
        // message must not introduce a phrase.
        //
        // It is NOT the near miss, and an earlier revision of this comment
        // called it one. The real near miss is `RequestTokenNotFoundException`,
        // whose REDUCED wire name contains `NotFound` — so the phrase-free
        // property genuinely does not hold for the one shape Cloud Control
        // raises about a request token. That shape has its own case, in the
        // round-8 block below, asserting the phrase IS present and that the
        // marker is what protects the state row.
        wireDelete('tok-phrases', [thrown]);

        const error = (await provider
          .delete('Queue', 'my-queue', 'AWS::SQS::Queue', {}, { expectedRegion: 'ap-northeast-1' })
          .then(
            () => undefined,
            (e: unknown) => e
          )) as Error;

        expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
        for (const phrase of ALREADY_DELETED_PHRASES) {
          expect(error.message).not.toContain(phrase);
        }
      }
    );

    it('is not absorbed as "already deleted" even when the LOGICAL ID contains a not-found phrase', async () => {
      // The bug this fences, measured on the first cut: `delete()`'s own catch
      // substring-matches `NotFound` / `not found` / `does not exist` over a
      // message that interpolates the logical id, and it is the ONE consumer of
      // those phrases with no `isMarkedNonRetryable` guard in front of it — a
      // DELETE abandonment being deliberately unmarked so the destroy runner
      // can re-issue the delete. A resource named `PageNotFound` therefore made
      // delete() report idempotent SUCCESS and drop the state row over a delete
      // that may still have been running. That is issue go-to-k/cdkd#2301's
      // class, inside the fence written to prevent it.
      //
      // The remedy is STRUCTURAL (an `instanceof CloudControlWaitAbandonedError`
      // short-circuit ahead of the heuristics), because the interpolated inputs
      // are the user's and no wording rule can cover them. So this case asserts
      // the THROW, not the message — the phrase assertions above cannot, and
      // never could, see this.
      wireDelete('tok-named', [neverClears()]);

      const error = await provider
        .delete('PageNotFound', 'my-thing', 'AWS::SQS::Queue', {}, { expectedRegion: 'ap-northeast-1' })
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      expect((error as CloudControlWaitAbandonedError).requestToken).toBe('tok-named');
    });

    it('reports the remnant through a ProvisioningError even when the cleanup SEND rejects with a non-Error', async () => {
      // Round 10 proposed converting this catch's text read to the guarded
      // helper, on the theory that a non-`Error` rejection reaches it the way
      // one reaches `disableCcProtection`'s catch. It does not, and this case
      // is the measurement: `cleanupFailedCreateRemnant` throws only out of
      // `this.delete(...)`, which wraps whatever it caught into a
      // `ProvisioningError`, so the catch always holds an `Error` and the bare
      // `String()` arm is dead. The site therefore keeps the raw message,
      // which a second reason requires — it feeds `isNotFoundMessage`, a
      // PROSE matcher a wire-name reduction would blind.
      //
      // Keeping the case rather than deleting it: it pins the wrapping that
      // makes the bare form safe, so a future change that lets a raw value
      // through reds here instead of shipping.
      mockCloudControlSend.mockImplementation((command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'CreateResourceCommand') {
          return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-create' } });
        }
        if (name === 'DeleteResourceCommand') {
          return Promise.reject(Object.assign(Object.create(null) as object, { code: 'ECONNRESET' }));
        }
        if (name === 'GetResourceRequestStatusCommand') {
          return Promise.resolve({
            ProgressEvent: {
              OperationStatus: 'FAILED',
              StatusMessage: 'stabilization failed',
              Identifier: 'cdkd-remnant',
              TypeName: 'AWS::Synthetics::Canary',
              ErrorCode: 'GeneralServiceException',
            },
          });
        }
        return Promise.resolve({});
      });

      const error = (await provider.create('Canary', 'AWS::Synthetics::Canary', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

      // The ORIGINAL failure survives -- not a `TypeError` about primitives.
      expect(error.message).toContain('stabilization failed');
      expect(error.message).not.toContain('convert object to primitive');
      // ...and the remnant warning still names what a retry will collide with.
      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('a retry may fail with AlreadyExists');
      expect(warned).toContain('cdkd-remnant');
    });

    it('sanitizes the FAILED remnant warn arm, the only one of the three whose value arrives raw', async () => {
      // The source comment on this function says all THREE warn arms take the
      // same `displaySafe` treatment. Only this one is FENCEABLE, and the
      // reason is worth recording because it looks like a coverage gap and is
      // not: measured one arm at a time, deleting `displaySafe` from the
      // ABANDONED arm and from the SKIPPED arm leaves every case green, while
      // deleting it from THIS one reds below.
      //
      // Those two are defence in depth by construction. The ABANDONED arm's
      // text comes from `abandonWait`, which has already sanitized it -- the
      // guard upstream severs the taint, so the second call cannot change any
      // rendering. The SKIPPED arm's text is a provider-authored skip reason,
      // not AWS's. Only the FAILED arm interpolates a raw caught message, so it
      // is the only one where the call is load-bearing rather than belt-and-
      // braces. Do not "fix" the other two by deleting them: the value that
      // arrives is sanitized TODAY, and nothing in this function guarantees
      // that upstream stays true.
      const ESC = '\u001b';
      mockCloudControlSend.mockImplementation((command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'CreateResourceCommand') {
          return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-create' } });
        }
        if (name === 'DeleteResourceCommand') {
          return Promise.reject(
            Object.assign(new Error(`access denied ${ESC}[31m for the cleanup`), {
              name: 'AccessDeniedException',
              $fault: 'client',
              $metadata: { httpStatusCode: 403 },
            })
          );
        }
        if (name === 'GetResourceRequestStatusCommand') {
          return Promise.resolve({
            ProgressEvent: {
              OperationStatus: 'FAILED',
              StatusMessage: 'stabilization failed',
              Identifier: 'cdkd-remnant',
              TypeName: 'AWS::Synthetics::Canary',
              ErrorCode: 'GeneralServiceException',
            },
          });
        }
        return Promise.resolve({});
      });

      await expect(provider.create('Canary', 'AWS::Synthetics::Canary', {})).rejects.toThrow();

      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      // Non-vacuity: the FAILED arm really rendered, carrying the cause.
      expect(warned).toContain('a retry may fail with AlreadyExists');
      expect(warned).toContain('for the cleanup');
      expect(warned).not.toContain(ESC);
    });

    it('warns rather than reporting the remnant already gone when the CLEANUP delete is abandoned', async () => {
      // The FIFTH guard, and the one no needle-driven scan can reach: its
      // partner classifier is the regex helper `isNotFoundMessage`, which
      // carries no literal needles, so `wait-abandoned-guard-population.test.ts`
      // cannot see it. Measured before this case existed: deleting the whole
      // `isWaitAbandonedError(cleanupError)` arm left every other case green.
      //
      // `isNotFoundMessage` is case-INSENSITIVE, unlike the other four
      // classifiers, so once the abandonment message interpolates a transport
      // cause a `getaddrinfo ENOTFOUND ...` matches `/not\s*found/i`. The arm
      // would then log "already gone; nothing to clean up" and SUPPRESS the
      // "remove it manually" warning — over a remnant still occupying the name,
      // which is exactly what the caller's retry is about to trip over.
      let cleanupPoll = 0;
      mockCloudControlSend.mockImplementation((command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'CreateResourceCommand') {
          return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-create' } });
        }
        if (name === 'DeleteResourceCommand') {
          return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-cleanup' } });
        }
        if (name === 'GetResourceRequestStatusCommand') {
          const token = (command as { input: { RequestToken: string } }).input.RequestToken;
          if (token === 'tok-create') {
            // A FAILED create that materialized a remnant — what arms cleanup.
            return Promise.resolve({
              ProgressEvent: {
                OperationStatus: 'FAILED',
                StatusMessage: 'stabilization failed',
                Identifier: 'cdkd-remnant',
                TypeName: 'AWS::Synthetics::Canary',
                ErrorCode: 'GeneralServiceException',
              },
            });
          }
          cleanupPoll++;
          return Promise.reject(
            // Carries an ESC so this arm's `displaySafe` is FENCED rather than
            // merely present: the three remnant warn arms all gained one in
            // this PR and the source comment says so, but a `displaySafe`
            // nothing asserts is deletable-green (measured by review).
            transportError(
              'getaddrinfo ENOTFOUND cloudcontrolapi.\u001b[31m.amazonaws.com',
              'ENOTFOUND'
            )
          );
        }
        return Promise.resolve({});
      });

      await expect(provider.create('Canary', 'AWS::Synthetics::Canary', {})).rejects.toThrow();

      // Non-vacuity: the cleanup delete really did run and really did abandon.
      expect(cleanupPoll).toBeGreaterThan(1);

      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('a retry may fail with AlreadyExists');
      expect(warned).toContain('cdkd-remnant');
      // The interpolated cause really did reach the line, and its ESC did not.
      expect(warned).toContain('cloudcontrolapi');
      expect(warned).not.toContain('\u001b');
      // The wrong answer, asserted on the INFO channel where it is actually
      // logged. The first cut asserted it absent from `warn`, where it could
      // never have appeared — vacuous, and it would have stayed green with the
      // guard removed.
      const infoed = mockLoggerInfo.mock.calls.map((c) => String(c[0])).join('\n');
      expect(infoed).not.toContain('was already gone');
    });

    it('drives the UPDATE call site, whose consequence clause differs from CREATE and DELETE', async () => {
      // The third of the four call sites, and the one whose wording would
      // otherwise go unread: an UPDATE's resource DOES have a state record, so
      // the CREATE clause ("cdkd has NO state record for it") would be false
      // there. Also pins the unmarked-retryable arm for UPDATE.
      let poll = 0;
      mockCloudControlSend.mockImplementation((command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'UpdateResourceCommand') {
          return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-upd' } });
        }
        if (name === 'GetResourceCommand') {
          return Promise.resolve({ ResourceDescription: { Properties: '{"Name":"q"}' } });
        }
        if (name === 'GetResourceRequestStatusCommand') {
          poll++;
          return Promise.reject(neverClears());
        }
        return Promise.resolve({});
      });

      const error = (await provider
        .update(
          'Queue',
          'my-queue',
          'AWS::SQS::Queue',
          { Name: 'q2' },
          { Name: 'q' },
          { expectedRegion: 'ap-northeast-1' }
        )
        .then(
          () => undefined,
          (e: unknown) => e
        )) as CloudControlWaitAbandonedError;

      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      expect(error.ccOperation).toBe('UPDATE');
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(error.message).toContain('its state record still holds the PREVIOUS properties');
      expect(error.message).not.toContain('cdkd has NO state record');
      expect(poll).toBeGreaterThan(1);
    });

    it.each([
      ['transport', transportError('getaddrinfo ENOTFOUND cloudcontrolapi', 'ENOTFOUND')],
      [
        'throttle',
        Object.assign(new Error('Rate exceeded'), {
          name: 'ThrottlingException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400, attempts: 1 },
        }),
      ],
    ])(
      'keeps the already-deleted phrases out of the IDENTIFIER clause too (%s cause)',
      async (_label, thrown) => {
        // The phrase cases above all reject on the FIRST poll, so
        // `lastSeenIdentifier` is undefined and `identifierClause` renders as
        // ''. That left the clause interpolating the SECOND user-controlled
        // input completely unfenced — measured: rewording it to
        // `The record does not exist for resource ...` left all 60 green.
        //
        // An IN_PROGRESS event carrying an Identifier is what puts the clause
        // in the message at all.
        wireDelete('tok-clause', [{ OperationStatus: 'IN_PROGRESS', Identifier: 'db-1' }, thrown]);

        const error = (await provider
          .delete('Queue', 'my-queue', 'AWS::SQS::Queue', {}, { expectedRegion: 'ap-northeast-1' })
          .then(
            () => undefined,
            (e: unknown) => e
          )) as Error;

        expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
        // The clause really is present — without this the loop below is
        // vacuous in exactly the way it was before.
        expect(error.message).toContain('db-1');
        for (const phrase of ALREADY_DELETED_PHRASES) {
          expect(error.message).not.toContain(phrase);
        }
      }
    );

    it('puts the identifier clause BEFORE the pasteable command, never after it', async () => {
      // A template-chosen identifier glued on after the command rendered on
      // the SAME line as it, inside what reads as a shell line, while taking
      // only sanitize — no quote, no suppress.
      wireCreate('tok-order', [
        { OperationStatus: 'IN_PROGRESS', Identifier: 'db-ordered' },
        neverClears(),
      ]);

      const error = (await provider.create('Db', 'AWS::RDS::DBInstance', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

      const lines = error.message.split('\n');
      const commandLine = lines.find((l) => l.includes('aws cloudcontrol'));
      expect(commandLine).toBeDefined();
      expect(commandLine).not.toContain('db-ordered');
      // ...and the command is the LAST thing on its line. `shellQuote` leaves
      // `ap-northeast-1` bare — its safe-set is `[A-Za-z0-9._/@:+-]` — so the
      // expected tail carries no quotes.
      expect(commandLine?.trimEnd().endsWith('--region ap-northeast-1')).toBe(true);
      expect(error.message).toContain('db-ordered');
    });

    it('drops --region when the resolved region is not clean ASCII', async () => {
      // The forgery `buildResumeCommand`'s doc comment argues for: a region
      // carrying a newline is inert once `shellQuote` wraps it, and still
      // renders a two-line "recovery command" on the terminal and into the
      // durable events store. Measured: replacing the guard with an
      // emptiness-only test left all 60 green.
      mockCloudControlConfigRegion.mockResolvedValue('us-east-1\nrm -rf x');
      wireCreate('tok-badregion', [neverClears()]);

      const error = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

      expect(error.message).toContain('--request-token tok-badregion');
      expect(error.message).not.toContain('--region');
      expect(error.message).not.toContain('rm -rf x');
    });

    it('suppresses the WHOLE command when the token is not clean ASCII', async () => {
      // Measured: deleting the suppression arm entirely left all 60 green.
      wireCreate('tok‮bad', [neverClears()]);

      const error = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

      expect(error.message).toContain('cdkd cannot render a safe resume command');
      expect(error.message).not.toContain('aws cloudcontrol get-resource-request-status');
    });

    it('carries the token out of the WALL-CLOCK deadline too, keeping the timeout wording', async () => {
      // The deadline arm has always lost the token for the same reason and
      // with the same consequence: the operation is still running when cdkd
      // stops waiting.
      wireCreate('tok-deadline', [{ OperationStatus: 'IN_PROGRESS', Identifier: 'slow-one' }]);

      const error = (await provider
        .create('Domain', 'AWS::OpenSearchService::Domain', {})
        .then(
          () => undefined,
          (e: unknown) => e
        )) as CloudControlWaitAbandonedError;

      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      expect(error.requestToken).toBe('tok-deadline');
      expect(error.lastSeenIdentifier).toBe('slow-one');
      expect(error.message).toContain('timeout for Domain after');
      expect(error.message).toContain('--request-token tok-deadline');
    });

    it('interpolates the cause on the DEADLINE arm too, when an outage is still open when the budget runs out', async () => {
      // The deadline's `lastTransientError instanceof Error ? … : undefined`
      // arm: with only IN_PROGRESS events `causeText` is always empty, so the
      // one deadline path that interpolates an AWS message — and therefore the
      // one covered by the `displaySafe` on that text — was never driven.
      //
      // Shape: poll normally until the clock is deep into the 15-minute budget,
      // then go dark. The grace (120s) has not elapsed when the budget does, so
      // the loop exits through the deadline with `lastTransientError` SET.
      //
      // 85 is derived, not picked: the backoff is 1000/1500/2250/3375/5063/7595
      // and then 10000 capped, so 85 answered polls spend 810,783 ms and leave
      // 89,217 ms — under the 120,000 ms grace, which is the whole point.
      //
      // The pass window is n in [82, 93], measured from both ends, and the case
      // fails LOUDLY outside it rather than going quiet: at n=95 the budget is
      // exhausted before the outage starts, so no cause arrives and the
      // `toContain('getaddrinfo EAI_AGAIN')` reds; at n=80 the grace arm fires
      // instead and the `toContain('timeout for R after')` reds. A change to
      // `INITIAL_POLL_INTERVAL_MS` or the 1.5x multiplier is absorbed by the
      // 10s cap, so neither can silently move it out of the window.
      const statuses: unknown[] = [];
      for (let i = 0; i < 85; i++) statuses.push({ OperationStatus: 'IN_PROGRESS' });
      statuses.push(neverClears('getaddrinfo EAI_AGAIN cloudcontrolapi', 'EAI_AGAIN'));
      wireCreate('tok-deadline-cause', statuses);

      const error = (await provider
        .create('R', 'AWS::SQS::Queue', {})
        .then(
          () => undefined,
          (e: unknown) => e
        )) as CloudControlWaitAbandonedError;

      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      // Deadline wording, not the grace wording — this is the arm under test.
      expect(error.message).toContain('timeout for R after');
      expect(error.message).not.toContain('could not reach Cloud Control API for');
      // ...and the pending cause rode out with it.
      expect(error.message).toContain('getaddrinfo EAI_AGAIN cloudcontrolapi');
      expect(error.cause).toBeInstanceOf(Error);
    });

    it('reports a NON-Error open outage on the deadline arm instead of dropping it', async () => {
      // The deadline arm filtered its cause with
      // `lastTransientError instanceof Error ? … : undefined`, which re-created
      // on this one arm the "abandonment stating no reason at all" that
      // `abandonWait`'s non-`Error` branch exists to remove. Same derived 85
      // answered polls as the case above — see its comment for why 85 and for
      // the [82, 93] window; the only change is the SHAPE of what goes dark.
      const statuses: unknown[] = [];
      for (let i = 0; i < 85; i++) statuses.push({ OperationStatus: 'IN_PROGRESS' });
      statuses.push(rejectWith({ code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN secret-host' }));
      wireCreate('tok-deadline-raw', statuses);

      const error = (await provider
        .create('R', 'AWS::SQS::Queue', {})
        .then(
          () => undefined,
          (e: unknown) => e
        )) as CloudControlWaitAbandonedError;

      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      // Deadline wording, not the grace wording — this is the arm under test.
      expect(error.message).toContain('timeout for R after');
      // The reason is REPORTED, withheld rather than dropped: the value's own
      // text stays out of the persisted message, and the abandonment still says
      // that something arrived.
      expect(error.message).toContain('a non-Error value of type object');
      expect(error.message).not.toContain('secret-host');
      expect(error.cause).toBeUndefined();
    });

    it('omits --region rather than failing twice when the region cannot be resolved', async () => {
      mockCloudControlConfigRegion.mockRejectedValue(new Error('Region is missing'));
      wireCreate('tok-no-region', [neverClears()]);

      const error = (await provider
        .create('R', 'AWS::SQS::Queue', {})
        .then(
          () => undefined,
          (e: unknown) => e
        )) as CloudControlWaitAbandonedError;

      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      expect(error.message).toContain('--request-token tok-no-region');
      expect(error.message).not.toContain('--region');
    });
  });
});

describe('the --remove-protection flip takes a SHORT grace and reports the token (#3253 item 1)', () => {
  let provider: CloudControlProvider;
  let now: number;
  let sleeps: number[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudControlConfigRegion.mockResolvedValue('ap-northeast-1');
    provider = new CloudControlProvider();
    now = 1_780_000_000_000;
    sleeps = [];
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockImplementation((ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Drive `delete()` with `removeProtection` on a type that carries a Cloud
   * Control protection property, with the FLIP's status poll dead and the
   * DELETE's healthy — so the only abandoned wait is the flip's.
   */
  function wireFlipOutage(): void {
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'UpdateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-flip' } });
      }
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-del' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        const token = (command as { input: { RequestToken: string } }).input.RequestToken;
        if (token === 'tok-flip') {
          return Promise.reject(transportError('connect ECONNREFUSED 10.1.2.3:443', 'ECONNREFUSED'));
        }
        return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
      }
      return Promise.resolve({});
    });
  }

  it('gives up on the flip in ~10s, not the 2-minute poll grace, and still deletes', async () => {
    wireFlipOutage();

    await expect(
      provider.delete(
        'Table',
        'my-table',
        'AWS::DSQL::Cluster',
        {},
        { expectedRegion: 'ap-northeast-1', removeProtection: true }
      )
    ).resolves.toBeUndefined();

    // THE discriminator. The flip is best-effort and swallowed either way, so
    // "the delete still succeeds" passes under both graces — only the wall
    // clock tells them apart. Under the default 120s grace this is >= 120000.
    // The SCHEDULE, not a loose upper bound. `spent < 30_000` was the first
    // cut and it admitted anything up to ~21s: measured, a grace of 20_000
    // still passed it, so it discriminated 10s from 120s but not from a
    // doubled constant. These five sleeps ARE the 10s grace's behaviour --
    // five re-polls, giving up on the sixth read at ~13.2s of wall clock.
    expect(sleeps).toEqual([1000, 1500, 2250, 3375, 5063]);
    // It really was abandoned rather than never retried: more than one poll.
    expect(statusTokens().filter((t) => t === 'tok-flip').length).toBeGreaterThan(1);
  });

  it('swallows a flip failure that cannot be stringified, instead of aborting the delete', async () => {
    // `disableCcProtection`'s catch exists to SWALLOW so the delete proceeds,
    // and it read the text with a bare
    // `error instanceof Error ? error.message : String(error)`. `String(value)`
    // THROWS for a null-prototype object, so the catch built to let the delete
    // continue became the thing that stopped it -- and under
    // `--remove-protection`, the one flag whose whole purpose is to get a
    // protected resource deleted.
    //
    // Probed: reverting that line to the bare form reds this case.
    // The rejection must come from the SEND, not from a poll: a poll failure is
    // wrapped into a `CloudControlWaitAbandonedError` before it reaches this
    // catch, and that IS an `Error`, so the bare form's `String()` arm is never
    // taken that way. It is the `UpdateResource` call ITSELF failing with a
    // non-`Error` that arrives raw -- measured, after a first cut of this case
    // rejected a poll and stayed green against the bare form.
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'UpdateResourceCommand') {
        return Promise.reject(Object.assign(Object.create(null) as object, { code: 'ECONNRESET' }));
      }
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-del' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
      }
      return Promise.resolve({});
    });

    // The delete COMPLETES. Under the bare form this rejects with
    // `TypeError: Cannot convert object to primitive value`.
    await expect(
      provider.delete(
        'Table',
        'my-table',
        'AWS::DSQL::Cluster',
        {},
        { expectedRegion: 'ap-northeast-1', removeProtection: true }
      )
    ).resolves.toBeUndefined();

    // Non-vacuity: the flip really was attempted and really did fail, so the
    // catch under test really ran.
    const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('proceeding with delete');
    expect(commandNames()).toContain('DeleteResourceCommand');
  });

  it('renders no dangling clause on the flip warn when the failure has an empty message', async () => {
    // The third site of the same guard `abandonWait` carries, and the one the
    // round-10 conversion missed: reducing through `describePollFailure` made
    // an empty `display` possible here for the first time, and the line ended
    // `proceeding with delete: ` -- a colon promising a reason and then giving
    // none.
    //
    // Reachable rather than theoretical: `asSdkError` normalizes a non-`Error`
    // rejection crossing the retry middleware into
    // `Object.assign(new Error(), obj)`, and this catch encloses the
    // `UpdateResource` SEND, so such a value arrives here raw.
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'UpdateResourceCommand') {
        return Promise.reject(
          Object.assign(new Error(), {
            code: 'ECONNRESET',
            $metadata: { attempts: 3, totalRetryDelay: 58 },
          })
        );
      }
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-del' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
      }
      return Promise.resolve({});
    });

    await expect(
      provider.delete(
        'Table',
        'my-table',
        'AWS::DSQL::Cluster',
        {},
        { expectedRegion: 'ap-northeast-1', removeProtection: true }
      )
    ).resolves.toBeUndefined();

    const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    // Non-vacuity: the flip really failed and the warn really ran.
    expect(warned).toContain('proceeding with delete');
    // ...and it ends there, with no colon and no trailing separator.
    expect(warned).not.toContain('proceeding with delete: ');
  });

  it('reduces an AccessDenied flip failure, which quotes the caller identity back', async () => {
    // The flip's warn runs at DEFAULT verbosity and is where a
    // `--remove-protection` run reports a rejected flip. AWS words an authz
    // failure as `User: arn:aws:sts::<acct>:assumed-role/<role>/<session> is
    // not authorized to perform: ...`, so a user whose role lacks the update
    // permission printed their account id, role and session name into the
    // terminal -- and, for most users, into a CI job log that outlives the run
    // and is readable by more people than hold the credentials.
    //
    // Round 10 closed this as a side effect of routing the line through
    // `describePollFailure`: an `AccessDeniedException` carries `$fault`, so it
    // classifies service-authored and reduces. Pinned here rather than left
    // incidental, so the fix cannot be undone by a change that only looks like
    // it is about the abandonment path.
    const denied = Object.assign(
      new Error(
        'User: arn:aws:sts::123456789012:assumed-role/DeployerRole/cdkd-session is not \u001b[31mauthorized to perform: cloudcontrolapi:UpdateResource'
      ),
      { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 403 } }
    );
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'UpdateResourceCommand') return Promise.reject(denied);
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-del' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
      }
      return Promise.resolve({});
    });

    await expect(
      provider.delete(
        'Table',
        'my-table',
        'AWS::DSQL::Cluster',
        {},
        { expectedRegion: 'ap-northeast-1', removeProtection: true }
      )
    ).resolves.toBeUndefined();

    const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    // Non-vacuity: the flip really failed and really was swallowed.
    expect(warned).toContain('proceeding with delete');
    // The diagnosis survives...
    expect(warned).toContain('AccessDeniedException');
    // ...the caller identity does not.
    expect(warned).not.toContain('123456789012');
    expect(warned).not.toContain('DeployerRole');
    expect(warned).not.toContain('cdkd-session');
    // ...and `--verbose` still recovers the whole sentence, sanitized. The
    // `displaySafe` on that debug line is the flip's half of the "both debug
    // lines" pair; without this assertion it is deletable-green.
    const debugged = mockLoggerDebug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debugged).toContain('DeployerRole');
    expect(debugged).not.toContain('\u001b');
  });

  it('carries the abandoned flip\'s request token into the swallowed warning', async () => {
    // The swallow discards the ERROR, so the warn is the only place the token
    // survives — and the token is the whole point of go-to-k/cdkd#3236. Without
    // this, a flip that stalled and gave up is indistinguishable from one that
    // was rejected outright.
    wireFlipOutage();

    await provider.delete(
      'Table',
      'my-table',
      'AWS::DSQL::Cluster',
      {},
      { expectedRegion: 'ap-northeast-1', removeProtection: true }
    );

    const warnLines = mockLoggerWarn.mock.calls.map((c) => String(c[0]));
    // Pinned like the outer block's warn case: without a count, a second warn
    // appearing on this path would be invisible to the `toContain`s below.
    expect(warnLines.filter((l) => l.includes('proceeding with delete'))).toHaveLength(1);
    const warned = warnLines.join('\n');
    expect(warned).toContain('proceeding with delete');
    expect(warned).toContain('tok-flip');
    expect(warned).toContain('aws cloudcontrol get-resource-request-status');
  });
});

describe('isTransientPollFailure', () => {
  it.each([
    // Every member of POLL_TRANSPORT_ERROR_CODES and
    // POLL_TRANSPORT_ERROR_NAMES, not a representative sample (#3253 item 4).
    // The arms they take are shared, so a missing member costs nothing today —
    // but a member nothing reaches is a member nothing would notice losing, and
    // the sets are module-private so no fence can derive this list for us.
    ['ECONNREFUSED by code', transportError('connect ECONNREFUSED 1.2.3.4:443', 'ECONNREFUSED')],
    ['ECONNRESET by code', transportError('socket hang up', 'ECONNRESET')],
    ['ECONNABORTED by code', transportError('aborted', 'ECONNABORTED')],
    ['EPIPE by code', transportError('write EPIPE', 'EPIPE')],
    ['ETIMEDOUT by code', transportError('connect ETIMEDOUT 1.2.3.4:443', 'ETIMEDOUT')],
    ['ENOTFOUND by code', transportError('getaddrinfo ENOTFOUND h', 'ENOTFOUND')],
    ['EAI_AGAIN by code', transportError('getaddrinfo EAI_AGAIN h', 'EAI_AGAIN')],
    ['EHOSTUNREACH by code', transportError('connect EHOSTUNREACH 10.0.0.1:443', 'EHOSTUNREACH')],
    ['ENETUNREACH by code', transportError('connect ENETUNREACH 10.0.0.1:443', 'ENETUNREACH')],
    ['ENETDOWN by code', transportError('connect ENETDOWN 10.0.0.1:443', 'ENETDOWN')],
    ['EPROTO by code', transportError('write EPROTO', 'EPROTO')],
    ['TimeoutError by name', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    [
      'RequestTimeout by name',
      Object.assign(new Error('request timed out'), { name: 'RequestTimeout' }),
    ],
    [
      'RequestTimeoutException by name',
      Object.assign(new Error('request timed out'), { name: 'RequestTimeoutException' }),
    ],
    [
      'RequestAbortedException by name',
      Object.assign(new Error('aborted'), { name: 'RequestAbortedException' }),
    ],
    ['code only in the message', new Error('connect ECONNREFUSED 100.72.0.170:443')],
    [
      'one hop down the cause chain',
      Object.assign(new Error('CREATE failed'), {
        cause: transportError('connect EPIPE', 'EPIPE'),
      }),
    ],
    ['throttle by name', Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })],
    ['429 by status', Object.assign(new Error('x'), { $metadata: { httpStatusCode: 429 } })],
    ['503 by status', Object.assign(new Error('x'), { $metadata: { httpStatusCode: 503 } })],
  ])('accepts %s', (_label, error) => {
    expect(isTransientPollFailure(error)).toBe(true);
  });

  it.each([
    [
      'RequestTokenNotFoundException — the token is genuinely gone',
      Object.assign(new Error('Request token not found'), {
        name: 'RequestTokenNotFoundException',
      }),
    ],
    [
      'AccessDeniedException — a retry only re-derives it',
      Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }),
    ],
    [
      'ValidationException',
      Object.assign(new Error('bad input'), { name: 'ValidationException' }),
    ],
    ['a 400', Object.assign(new Error('x'), { $metadata: { httpStatusCode: 400 } })],
    ['a plain Error', new Error('something went sideways')],
    ['a service message that merely contains an E-word', new Error('ENCRYPTION is required')],
    ['undefined', undefined],
    ['null', null],
  ])('refuses %s', (_label, error) => {
    expect(isTransientPollFailure(error)).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isTransientPollFailure(a)).toBe(false);
  });
});

describe('parseResourceModel never echoes the model into its warn line (#3290)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudControlConfigRegion.mockResolvedValue('ap-northeast-1');
    provider = new CloudControlProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the failure CLASS, not JSON.parse\'s input-echoing message', async () => {
    // V8 quotes the input around the failure point, so `JSON.parse`'s own
    // message carries ~30 characters of the model — into a WARN line whose
    // comment promises it logs the SHAPE and never the body. A
    // `{{resolve:secretsmanager:...}}` value resolved into a non-write-only
    // property can round-trip back through a Cloud Control readback, which is
    // what makes that promise worth keeping.
    const SECRET = 'hunter2SuperSecretValue';
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'CreateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-parse' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({
          ProgressEvent: {
            OperationStatus: 'SUCCESS',
            Identifier: 'made-it',
            // Malformed on purpose: a well-formed model never enters the catch.
            ResourceModel: `{"pw": ${SECRET}}`,
          },
        });
      }
      return Promise.resolve({});
    });

    await provider.create('R', 'AWS::SQS::Queue', {});

    const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    // Non-vacuity: the line really was emitted, and really does carry the shape.
    expect(warned).toContain('Failed to parse resource model');
    expect(warned).toContain('Model shape:');
    // The case is named for the CLASS, so assert it positively: without this
    // the whole interpolation can be deleted and the negatives below still
    // pass.
    expect(warned).toContain('SyntaxError');
    // The defect: V8's message quotes the input, so the secret rode along.
    expect(warned).not.toContain(SECRET);
    expect(warned).not.toContain('hunter2Sup');
    // ...and the carve-out the doc comment now names explicitly: the DEBUG line
    // does carry the raw parser message, echo included. Pinned so the promise
    // and its exception cannot drift apart.
    const debugged = mockLoggerDebug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debugged).toContain('Resource model parse failure detail');
    expect(debugged).toContain('hunter2Sup');
  });

  it('SANITIZES the parse-failure detail line, whose text is an attacker-influenced readback', async () => {
    // Its own case rather than an assertion on the one above: a control char in
    // the model SHIFTS V8's echo window, so the two fixtures cannot be the same
    // one without weakening that case's `hunter2Sup` needle.
    //
    // The highest-value sanitizer site in this PR, and the only one whose text
    // is known to carry attacker-influenced bytes BY DESIGN: V8 quotes the
    // model back around the parse failure, and the model is a Cloud Control
    // readback. Measured by review as deletable-green before this existed.
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'CreateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-parse-esc' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({
          ProgressEvent: {
            OperationStatus: 'SUCCESS',
            Identifier: 'made-it',
            ResourceModel: '{"pw": \u001b[31mbroken}',
          },
        });
      }
      return Promise.resolve({});
    });

    await provider.create('R', 'AWS::SQS::Queue', {}).catch(() => undefined);

    const debugged = mockLoggerDebug.mock.calls.map((c) => String(c[0])).join('\n');
    // Non-vacuity: the detail line really ran and really echoed the model.
    expect(debugged).toContain('Resource model parse failure detail');
    expect(debugged).toContain('[31m');
    // ...with the ESC itself stripped, so no terminal sequence is driven.
    expect(debugged).not.toContain('\u001b');
  });
});

/**
 * Round 8's mutation audit found five sites that stayed GREEN when mutated, and
 * one fixture that could not exhibit the shape its own comment claimed. Each
 * case below reds a specific one of those mutations; the mutation is named in
 * the case so a later reader can re-run it rather than take this on trust.
 */
describe('round-8 mutation gaps in the abandonment path (#3236)', () => {
  let provider: CloudControlProvider;
  let now: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudControlConfigRegion.mockResolvedValue('ap-northeast-1');
    provider = new CloudControlProvider();
    now = 1_780_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockImplementation((ms: number) => {
      now += ms;
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Drive a CREATE whose polls never clear, so the wait is abandoned.
   *
   * WHICH exit it takes depends on the fixture, and both are used below: a
   * TRANSIENT shape spends the grace and leaves through it, while a shape
   * `isTransientPollFailure` refuses (a credential or token failure) abandons
   * on the FIRST poll through the non-retryable arm. The cause text is built
   * the same way on both, which is the point of the shared helper under test.
   */
  async function abandonCreate(thrown: Error | RawRejection): Promise<CloudControlWaitAbandonedError> {
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'CreateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-gap' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        if (thrown instanceof RawRejection) return Promise.reject(thrown.value);
        return Promise.reject(thrown);
      }
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-cleanup' } });
    });

    return (await provider.create('R', 'AWS::SQS::Queue', {}).then(
      () => undefined,
      (e: unknown) => e
    )) as CloudControlWaitAbandonedError;
  }

  it('WITHHOLDS a non-Error rejection rather than rendering it, and routes it to debug', async () => {
    // GAP 1. The whole non-`Error` arm was inert: making it unreachable was
    // green, and so was swapping `other.summary` for `other.detail`, which
    // leaks the thrown value into the PERSISTED `deployments/{runId}.jsonl`
    // message. Reachable in production because `isTransientPollFailure`
    // duck-types `code` off any object, so a duck-typed throw is admitted,
    // spends the grace, and arrives at `abandonWait`.
    const SECRET = 'aws_session_token=FwoGZXIvYXdzSECRETVALUE';
    const duckTyped = { code: 'ECONNRESET', message: `socket hang up ${SECRET}` };

    const error = await abandonCreate(rejectWith(duckTyped));

    expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
    // Withheld: the value's own text is nowhere in the persisted message...
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('socket hang up');
    // ...but the abandonment does not state "no reason at all" either.
    expect(error.message).toContain('a non-Error value of type object');
    // The detail half survives for a `--verbose` reader. Without this, a
    // revision that stopped logging the detail is indistinguishable from one
    // that never had it.
    const debugged = mockLoggerDebug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debugged).toContain("the abandoned operation's underlying failure was");
    // ...and the line really is emitted with a body, so the assertion above is
    // about content rather than about the phrase existing.
    expect(debugged).toContain('[object Object]');
    // MEASURED, and stronger than the summary claim: for a non-`Error` the
    // detail is `String(value)`, which for a plain object is `[object Object]`
    // -- so the thrown value reaches NEITHER channel, not even `--verbose`.
    // That is a real diagnosability cost of withholding a shape with no class
    // to fall back on, and it is stated here rather than asserted away: a
    // reviewer expected the secret on the debug line, and it is not there.
    expect(debugged).not.toContain(SECRET);
    // `cause` is deliberately NOT threaded — it is not an `Error`.
    expect(error.cause).toBeUndefined();
    expect(hasRedactedCause(error)).toBe(false);
  });

  it('does not out-throw the failure it is describing when the thrown value cannot be stringified', async () => {
    // GAP 1b. `describeAwsFailure` ends in `String(error)`, which THROWS for a
    // null-prototype object (`TypeError: Cannot convert object to primitive
    // value`). Every caller is inside a catch, so the throw would escape
    // `abandonWait`, replace the `CloudControlWaitAbandonedError`, and take the
    // `RequestToken` with it — #3236's exact defect, re-created by the helper
    // that exists to describe it.
    const hostile = Object.assign(Object.create(null) as object, { code: 'ECONNRESET' });

    const error = await abandonCreate(rejectWith(hostile));

    expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
    // The token is what must survive; that is the whole issue.
    expect(error.requestToken).toBe('tok-gap');
    expect(error.message).toContain('--request-token tok-gap');
  });

  it('produces the region-check refusal, not a TypeError, when the region probe rejects with a non-Error', async () => {
    // The pre-flight region check resolves the client's own region in a `try`
    // whose catch logs and then leaves `clientRegion` undefined, so
    // `assertRegionMatch` can raise its own "client region is unknown" refusal
    // rather than letting a raw SDK credential-chain error surface. That catch
    // read the text with a bare `String(error)`, which THROWS on a
    // null-prototype object -- turning the catch that exists to produce a clean
    // refusal into the thing that replaces it with a `TypeError`.
    //
    // Probed: reverting that line to the bare form reds this case.
    mockCloudControlConfigRegion.mockRejectedValue(
      Object.assign(Object.create(null) as object, { code: 'ENOTFOUND' })
    );
    mockCloudControlSend.mockImplementation(() => Promise.resolve({}));

    const error = (await provider
      .delete('Queue', 'my-queue', 'AWS::SQS::Queue', {}, { expectedRegion: 'ap-northeast-1' })
      .then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

    // cdkd's own refusal, naming the region it could not establish...
    expect(error.message).toContain('ap-northeast-1');
    // ...and NOT the primitive-conversion failure of the logging line.
    expect(error.message).not.toContain('convert object to primitive');
    expect(error).not.toBeInstanceOf(TypeError);
    // Non-vacuity: the refusal fired BEFORE any AWS call was issued.
    expect(commandNames()).not.toContain('DeleteResourceCommand');
  });

  it('KEEPS a TokenProviderError message, which is the SSO remedy, not a leak', async () => {
    // A round-9 revision widened the credential test from equality to the whole
    // `*ProviderError` suffix on a brittleness argument. Review measured the
    // family and the widening was WRONG in the direction that costs a user the
    // fix: `@aws-sdk/token-providers` never shells out, and its message IS the
    // remedy -- `Token is expired. To refresh this SSO session run 'aws sso
    // login' with the corresponding profile.` Reducing that to a wire name
    // leaves an SSO user with an expired token and nothing to act on.
    //
    // Mutation: re-widen the predicate to `/ProviderError$/` and this reds.
    const ssoFailure = Object.assign(
      new Error(
        "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile."
      ),
      { name: 'TokenProviderError' }
    );

    const error = await abandonCreate(ssoFailure);

    expect(error.message).toContain("run 'aws sso login'");
    // No reduction happened, so nothing was withheld and no marker is stamped.
    expect(hasRedactedCause(error)).toBe(false);
  });

  it('KEEPS an InstanceMetadataV1FallbackError message, a CredentialsProviderError SUBCLASS', async () => {
    // The other direction of the same enumeration. This is the ONLY subclass in
    // the installed tree that overrides `name`, so an equality test misses it --
    // and that is CORRECT rather than a gap: its message interpolates three
    // fixed literals naming config keys, with no argv, stderr, profile value or
    // identity in it, and a user disabling IMDSv1 needs to read which key did
    // it. Pinned so a future lane cannot "fix" the miss by widening.
    const imdsFailure = Object.assign(
      new Error(
        'AWS EC2 Metadata v1 fallback has been blocked by AWS SDK configuration in the following: [AWS_EC2_METADATA_V1_DISABLED]'
      ),
      { name: 'InstanceMetadataV1FallbackError' }
    );

    const error = await abandonCreate(imdsFailure);

    expect(error.message).toContain('AWS_EC2_METADATA_V1_DISABLED');
    expect(hasRedactedCause(error)).toBe(false);
  });

  it('stamps no marker and points at nothing when a SERVICE-authored error has an empty message', async () => {
    // The reduced arm's half of the empty-message case, and it was mutation-
    // GREEN: the transport fixture carries no `$fault`, so `serviceAuthored`
    // short-circuits and that case lands on the other arm entirely.
    //
    // Without the guard this renders `Error. Re-run with --verbose for AWS's
    // own message.` -- an instruction to go and read an empty string -- and
    // stamps `markRedactedCause` over a chain carrying no withheld text, which
    // `aws-failure-text.ts` calls worse than not stamping at all.
    const emptyService = Object.assign(new Error(), {
      code: 'ECONNRESET',
      $fault: 'client',
      $metadata: { httpStatusCode: 500, attempts: 1 },
    });

    const error = await abandonCreate(emptyService);

    expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
    expect(error.message).not.toContain(VERBOSE_POINTER);
    expect(error.message).not.toContain(': ).');
    expect(hasRedactedCause(error)).toBe(false);
    // Non-vacuity: the abandonment itself really happened.
    expect(error.requestToken).toBe('tok-gap');
  });

  it('sanitizes the DEBUG line too, which carries the raw withheld text', async () => {
    // Residual the round-9 audit measured: both `displaySafe` calls on the
    // abandonment's `debug` lines dropped GREEN across the whole provisioning
    // suite. `debug` is lower-exposure than the persisted message, not
    // exposure-free -- it is the line that carries AWS's own text and the raw
    // thrown value, i.e. exactly the strings an attacker-controlled endpoint
    // writes, and it renders into the same terminal.
    const ESC = '\u001b';
    const hostile = Object.assign(new Error(`denied${ESC}[31m by policy`), {
      $fault: 'client',
      $metadata: { httpStatusCode: 403, attempts: 1 },
    });

    const error = await abandonCreate(hostile);

    const debugged = mockLoggerDebug.mock.calls.map((c) => String(c[0])).join('\n');
    // Non-vacuity: the detail half really is on the debug channel...
    expect(debugged).toContain('by policy');
    // ...and the reduction really happened, so this is the withheld text.
    expect(error.message).not.toContain('by policy');
    expect(debugged).not.toContain(ESC);
  });

  it('renders no clause when the message is only whitespace, which sanitizing empties', async () => {
    // The guard tests the SANITIZED value, not the RAW one, and the difference
    // is a whole reachable case: `displaySafe` maps C0 / C1 / bidi to a space
    // and then TRIMS, so a control-only message is non-empty going in and empty
    // coming out. Keyed on the raw value it passes the guard and renders the
    // dangling `(<reason>: )` the guard exists to remove.
    //
    // Reachable: the message arm of `isTransientPollFailure` admits this (the
    // code is on the object), so it spends the grace and arrives with its
    // message intact. Probed: reversing the two operations reds this case.
    expect(displaySafe('\u0085\u2028 ')).toBe('');
    const blank = Object.assign(new Error('\u0085\u2028 '), {
      code: 'ECONNRESET',
      $metadata: { attempts: 3, totalRetryDelay: 58 },
    });

    const error = await abandonCreate(blank);

    expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
    expect(error.message).not.toContain(': ).');
    expect(error.message).toContain('could not reach Cloud Control API for');
  });

  it('renders no dangling clause on the RE-POLL WARN when the failure has an empty message', async () => {
    // The fourth site of the same guard. `asSdkError` yields an `Error` with
    // `message: ''`, which is transient by its `code`, so the loop re-polls and
    // this warn renders once per attempt -- previously as
    // `(attempt 1):  — the operation may still be running`, a colon and a dash
    // around nothing.
    const normalized = Object.assign(new Error(), {
      code: 'ECONNRESET',
      $metadata: { attempts: 3, totalRetryDelay: 58 },
    });

    const error = await abandonCreate(normalized);

    expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
    const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    // Non-vacuity: the re-poll warn really ran, so this is about the clause.
    expect(warned).toContain('could not read the Cloud Control operation status');
    expect(warned).not.toMatch(/\(attempt \d+\): {2}—/);
    expect(warned).not.toContain(':  —');
  });

  it('reduces a credential failure on the RE-POLL WARN too, not only on the abandonment', async () => {
    // The two channels shared no decision until round 10, and the gap was
    // reachable rather than theoretical: `POLL_TRANSPORT_CODE_IN_MESSAGE`
    // matches a socket code ANYWHERE in the message, so a `credential_process`
    // stderr that happens to contain one classifies as TRANSIENT. The warn --
    // DEFAULT verbosity, once per re-poll -- then printed the helper's argv and
    // its stderr, while the abandonment that eventually followed reduced them.
    //
    // Probed: reverting the warn to `describeAwsFailure(error).detail` reds.
    const SECRET = 'hvs.SUPERSECRETVAULTTOKEN';
    const credFailure = Object.assign(
      new Error(
        `Command failed: /bin/sh -c 'aws-vault exec prod'\nvault: ETIMEDOUT talking to server, token ${SECRET} rejected`
      ),
      { name: 'CredentialsProviderError' }
    );

    const error = await abandonCreate(credFailure);

    const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    // Non-vacuity: the re-poll warn really did run, so this failure really was
    // classified transient -- which is the premise the case rests on.
    expect(warned).toContain('could not read the Cloud Control operation status');
    expect(warned).not.toContain(SECRET);
    expect(warned).not.toContain('aws-vault');
    expect(warned).toContain('CredentialsProviderError');
    // ...and the persisted message agrees with it, which is the whole point.
    expect(error.message).not.toContain(SECRET);
    // The operator can still recover it with `--verbose`.
    const debugged = mockLoggerDebug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debugged).toContain(SECRET);
  });

  it('renders no dangling colon when the SDK normalized the rejection into an empty-message Error', async () => {
    // GAP: `@smithy/core`'s `asSdkError` turns a non-`Error` rejection that
    // crosses the retry middleware into `Object.assign(new Error(), obj)` — an
    // `Error` whose `message` is `''`. The transport arm rendered it
    // unconditionally, producing `(<reason>: ).`: a colon promising a reason
    // and then giving none, on the arm whose whole job is to KEEP the wording.
    const normalized = Object.assign(new Error(), {
      code: 'ECONNRESET',
      $metadata: { attempts: 3, totalRetryDelay: 58 },
    });

    const error = await abandonCreate(normalized);

    expect(error.message).not.toContain(': ).');
    expect(error.message).toContain('could not reach Cloud Control API for');
    // And the marker is NOT stamped over a chain carrying no text —
    // `aws-failure-text.ts` calls that worse than not stamping at all.
    expect(hasRedactedCause(error)).toBe(false);
  });

  it('bounds the poll cause-chain walk at POLL_CAUSE_CHAIN_DEPTH', () => {
    // GAP 2. `POLL_CAUSE_CHAIN_DEPTH` was mutable 5 -> 2 AND 5 -> 50 with the
    // suite green, while the constant's own doc comment claimed THIS file pins
    // it "by building a chain one hop deeper than the bound". It did not. Here
    // is that case: a transient code buried at the bound is still seen, and the
    // same code one hop past it is not.
    // The loop inspects depths 0 .. POLL_CAUSE_CHAIN_DEPTH-1, so FOUR wrappers
    // put the transient code at the last inspected depth and a fifth puts it
    // one past. Both directions matter: 5 -> 2 reds the first assertion, 5 -> 50
    // reds the second.
    const atBound = [0, 1, 2, 3].reduce<Error>(
      (inner, i) => Object.assign(new Error(`wrapper ${i}`), { cause: inner }),
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' })
    );
    const pastBound = Object.assign(new Error('wrapper 4'), { cause: atBound });

    expect(isTransientPollFailure(atBound)).toBe(true);
    expect(isTransientPollFailure(pastBound)).toBe(false);

    // The constant's doc comment states EQUALITY with `retryable-errors.ts`'s
    // own `MAX_CAUSE_CHAIN_DEPTH` — "a transport code this predicate finds at a
    // depth the retry classifiers structurally cannot reach means two
    // classifiers answering differently about one chain". That claim needs a
    // shape BOTH walks can see, which a socket code is not: build the same two
    // chains around a transient 503 and assert the two predicates flip at the
    // SAME hop. Raising either bound alone reds this.
    const wrap = (n: number, inner: Error): Error =>
      Array.from({ length: n }).reduce<Error>(
        (acc, _, i) => Object.assign(new Error(`wrapper ${i}`), { cause: acc }),
        inner
      );
    const serverError = Object.assign(new Error('Service Unavailable'), {
      $metadata: { httpStatusCode: 503 },
    });

    const at = wrap(4, serverError);
    const past = wrap(5, serverError);
    expect(isTransientPollFailure(at)).toBe(true);
    // The message argument is the WRAPPER's, which matches no retryable
    // pattern — so this answers from the chain walk alone, which is the bound
    // under test.
    expect(isRetryableTransientError(at, at.message)).toBe(true);
    expect(isTransientPollFailure(past)).toBe(false);
    expect(isRetryableTransientError(past, past.message)).toBe(false);
  });

  it('sanitizes the interpolated cause text and the re-poll warn', async () => {
    // GAP 3. Three `displaySafe` calls were unfenced while their two siblings
    // in `buildResumeCommand` were pinned. The threat is stated in the source:
    // `AWS_ENDPOINT_URL_CLOUDCONTROL` lets a caller point the client at text
    // they control, and the identifier is template-chosen.
    //
    // ESC and a bidi override in one string: ESC drives a terminal escape
    // sequence, RLO visually reverses what follows it. Written as escapes so
    // the characters cannot be lost by a tool that strips them in transit.
    const ESC = '\u001b';
    const RLO = '\u202e';
    const hostile = Object.assign(new Error(`socket ${ESC}[31mhang${RLO} up`), {
      code: 'ECONNRESET',
      $metadata: { attempts: 3, totalRetryDelay: 58 },
    });

    const error = await abandonCreate(hostile);

    expect(error.message).not.toContain(ESC);
    expect(error.message).not.toContain(RLO);
    // Non-vacuity: the surrounding text really did reach the message, so the
    // negatives above are about sanitization rather than about absence.
    expect(error.message).toContain('socket');
    const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    // The re-poll warn runs at DEFAULT verbosity, so it is the more exposed of
    // the two and the one the source comment names.
    expect(warned).toContain('could not read the Cloud Control operation status');
    expect(warned).not.toContain(ESC);
    expect(warned).not.toContain(RLO);
  });

  it('sanitizes the REDUCED cause text too, which the transport case cannot reach', async () => {
    // The transport case above exercises only the raw arm. The reduced arm
    // renders `error.name`, and a name is no safer than a message: Cloud
    // Control deserializes it out of the response body, and
    // `AWS_ENDPOINT_URL_CLOUDCONTROL` decides whose body that is. Probed: with
    // only the transport case present, dropping `displaySafe` from this arm
    // stayed green.
    const ESC = '\u001b';
    const RLO = '\u202e';
    const hostile = Object.assign(new Error('denied for arn:aws:sts::123456789012:role/Deployer'), {
      name: `Access${ESC}[31mDenied${RLO}Exception`,
      $fault: 'client',
      $metadata: { httpStatusCode: 403, attempts: 1 },
    });

    const error = await abandonCreate(hostile);

    // Non-vacuity: the reduced arm really did run — the wire name is present
    // and AWS's own sentence is not.
    expect(error.message).toContain('Denied');
    expect(error.message).not.toContain('123456789012');
    expect(error.message).not.toContain(ESC);
    expect(error.message).not.toContain(RLO);
  });

  it('strips a bidi MARK from the identifier clause, which the denylist alone keeps', async () => {
    // The identifier clause takes `displaySafe(..., { asciiOnly: true })`
    // because it renders on the same line as a pasteable command. Probed:
    // dropping `asciiOnly` stayed green, because every other case's identifier
    // is plain ASCII. U+200E is the discriminator — a bidi MARK, which the
    // denylist deliberately does NOT cover (`display-safe.ts` names the
    // residual) and only the positive allowlist removes. It is reachable: the
    // identifier is template-chosen for GlobalTable and ASG, and cdkd reads it
    // straight back out of the ProgressEvent.
    const MARK = '\u200e';
    let polls = 0;
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'CreateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-ident' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        // The FIRST answered poll names the identifier; then the link goes dark
        // and stays dark until the grace expires.
        polls++;
        if (polls === 1) {
          return Promise.resolve({
            ProgressEvent: { OperationStatus: 'IN_PROGRESS', Identifier: `my${MARK}table` },
          });
        }
        return Promise.reject(transportError('connect ECONNREFUSED 10.0.0.1:443', 'ECONNREFUSED'));
      }
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-cleanup' } });
    });

    const error = (await provider.create('R', 'AWS::SQS::Queue', {}).then(
      () => undefined,
      (e: unknown) => e
    )) as CloudControlWaitAbandonedError;

    expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
    // Non-vacuity: the clause really is rendered, carrying the surrounding text.
    expect(error.message).toContain('The last status cdkd read named the resource');
    // `sanitizeAsciiOnly` REPLACES a non-ASCII code point with a space rather
    // than deleting it, so the rendered form is `my table` — asserted
    // literally, because it is the discriminator: the denylist mode keeps
    // U+200E verbatim and would render `my<MARK>table`.
    expect(error.message).toContain('my table');
    expect(error.message).not.toContain(MARK);
    // Non-vacuity from the other side: the RAW identifier really did carry the
    // mark, so the message's not-contains is about sanitization.
    expect(error.lastSeenIdentifier).toContain(MARK);
  });

  it('keeps a production-shaped RequestTokenNotFoundException out of the already-deleted path by the MARKER, not by wording', async () => {
    // GAP 5, and the one that corrects a claim rather than adding coverage.
    // The DELETE phrase fence asserts the rendered message carries none of the
    // four classifiers' phrases, and its comment calls `ENOTFOUND` "the live
    // near-miss". Measured: it is not the near miss — a production-shaped
    // `RequestTokenNotFoundException` ($fault 'client', httpStatusCode 404) is
    // REDUCED TO ITS WIRE NAME, and that name CONTAINS `NotFound` and
    // `NotFoundException`. So the phrase-free property genuinely does not hold
    // for the one shape Cloud Control raises about a request token.
    //
    // That is safe, and this case pins WHY: the wording layer is the weaker
    // half and the marker is the structural one. Mutation: drop
    // `markWaitAbandoned` from the constructor and the guard assertion reds,
    // while a phrase assertion would have gone on passing.
    const tokenGone = Object.assign(new Error('Request token tok-phrases was not found'), {
      name: 'RequestTokenNotFoundException',
      $fault: 'client',
      $metadata: { httpStatusCode: 404, attempts: 1 },
    });
    mockCloudControlSend.mockImplementation((command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-phrases' } });
      }
      if (name === 'GetResourceRequestStatusCommand') return Promise.reject(tokenGone);
      return Promise.resolve({});
    });

    const error = (await provider
      .delete('Queue', 'my-queue', 'AWS::SQS::Queue', {}, { expectedRegion: 'ap-northeast-1' })
      .then(
        () => undefined,
        (e: unknown) => e
      )) as CloudControlWaitAbandonedError;

    expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
    // AWS's own sentence is withheld; only the wire name survives...
    expect(error.message).not.toContain('was not found');
    // ...and the wire name DOES carry a phrase the classifiers match. Asserted
    // positively so a future reader cannot mistake this for an oversight.
    expect(error.message).toContain('RequestTokenNotFoundException');
    expect(ALREADY_DELETED_PHRASES.some((p) => error.message.includes(p))).toBe(true);
    // The marker is what stops all four classifiers dropping the state row.
    expect(isWaitAbandonedError(error)).toBe(true);
    // Unmarked for retry, so the destroy runner can re-issue the delete.
    expect(isMarkedNonRetryable(error)).toBe(false);
  });
});
