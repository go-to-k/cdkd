import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
// Hoisted so the `--revert` / `--accept` cases can assert the POSITIVE marker.
// "provider.update was not called" is a confluence point -- a run that errored
// out before reaching the remediation loop satisfies it just as well as one that
// correctly declined -- so the line the correct path PRINTS is what those tests
// read.
const infoSpy = vi.hoisted(() => vi.fn());
// Hoisted because the guard writes TWO lines at debug level, and both were
// unasserted: the stack-detail line under `--verbose`, and the no-read-path
// downgrade note. A mocked `vi.fn()` swallows an argument that would have
// CRASHED the real logger, which is how a `JSON.stringify`-on-a-cycle throw
// survived a green suite.
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

// Issue #1515: the principal canonicalization resolves an IAM role/user ARN to
// its unique id via `iam:GetRole` / `GetUser`. The client is only touched when
// a policy actually carries a unique-id principal, so every other test in this
// file never reaches it.
const mockIamSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get iam() {
      return { send: mockIamSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

const mockGetState =
  vi.fn<
    (
      stackName: string,
      region: string
    ) => Promise<{ state: StackState; etag: string; migrationPending?: boolean } | null>
  >();
const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
const mockSaveState =
  vi.fn<
    (
      stackName: string,
      region: string,
      state: StackState,
      options?: { expectedEtag?: string; migrateLegacy?: boolean }
    ) => Promise<string>
  >();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
    saveState: mockSaveState,
  })),
}));

const mockAcquireLock = vi.fn<() => Promise<boolean>>();
// Issue #2170: production calls `getLockInfo` to name the holder. Without it
// on the mock the call THREW, the best-effort catch swallowed it, and the
// assertion below still matched the degraded wording — so the test certified
// nothing about this change.
const mockGetLockInfo = vi.fn<() => Promise<unknown>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    getLockInfo: mockGetLockInfo,
    releaseLock: mockReleaseLock,
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
const mockRegistryShouldSkip = vi.fn<(resourceType: string) => boolean>().mockReturnValue(false);
const mockRegistrySetCustomBucket = vi.fn();
// #614: drift's new code path uses `getProviderFor({resourceType, provisionedBy})`
// instead of `getProvider(type)`. Wrap the existing `getProvider` mock so
// the routing-decision shape is returned with `provisionedBy: 'sdk'`
// (legacy default; the test fixtures don't set state.provisionedBy).
const mockRegistryGetProviderFor = vi
  .fn<(input: { resourceType: string }) => unknown>()
  .mockImplementation((input) => ({
    provider: mockRegistryGetProvider(input.resourceType),
    provisionedBy: 'sdk',
  }));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: mockRegistryGetProviderFor,
    shouldSkipResource: mockRegistryShouldSkip,
    setCustomResourceResponseBucket: mockRegistrySetCustomBucket,
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

// PR J: drift falls back to Cloud Control API when an SDK provider does
// not implement `readCurrentState`. Mock the CC API readCurrentState so
// tests can simulate "fallback returns undefined" (drift unknown) by
// default; tests that exercise the fallback override per-call.
const mockCcReadCurrentState = vi
  .fn<(physicalId: string, logicalId: string, type: string) => Promise<Record<string, unknown> | undefined>>()
  .mockResolvedValue(undefined);
vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: mockCcReadCurrentState,
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';

/**
 * Issues [#2151](https://github.com/go-to-k/cdkd/issues/2151),
 * [#1945](https://github.com/go-to-k/cdkd/issues/1945) and
 * [#2154](https://github.com/go-to-k/cdkd/issues/2154).
 *
 * ONE root cause with two reported sites: a per-resource call in the drift loop
 * was unguarded, so a throw aborted the whole run and every OTHER resource in
 * the stack went unchecked. #2151 reported it at the Cloud Control fallback,
 * #1945 at `calculateResourceDrift`.
 *
 * The load-bearing assertion in almost every case below is the SIBLING one --
 * that a second, ordinary resource in the same stack was still compared. That is
 * the discriminator, and it is deliberately not the obvious one: the obvious
 * assertion is "the bad resource is reported as X", which is ALSO satisfied by
 * plenty of broken implementations, including the pre-fix one on a stack with a
 * single resource. Every fixture here therefore carries a sibling, and the
 * sibling is the only thing that distinguishes "guarded" from "aborted".
 *
 * #2154 rides along because this fix PROMOTES it: once a throwing resource
 * becomes an outcome instead of an abort, a stack whose only resource threw
 * renders a report -- and before #2154 that report carried the reassuring glyph.
 */

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function runDrift(args: string[]): Promise<{ output: string; error: unknown }> {
  const cap = captureStdout();
  let error: unknown;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    cap.restore();
  }
  return { output: cap.output.join(''), error };
}

/**
 * Every debug arg the command emitted, rendered the way `ConsoleLogger` renders
 * them -- extra args through `JSON.stringify`. That is the whole point: a spy
 * that merely RECORDS an argument cannot see that the real logger would print
 * `{}` for it, or throw on it. Anything this helper cannot stringify is a crash
 * in production at `--verbose`.
 */
function debugRendered(): string {
  return debugSpy.mock.calls
    .map((call: unknown[]) =>
      call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    )
    .join('\n');
}

/** Every line the command logged at info level, in one string. */
function infoText(): string {
  return infoSpy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')).join('\n');
}

const LAMBDA = 'AWS::Lambda::Function';
const QUEUE = 'AWS::SQS::Queue';

function makeState(
  resources: StackState['resources'],
  stackName = 'TestStack'
): {
  state: StackState;
  etag: string;
} {
  return {
    state: {
      version: 2,
      stackName,
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

function resource(resourceType: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId: `phys-${resourceType}`, resourceType, properties };
}

/**
 * The SIBLING every fixture carries: an ordinary resource whose provider reads
 * back cleanly and matches state. If the run aborted, this resource produces no
 * outcome at all -- which is exactly what the pre-fix behaviour did and what the
 * `clean`/`checked` assertions detect.
 */
const SIBLING_PROVIDER = {
  readCurrentState: async () => ({ QueueName: 'ok' }),
};

const ARGS = ['TestStack', '--state-bucket', 'b', '--region', 'us-east-1'];

/** An SDK-shaped error: `name` is what the AWS SDK v3 sets. */
function awsError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('a per-resource failure does not sink the whole drift run (#2151 / #1945)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
    mockSaveState.mockReset().mockResolvedValue('"etag-2"');
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    mockCcReadCurrentState.mockReset().mockResolvedValue(undefined);
    mockIamSend.mockReset();
    errorSpy.mockReset();
    warnSpy.mockReset();
    infoSpy.mockReset();
    debugSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  /**
   * #2151's measured shape: the SDK provider has no `readCurrentState`, so the
   * loop takes the Cloud Control fallback, and the fallback THROWS
   * `UnsupportedActionException` because the type has no READ handler.
   *
   * Reports `unsupported`, NOT `readFailed`. The condition is permanent by
   * construction -- the type will not grow a handler because this run failed --
   * so routing it to the exit code would fail such a stack's CI forever, which
   * is the same argument `unresolvedToken` is excluded on. It is also the SAME
   * condition the fallback signals by returning `undefined`, and AWS picks which
   * spelling it sends.
   */
  it('a Cloud Control fallback that throws UnsupportedActionException reports unsupported, and the sibling is still compared', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Detector: resource('AWS::CloudWatch::AnomalyDetector', { MetricName: 'm' }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE ? SIBLING_PROVIDER : {}
    );
    mockCcReadCurrentState.mockRejectedValue(
      awsError(
        'UnsupportedActionException',
        'Resource type AWS::CloudWatch::AnomalyDetector does not support READ action'
      )
    );

    const { output, error } = await runDrift(ARGS);

    // THE discriminator. Pre-fix the throw propagated out of the loop, so the
    // command produced no report at all and this string could not appear.
    expect(output).toContain('? Detector (AWS::CloudWatch::AnomalyDetector)');
    expect(output).toContain('drift unknown');
    // The sibling was compared -- the whole point of the guard.
    expect(output).toContain('(1 resource checked, 1 unsupported)');
    // Permanent condition -> exit 0, and no throw escaped the command.
    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    // NOT routed to the actionable bucket.
    expect(output).not.toContain('NOT fully compared');
    // The downgrade SAYS SO at debug. This arm is the one place the guard is
    // quieter than main -- main aborted loudly on this throw, and the `?` line
    // it now prints is identical to the one a provider with no
    // `readCurrentState` yields, so without this the fact that something THREW
    // is unrecoverable. Deleting the debug call fails here.
    expect(debugRendered()).toContain('read threw with a no-READ-handler signature');
  });

  /**
   * The same site, but an error a RE-RUN CAN CLEAR. This is the half that must
   * NOT be reported `unsupported`: saying "cdkd cannot read this type" about a
   * type it reads fine on every other run is a false statement, and it would
   * exit 0 over a resource nobody compared.
   */
  it('a Cloud Control fallback that throws AccessDenied reports readFailed and exits 2, and the sibling is still compared', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Detector: resource('AWS::CloudWatch::AnomalyDetector', { MetricName: 'm' }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE ? SIBLING_PROVIDER : {}
    );
    mockCcReadCurrentState.mockRejectedValue(
      awsError('AccessDeniedException', 'User is not authorized to perform: cloudformation:GetResource')
    );

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('NOT fully compared');
    expect(output).toContain('not compared AT ALL (the read or comparison failed)');
    expect(output).toContain('! Detector (AWS::CloudWatch::AnomalyDetector)');
    // The SUMMARY line's conditional arm, which is a different string from the
    // block heading above and was unfenced: `not fully compared` appeared
    // nowhere under tests/, so swapping the ternary's two arms left the suite
    // green. The else-arm is byte-identical to main and is fenced by
    // drift-cross-region-secret.test.ts.
    expect(output).toContain('(1 not fully compared), 0 unsupported');
    // The sibling was compared. `1 of 2 ... fully checked` is the discriminator:
    // an earlier revision asserted `toContain('Detector')` here under a "sibling
    // was compared" comment, which is the FAILING resource and was already
    // asserted one line up -- it passed for the wrong reason. `no drift
    // detected` is no better: the ⚠ branch prints that phrase too, so a run that
    // compared NOTHING satisfies it.
    expect(output).toContain('1 of 2 resources fully checked');
    // Actionable -> exit 2, distinct from the `1` that means drift detected.
    // #2151's complaint was precisely that a CI gate could not tell the two
    // apart, so the CODE is asserted -- and BOTH directions are, because
    // `toHaveBeenCalledWith(2)` alone passes on a run that exited 1 as well.
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    void error;
    // Never reported as a type cdkd cannot read.
    expect(output).not.toContain('? Detector');
  });

  /**
   * #1945's site: the SDK provider reads back fine and the COMPARISON throws.
   * Driven through a provider-authored hook the comparison path calls, because
   * that is the realistic shape -- a normalizer assuming a field the provider
   * omitted.
   */
  it('a provider-authored canonicalizer that throws reports readFailed, and the sibling is still compared', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? SIBLING_PROVIDER
        : {
            readCurrentState: async () => ({ MemorySize: 128 }),
            canonicalizeDriftProperties: () => {
              throw new TypeError("Cannot read properties of undefined (reading 'Runtime')");
            },
          }
    );

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('! Fn (AWS::Lambda::Function)');
    expect(output).toContain('the read or comparison threw');
    // The sibling was compared. Pre-fix this TypeError propagated out of the
    // command and no report existed at all. Asserted as the COUNT, not as
    // `no drift detected` -- the ⚠ branch prints that phrase over
    // `0 of 2 ... fully checked` as well, so the phrase alone does not
    // distinguish `continue` from `break`.
    expect(output).toContain('1 of 2 resources fully checked');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    void error;
  });

  /**
   * The SDK read path, which neither issue named. #2151 reported the Cloud
   * Control fallback and #1945 the comparator; this site sits between them and
   * was unguarded for the same reason. It is here because a guard written for
   * the two REPORTED sites would have left it -- the sweep is the point.
   */
  it("a provider's own readCurrentState that throws reports readFailed, and the sibling is still compared", async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? SIBLING_PROVIDER
        : {
            readCurrentState: async () => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('! Fn (AWS::Lambda::Function)');
    expect(output).toContain('1 of 2 resources fully checked');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    void error;
  });

  /**
   * The wrapped spelling. `CloudControlProvider.handleError` turns the same two
   * SDK error names into a `ProvisioningError` and keeps the original as
   * `cause`, so a detection that only read the TOP-LEVEL `name` would route this
   * to `readFailed` and exit 2 forever for a type that simply has no read path.
   */
  it('an UnsupportedActionException wrapped in another error is still recognized through the cause chain', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Detector: resource('AWS::CloudWatch::AnomalyDetector', { MetricName: 'm' }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE ? SIBLING_PROVIDER : {}
    );
    const wrapped = new Error('Resource type is not supported by Cloud Control API');
    wrapped.name = 'ProvisioningError';
    (wrapped as Error & { cause?: unknown }).cause = awsError(
      'UnsupportedActionException',
      'no READ handler'
    );
    mockCcReadCurrentState.mockRejectedValue(wrapped);

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('? Detector (AWS::CloudWatch::AnomalyDetector)');
    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  /**
   * `TypeNotFoundException` -- the OTHER name in `NO_READ_HANDLER_NAMES`. Both
   * arms of a disjunction need their own case: with only the
   * `UnsupportedActionException` one, deleting this name from the set left the
   * suite green, which is the unfenced-disjunction shape this repo keeps getting
   * bitten by.
   */
  it('a TypeNotFoundException is also treated as no-read-path, not as a read failure', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Detector: resource('AWS::Some::UnregisteredType', {}),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE ? SIBLING_PROVIDER : {}
    );
    mockCcReadCurrentState.mockRejectedValue(
      awsError('TypeNotFoundException', 'Type AWS::Some::UnregisteredType was not found')
    );

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('? Detector (AWS::Some::UnregisteredType)');
    // Anchored: a bare `1 resource checked` is a SUBSTRING of the
    // `0 of 1 resource checked` the #2154 warning branch prints, so the loose
    // spelling passes on exactly the output that means nothing was compared.
    expect(output).toContain('(1 resource checked, 1 unsupported)');
    expect(output).not.toContain('NOT fully compared');
    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  /**
   * The MESSAGE fallback, which nothing reached before: both no-read-path cases
   * above match by `name`, so deleting the regex clause entirely left the suite
   * green. It exists for an error re-wrapped in a way that keeps neither the
   * name nor the cause, so the fixture has to be exactly that.
   */
  it('an error that lost its name and cause is still recognized by its message', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Detector: resource('AWS::CloudWatch::AnomalyDetector', { MetricName: 'm' }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE ? SIBLING_PROVIDER : {}
    );
    // Deliberately a bare `Error`: `name` is 'Error' and there is no `cause`, so
    // the name walk cannot match and only the phrase can.
    mockCcReadCurrentState.mockRejectedValue(
      new Error('Resource type AWS::CloudWatch::AnomalyDetector does not support READ action')
    );

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('? Detector (AWS::CloudWatch::AnomalyDetector)');
    expect(exitSpy).not.toHaveBeenCalled();
    void error;
  });

  /**
   * The OTHER direction of that clause, which decides whether the phrase may be
   * matched loosely. A genuine read failure whose text merely contains
   * `does not support` must NOT be downgraded to exit 0 -- the regex is the full
   * phrase for exactly this reason, and without a case saying so, loosening it
   * to `/does not support/` is a silent one-character change that makes a real
   * failure report a pass.
   */
  it('a read failure whose text says "does not support" something ELSE is still a read failure', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? SIBLING_PROVIDER
        : {
            readCurrentState: async () => {
              throw awsError(
                'ValidationException',
                'This account does not support the requested configuration'
              );
            },
          }
    );

    const { output } = await runDrift(ARGS);

    expect(output).toContain('! Fn (AWS::Lambda::Function)');
    expect(output).not.toContain('? Fn');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  /**
   * The bound on the cause walk. A wrapper whose `cause` points back at itself
   * would spin forever INSIDE the guard that exists to keep the command running,
   * which is a worse failure than the one being fixed: the pre-fix behaviour at
   * least terminated.
   */
  it('a self-referential cause chain terminates instead of hanging', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE ? SIBLING_PROVIDER : {}
    );
    const loop = new Error('wrapped');
    loop.name = 'SomeWrapper';
    (loop as Error & { cause?: unknown }).cause = loop;
    mockCcReadCurrentState.mockRejectedValue(loop);

    const { output, error } = await runDrift(ARGS);

    // Terminated, and classified as the loud outcome (no name in the chain
    // matched, which is the safe side).
    expect(output).toContain('! Fn (AWS::Lambda::Function)');
    expect(output).toContain('1 of 2 resources fully checked');
    expect(exitSpy).toHaveBeenCalledWith(2);
    void error;
  });

  /**
   * The `--verbose` stack line, and the reason it is asserted through a helper
   * that STRINGIFIES rather than off the spy's raw argument.
   *
   * The first version of this line passed the Error OBJECT to `logger.debug`.
   * A spy records that happily and every suite stayed green, but
   * `ConsoleLogger.formatMessage` renders extra args with `JSON.stringify`, and
   * an Error's `message` / `stack` are non-enumerable -- `maskSecretsInError`
   * re-defines them that way itself -- so the real logger printed `{}` for
   * exactly the population the line exists for. Asserting the RENDERED form is
   * what makes a mocked logger tell the truth about the real one.
   */
  it('--verbose emits the masked STACK, rendered as text rather than an empty object', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? SIBLING_PROVIDER
        : {
            readCurrentState: async () => ({ MemorySize: 128 }),
            canonicalizeDriftProperties: () => {
              throw new TypeError('normalizer exploded');
            },
          }
    );

    await runDrift([...ARGS, '--verbose']);

    const rendered = debugRendered();
    expect(rendered).toContain('comparison failure detail');
    // A real stack, not `{}`. Passing the Error object renders `{}` and fails
    // here; passing `.stack` renders the frames.
    expect(rendered).toContain('normalizer exploded');
    expect(rendered).not.toContain('detail {}');
  });

  /**
   * The blocker this whole arm exists for: at `--verbose`, a CIRCULAR error must
   * not take the command down.
   *
   * `err.cause = err` by ordinary assignment is an OWN ENUMERABLE property, so
   * `JSON.stringify` throws `Converting circular structure to JSON` on it. With
   * the Error object passed to `logger.debug`, that throw came from INSIDE the
   * per-resource catch handler -- escaping the catch, the loop and the command,
   * which is issue go-to-k/cdkd#2151 reintroduced by its own fix. The cycle case
   * further up this file does not catch it, because it never runs `--verbose`.
   */
  it('--verbose with a CIRCULAR error still completes and still compares the sibling', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    const loop = new Error('circular boom');
    loop.name = 'SomeWrapper';
    (loop as Error & { cause?: unknown }).cause = loop;
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? SIBLING_PROVIDER
        : {
            readCurrentState: async () => {
              throw loop;
            },
          }
    );

    const { output } = await runDrift([...ARGS, '--verbose']);

    // The run COMPLETED: the sibling was compared and a report exists.
    expect(output).toContain('! Fn (AWS::Lambda::Function)');
    expect(output).toContain('1 of 2 resources fully checked');
    expect(exitSpy).toHaveBeenCalledWith(2);
    // ...and the debug arg is renderable, which is the property that was false.
    expect(() => debugRendered()).not.toThrow();
  });

  /**
   * `isNoReadHandlerError`'s own try/catch (deleting it left the suite green).
   * A throwing getter on `name` is the realistic shape -- a Proxy or a lazily
   * computed property -- and reading it happens INSIDE the per-resource catch,
   * so an escape here is the same hole one level deeper.
   */
  it('an error whose name getter THROWS is classified as a read failure, not a crash', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    const hostile = {
      get name(): string {
        throw new Error('getter exploded');
      },
      get message(): string {
        throw new Error('getter exploded');
      },
    };
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? SIBLING_PROVIDER
        : {
            readCurrentState: async () => {
              throw hostile;
            },
          }
    );

    const { output } = await runDrift(ARGS);

    // Classified loud (the safe direction) rather than escaping.
    expect(output).toContain('! Fn (AWS::Lambda::Function)');
    expect(output).toContain('1 of 2 resources fully checked');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  /**
   * `--json`: the two keys issues #2151 / #1945 moved.
   *
   * `referencesUnresolved` was the literal `true` for every entry in this array;
   * for a `readFailed` one that is FALSE -- nothing about its references is
   * unresolved, its read threw. `cause` is the additive key a CI job keys on to
   * tell a clearable cause from a permanent one.
   */
  it('--json reports cause readFailed with referencesUnresolved false', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? SIBLING_PROVIDER
        : {
            readCurrentState: async () => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { output } = await runDrift([...ARGS, '--json']);
    const parsed = JSON.parse(output) as Array<{
      clean: Array<{ logicalId: string }>;
      notCompared: Array<{ logicalId: string; referencesUnresolved: boolean; cause: string }>;
    }>;

    expect(parsed[0]!.notCompared).toEqual([
      {
        logicalId: 'Fn',
        type: LAMBDA,
        referencesUnresolved: false,
        cause: 'readFailed',
      },
    ]);
    // The sibling is in `clean`, which is the machine-readable form of the
    // sibling assertion every case above makes against stdout.
    expect(parsed[0]!.clean.map((c) => c.logicalId)).toEqual(['Queue']);
  });

  /**
   * NEGATIVE CONTROL. A guard that reported `readFailed` for everything would
   * satisfy every positive assertion above, so one case has to prove an ordinary
   * clean run is untouched: same fixture, no throw.
   */
  it('an ordinary clean run is unaffected: no readFailed, ✓ glyph, exit 0', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE ? SIBLING_PROVIDER : { readCurrentState: async () => ({ MemorySize: 128 }) }
    );

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('✓ TestStack (us-east-1): no drift detected');
    expect(output).toContain('2 resources checked');
    expect(output).not.toContain('NOT fully compared');
    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  /**
   * The other negative control, on the DIRECTION the guard could over-reach in:
   * real drift on a resource whose sibling threw must still be reported and
   * still exit 1. A catch that swallowed too much is the usual way this class is
   * over-fixed, and `1` (drift) must keep outranking `2` (incomplete).
   */
  it('real drift still exits 1 even when another resource in the same stack threw', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? { readCurrentState: async () => ({ QueueName: 'CHANGED-IN-CONSOLE' }) }
        : {
            readCurrentState: async () => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('drift detected on 1 resource');
    expect(output).toContain('QueueName');
    // Drift outranks the incomplete comparison.
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(2);
    void error;
    // ...and the failed one is still reported rather than hidden by the drift.
    expect(output).toContain('! Fn (AWS::Lambda::Function)');
  });

  /**
   * go-to-k/cdkd#1945's SECOND open question, asserted rather than left to fall
   * out. It reads: "whether `--revert` should attempt the resource anyway. It
   * cannot know whether it drifted, so refusing is probably right, but say so
   * explicitly rather than letting it fall out of the implementation."
   *
   * It DOES fall out -- both remediation paths iterate the drifted outcomes only
   * -- and that is precisely why it is pinned: a structural guarantee nothing
   * asserts is one refactor away from a `readFailed` resource being written to
   * AWS on the strength of a comparison that never happened.
   */
  it('--revert does not touch a resource whose read failed', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? { ...SIBLING_PROVIDER, update }
        : {
            readCurrentState: async () => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
            update,
          }
    );

    const { output } = await runDrift([...ARGS, '--revert', '--yes']);

    // THE assertion: nothing is written to AWS for a resource cdkd could not
    // compare.
    expect(update).not.toHaveBeenCalled();
    // Issue #2208 replaced the line this reads. `nothing to revert` is a
    // SUBSTRING of the new one, so it would have passed unchanged while saying
    // nothing about which of the two was printed; the discriminating half is
    // that the run no longer claims no drift was detected.
    expect(infoText()).toContain('Comparison INCOMPLETE — nothing to revert');
    expect(infoText()).not.toContain('No drift detected');
    void output;
  });

  /**
   * The per-entry REASON strings, which nothing read: every case above asserts
   * `! <id> (<type>)`, so swapping the `refused` and `unresolvedToken` wordings
   * in `notComparedReason` -- or blanking either -- left the suite green. The
   * strings are the only place the report tells a user WHICH of three things
   * happened, so an exhaustive record that nobody reads is a compile-time fence
   * around a runtime lie.
   *
   * Both non-`readFailed` causes are driven here in ONE stack, which also fences
   * the mixed-population heading: with a `readFailed` entry beside a
   * reference-caused one the heading must count them separately rather than
   * calling all three "partially compared".
   */
  it('each not-compared entry names its own cause, and a mixed population is counted apart', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        // `ssm-secure` is the spelling cdkd resolves for nobody -> unresolvedToken.
        Tokened: resource(LAMBDA, {
          Environment: { Variables: { PW: '{{resolve:ssm-secure:/pw}}' } },
        }),
        Thrower: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === LAMBDA
        ? {
            readCurrentState: async () => ({
              Environment: { Variables: { PW: 'live-value' } },
            }),
          }
        : {
            readCurrentState: async () => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { output } = await runDrift(ARGS);

    // The WHOLE LINE per entry, pairing the resource with its reason. Asserting
    // the two reason strings independently is vacuous here and was measured so:
    // a mutation that gives `refused` the `unresolvedToken` wording leaves the
    // phrase present in this output (the Tokened entry still carries it), so a
    // bare `toContain('resolves for nobody')` passed under the very swap it was
    // written to catch. The pairing is what cannot be satisfied by accident.
    expect(output).toContain(
      '! Tokened (AWS::Lambda::Function) — its state records a `{{resolve:...}}` spelling cdkd resolves for nobody'
    );
    expect(output).toContain(
      '! Thrower (AWS::SQS::Queue) — the read or comparison threw, so NONE of its properties were compared'
    );
    // ...and the heading counts them apart rather than lumping both under
    // "partially". Nothing else in the suite has both populations at once.
    expect(output).toContain('not compared AT ALL (the read or comparison failed)');
    expect(output).toContain('only PARTIALLY compared');
  });

  /**
   * The OUTER loop. go-to-k/cdkd#1945 states the blast radius as "the whole
   * stack, and on `--all` every remaining stack with it", and every other case
   * here proves only that the throw does not escape ONE stack's per-resource
   * loop. That it therefore cannot reach the multi-stack driver is a structural
   * argument, and this repo's rule is that a structural guarantee nothing
   * asserts is one refactor from being false -- the same reason the
   * `--revert` / `--accept` cases above are pinned rather than reasoned about.
   *
   * The FIRST stack is the one that throws, deliberately: if the throw escaped,
   * the second stack would never be read at all, so the discriminator is that
   * StackB's resource appears in the report.
   */
  it('--all: a throw in the first stack does not stop the second stack being compared', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'StackA', region: 'us-east-1' },
      { stackName: 'StackB', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (stackName: string) =>
      stackName === 'StackA'
        ? makeState({ Fn: resource(LAMBDA, { MemorySize: 128 }) }, 'StackA')
        : makeState({ Queue: resource(QUEUE, { QueueName: 'ok' }) }, 'StackB')
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? SIBLING_PROVIDER
        : {
            readCurrentState: async () => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { output } = await runDrift(['--all', '--state-bucket', 'b', '--region', 'us-east-1']);

    // StackA reported its failure...
    expect(output).toContain('! Fn (AWS::Lambda::Function)');
    // ...and StackB was still READ and compared. Pre-fix the throw escaped
    // `runDriftForStack` into the driver loop and this stack was never touched.
    // The full parenthetical, with StackB's OWN counts -- it has no unsupported
    // resource, so the `1 unsupported` spelling the single-stack cases use is
    // simply the wrong literal here rather than a stricter one.
    expect(output).toContain('✓ StackB (us-east-1): no drift detected (1 resource checked, 0 unsupported)');
    // The run still reports the incomplete comparison rather than passing.
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  /**
   * The same for `--accept`, which writes the AWS-current value into STATE. A
   * `readFailed` resource has no AWS-current value cdkd ever read, so accepting
   * one would persist a bag that came from nowhere.
   */
  it('--accept does not persist anything for a resource whose read failed', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? SIBLING_PROVIDER
        : {
            readCurrentState: async () => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { output } = await runDrift([...ARGS, '--accept', '--yes']);

    expect(mockSaveState).not.toHaveBeenCalled();
    // Same as the `--revert` twin above: issue #2208's line, not the old one
    // that reported a clean bill of health for a stack it half read.
    expect(infoText()).toContain('Comparison INCOMPLETE — nothing to accept');
    expect(infoText()).not.toContain('No drift detected');
    void output;
  });
});

/**
 * Issue [#2154](https://github.com/go-to-k/cdkd/issues/2154): the glyph follows
 * "was everything actually compared". A stack where the answer is "none of it"
 * is the extreme case, and it used to get the opposite answer.
 */
describe('a stack in which NOTHING was compared does not get the ✓ glyph (#2154)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    mockCcReadCurrentState.mockReset().mockResolvedValue(undefined);
    warnSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  /**
   * The `skipped`-only case, which #2154 flagged as a SEPARATE user-visible
   * decision rather than an obvious consequence. Taken deliberately: the
   * sentence the glyph answers is true of a `Custom::*`-only stack in exactly
   * the same way. #323's decision was that such a resource is not ACTIONABLE --
   * an argument for keeping it out of the counts, which it still is -- not for
   * claiming it was checked.
   */
  it('a Custom-Resource-only stack warns instead of printing ✓, and still exits 0', async () => {
    mockGetState.mockResolvedValue(
      makeState({ Cr: resource('Custom::MyThing', { ServiceToken: 'arn:aws:lambda:::function:f' }) })
    );

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('NOTHING was compared');
    // The FULL partition, not just the count. The line claims to account for the
    // whole stack, and an earlier revision printed `(0 unsupported)` alone --
    // which accounts for NONE of an all-`Custom::*` stack, since a skipped
    // resource is in neither the checked count nor the unsupported one.
    expect(output).toContain('0 of 1 resource checked (0 unsupported, 1 skipped)');
    expect(output).not.toContain('✓ TestStack');
    // GLYPH ONLY. Flipping the exit code here would fail CI forever for every
    // stack whose resources are all Custom Resources, which is the hazard this
    // command already refuses to create for `unresolvedToken`.
    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  /**
   * The boundary. A stack with NO resources has nothing to compare, so
   * "everything was compared" is vacuously true and a warning would be noise no
   * action can clear. Without this case the condition could have been written as
   * `checked === 0` alone and nothing would have failed.
   */
  it('a stack with NO resources keeps the ✓ glyph', async () => {
    mockGetState.mockResolvedValue(makeState({}));

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('✓ TestStack (us-east-1): no drift detected');
    expect(output).not.toContain('NOTHING was compared');
    expect(error).toBeUndefined();
  });

  /**
   * A stack where SOMETHING was compared keeps the ✓, even alongside an
   * unsupported resource. This is the case the new branch must not steal: the
   * condition is "nothing was compared", not "something was unsupported".
   */
  it('a stack with one compared resource and one unsupported keeps the ✓ glyph', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Queue: resource(QUEUE, { QueueName: 'ok' }),
        Other: resource('AWS::Some::Type', {}),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE ? { readCurrentState: async () => ({ QueueName: 'ok' }) } : {}
    );

    const { output, error } = await runDrift(ARGS);

    expect(output).toContain('✓ TestStack (us-east-1): no drift detected');
    expect(output).toContain('1 resource checked, 1 unsupported');
    expect(output).not.toContain('NOTHING was compared');
    expect(error).toBeUndefined();
  });
});

/**
 * Issue [#2208](https://github.com/go-to-k/cdkd/issues/2208): a remediation run
 * that compared NOTHING used to print `No drift detected — nothing to accept.`
 * and exit `0`. Nothing drifted only because nothing was read, so the sentence
 * was a clean bill of health for a comparison that never happened -- the exact
 * false reassurance #2135 made `notCompared` a variant to prevent, surviving on
 * the one path #2135 did not touch.
 *
 * The fix is MESSAGE-ONLY and the exit code stays `0` on purpose (see
 * `incompleteRemediationMessage`), so the MESSAGE is the whole contract and the
 * assertions here are on its exact text. They are POSITIVE markers: every case
 * also has a "nothing was written" assertion, but `saveState` / `update` not
 * having been called is a confluence point -- a run that crashed before the
 * remediation loop satisfies it just as well as one that correctly declined --
 * so the line the correct path PRINTS is what discriminates.
 */
describe('a remediation run that compared nothing does not report no drift (#2208)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
    mockSaveState.mockReset().mockResolvedValue('"etag-2"');
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    mockCcReadCurrentState.mockReset().mockResolvedValue(undefined);
    mockIamSend.mockReset();
    errorSpy.mockReset();
    warnSpy.mockReset();
    infoSpy.mockReset();
    debugSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  const mockUpdate = vi.fn().mockResolvedValue({ physicalId: 'phys' });

  /** Every read in the stack throws: the extreme case, where NOTHING was compared. */
  function everyReadThrows(): void {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation(() => ({
      readCurrentState: async () => {
        throw awsError('ThrottlingException', 'Rate exceeded');
      },
      update: mockUpdate,
    }));
  }

  it('--accept over a stack whose every read failed says the comparison was INCOMPLETE, not that no drift was detected', async () => {
    mockUpdate.mockClear();
    everyReadThrows();

    const { error } = await runDrift([...ARGS, '--accept', '--yes']);

    const text = infoText();
    // THE positive marker, as one literal: the count, the cause and the
    // "not a clean bill of health" clause have to arrive together, because each
    // of them alone is satisfiable by wording that still reassures.
    expect(text).toContain(
      'Comparison INCOMPLETE — nothing to accept, and that is NOT a clean bill of health: ' +
        '2 of 2 resource(s) could not be compared ' +
        '(2 not compared AT ALL: the read or comparison failed), ' +
        'so cdkd does not know whether they drifted.'
    );
    // ...and the pointer at the mode whose EXIT CODE reports it, since this
    // one's does not.
    expect(text).toContain(
      "Re-run 'cdkd drift' without --accept to see which resources and why — " +
        'a detection-only run exits 2 while a comparison is incomplete.'
    );
    // The sentence that was false is gone entirely.
    expect(text).not.toContain('No drift detected');
    // The exit code is deliberately UNCHANGED: `--accept` / `--revert` exit
    // codes are a documented contract (#2108 scoped its `2` to detection-only
    // mode), so a CI that runs `--accept` does not start failing.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(error).toBeUndefined();
    // Nothing was written on the strength of a comparison that did not happen.
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('--revert over the same stack says the same thing in its own words, and writes nothing', async () => {
    mockUpdate.mockClear();
    everyReadThrows();

    const { error } = await runDrift([...ARGS, '--revert', '--yes']);

    const text = infoText();
    expect(text).toContain(
      'Comparison INCOMPLETE — nothing to revert, and that is NOT a clean bill of health: ' +
        '2 of 2 resource(s) could not be compared ' +
        '(2 not compared AT ALL: the read or comparison failed), ' +
        'so cdkd does not know whether they drifted.'
    );
    expect(text).toContain("Re-run 'cdkd drift' without --revert");
    expect(text).not.toContain('No drift detected');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(error).toBeUndefined();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  /**
   * The PARTIAL population, which is the realistic one: one resource threw and
   * the rest of the stack compared cleanly. `no drift detected` is still wrong
   * -- it is true of 1 of the 2 resources -- and the count has to say which
   * fraction it covers rather than implying the whole stack.
   */
  it('counts the resources it could not compare against the stack total', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? SIBLING_PROVIDER
        : {
            readCurrentState: async () => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { error } = await runDrift([...ARGS, '--accept', '--yes']);

    expect(infoText()).toContain(
      'Comparison INCOMPLETE — nothing to accept, and that is NOT a clean bill of health: ' +
        '1 of 2 resource(s) could not be compared ' +
        '(1 not compared AT ALL: the read or comparison failed), ' +
        'so cdkd does not know whether they drifted.'
    );
    expect(exitSpy).not.toHaveBeenCalled();
    expect(error).toBeUndefined();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  /**
   * THE NEGATIVE DIRECTION. Without this an over-broad fix -- one that prints
   * the incomplete line whenever anything at all is in the `notCompared`
   * roll-up, or unconditionally -- passes every case above.
   */
  it('a stack that was fully compared and has no drift keeps the original message', async () => {
    mockGetState.mockResolvedValue(makeState({ Queue: resource(QUEUE, { QueueName: 'ok' }) }));
    mockRegistryGetProvider.mockImplementation(() => SIBLING_PROVIDER);

    const { error } = await runDrift([...ARGS, '--accept', '--yes']);

    expect(infoText()).toContain('No drift detected — nothing to accept.');
    expect(infoText()).not.toContain('Comparison INCOMPLETE');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(error).toBeUndefined();
  });

  /**
   * The OTHER negative direction, and the one that fences the TRIGGER -- which
   * is a different population from the COUNT (see `incompleteRemediationMessage`).
   * A `{{resolve:ssm-secure:...}}` resource IS in the `notCompared` roll-up, and
   * IS counted once the line fires, but it must not FIRE the line on its own: it
   * is permanent, unclearable, and the reason the detection exit code does not
   * fire on it either. Widening the trigger from `outcomeExitSignal`'s
   * `incomplete` to the whole roll-up would make every such stack's `--accept`
   * start shouting, on every run, about a comparison no action of the user's can
   * ever complete. Deleting that filter from the trigger reds exactly this case.
   */
  it('a permanently-unresolvable reference does NOT trigger the incomplete message', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Tokened: resource(LAMBDA, {
          Environment: { Variables: { PW: '{{resolve:ssm-secure:/pw}}' } },
        }),
      })
    );
    mockRegistryGetProvider.mockImplementation(() => ({
      readCurrentState: async () => ({ Environment: { Variables: { PW: 'live-value' } } }),
    }));

    const { output, error } = await runDrift([...ARGS, '--accept', '--yes']);

    // The resource IS reported as not fully compared...
    expect(output).toContain('! Tokened (AWS::Lambda::Function)');
    // ...and the remediation line is still the plain one.
    expect(infoText()).toContain('No drift detected — nothing to accept.');
    expect(infoText()).not.toContain('Comparison INCOMPLETE');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(error).toBeUndefined();
  });

  /**
   * The third direction: a REAL drift with nothing uncompared must still go
   * through the remediation loop untouched. The incomplete line is reachable
   * only from the `!drifted` branch, and a fix that moved it above the drift
   * check would silently stop accepting drift.
   */
  it('a genuine drift with no incomplete reads still gets accepted, with no incomplete line', async () => {
    mockGetState.mockResolvedValue(makeState({ Queue: resource(QUEUE, { QueueName: 'ok' }) }));
    mockRegistryGetProvider.mockImplementation(() => ({
      readCurrentState: async () => ({ QueueName: 'CHANGED-IN-CONSOLE' }),
    }));

    const { output, error } = await runDrift([...ARGS, '--accept', '--yes']);

    expect(output).toContain('drift detected on 1 resource');
    expect(mockSaveState).toHaveBeenCalled();
    expect(infoText()).not.toContain('Comparison INCOMPLETE');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(error).toBeUndefined();
  });

  /**
   * Drift BESIDE an incomplete read, which is what fences the ORDER of the two
   * checks. The incomplete line lives inside the `!drifted` branch, so drift
   * still outranks it exactly as it does in detection mode: the remediation loop
   * runs and accepts the resource that DID compare, and the failed sibling is
   * simply not one of them. Hoisting the incomplete branch above the drift check
   * -- the obvious "be louder about it" edit -- would stop accepting drift
   * altogether on any stack that also hit a throttle.
   */
  it('drift beside a failed read is still accepted: the incomplete branch does not outrank it', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Fn: resource(LAMBDA, { MemorySize: 128 }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? { readCurrentState: async () => ({ QueueName: 'CHANGED-IN-CONSOLE' }) }
        : {
            readCurrentState: async () => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { output, error } = await runDrift([...ARGS, '--accept', '--yes']);

    expect(output).toContain('drift detected on 1 resource');
    // The drifted resource was accepted...
    expect(mockSaveState).toHaveBeenCalled();
    // ...and the run did NOT take the no-drift branch.
    expect(infoText()).not.toContain('Comparison INCOMPLETE');
    expect(infoText()).not.toContain('No drift detected');
    // The failed read is still reported, just not as a reason to stop.
    expect(output).toContain('! Fn (AWS::Lambda::Function)');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(error).toBeUndefined();
  });

  /**
   * THE MIXED-POPULATION CASE, and the one review round 1 found the bug by
   * looking for. Every other fixture in this file carries ONE reason, so the
   * count and the labels were free to be taken from the wrong population and
   * still look right: the first cut counted only the CLEARABLE reasons and
   * printed `1 of 3` for a stack the human report a few lines above called
   * `2 resource(s) NOT fully compared`, the newer line being the quieter of the
   * two -- in a message written to stop this command being quietly reassuring.
   *
   * Four resources, four different fates in one stack: a read that threw, a
   * permanently-unresolvable token, a type with no read path, and one ordinary
   * resource that compared cleanly. The assertion is the WHOLE line, because the
   * count, the order and the three phrases only constrain each other together --
   * asserting `2 of 4` alone passes under any relabelling, and asserting one
   * phrase alone passes while the count is wrong.
   */
  it('counts and labels EVERY uncompared resource, each by its own reason', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Tokened: resource(LAMBDA, {
          Environment: { Variables: { PW: '{{resolve:ssm-secure:/pw}}' } },
        }),
        Thrower: resource(QUEUE, { QueueName: 'ok' }),
        NoReadPath: resource('AWS::Some::Type', {}),
        Fine: resource('AWS::SNS::Topic', { TopicName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) => {
      if (type === LAMBDA) {
        return { readCurrentState: async () => ({ Environment: { Variables: { PW: 'live' } } }) };
      }
      if (type === QUEUE) {
        return {
          readCurrentState: async () => {
            throw awsError('ThrottlingException', 'Rate exceeded');
          },
        };
      }
      // No `readCurrentState`: the Cloud Control fallback returns undefined
      // (the suite default), which is the `unsupported` outcome.
      if (type === 'AWS::Some::Type') {
        return {};
      }
      return { readCurrentState: async () => ({ TopicName: 'ok' }) };
    });

    const { error } = await runDrift([...ARGS, '--accept', '--yes']);

    expect(infoText()).toContain(
      'Comparison INCOMPLETE — nothing to accept, and that is NOT a clean bill of health: ' +
        '3 of 4 resource(s) could not be compared ' +
        '(1 not compared AT ALL: the read or comparison failed; ' +
        '1 only PARTIALLY compared: their state records a `{{resolve:...}}` spelling cdkd ' +
        'resolves for nobody, which no re-run can clear; ' +
        '1 not compared AT ALL: their provider does not support drift detection yet), ' +
        'so cdkd does not know whether they drifted.'
    );
    // The permanently-unresolvable resource must NOT be described as a refusal.
    // Pre-fix it was counted under the `refused` wording, which points the
    // reader at an ARN they can respell for a condition no respelling clears.
    expect(infoText()).not.toContain('cdkd refused to resolve');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(error).toBeUndefined();
    expect(mockSaveState).not.toHaveBeenCalled();
  });
});
