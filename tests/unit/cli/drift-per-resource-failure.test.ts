import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const errorSpy = vi.hoisted(() => vi.fn());
// Hoisted so the issue-#1515 denial tests can read what the command WARNED.
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
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

const LAMBDA = 'AWS::Lambda::Function';
const QUEUE = 'AWS::SQS::Queue';

function makeState(resources: StackState['resources']): {
  state: StackState;
  etag: string;
} {
  return {
    state: {
      version: 2,
      stackName: 'TestStack',
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
    expect(output).toContain('1 resource checked');
    // Permanent condition -> exit 0, and no throw escaped the command.
    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    // NOT routed to the actionable bucket.
    expect(output).not.toContain('NOT fully compared');
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
    // The sibling was compared.
    expect(output).toContain('Detector');
    expect(output).toContain('no drift detected');
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
    // command and no report existed at all.
    expect(output).toContain('no drift detected');
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
    expect(output).toContain('no drift detected');
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
    expect(exitSpy).toHaveBeenCalledWith(2);
    void error;
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
    expect(output).toContain('0 of 1 resource checked');
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
