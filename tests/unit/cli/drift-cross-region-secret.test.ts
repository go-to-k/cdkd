import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * `cdkd drift` must not re-resolve a state-recorded secret reference against
 * the CONSUMER's region when the expression belongs to a PRODUCER's (issue
 * [#2108](https://github.com/go-to-k/cdkd/issues/2108)).
 *
 * Since issue #1934 a cross-stack consumer re-resolves a redacted producer
 * value in the PRODUCER's region and records the PRODUCER's spelling of the
 * `{{resolve:...}}` expression into its own `state.json`. `drift.ts` then built
 * BOTH of its re-resolution resolvers from the consumer's region alone, with no
 * region check at all — the same defect issue #2057 fixed in the rollback
 * replay, but reachable from an ordinary drift run rather than only after a
 * failed deploy. Three consequences, one test group each:
 *
 *   1. `--revert` hands `desiredProperties` straight to `provider.update`, so a
 *      foreign region's same-named secret is WRITTEN to a live resource.
 *   2. Detection baselines against the wrong region's plaintext, which can never
 *      equal what AWS holds — permanent phantom drift.
 *   3. `secrets` — the redaction needle map — is populated with the WRONG
 *      plaintext, so value-based redaction both misses the real secret and
 *      rewrites an unrelated literal that coincides with the foreign one.
 *
 * WHY THIS FILE FAKES THE SDK CLIENT CLASSES rather than `getAwsClients()`
 * (the same choice as `rollback-executor-cross-region-secret.test.ts`): the
 * whole question is WHICH REGION WAS ASKED, and the plain-object
 * `getAwsClients()` double the other drift suites use has no region, so it
 * cannot be asked it. The real `AwsClients` is used — which is also what makes
 * `IntrinsicFunctionResolver.clientsForRegion` derive a region-pinned sibling
 * at all — and only the leaf `SecretsManagerClient` / `SSMClient` are faked,
 * with the CONSTRUCTOR region as the discriminator.
 *
 * Responses are primed per (REGION, COMMAND) — no `*Once` queue to leak.
 */

interface FakeClientConfig {
  region?: string;
  profile?: string;
}

interface FakeSend {
  /** The region the sending client was CONSTRUCTED with — the discriminator. */
  ctorRegion: string | undefined;
  region: string | undefined;
  command: string;
  input: unknown;
}

const { responses, secretSends, ssmSends, makeFakeClientClass } = vi.hoisted(() => {
  const responses = new Map<string, unknown>();

  const makeFakeClientClass = (sends: FakeSend[], serviceLabel: string): unknown =>
    class {
      readonly ctorConfig: FakeClientConfig;
      readonly config: { region: () => Promise<string> };
      private resolved?: Promise<string>;

      constructor(ctorConfig: FakeClientConfig = {}) {
        this.ctorConfig = ctorConfig;
        this.config = { region: () => this.resolveRegion() };
      }

      private resolveRegion(): Promise<string> {
        if (!this.resolved) {
          const region = this.ctorConfig.region || process.env['AWS_REGION'];
          this.resolved = region
            ? Promise.resolve(region)
            : Promise.reject(new Error('Region is missing'));
        }
        return this.resolved;
      }

      async send(command: { input?: unknown; constructor: { name: string } }): Promise<unknown> {
        let region: string | undefined;
        try {
          region = await this.resolveRegion();
        } catch {
          region = undefined;
        }
        const name = command.constructor.name;
        sends.push({
          ctorRegion: this.ctorConfig.region,
          region,
          command: name,
          input: command.input,
        });
        const response = responses.get(`${String(region)}|${name}`);
        if (response === undefined) {
          throw new Error(`no ${serviceLabel} response primed for ${String(region)}|${name}`);
        }
        return response;
      }
      destroy(): void {}
    };

  return {
    responses,
    secretSends: [] as FakeSend[],
    ssmSends: [] as FakeSend[],
    makeFakeClientClass,
  };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: makeFakeClientClass(secretSends, 'secretsmanager'),
  };
});

// An `ssm` reference can name an ARN too, so the ssm client needs the same
// region-observable fake as the secretsmanager one.
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass(ssmSends, 'ssm') };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass([], 'sts') };
});

// Pass-through retry: `--revert` wraps `provider.update` in `withRetry`, and a
// refusal must not sleep through a real backoff schedule.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
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

const mockGetState =
  vi.fn<
    (
      stackName: string,
      region: string
    ) => Promise<{ state: StackState; etag: string } | null>
  >();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
const mockSaveState = vi.fn<() => Promise<string>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
    saveState: mockSaveState,
  })),
}));

const mockAcquireLock = vi.fn<() => Promise<boolean>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    releaseLock: mockReleaseLock,
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
const mockRegistryShouldSkip = vi.fn<(resourceType: string) => boolean>().mockReturnValue(false);
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
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import { resetAwsClients } from '../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const CONSUMER_REGION = 'ap-northeast-1';
const PRODUCER_REGION = 'eu-west-1';

const SECRET_NAME = 'prod/db/cred';
/** The producer's own, region-less spelling — what issue #1934 persists downstream. */
const NAME_EXPR = `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password}}`;
const PRODUCER_ARN = `arn:aws:secretsmanager:${PRODUCER_REGION}:111122223333:secret:${SECRET_NAME}-AbCdEf`;
const PRODUCER_ARN_EXPR = `{{resolve:secretsmanager:${PRODUCER_ARN}:SecretString:password}}`;
const CONSUMER_ARN = `arn:aws:secretsmanager:${CONSUMER_REGION}:111122223333:secret:${SECRET_NAME}-AbCdEf`;
const CONSUMER_ARN_EXPR = `{{resolve:secretsmanager:${CONSUMER_ARN}:SecretString:password}}`;

/**
 * Two regions holding DIFFERENT values behind the SAME reference — the ordinary
 * Secrets Manager reality, and the only thing that makes "which region
 * answered" observable at all. A fixture that primed one value for both regions
 * could not tell the fixed path from the broken one.
 */
const TOKYO_PASSWORD = 'tokyo-password-2108';
const IRELAND_PASSWORD = 'ireland-password-2108';

const LAMBDA_TYPE = 'AWS::Lambda::Function';

/**
 * A leaf that is NOT a whole token — literal text on both sides of a
 * foreign-ARN reference (issue #2108 review).
 *
 * Every other fixture in this file makes the property's WHOLE value one token,
 * and a whole-token leaf never exercises the segment REBUILD at all: the loop
 * appends `leaf.slice(cursor, at)` and `leaf.slice(cursor)` and both are empty
 * strings, so gutting either splice site leaves the result identical. The
 * rebuild is the newest code on the path that feeds `desiredProperties` into
 * `provider.update` on a LIVE resource, and a mixed leaf is the only shape that
 * can red it: get the splice wrong and cdkd writes the bare secret and DROPS
 * the connection string around it.
 */
const mixedUrl = (secret: string): string =>
  `postgres://appuser:${secret}@db.internal:5432/appdb?sslmode=require`;

/** The SAME reference twice in one leaf — fences the `indexOf(token, cursor)` advance. */
const twiceLeaf = (secret: string): string => `primary=${secret};replica=${secret};`;

/** Two DIFFERENT references in one leaf, one `local` and one `named-region`. */
const twoTokenLeaf = (localValue: string, foreignValue: string): string =>
  `local=${localValue}|foreign=${foreignValue}|end`;

const SSM_PARAM = '/app/db/password';
/**
 * `resolveSSMReference` re-joins its colon-split tail, so an `ssm` reference CAN
 * name a full ARN and CAN therefore route to a pinned sibling resolver — the
 * argument `rollback-executor.ts` spells out where it explains why a pinned
 * sibling needs no guest flag. The `SSMClient` fake exists for this case.
 */
const PRODUCER_SSM_ARN = `arn:aws:ssm:${PRODUCER_REGION}:111122223333:parameter${SSM_PARAM}`;
const SSM_ARN_EXPR = `{{resolve:ssm:${PRODUCER_SSM_ARN}}}`;

/**
 * The spelling cdkd resolves for NOBODY. CloudFormation resolves `ssm-secure`
 * SERVER-side, so `resolveDynamicReferences` warns and hands the literal back
 * rather than throwing -- the token SURVIVES the pass, which marks the resource
 * `referencesUnresolved` WITHOUT anything having been refused.
 *
 * That distinction is the whole reason this constant exists: it is the
 * pre-existing population that must NOT be driven into the exit code.
 */
const SSM_SECURE_EXPR = `{{resolve:ssm-secure:${SSM_PARAM}}}`;

/**
 * The `--json` payload shape, restated here rather than imported: `drift.ts`
 * keeps `StackDriftJson` private and the comment above it calls the shape a
 * "stable contract for tooling", so a test that asserts against a local copy is
 * also asserting the contract has not moved.
 */
interface StackDriftJson {
  stack: string;
  region: string;
  drifted: Array<{
    logicalId: string;
    type: string;
    changes: Array<{ path: string; stateValue: unknown; awsValue: unknown }>;
    referencesUnresolved: boolean;
  }>;
  /** Issue #2135: compared-and-MATCHED only, so the flag is always `false`. */
  clean: Array<{ logicalId: string; type: string; referencesUnresolved: false }>;
  notSupported: Array<{ logicalId: string; type: string }>;
  skipped: Array<{ logicalId: string; type: string }>;
  /** Issue #2108: the roll-up of every entry carrying `referencesUnresolved`. */
  notCompared: Array<{
    logicalId: string;
    type: string;
    referencesUnresolved: boolean;
    cause: 'refused' | 'unresolvedToken' | 'readFailed';
  }>;
}

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
    await cmd.parseAsync([...args, '--region', CONSUMER_REGION], { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    cap.restore();
  }
  return { output: cap.output.join(''), error };
}

/**
 * The consumer Lambda: one env var carrying `expr`, one ordinary public one.
 * `properties` and `observedProperties` BOTH hold the expression, which is what
 * the deploy-time redaction leaves behind (`scrubResourceRecord`).
 */
function lambdaResource(expr: string, plain = 'ok'): ResourceState {
  const bag = {
    FunctionName: 'fn',
    Environment: { Variables: { SECRET_PASSWORD: expr, PLAIN: plain } },
  };
  return {
    physicalId: 'fn',
    resourceType: LAMBDA_TYPE,
    properties: JSON.parse(JSON.stringify(bag)) as Record<string, unknown>,
    observedProperties: JSON.parse(JSON.stringify(bag)) as Record<string, unknown>,
  };
}

/**
 * ONE resource that trips BOTH not-compared causes, in the order that makes
 * both of them stick.
 *
 * `resolveStateSecretExpressions` walks leaves SEQUENTIALLY in key order, so
 * the surviving-token leaf has to come FIRST: the refusal on the second leaf
 * THROWS, and a throw on the first leaf would abort the pass before the
 * survivor is ever seen, leaving only `secretResolutionFailed` set. In that
 * order the resource reaches the construction site with
 * `unresolvedTokens.size > 0` AND `secretResolutionFailed === true` -- the only
 * shape in which the precedence between the two arms is observable at all.
 *
 * Every leaf outside `Environment.Variables` is ordinary, so nothing here can
 * drift and the exit code is decided by the cause alone.
 */
function bothCausesResource(): ResourceState {
  const bag = {
    FunctionName: 'fn',
    Environment: {
      Variables: {
        /** Walked FIRST: cdkd resolves `ssm-secure` for nobody, so the token SURVIVES. */
        SSM_SECURE_PASSWORD: SSM_SECURE_EXPR,
        /** Walked SECOND: region-less name + a foreign producer on record = REFUSED. */
        SECRET_PASSWORD: NAME_EXPR,
      },
    },
  };
  return {
    physicalId: 'fn',
    resourceType: LAMBDA_TYPE,
    properties: JSON.parse(JSON.stringify(bag)) as Record<string, unknown>,
    observedProperties: JSON.parse(JSON.stringify(bag)) as Record<string, unknown>,
  };
}

/**
 * The live readback for {@link bothCausesResource}: the SAME key set (the walk
 * is a union of baseline and AWS keys, so an extra or missing key would be
 * drift of its own) with AWS holding resolved plaintext at both secret-bearing
 * leaves. Neither is compared -- the state side still carries `{{resolve:`, so
 * `calculateResourceDrift` skips it -- which is what keeps this run's exit code
 * a function of the cause and not of drift.
 */
function bothCausesAws(): Record<string, unknown> {
  return {
    FunctionName: 'fn',
    Environment: {
      Variables: {
        SSM_SECURE_PASSWORD: 'whatever-aws-holds-here',
        SECRET_PASSWORD: IRELAND_PASSWORD,
      },
    },
  };
}

/**
 * A consumer state record whose cross-stack reads name `producerRegions` —
 * exactly the `state.imports[].sourceRegion` / `state.outputReads[].sourceRegion`
 * evidence `producerRegionsFromState` reads, and the reason this command needs
 * no plumbing to answer the region question the rollback lane had to thread.
 */
function makeState(
  resources: Record<string, ResourceState>,
  producerRegions: string[],
  kind: 'imports' | 'outputReads' = 'imports'
): { state: StackState; etag: string } {
  const state: StackState = {
    version: 8,
    stackName: 'Consumer',
    region: CONSUMER_REGION,
    resources,
    outputs: {},
    lastModified: 0,
    ...(kind === 'imports'
      ? {
          imports: producerRegions.map((sourceRegion, i) => ({
            sourceStack: 'Producer',
            sourceRegion,
            exportName: `Producer:Export${i}`,
          })),
        }
      : {
          outputReads: producerRegions.map((sourceRegion, i) => ({
            sourceStack: 'Producer',
            sourceRegion,
            outputName: `Output${i}`,
          })),
        }),
  };
  return { state, etag: '"etag-1"' };
}

/** The live readback: AWS holds the RESOLVED value, never the expression. */
function awsEnv(secretValue: string, plain = 'ok'): Record<string, unknown> {
  return {
    FunctionName: 'fn',
    Environment: { Variables: { SECRET_PASSWORD: secretValue, PLAIN: plain } },
  };
}

function prime(region: string, command: string, response: unknown): void {
  responses.set(`${region}|${command}`, response);
}

let savedRegion: string | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedRegion = process.env['AWS_REGION'];
  delete process.env['AWS_REGION'];
  responses.clear();
  secretSends.length = 0;
  ssmSends.length = 0;
  resetAwsClients();
  resetAccountInfoCache();

  mockGetState.mockReset();
  mockListStacks.mockReset();
  mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
  mockSaveState.mockReset().mockResolvedValue('"etag-2"');
  mockAcquireLock.mockReset().mockResolvedValue(true);
  mockReleaseLock.mockReset().mockResolvedValue(undefined);
  mockRegistryGetProvider.mockReset();
  mockRegistryShouldSkip.mockReset().mockReturnValue(false);
  errorSpy.mockReset();
  warnSpy.mockReset();
  infoSpy.mockReset();
  debugSpy.mockReset();

  prime(CONSUMER_REGION, 'GetSecretValueCommand', {
    SecretString: JSON.stringify({ password: TOKYO_PASSWORD }),
  });
  prime(PRODUCER_REGION, 'GetSecretValueCommand', {
    SecretString: JSON.stringify({ password: IRELAND_PASSWORD }),
  });
  // The `ssm` route, priming the SAME two-values-behind-one-name shape. `Type`
  // is `SecureString`, so the parameter is a real secret rather than public
  // config and takes the same persisted-as-its-expression path.
  prime(CONSUMER_REGION, 'GetParameterCommand', {
    Parameter: { Value: TOKYO_PASSWORD, Type: 'SecureString' },
  });
  prime(PRODUCER_REGION, 'GetParameterCommand', {
    Parameter: { Value: IRELAND_PASSWORD, Type: 'SecureString' },
  });

  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__exit__');
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  resetAwsClients();
  if (savedRegion === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedRegion;
});

/**
 * The DISTINCT regions the faked `SecretsManagerClient`s that actually sent a
 * request were CONSTRUCTED with — the discriminator this whole file exists for.
 *
 * Distinct, because `--revert` re-resolves twice by design: detection builds
 * one `DriftSecretResolvers` per stack and the revert loop builds another (the
 * revert wants AWS as it is NOW, not as it was when the report was built), so a
 * healthy run legitimately fetches the same reference once per pass. What must
 * never vary is WHICH region was asked.
 */
function secretCtorRegions(): string[] {
  return [...new Set(secretSends.map((s) => s.ctorRegion))] as string[];
}

/** The `ssm` twin of {@link secretCtorRegions}. */
function ssmCtorRegions(): string[] {
  return [...new Set(ssmSends.map((s) => s.ctorRegion))] as string[];
}

/** Every line the mocked logger saw, in one string. */
function logText(): string {
  const all = [errorSpy, warnSpy, infoSpy, debugSpy].flatMap((spy) =>
    spy.mock.calls.map((call: unknown[]) => call.map(String).join(' '))
  );
  return all.join('\n');
}

describe('cdkd drift --revert refuses a region-ambiguous secret reference (issue #2108)', () => {
  it('cross-region import on record: refuses instead of writing the CONSUMER region secret to AWS', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [PRODUCER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD, 'tampered'),
      update,
    });

    await runDrift(['Consumer', '--revert', '--yes']);

    // THE discriminator: the fixed path asks NOBODY, so nothing is written.
    // The broken path asks the consumer's region and hands `provider.update`
    // the Tokyo password — a different credential from the Ireland one the
    // deploy applied.
    expect(update).not.toHaveBeenCalled();
    expect(secretSends).toHaveLength(0);

    const text = logText();
    expect(text).toContain(SECRET_NAME);
    expect(text).toContain(CONSUMER_REGION);
    expect(text).toContain(PRODUCER_REGION);
    expect(text).toContain("re-run 'cdkd drift'");
    // A refusal is a DECISION, not a failed read, and the line has to say which
    // — 'could not re-resolve' sends the reader hunting for an IAM grant that
    // is not missing. This discriminates: the pre-review code printed the
    // read-failure wording on this path.
    expect(text).toContain('refused to re-resolve');
    expect(text).not.toContain('could not re-resolve');
    // A "neither password appears" assertion used to sit here and was DELETED
    // rather than kept: `secretSends` is empty two lines up, so no region was
    // ever asked and neither value exists in this process. It could not fail
    // under any mutation of the code it appeared to guard, and a test that
    // cannot fail is worse than no test. The leak question is asserted where it
    // can actually be answered — the tests below, which DO fetch.
  });

  it('cross-region Fn::GetStackOutput read on record: refused on the same evidence', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    // `outputReads` is the WEAK cross-stack edge (schema v8) and is the EASIER
    // of the two to point across a region boundary, so it must count as
    // evidence exactly like `imports`.
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [PRODUCER_REGION], 'outputReads')
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD, 'tampered'),
      update,
    });

    await runDrift(['Consumer', '--revert', '--yes']);

    expect(update).not.toHaveBeenCalled();
    expect(secretSends).toHaveLength(0);
  });

  it('same-region imports only: resolves in the consumer region and writes exactly as before', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [CONSUMER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(TOKYO_PASSWORD, 'tampered'),
      update,
    });

    await runDrift(['Consumer', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    // Asked, and asked the CONSUMER's region — behaviour unchanged.
    expect(secretCtorRegions()).toEqual([CONSUMER_REGION]);
    const sent = update.mock.calls[0]![3] as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(sent.Environment.Variables['SECRET_PASSWORD']).toBe(TOKYO_PASSWORD);
  });

  it('no cross-stack reads on record at all: resolves in the consumer region exactly as before', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(makeState({ Fn: lambdaResource(NAME_EXPR) }, []));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(TOKYO_PASSWORD, 'tampered'),
      update,
    });

    await runDrift(['Consumer', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    expect(secretCtorRegions()).toEqual([CONSUMER_REGION]);
    const sent = update.mock.calls[0]![3] as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(sent.Environment.Variables['SECRET_PASSWORD']).toBe(TOKYO_PASSWORD);
  });

  it('ARN naming a FOREIGN region: resolved by a client CONSTRUCTED in the ARN region, and THAT value is written', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    // No cross-stack reads recorded — the ARN arm stands on the EXPRESSION
    // alone, so the weaker per-stack evidence is never consulted.
    mockGetState.mockResolvedValue(makeState({ Fn: lambdaResource(PRODUCER_ARN_EXPR) }, []));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD, 'tampered'),
      update,
    });

    await runDrift(['Consumer', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    // WHICH region answered, not merely that a value came back: the fixed path
    // constructs its client in eu-west-1. The broken path constructs it in
    // ap-northeast-1 and gets the Tokyo password back for the very same ARN.
    expect(secretCtorRegions()).toEqual([PRODUCER_REGION]);
    const sent = update.mock.calls[0]![3] as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(sent.Environment.Variables['SECRET_PASSWORD']).toBe(IRELAND_PASSWORD);
  });

  it('ARN naming the stack OWN region: still the consumer resolver, even with a foreign producer on record', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(CONSUMER_ARN_EXPR) }, [PRODUCER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(TOKYO_PASSWORD, 'tampered'),
      update,
    });

    await runDrift(['Consumer', '--revert', '--yes']);

    // The expression settles the question itself, so the per-stack evidence
    // never gets consulted and the reference is NOT refused.
    expect(update).toHaveBeenCalledTimes(1);
    expect(secretCtorRegions()).toEqual([CONSUMER_REGION]);
    const sent = update.mock.calls[0]![3] as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(sent.Environment.Variables['SECRET_PASSWORD']).toBe(TOKYO_PASSWORD);
  });
});

describe('cdkd drift detection baselines against the PRODUCER region (issue #2108)', () => {
  it('ARN naming a FOREIGN region: no phantom drift, because the baseline is resolved where the ARN says', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(makeState({ Fn: lambdaResource(PRODUCER_ARN_EXPR) }, []));
    // AWS holds what the PRODUCER's region resolves to — which is the whole
    // point of a cross-region reference.
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD),
    });

    const { output } = await runDrift(['Consumer', '--json']);

    expect(secretCtorRegions()).toEqual([PRODUCER_REGION]);
    const parsed = JSON.parse(output) as StackDriftJson[];
    // The broken path resolves the SAME ARN in ap-northeast-1, gets the Tokyo
    // password, and reports a drift that no `--revert` and no `--accept` can
    // ever converge.
    expect(parsed[0]!.drifted).toEqual([]);
    expect(parsed[0]!.clean.map((c) => c.logicalId)).toEqual(['Fn']);
    expect(output).not.toContain(IRELAND_PASSWORD);
    expect(output).not.toContain(TOKYO_PASSWORD);
  });

  it('region-less reference with a cross-region import on record: refuses, and does NOT compare against the wrong region', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [PRODUCER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD),
    });

    const { output } = await runDrift(['Consumer', '--json']);

    // Nothing was fetched, so nothing was compared against a foreign plaintext.
    expect(secretSends).toHaveLength(0);
    const parsed = JSON.parse(output) as StackDriftJson[];
    // `calculateResourceDrift` skips a state leaf still holding a
    // `{{resolve:...}}` string, so the degraded baseline reports NO drift
    // rather than drifting forever against the Tokyo password. Issue #2135:
    // "no drift" is its own outcome here, `notCompared` -- `clean` means
    // compared-and-matched and this resource was not compared at all.
    expect(parsed[0]!.drifted).toEqual([]);
    expect(parsed[0]!.clean).toEqual([]);
    expect(parsed[0]!.notCompared.map((c) => c.logicalId)).toEqual(['Fn']);
    const text = logText();
    expect(text).toContain('NOT compared');
    // The detection twin of the revert-side wording split: this resource was
    // not UNREADABLE, cdkd declined to read it. Saying 'could not resolve'
    // here points the reader at an IAM grant that is not missing.
    expect(text).toContain('refused to resolve');
    expect(text).not.toContain('could not resolve the dynamic reference');
    expect(text).toContain(PRODUCER_REGION);
    expect(text).not.toContain(IRELAND_PASSWORD);
    expect(text).not.toContain(TOKYO_PASSWORD);
    expect(output).not.toContain(IRELAND_PASSWORD);
  });

  it('same-region-only imports: resolves in the consumer region and detects a real drift exactly as before', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [CONSUMER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv('tampered-in-the-console'),
    });

    const { output } = await runDrift(['Consumer', '--json']);

    expect(secretCtorRegions()).toEqual([CONSUMER_REGION]);
    const parsed = JSON.parse(output) as StackDriftJson[];
    expect(parsed[0]!.drifted.map((d) => d.logicalId)).toEqual(['Fn']);
    expect(parsed[0]!.drifted[0]!.changes.map((c) => c.path)).toContain(
      'Environment.Variables.SECRET_PASSWORD'
    );
  });
});

describe('the drift redaction needle is the PRODUCER region plaintext (issue #2108)', () => {
  it('does not rewrite an unrelated public literal that coincides with the CONSUMER region secret', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    // `PLAIN` is ordinary public config whose value happens to equal what the
    // SAME-NAMED secret holds in the consumer's region. It is not a secret and
    // must survive the report verbatim.
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(PRODUCER_ARN_EXPR, TOKYO_PASSWORD) }, [])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD, 'changed-in-the-console'),
    });

    const { output } = await runDrift(['Consumer', '--json']);

    expect(secretCtorRegions()).toEqual([PRODUCER_REGION]);
    const parsed = JSON.parse(output) as StackDriftJson[];
    const plain = parsed[0]!.drifted[0]!.changes.find(
      (c) => c.path === 'Environment.Variables.PLAIN'
    );
    expect(plain).toBeDefined();
    // The broken path records the TOKYO password as the needle for the ARN
    // expression, so this public literal is rewritten to
    // `{{resolve:secretsmanager:arn:...}}` — a value the user never set, in a
    // report they are about to act on.
    expect(plain!.stateValue).toBe(TOKYO_PASSWORD);
    // ...and the OTHER half of the same fact: the secret path itself does NOT
    // drift, because the baseline was resolved where the ARN says and matches
    // what AWS holds. Under the broken code the baseline is the TOKYO password
    // against an IRELAND readback, so a second, permanent change appears here.
    //
    // This replaces a bare `expect(output).not.toContain(IRELAND_PASSWORD)`,
    // which could not discriminate: the path is secret-BEARING under either
    // code path, so positional masking turns the AWS value into `***` and the
    // plaintext is absent from the output either way.
    expect(
      parsed[0]!.drifted[0]!.changes.find(
        (c) => c.path === 'Environment.Variables.SECRET_PASSWORD'
      )
    ).toBeUndefined();
  });
});

/**
 * The segment REBUILD, which every whole-token fixture above leaves dead.
 *
 * `resolveDriftLeafByRegion` takes two paths. With no `named-region` verdict
 * the leaf goes to `resolveDynamicReferences` WHOLE — that is every leaf on
 * every pre-#2108 code path, and it is what the fixtures above exercise. With
 * one, the leaf is rebuilt token by token so each reference reaches its own
 * region's resolver, and THAT loop is the newest code in the change and the one
 * feeding `desiredProperties` into `provider.update` on a live resource.
 *
 * A whole-token leaf cannot fence it: `leaf.slice(cursor, at)` and
 * `leaf.slice(cursor)` are both `''` when the token IS the leaf, so deleting
 * either splice site changes nothing. Each case below asserts the FULL rebuilt
 * string, and each is a mutation-probe target:
 *
 *   - gut `out += leaf.slice(cursor, at)`      -> the mixed / two-token cases red
 *   - gut `return out + leaf.slice(cursor)`    -> the mixed / duplicate cases red
 *   - drop the `cursor` argument to `indexOf`  -> the duplicate case reds
 *   - route every verdict to `resolvers.primary` -> the two-token case reds
 */
describe('cdkd drift --revert rebuilds a MIXED leaf around its references (issue #2108)', () => {
  it('literal text on both sides of a foreign-ARN token: writes the whole string, not the bare secret', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(mixedUrl(PRODUCER_ARN_EXPR)) }, [])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(mixedUrl('tampered-in-the-console')),
      update,
    });

    await runDrift(['Consumer', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    expect(secretCtorRegions()).toEqual([PRODUCER_REGION]);
    const sent = update.mock.calls[0]![3] as {
      Environment: { Variables: Record<string, unknown> };
    };
    // The WHOLE connection string, byte for byte. A broken splice writes the
    // bare password here and drops `postgres://appuser:` and everything after
    // the token — a live Lambda env var that no longer parses as a URL.
    expect(sent.Environment.Variables['SECRET_PASSWORD']).toBe(mixedUrl(IRELAND_PASSWORD));
  });

  it('the SAME token twice in one leaf: both occurrences substituted, in place', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(twiceLeaf(PRODUCER_ARN_EXPR)) }, [])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(twiceLeaf('tampered-in-the-console')),
      update,
    });

    await runDrift(['Consumer', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![3] as {
      Environment: { Variables: Record<string, unknown> };
    };
    // `indexOf(token, cursor)` is what keeps the second iteration from
    // re-finding the FIRST occurrence. Without the cursor argument the two
    // segments collapse onto one position and the tail still carries the raw
    // `{{resolve:...}}` token.
    expect(sent.Environment.Variables['SECRET_PASSWORD']).toBe(twiceLeaf(IRELAND_PASSWORD));
  });

  it('two DIFFERENT tokens in one leaf, one local and one named-region: each resolved by ITS region', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    // No cross-stack reads on record, so the name-form token classifies `local`
    // rather than `ambiguous` and the leaf carries one verdict of each kind —
    // the only shape in which "route each token separately" is observable.
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(twoTokenLeaf(NAME_EXPR, PRODUCER_ARN_EXPR)) }, [])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(twoTokenLeaf('tampered', 'tampered')),
      update,
    });

    await runDrift(['Consumer', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    // BOTH regions were asked, which a single-resolver rebuild cannot produce.
    expect([...secretCtorRegions()].sort()).toEqual([CONSUMER_REGION, PRODUCER_REGION].sort());
    const sent = update.mock.calls[0]![3] as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(sent.Environment.Variables['SECRET_PASSWORD']).toBe(
      twoTokenLeaf(TOKYO_PASSWORD, IRELAND_PASSWORD)
    );
  });
});

describe('cdkd drift --json marks a resource whose properties were NOT compared (issue #2108)', () => {
  it('a refused resource is reported under notCompared and NEVER under clean', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [PRODUCER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD),
    });

    const { output } = await runDrift(['Consumer', '--json']);

    const parsed = JSON.parse(output) as StackDriftJson[];
    // No drift to report — the comparator SKIPS a state leaf holding a
    // `{{resolve:...}}` string. What must not happen is a consumer reading that
    // as "checked and fine": pre-#2108 this resource reported (wrongly, but
    // visibly) as drifted, so a silent `clean` would be a regression this
    // change introduced.
    expect(parsed[0]!.drifted).toEqual([]);
    // Issue #2135, and the assertion the whole refactor exists for: the entry
    // is OUT of `clean` entirely, not in it wearing a flag a reader has to
    // remember to consult.
    expect(parsed[0]!.clean).toEqual([]);
    // The roll-up a CI job can gate on with ONE key instead of a filter over
    // two arrays.
    expect(parsed[0]!.notCompared).toEqual([
      { logicalId: 'Fn', type: LAMBDA_TYPE, referencesUnresolved: true, cause: 'refused' },
    ]);
  });

  it('a fully compared resource carries the flag as false and stays out of notCompared', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(makeState({ Fn: lambdaResource(PRODUCER_ARN_EXPR) }, []));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD),
    });

    const { output } = await runDrift(['Consumer', '--json']);

    const parsed = JSON.parse(output) as StackDriftJson[];
    // The NEGATIVE twin. Without it every resource could be routed to
    // `notCompared` unconditionally and the case above would still pass, which
    // would make the roll-up useless in exactly the direction that matters —
    // everything looks unchecked.
    expect(parsed[0]!.clean).toEqual([
      { logicalId: 'Fn', type: LAMBDA_TYPE, referencesUnresolved: false },
    ]);
    expect(parsed[0]!.notCompared).toEqual([]);
  });

  it('the human report says so too, so stdout is not more reassuring than --json', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [PRODUCER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD),
    });

    const { output } = await runDrift(['Consumer']);

    // `✓ no drift detected` is still printed — nothing drifted. The added line
    // is what stops it being read as "everything was checked". The per-resource
    // warning goes to the LOGGER, which a user piping stdout does not see.
    expect(output).toContain('no drift detected');
    expect(output).toContain('PARTIALLY compared');
    expect(output).toContain('Fn');
    expect(output).not.toContain(IRELAND_PASSWORD);
    expect(output).not.toContain(TOKYO_PASSWORD);
  });
});

describe('cdkd drift resolves each reference ONCE per stack (issue #2108)', () => {
  it('two resources sharing one foreign ARN pay one GetSecretValue, not one each', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState(
        { Fn: lambdaResource(PRODUCER_ARN_EXPR), Fn2: lambdaResource(PRODUCER_ARN_EXPR) },
        []
      )
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD),
    });

    await runDrift(['Consumer', '--json']);

    // COUNTED, not deduped. `secretCtorRegions()` folds the sends through a
    // `Set`, so no assertion built on it can see a resolver being rebuilt per
    // resource — the fetch count would go from 1 to N while the region set
    // stayed `[eu-west-1]` and every existing assertion in this file stayed
    // green. One `DriftSecretResolvers` per STACK is what makes this 1: the
    // resolved-value cache lives on the resolver instance (issue #1933), and
    // the pinned sibling is cached on the bag.
    expect(secretSends).toHaveLength(1);
    expect(secretCtorRegions()).toEqual([PRODUCER_REGION]);
  });
});

describe('cdkd drift routes an ARN-form ssm reference by its ARN region (issue #2108)', () => {
  it('a foreign-region ssm ARN is read by an SSM client CONSTRUCTED in that region, and THAT value is written', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(makeState({ Fn: lambdaResource(SSM_ARN_EXPR) }, []));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv('tampered-in-the-console'),
      update,
    });

    await runDrift(['Consumer', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    // The `ssm` arm was inert before this case: `ssmSends` was reset in
    // `beforeEach` and never primed or asserted, so `classifyReplaySecretRegion`
    // could have returned `local` for every ssm reference and nothing here
    // would have noticed.
    expect(ssmSends.length).toBeGreaterThan(0);
    expect(ssmCtorRegions()).toEqual([PRODUCER_REGION]);
    // `resolveSSMReference` re-joins the colon-split tail, so the pinned client
    // is asked for the ARN verbatim rather than for a truncated `arn`.
    expect(ssmSends[0]!.input).toMatchObject({ Name: PRODUCER_SSM_ARN });
    // No secretsmanager traffic at all — this reference is ssm end to end.
    expect(secretSends).toHaveLength(0);
    const sent = update.mock.calls[0]![3] as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(sent.Environment.Variables['SECRET_PASSWORD']).toBe(IRELAND_PASSWORD);
  });
});

describe('cdkd drift EXIT CODE distinguishes "clean" from "not compared" (issue #2108)', () => {
  /**
   * The exit code is the signal most CI gates actually read, and it was the one
   * round 1 of #2108 left saying "pass" for a refused comparison.
   *
   * DIRECTION MATTERS: pre-#2108 this population resolved the reference in the
   * WRONG region, could never match, and reported `drifted` -- so it exited 1.
   * Refusing correctly made it report `clean`, which would have exited 0. A
   * non-zero exit therefore PRESERVES what those gates already had; leaving it
   * at 0 would have been the silent downgrade.
   *
   * The four cases are the full truth table of the two independent facts the
   * code decides on (did anything drift, was anything left uncompared), because
   * a test of the refused case alone cannot tell a correct implementation from
   * one that exits non-zero unconditionally.
   */
  it('refused-only: exits 2, not 0 -- nothing drifted, but nothing was fully compared either', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [PRODUCER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD),
    });

    const { output } = await runDrift(['Consumer']);

    // Still reports no drift -- the comparator skipped the only property that
    // could have differed. The exit code is what stops that reading as a pass.
    expect(output).toContain('no drift detected');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('drifted-only: exits 1, unchanged -- a fully compared resource that really differs', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    // Foreign ARN, so the reference RESOLVES (in the producer's region) and
    // nothing is refused; the public `PLAIN` var is what drifts.
    mockGetState.mockResolvedValue(makeState({ Fn: lambdaResource(PRODUCER_ARN_EXPR) }, []));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD, 'tampered'),
    });

    const { output } = await runDrift(['Consumer']);

    expect(output).toContain('drift detected');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('clean with nothing refused: exits 0 -- the only case that is a clean bill of health', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(makeState({ Fn: lambdaResource(PRODUCER_ARN_EXPR) }, []));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD),
    });

    const { error } = await runDrift(['Consumer']);

    // No throw at all: `process.exit` is never reached, so the command returns.
    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('both at once: exits 1 -- drift is the stronger signal and keeps its code', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    // Region-less reference WITH a foreign producer on record -> refused, and
    // the public `PLAIN` var drifts, so the same resource is both.
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [PRODUCER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD, 'tampered'),
    });

    await runDrift(['Consumer']);

    // 1, NOT 2: a consumer gating on `=== 1` must not lose a detection it gets
    // today just because the same run also refused a secret comparison.
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(2);
  });

  it('a DRIFTED entry carries referencesUnresolved: true and is rolled up under notCompared', async () => {
    // The `clean` variant had both polarities pinned; the `drifted` one had
    // NEITHER, and it is the harder half -- the changes it DOES report are real,
    // so a consumer reading them as the whole comparison is exactly the false
    // reassurance the flag exists to prevent. The integ's `..|objects` walk
    // cannot stand in for this: it cannot tell which array a value came from.
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [PRODUCER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD, 'tampered'),
    });

    const { output } = await runDrift(['Consumer', '--json']);

    const parsed = JSON.parse(output) as StackDriftJson[];
    expect(parsed[0]!.clean).toEqual([]);
    expect(parsed[0]!.drifted).toHaveLength(1);
    expect(parsed[0]!.drifted[0]!.logicalId).toBe('Fn');
    expect(parsed[0]!.drifted[0]!.referencesUnresolved).toBe(true);
    // The reported change is the PUBLIC one; the secret-bearing path was skipped.
    expect(parsed[0]!.drifted[0]!.changes.map((c) => c.path)).toEqual([
      'Environment.Variables.PLAIN',
    ]);
    expect(parsed[0]!.notCompared).toEqual([
      { logicalId: 'Fn', type: LAMBDA_TYPE, referencesUnresolved: true, cause: 'refused' },
    ]);
    expect(output).not.toContain(IRELAND_PASSWORD);
    expect(output).not.toContain(TOKYO_PASSWORD);
  });

  it('the human summary counts a refused resource as inspected but NOT as checked', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [PRODUCER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD),
    });

    const { output } = await runDrift(['Consumer']);

    // `1 resource checked` was the pre-fix text, and it contradicted the
    // `PARTIALLY compared` block printed two lines below it.
    expect(output).toContain('0 of 1 resource fully checked');
    expect(output).toContain('1 only partially compared');
    expect(output).not.toContain('1 resource checked');
    // The glyph follows the exit code, as it does for every other cdkd command
    // that exits 2.
    expect(output).toContain('⚠ Consumer');
    expect(output).not.toContain('✓ Consumer');
  });
});

describe('the drift EXIT CODE is scoped to REFUSALS, not to everything uncompared (issue #2108)', () => {
  /**
   * The narrowing this group exists to hold. "Not compared" has TWO causes --
   * cdkd REFUSED to resolve, or a `{{resolve:...}}` token simply survived -- and
   * the second one is a large PRE-EXISTING population (`ssm-secure`, which cdkd
   * resolves for nobody) that predates issue #2108 and can never clear on a
   * re-run. Driving the exit code off both would make `cdkd drift` exit non-zero
   * forever, in CI, for every one of those users, over a defect this change did
   * not introduce.
   *
   * So the report and the exit code deliberately answer DIFFERENT questions, and
   * the pair of cases below is what keeps them apart. Since issue #2135 the
   * cause is one field on the `notCompared` outcome: the exit reads
   * `notComparedCause === 'refused'`, while `notCompared` / the human
   * `PARTIALLY compared` block still cover both populations, because as
   * INFORMATION both were genuinely not compared.
   */
  it('a SURVIVING ssm-secure token alone exits 0 — it is reported, never refused', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    // No foreign producer on record, so nothing can be refused; the token is
    // simply one cdkd cannot resolve at all.
    mockGetState.mockResolvedValue(makeState({ Fn: lambdaResource(SSM_SECURE_EXPR) }, []));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv('whatever-aws-holds-here'),
    });

    const { output, error } = await runDrift(['Consumer']);

    // Nothing was fetched: `ssm-secure` never reaches a resolver.
    expect(secretSends).toHaveLength(0);
    expect(ssmSends).toHaveLength(0);
    // THE ASSERTION. This population exited 0 before #2108 and must keep doing
    // so -- it is permanent, so a non-zero exit here can never be cleared.
    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    // ...and it is still REPORTED, which is the half that does not change: the
    // exit code is narrower than the report on purpose, not by omission.
    expect(output).toContain('PARTIALLY compared');
  });

  it('the same run still marks it notCompared in --json, so only the exit code is narrowed', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(makeState({ Fn: lambdaResource(SSM_SECURE_EXPR) }, []));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv('whatever-aws-holds-here'),
    });

    const { output } = await runDrift(['Consumer', '--json']);

    const parsed = JSON.parse(output) as StackDriftJson[];
    // Without this the narrowing could have been implemented by simply dropping
    // the population from the report, which would delete information rather
    // than re-scope the exit code.
    expect(parsed[0]!.clean).toEqual([]);
    expect(parsed[0]!.notCompared).toEqual([
      {
        logicalId: 'Fn',
        type: LAMBDA_TYPE,
        referencesUnresolved: true,
        cause: 'unresolvedToken',
      },
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('a refusal in the SAME run does exit 2, so the two causes are told apart per resource', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    // Two resources: one merely unresolvable, one genuinely refused. If the exit
    // decision could not tell them apart per RESOURCE, this case and the first
    // one could not both hold.
    mockGetState.mockResolvedValue(
      makeState(
        { Survivor: lambdaResource(SSM_SECURE_EXPR), Refused: lambdaResource(NAME_EXPR) },
        [PRODUCER_REGION]
      )
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD),
    });

    const { output } = await runDrift(['Consumer', '--json']);

    const parsed = JSON.parse(output) as StackDriftJson[];
    expect(parsed[0]!.notCompared.map((n) => n.logicalId).sort()).toEqual(['Refused', 'Survivor']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  /**
   * ONE RESOURCE CARRYING BOTH CAUSES — the case that fences the PRECEDENCE of
   * the two arms, which nothing else in this suite does.
   *
   * Every other case here separates the causes across two RESOURCES, and a
   * per-resource split is decided by which outcome each one gets, not by the
   * order the two arms are written in: flip the ternary at the construction
   * site and all of them stay green. The ordering is only observable when ONE
   * resource sets BOTH flags, and it is reachable rather than theoretical --
   * `onUnresolved` accumulates surviving tokens as the pass walks leaves and
   * the refusal throws on a LATER leaf, so `unresolvedTokens` is already
   * non-empty when `secretResolutionFailed` is set, and the `catch` does not
   * clear it.
   *
   * Under the flipped order this resource classifies as `unresolvedToken`,
   * `outcomeExitSignal` answers `none`, and the command EXITS 0 on a refused
   * comparison -- the exact silent downgrade issues #2108 and #2135 exist to
   * prevent. `refused` therefore has to win, and the direction is not
   * symmetric: `unresolvedToken` must NOT drive a non-zero exit, because
   * `ssm-secure` is a large pre-existing population that can never clear on a
   * re-run, while `refused` must, because pre-#2108 that same population exited
   * 1 and exiting 0 would be a downgrade.
   */
  it('ONE resource with BOTH causes is `refused`, not `unresolvedToken`: exits 2', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(makeState({ Fn: bothCausesResource() }, [PRODUCER_REGION]));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => bothCausesAws(),
    });

    const { output } = await runDrift(['Consumer']);

    // THE PREMISE, asserted positively rather than assumed: this fixture only
    // fences the ordering while it really does set BOTH flags on ONE resource.
    // Each warning is emitted from its own branch -- the `catch` for the
    // refusal, the `unresolvedTokens.size > 0` block for the survivor -- so the
    // pair is direct evidence that both were true at the construction site. A
    // later fixture change that stopped tripping one of them would leave this
    // test passing over a premise it no longer has, and the ordering unfenced
    // again.
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('refused to resolve a dynamic reference'))).toBe(true);
    expect(warnings.some((w) => w.includes(`cdkd cannot resolve ${SSM_SECURE_EXPR}`))).toBe(true);

    // THE ASSERTION. Nothing drifted -- both secret-bearing leaves were
    // SKIPPED, which is why `2` and not `1` is the code that must appear -- so
    // the exit code is decided by the cause alone, and `2` is observable only
    // when the cause resolved to `refused`.
    expect(output).toContain('no drift detected');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    // ...and the REPORT covers it under both causes alike, so the narrowing
    // lives in the exit code only: the resource is inspected, not checked, and
    // named in the block.
    expect(output).toContain('0 of 1 resource fully checked');
    expect(output).toContain('1 only partially compared');
    const block = output.slice(output.indexOf('PARTIALLY compared'));
    expect(block).toContain('! Fn (');
  });
});

describe('every rendering agrees about what was NOT compared (issue #2135)', () => {
  /**
   * The acceptance this refactor was filed for: the exit code, `--json`, the
   * human `PARTIALLY compared` block and the `N of M fully checked` counter all
   * answer from the SAME outcome variant, so they cannot drift apart the way
   * they did across two review rounds on the #2108 lane.
   *
   * One state, three resources chosen so each rendering has to make a different
   * call about each: one compared-and-matched, one refused (the exit-code
   * population), and one carrying a surviving `{{resolve:ssm-secure:...}}`
   * token, which is reported but deliberately NOT in the exit code. Asserting
   * them together is the point -- each rendering on its own was already correct
   * at some round or other.
   */
  function mixedState(): ReturnType<typeof makeState> {
    return makeState(
      {
        Matched: lambdaResource('plain-value'),
        Refused: lambdaResource(NAME_EXPR),
        Survivor: lambdaResource(SSM_SECURE_EXPR),
      },
      [PRODUCER_REGION]
    );
  }

  /** AWS agrees with state for every resource, so nothing can drift. */
  function mixedProvider(): { readCurrentState: (p: string, l: string) => Promise<unknown> } {
    return {
      readCurrentState: async (_physicalId: string, logicalId: string) =>
        logicalId === 'Matched' ? awsEnv('plain-value') : awsEnv(IRELAND_PASSWORD),
    };
  }

  it('the human counter, its PARTIALLY block and the exit code tell the same story', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(mixedState());
    mockRegistryGetProvider.mockReturnValue(mixedProvider());

    const { output } = await runDrift(['Consumer']);

    // 1 of 3, not 3 of 3: two resources were inspected and never compared, and
    // the counter is the number a user actually reads off this report.
    expect(output).toContain('1 of 3 resources fully checked');
    expect(output).toContain('2 only partially compared');
    // The SAME two, named -- a count that agrees with a block listing different
    // resources would still be a report that contradicts itself.
    const block = output.slice(output.indexOf('PARTIALLY compared'));
    expect(block).toContain('! Refused (');
    expect(block).toContain('! Survivor (');
    expect(block).not.toContain('! Matched (');
    // ...and the exit code, which is the narrower question: only `Refused` is a
    // refusal, so 2 rather than 0, and never 1 (nothing drifted).
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('--json rolls up exactly the resources the human report withheld from `checked`', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(mixedState());
    mockRegistryGetProvider.mockReturnValue(mixedProvider());

    const { output } = await runDrift(['Consumer', '--json']);

    const parsed = JSON.parse(output) as StackDriftJson[];
    // The positive marker on the OTHER side of the same run: `clean` holds the
    // one resource the counter called `checked`, and nothing else.
    expect(parsed[0]!.clean).toEqual([
      { logicalId: 'Matched', type: LAMBDA_TYPE, referencesUnresolved: false },
    ]);
    expect(parsed[0]!.notCompared).toEqual([
      { logicalId: 'Refused', type: LAMBDA_TYPE, referencesUnresolved: true, cause: 'refused' },
      {
        logicalId: 'Survivor',
        type: LAMBDA_TYPE,
        referencesUnresolved: true,
        cause: 'unresolvedToken',
      },
    ]);
    expect(parsed[0]!.drifted).toEqual([]);
  });

  it('an UNSUPPORTED resource is outside the `N of M` denominator too (issue #2141)', async () => {
    // The other site that reads `inspected`. The test above fences the `✓`
    // branch's `N resources checked`; this one fences the `⚠` branch's
    // `N of M ... fully checked`, which the same counter feeds.
    //
    // Four resources, three of them the mixed fixture above and a fourth whose
    // provider returns nothing. The denominator must stay `3`: cdkd attempted
    // a comparison for three resources and produced none for the fourth, so
    // counting it would claim a read that never happened -- the same
    // overstatement in the partially-compared rendering.
    //
    // WHICH ROUTE reaches `unsupported` here, stated because the obvious
    // reading is wrong: the registry is mocked, so the queue's provider has no
    // `readCurrentState` AND this file's Cloud Control double resolves
    // `undefined`, which drift.ts turns into `unsupported`. Do not read that as
    // the production shape for `AWS::SQS::Queue` -- it has a real provider WITH
    // `readCurrentState` and is never unsupported -- nor as "no
    // readCurrentState implies unsupported", because in production that case
    // reaches the LIVE Cloud Control fallback, which can THROW rather than
    // resolve `undefined` (issue #2151). The arithmetic under test does not
    // depend on the route: every route pushes the same `unsupported` outcome,
    // and the deny-list route -- the one needing no AWS call at all -- is
    // covered against real AWS in `tests/integration/nested-stack/verify.sh`
    // Phase A2.
    //
    // THE DISCRIMINATOR is `1 of 3`, and it pins BOTH numbers deliberately.
    // Restoring the `unsupported` increment renders `2 of 4` -- the increment
    // moves the NUMERATOR too, via `checked = inspected - notCompared.length`
    // -- so a companion negative would have had to spell `of 4` rather than
    // `1 of 4` to catch it. Pinning the whole fragment sidesteps that trap and
    // needs no companion at all. The `1 unsupported` half alone would catch
    // nothing: it is printed from `unsupported.length`, which the increment
    // does not feed.
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState(
        {
          Matched: lambdaResource('plain-value'),
          Refused: lambdaResource(NAME_EXPR),
          Survivor: lambdaResource(SSM_SECURE_EXPR),
          Unread: {
            physicalId: 'q',
            resourceType: 'AWS::SQS::Queue',
            properties: { QueueName: 'q' },
          },
        },
        [PRODUCER_REGION]
      )
    );
    // Keyed on the TYPE, which is what `getProviderFor` passes: the Lambda
    // resources keep the mixed provider, and the queue's provider implements
    // nothing, which is what makes it `unsupported`.
    mockRegistryGetProvider.mockImplementation((resourceType: string) =>
      resourceType === LAMBDA_TYPE ? mixedProvider() : {}
    );

    const { output } = await runDrift(['Consumer']);

    expect(output).toContain('1 of 3 resources fully checked');
    // THE WHOLE LINE, because the fragments above cannot see how it is
    // GROUPED. Issue #2141 moved `unsupported` out of the parenthetical: while
    // it sat inside, this rendering printed `(2 only partially compared, 1
    // unsupported)` against a stated total of `3`, so its parts summed to 4.
    // Outside the parens the paren accounts for exactly the
    // `inspected - checked` gap. Every `toContain` fragment in this test
    // survives that regrouping unchanged -- measured, by reverting the regroup
    // and watching all 32 tests in this file stay green -- so without this
    // assertion the grouping is unfenced.
    expect(output).toContain(
      'no drift detected, but 1 of 3 resources fully checked ' +
        '(2 only partially compared), 1 unsupported'
    );
    // The premise, stated positively: the fourth resource WAS seen and
    // classified, rather than dropped upstream -- without this, `1 of 3` is
    // also what a report that lost the queue entirely would print.
    expect(output).toContain('1 unsupported');
    expect(output).toContain('? Unread (AWS::SQS::Queue)');
    // The partially-compared population is unchanged by the addition: the
    // queue is reported under its own heading, not in this block.
    const block = output.slice(output.indexOf('PARTIALLY compared'));
    expect(block).not.toContain('! Unread (');
    expect(output).toContain('2 only partially compared');
  });

  it('a DRIFTED resource whose comparison was incomplete is in the human block too', async () => {
    // The half only `--json` used to hold. A drifted resource is never mistaken
    // for a clean one, so the flag shape survived here -- but the human report
    // must still say the reported changes are not the whole comparison, or a
    // reader fixes the one drift shown and believes the resource is done.
    mockListStacks.mockResolvedValue([{ stackName: 'Consumer', region: CONSUMER_REGION }]);
    mockGetState.mockResolvedValue(
      makeState({ Fn: lambdaResource(NAME_EXPR) }, [PRODUCER_REGION])
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv(IRELAND_PASSWORD, 'tampered'),
    });

    const { output } = await runDrift(['Consumer']);

    expect(output).toContain('drift detected on 1 resource');
    const block = output.slice(output.indexOf('PARTIALLY compared'));
    expect(block).toContain('! Fn (');
    // Drift outranks the refusal in the exit code, and the block does not
    // change that.
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
