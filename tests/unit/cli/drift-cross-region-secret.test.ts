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
  }>;
  clean: Array<{ logicalId: string; type: string }>;
  notSupported: Array<{ logicalId: string; type: string }>;
  skipped: Array<{ logicalId: string; type: string }>;
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
    // Never leaks either region's value.
    expect(text).not.toContain(TOKYO_PASSWORD);
    expect(text).not.toContain(IRELAND_PASSWORD);
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
    // `{{resolve:...}}` string, so the degraded baseline reports the resource
    // clean rather than drifted-forever against the Tokyo password.
    expect(parsed[0]!.drifted).toEqual([]);
    expect(parsed[0]!.clean.map((c) => c.logicalId)).toEqual(['Fn']);
    const text = logText();
    expect(text).toContain('NOT compared');
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
    // ...and the real secret is still never printed.
    expect(output).not.toContain(IRELAND_PASSWORD);
  });
});
