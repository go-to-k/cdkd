import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
/**
 * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275): the confirmation
 * prompt this file drives now REFUSES a non-interactive stdin
 * (`CdkdError` / `NON_INTERACTIVE_CONFIRM`, from the shared
 * `confirmOrRefuse` helper) instead of hanging on a `question` an EOF stdin
 * can never settle. Vitest's stdin is NOT a TTY, so every case that exercises
 * the PROMPT has to present as interactive; the refusal cases set it back.
 */
import { setStdinIsTty } from '../../stdin-tty.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * Issue [#2230](https://github.com/go-to-k/cdkd/issues/2230): `cdkd drift --json`
 * must put NOTHING but the payload on stdout, and must still SHOW the operator
 * every human-facing line it would otherwise have printed there.
 *
 * THE LOGGER IS DELIBERATELY NOT MOCKED IN THIS FILE, unlike every other
 * `drift` suite. The whole defect is which `console` method `ConsoleLogger.emit`
 * picks, and a `vi.fn()` standing in for `getLogger()` answers that question by
 * construction: it records the call and writes nothing, so `--json` output looks
 * clean whether or not the fix exists. `tests/unit/cli/drift.test.ts`'s two
 * `--json` cases pass today for exactly that reason. Here the real logger runs
 * and the CONSOLE METHODS are spied instead.
 *
 * WHY THE SPIES REPLACE `console.*` RATHER THAN `process.stdout.write`: measured
 * on this toolchain, Vitest intercepts `console` and its output never reaches
 * `process.stdout.write` / `process.stderr.write` at all (probe on 2026-08-26:
 * `console.info` inside a test produced zero chunks on both patched streams). A
 * capture built only on the stream methods is therefore BLIND to every logger
 * line, so it would report "stdout parses" over a run that in production emits
 * prose. `console.info` / `console.debug` / `console.log` go to fd 1 and
 * `console.warn` / `console.error` go to fd 2 — that is a Node guarantee, not a
 * detail of this suite — so routing the spies into an ordered fd-1 / fd-2
 * transcript alongside the real `process.stdout.write` calls models the real
 * binary's two streams. `tests/integration` is not involved; the ground truth
 * for that model is the live `node dist/cli.js ... 1>out 2>err` run recorded in
 * the PR body.
 */

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

const mockIamSend = vi.hoisted(() => vi.fn());
/**
 * Resolves the ONE reference the masking case below plants, so `o.secrets` is
 * non-empty when `printRevertPlan` masks a path. With an empty map
 * `maskSecretsInText` is the identity function, and a case that never populates
 * it cannot tell the masked call from a bare `path`.
 */
const mockSecretsManagerSend = vi.hoisted(() =>
  vi.fn(async () => ({ SecretString: JSON.stringify({ password: 'cdkd-lanec-plaintext-8f3a' }) }))
);
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
  getAwsClients: () => ({
    secretsManager: { send: mockSecretsManagerSend },
    ssm: { send: vi.fn() },
  }),
}));

const mockGetState =
  vi.fn<
    (
      stackName: string,
      region: string
    ) => Promise<{ state: StackState; etag: string; migrationPending?: boolean } | null>
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

/**
 * `applyRoleArnIfSet` (`src/utils/role-arn.ts`) is the module the reservation
 * exists FOR: it logs `Assuming role ...` at DEBUG and `Assumed role ...` at
 * INFO through a `child()` logger, from a file `drift.ts` does not own. Mocking
 * STS is what lets a unit case drive it.
 */
const mockStsSend = vi.hoisted(() => vi.fn());
const mockStsDestroy = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: mockStsDestroy,
  })),
  AssumeRoleCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

/**
 * `confirmPrompt` hands `readline.createInterface` a sink ONCE and the
 * interface holds it, so the stream is fenced by the IDENTITY passed here --
 * there are no bytes to capture.
 *
 * Two wrong ways to fence this, both measured and both rejected. Driving the
 * REAL `readline/promises` HANGS: vitest's stdin is not a TTY, so `question`
 * never settles (Node 24.15). And `expect(stdout).not.toContain('[y/N]')` is a
 * confluence point -- it passes just as well if the prompt were dropped
 * entirely, which is the regression that makes a confirmation INVISIBLE.
 */
const mockCreateInterface = vi.hoisted(() =>
  // The parameter is TYPED rather than inferred: `vi.fn(() => ...)` gives
  // `mock.calls` an empty-tuple element type, so reading `calls[0][0]` — the
  // whole point of these two cases — does not type-check.
  vi.fn((_opts: { input: unknown; output: unknown }) => ({
    question: async (): Promise<string> => 'y',
    close: (): void => {},
  }))
);
vi.mock('node:readline/promises', () => ({
  createInterface: mockCreateInterface,
}));

const mockCcReadCurrentState = vi
  .fn<() => Promise<Record<string, unknown> | undefined>>()
  .mockResolvedValue(undefined);
vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: mockCcReadCurrentState,
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { getLogger, releaseStdoutForPayload } from '../../../src/utils/logger.js';

interface Streams {
  /** Everything a pipe reading fd 1 would receive, in order. */
  stdout: string;
  /** Everything a terminal reading fd 2 would receive, in order. */
  stderr: string;
  error: unknown;
}

/**
 * Run the `drift` subcommand with fd 1 and fd 2 modelled separately.
 *
 * Both the direct `process.stdout.write` calls (the payload, the plans) and the
 * `console.*` calls the logger makes are funnelled into the same two buffers, so
 * `stdout` is the byte stream a consumer's `JSON.parse` actually sees.
 */
async function runDrift(args: string[]): Promise<Streams> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  // fd 1 for console.log / console.info / console.debug, fd 2 for console.warn /
  // console.error -- Node's own mapping, which is what makes the routing choice
  // inside `ConsoleLogger.emit` observable at all.
  const toFd1 = (line: unknown): void => void out.push(`${String(line)}\n`);
  const toFd2 = (line: unknown): void => void err.push(`${String(line)}\n`);
  const consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(toFd1),
    vi.spyOn(console, 'info').mockImplementation(toFd1),
    vi.spyOn(console, 'debug').mockImplementation(toFd1),
    vi.spyOn(console, 'warn').mockImplementation(toFd2),
    vi.spyOn(console, 'error').mockImplementation(toFd2),
  ];

  let error: unknown;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    for (const spy of consoleSpies) spy.mockRestore();
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

/**
 * Drop SGR escapes. The logger colours its VERBOSE rendering, so the raw line
 * is `<esc>[90mDEBUG<esc>[0m [role-arn] ...` and a plain ` DEBUG ` needle never
 * matches -- which is how a level assertion silently becomes untestable rather
 * than merely fussy.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function resource(resourceType: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'phys-id', resourceType, properties };
}

function makeState(resources: Record<string, ResourceState>): {
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

const BUCKET = 'AWS::S3::Bucket';
const QUEUE = 'AWS::SQS::Queue';
const ARGS = ['TestStack', '--state-bucket', 'b', '--region', 'us-east-1'];

/** An SDK-shaped error: `name` is what the AWS SDK v3 sets. */
function awsError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** A provider whose readback matches state, so its resource is `clean`. */
const CLEAN_PROVIDER = {
  readCurrentState: async (): Promise<Record<string, unknown>> => ({ QueueName: 'ok' }),
};

/** A provider whose readback DIFFERS from state, so its resource is `drifted`. */
const DRIFTED_PROVIDER = {
  readCurrentState: async (): Promise<Record<string, unknown>> => ({
    VersioningConfiguration: { Status: 'Suspended' },
  }),
};

/**
 * State whose only resource has a drifted `VersioningConfiguration`.
 * Paired with {@link DRIFTED_PROVIDER}.
 */
function driftedState(): { state: StackState; etag: string } {
  return makeState({
    Bucket1: resource(BUCKET, { VersioningConfiguration: { Status: 'Enabled' } }),
  });
}

let originalIsTTY: boolean | undefined;
beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
});
afterEach(() => {
  setStdinIsTty(originalIsTTY);
});

describe('drift --json keeps stdout to the payload (issue #2230)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  // `applyRoleArnIfSet` WRITES the assumed credentials into `process.env`, so
  // the `--role-arn` cases below would otherwise leak them into every later
  // case in this file.
  let envBefore: Record<string, string | undefined>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
    mockSaveState.mockReset().mockResolvedValue('"etag-2"');
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockGetLockInfo.mockReset().mockResolvedValue(null);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    mockCcReadCurrentState.mockReset().mockResolvedValue(undefined);
    mockIamSend.mockReset();
    mockStsSend.mockReset().mockResolvedValue({
      Credentials: {
        AccessKeyId: 'AKIA_LANEC_TEST',
        SecretAccessKey: 'secret-lanec-test',
        SessionToken: 'token-lanec-test',
        Expiration: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    mockStsDestroy.mockReset();
    mockCreateInterface.mockClear();
    mockSecretsManagerSend.mockClear();
    // The resolved-value cache is module-global; clearing it keeps the
    // masking case independent of whatever ran before it.
    resetAccountInfoCache();
    envBefore = {
      AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
      AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
      AWS_SESSION_TOKEN: process.env['AWS_SESSION_TOKEN'],
    };
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    exitSpy.mockRestore();
    // The reservation is module-global by design (it is a property of the
    // PROCESS's stdout, so a `child()` logger inherits it). Releasing here keeps
    // one case from deciding the next one's routing.
    releaseStdoutForPayload();
    // Same reasoning, second global: `drift.ts` raises the level on the logger
    // SINGLETON under `--verbose` and never lowers it, so without this every
    // case declared after the `--verbose` one renders in verbose form. Harmless
    // today (the later assertions are substring-based) but it makes them
    // ORDER-DEPENDENT, which is the state this hook exists to prevent.
    getLogger().setLevel('info');
  });

  /**
   * THE FENCE THE ISSUE NAMES. `--json --accept` over a run that drifted
   * nowhere but could not compare everything prints the issue-#2208
   * incomplete-remediation message, and printed it onto the payload's stream.
   *
   * The discriminator is `JSON.parse(stdout)`, not "stdout contains the
   * payload": the broken path emits BOTH the payload and the prose, so any
   * containment assertion passes on it. Only parsing the WHOLE stream as one
   * document separates the two paths.
   */
  it('--json --accept on an incomplete comparison leaves stdout a single JSON document', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Bucket1: resource(BUCKET, { VersioningConfiguration: { Status: 'Enabled' } }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? CLEAN_PROVIDER
        : {
            readCurrentState: async (): Promise<never> => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { stdout, stderr, error } = await runDrift([...ARGS, '--json', '--accept']);

    expect(error).toBeUndefined();
    const payload = JSON.parse(stdout) as Array<{
      stack: string;
      notCompared: Array<{ logicalId: string; cause: string }>;
    }>;
    // The premise, stated positively: this run really did take the incomplete
    // remediation path, so the message below was genuinely emitted. Without
    // this a fixture that silently stopped reaching that path would still parse.
    expect(payload[0]?.notCompared).toEqual([
      { logicalId: 'Bucket1', type: BUCKET, referencesUnresolved: false, cause: 'readFailed' },
    ]);

    // ...and the operator still sees the message. Asserted on stderr rather
    // than as "absent from stdout": a fix that DROPPED the lines would satisfy
    // the parse above while losing the one thing the run had to say.
    expect(stderr).toContain('Comparison INCOMPLETE — nothing to accept');
    expect(stderr).toContain('1 of 2 resource(s) could not be compared.');
    expect(stderr).toContain("Re-run 'cdkd drift' without --accept");
    expect(stdout).not.toContain('Comparison INCOMPLETE');
  });

  it('--json --revert on an incomplete comparison does the same, with the revert wording', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Bucket1: resource(BUCKET, { VersioningConfiguration: { Status: 'Enabled' } }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? CLEAN_PROVIDER
        : {
            readCurrentState: async (): Promise<never> => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { stdout, stderr } = await runDrift([...ARGS, '--json', '--revert']);

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain('Comparison INCOMPLETE — nothing to revert');
    expect(stderr).toContain("Re-run 'cdkd drift' without --revert");
  });

  /**
   * The line this replaced (`No drift detected — nothing to accept.`) is the
   * OTHER arm of the same branch and was on stdout for the same reason.
   */
  it('--json --accept with nothing to do puts the no-drift line on stderr', async () => {
    mockGetState.mockResolvedValue(makeState({ Queue: resource(QUEUE, { QueueName: 'ok' }) }));
    mockRegistryGetProvider.mockReturnValue(CLEAN_PROVIDER);

    const { stdout, stderr } = await runDrift([...ARGS, '--json', '--accept']);

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain('No drift detected — nothing to accept.');
    expect(stdout).not.toContain('No drift detected');
  });

  /**
   * The PLAN printers do not go through the logger at all — they call
   * `process.stdout.write` directly — so the logger-level reservation cannot
   * reach them and they are routed per call site. A test that only covered the
   * `logger.info` lines would report the fix complete with these still broken.
   */
  it('--json --accept --dry-run puts the whole accept plan on stderr', async () => {
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);

    const { stdout, stderr } = await runDrift([...ARGS, '--json', '--accept', '--dry-run']);

    const payload = JSON.parse(stdout) as Array<{ drifted: Array<{ logicalId: string }> }>;
    expect(payload[0]?.drifted.map((d) => d.logicalId)).toEqual(['Bucket1']);

    expect(stderr).toContain('Plan (--accept): update cdkd state for TestStack (us-east-1):');
    expect(stderr).toContain('~ Bucket1 (AWS::S3::Bucket)');
    expect(stderr).toContain('VersioningConfiguration.Status: Enabled -> Suspended');
    expect(stderr).toContain('--dry-run: state will NOT be written.');
    expect(stdout).not.toContain('Plan (--accept)');
    expect(stdout).not.toContain('--dry-run: state will NOT be written.');
  });

  it('--json --revert --dry-run puts the whole revert plan on stderr', async () => {
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);

    const { stdout, stderr } = await runDrift([...ARGS, '--json', '--revert', '--dry-run']);

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain(
      'Plan (--revert): push cdkd state values back into AWS for TestStack (us-east-1):'
    );
    expect(stderr).toContain('→ provider.update on Bucket1 (AWS::S3::Bucket)');
    expect(stderr).toContain('--dry-run: AWS will NOT be modified.');
    expect(stdout).not.toContain('Plan (--revert)');
  });

  /**
   * The write path's own summary line, which runs AFTER the payload was already
   * flushed — so it appends prose to a document a consumer may already be
   * mid-parse on. `-y` skips the prompt here; the prompt's OWN stream is fenced
   * separately, by the `createInterface` identity cases below.
   */
  it('--json --accept -y puts the state-updated summary on stderr', async () => {
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);

    const { stdout, stderr } = await runDrift([...ARGS, '--json', '--accept', '-y']);

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(stderr).toContain('✓ State updated for TestStack (us-east-1):');
    expect(stderr).toContain('accepted drift on 1 resource(s).');
    expect(stdout).not.toContain('✓ State updated');
  });

  /**
   * THE ORDERING FENCE, and the justification for the flag being module-level
   * at all.
   *
   * `applyRoleArnIfSet` lives in `src/utils/role-arn.ts` and logs through a
   * `child()` logger, so it is BOTH out of reach of any per-call-site fix in
   * `drift.ts` AND out of reach of an instance field on the command's own
   * logger. It also runs BEFORE the payload is written, which is why
   * `drift.ts` reserves stdout above it rather than beside the report.
   *
   * Moving the reservation below `applyRoleArnIfSet` puts `Assumed role ...`
   * on stdout AHEAD of the `[`, so `JSON.parse` fails on the first character.
   * That is what this case measures; previously the placement rested on a
   * comment and `--role-arn` appeared in no drift test at all.
   */
  it('--json --role-arn keeps the assume-role notice from a helper module off stdout', async () => {
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);

    const { stdout, stderr } = await runDrift([
      ...ARGS,
      '--json',
      '--role-arn',
      'arn:aws:iam::111122223333:role/cdkd-lanec',
      '--accept',
      '--dry-run',
    ]);

    // The premise, positively: the helper really ran. Without this the parse
    // below passes on a fixture that never reached `applyRoleArnIfSet`.
    expect(mockStsSend).toHaveBeenCalledTimes(1);
    expect(stderr).toContain('Assumed role arn:aws:iam::111122223333:role/cdkd-lanec');

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stdout).not.toContain('Assumed role');
  });

  /**
   * `--verbose` promotes `logger.debug` onto the same stream, and `--json` must
   * win.
   *
   * DRIVEN THROUGH `--role-arn` because the ordinary fixture emits no DEBUG
   * line at all: `drift.ts`'s two `logger.debug` sites are in the
   * secret-resolution path, which a versioning-only drift never enters. The
   * earlier version of this case asserted `stderr.length > 0`, which the plan
   * alone satisfies -- so it passed with `--verbose` removed, and failed when
   * asked for an actual ` DEBUG ` line. The assertion is now that line.
   */
  it('--json --verbose routes a real DEBUG line to stderr, not stdout', async () => {
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);

    const { stdout, stderr } = await runDrift([
      ...ARGS,
      '--json',
      '--verbose',
      '--role-arn',
      'arn:aws:iam::111122223333:role/cdkd-lanec',
      '--accept',
      '--dry-run',
    ]);

    expect(() => JSON.parse(stdout)).not.toThrow();
    // A REAL debug line, in the logger's verbose rendering (timestamp + padded
    // level + the `child()` prefix), not merely "stderr is non-empty".
    expect(stripAnsi(stderr)).toMatch(
      / DEBUG \[role-arn\] Assuming role arn:aws:iam::111122223333:role\/cdkd-lanec/
    );
    expect(stripAnsi(stdout)).not.toMatch(/ DEBUG /);
  });

  /**
   * `confirmPrompt` writes through `readline`, which no logger flag reaches and
   * which produces no capturable bytes here -- so the fence is the IDENTITY of
   * the sink handed to `createInterface`. Reverting `drift.ts`'s `out.stream`
   * to `process.stdout` left the whole suite green before this case existed,
   * and that regression makes the confirmation prompt INVISIBLE to anyone
   * piping stdout.
   */
  it('--json attaches the confirmation prompt to stderr', async () => {
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);

    // No `-y` and no `--dry-run`, so the prompt is actually reached.
    const { stdout } = await runDrift([...ARGS, '--json', '--accept']);

    expect(mockCreateInterface).toHaveBeenCalledTimes(1);
    const opts = mockCreateInterface.mock.calls[0]?.[0];
    expect(opts).toBeDefined();
    expect(opts.output).toBe(process.stderr);
    expect(opts.output).not.toBe(process.stdout);
    // ...and the run really did proceed past the prompt, so the interface was
    // consulted rather than constructed and abandoned.
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  /**
   * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275), the ROUTING
   * half. `tests/unit/cli/non-interactive-confirm-guards.test.ts` probes this
   * command's prompt HELPER directly (the `NON_INTERACTIVE_CONFIRM` code, the
   * refusal wording, the never-settling-question hang fence); what a
   * helper-level probe cannot see is whether the COMMAND's own call site
   * still reaches it, or has grown a second `readline.createInterface` of its
   * own. This case drives the real command path with no confirmation flag and
   * a non-TTY stdin, and asserts the refusal surfaces with nothing mutated.
   */
  it('REFUSES a non-interactive --accept run and never opens the prompt', async () => {
    setStdinIsTty(undefined);
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);

    // No `-y` and no `--dry-run`, so the prompt would be reached.
    const { stderr, error } = await runDrift([...ARGS, '--accept']);

    expect(error).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const text = stripAnsi(stderr);
    expect(text).toContain('CdkdError');
    expect(text).toContain('The cdkd drift confirmation prompt cannot run');
    expect(text).toContain('-y / --yes');
    // Refused before the interface exists, and state left alone.
    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  /**
   * The `--revert` twin of the case above, and NOT redundant with it.
   *
   * `drift.ts` has TWO prompt call sites — one per mode — and the docs table
   * row is labelled "`--accept` / `--revert`", so a single `--accept` case
   * left half of what the row claims unfenced: deleting the guard from the
   * revert call site alone would keep every other case in this file green.
   *
   * `--revert` also has strictly more to lose than `--accept`: it calls
   * `provider.update` against LIVE AWS, so the refusal is asserted against
   * the provider as well as against the state write.
   */
  it('REFUSES a non-interactive --revert run and never calls provider.update', async () => {
    setStdinIsTty(undefined);
    const update = vi.fn();
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue({ ...DRIFTED_PROVIDER, update });

    // No `-y` and no `--dry-run`, so the prompt would be reached.
    const { stderr, error } = await runDrift([...ARGS, '--revert']);

    expect(error).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const text = stripAnsi(stderr);
    expect(text).toContain('CdkdError');
    expect(text).toContain('The cdkd drift confirmation prompt cannot run');
    expect(text).toContain('-y / --yes');
    // Refused before the interface exists — and before AWS was touched.
    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('without --json the confirmation prompt stays on stdout', async () => {
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);

    await runDrift([...ARGS, '--accept']);

    expect(mockCreateInterface).toHaveBeenCalledTimes(1);
    const opts = mockCreateInterface.mock.calls[0]?.[0];
    expect(opts).toBeDefined();
    expect(opts.output).toBe(process.stdout);
  });

  it('without --json the assume-role notice stays on stdout', async () => {
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);

    const { stdout } = await runDrift([
      ...ARGS,
      '--role-arn',
      'arn:aws:iam::111122223333:role/cdkd-lanec',
      '--accept',
      '--dry-run',
    ]);

    expect(stdout).toContain('Assumed role arn:aws:iam::111122223333:role/cdkd-lanec');
  });

  /**
   * THE DEEP PLAN BLOCKS. `printRevertPlan`'s per-resource warnings -- the
   * preserved-tag list, the unbaselined-value list, and the two withheld
   * variants of each -- are 8 of the 13 routed `out.write` sites, and none of
   * them is reachable from a versioning-only drift. Rewriting all 8 back to
   * `process.stdout.write` left the suite green before these cases existed.
   *
   * Issue #1501's shape: the baseline carries `Env`, AWS additionally carries a
   * service-managed `AmazonECSManaged` that a revert cannot strip, so the plan
   * has to say so before the user confirms.
   */
  it('--json --revert routes the preserved-tag warning block to stderr', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Svc: {
          physicalId: 'svc-1',
          resourceType: 'AWS::ECS::Service',
          properties: { Tags: [{ Key: 'Env', Value: 'prod' }] },
          // PRESENT, so the trailer renders its `Every other tag reverts
          // normally. ` half -- the branch the raw-TEMPLATE baseline omits.
          observedProperties: { Tags: [{ Key: 'Env', Value: 'prod' }] },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async (): Promise<Record<string, unknown>> => ({
        Tags: [
          { Key: 'Env', Value: 'dev' },
          { Key: 'AmazonECSManaged', Value: 'true' },
        ],
      }),
    });

    const { stdout, stderr } = await runDrift([...ARGS, '--json', '--revert', '--dry-run']);

    expect(() => JSON.parse(stdout)).not.toThrow();
    // All three sites in the block, each a separate `out.write`.
    expect(stderr).toContain('! reverting this tag list KEEPS 1 AWS-authored tag');
    expect(stderr).toContain('Tags.AmazonECSManaged');
    expect(stderr).toContain('Every other tag reverts normally.');
    expect(stdout).not.toContain('AWS-authored tag');
    expect(stdout).not.toContain('Tags.AmazonECSManaged');
  });

  /**
   * Issue #1626's shape: no observed-capture baseline, so the revert pushes the
   * raw template and LEAVES every AWS-authored key inside a drifted subtree
   * untouched. Three more `out.write` sites.
   */
  it('--json --revert routes the unbaselined-value warning block to stderr', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Table: {
          physicalId: 'tbl-1',
          resourceType: 'AWS::Glue::Table',
          // No `observedProperties` -- that absence IS the trigger.
          properties: { Parameters: { classification: 'parquet' } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async (): Promise<Record<string, unknown>> => ({
        Parameters: { classification: 'json', metadata_location: 's3://b/metadata/00000.json' },
      }),
    });

    const { stdout, stderr } = await runDrift([...ARGS, '--json', '--revert', '--dry-run']);

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain('this resource has no observed-capture baseline');
    expect(stderr).toContain('Parameters.metadata_location');
    expect(stderr).toContain("Run 'cdkd state refresh-observed TestStack'");
    expect(stdout).not.toContain('observed-capture baseline');
    expect(stdout).not.toContain('metadata_location');
  });

  /**
   * The masked-path `out.write` inside the unbaselined block, with `o.secrets`
   * actually POPULATED.
   *
   * The two `maskSecretsInText(path, o.secrets)` calls in `printRevertPlan`
   * exist because these paths are built from `o.awsProperties` -- the one bag
   * on this path that is deliberately unredacted -- so a readback answering
   * with a map KEYED by a secret would print the plaintext. With an empty
   * secrets map the call is the identity function, so the two cases above
   * cannot distinguish `maskSecretsInText(path, ...)` from a bare `path`.
   * Here the AWS-authored KEY *is* the resolved secret, which is exactly the
   * shape the masking was written for.
   *
   * NOTE this case fences ONE of those two calls (the unbaselined-value block).
   * The preserved-tag one is fenced by
   * `tests/unit/cli/drift-secret-redaction.test.ts` -- measured: stripping the
   * mask there leaves this file 18/18 GREEN and reddens that suite instead. So
   * the coverage exists, it just does not live here.
   */
  it('--json --revert masks a secret-valued path in the unbaselined block', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Table: {
          physicalId: 'tbl-1',
          resourceType: 'AWS::Glue::Table',
          properties: {
            Parameters: { classification: 'parquet' },
            Cred: '{{resolve:secretsmanager:cdkd-lanec-secret:SecretString:password}}',
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async (): Promise<Record<string, unknown>> => ({
        Parameters: {
          classification: 'json',
          // AWS answering with the secret as a KEY -- unmaskable from the value
          // map alone unless the print site masks it.
          'cdkd-lanec-plaintext-8f3a': 'x',
        },
        Cred: 'cdkd-lanec-plaintext-8f3a',
      }),
    });

    const { stdout, stderr } = await runDrift([...ARGS, '--json', '--revert', '--dry-run']);

    expect(() => JSON.parse(stdout)).not.toThrow();
    // The premise: the reference really resolved, so the map is non-empty.
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
    // The block was reached...
    expect(stderr).toContain('this resource has no observed-capture baseline');
    // ...and the path is MASKED rather than printed. Both halves: the mask is
    // present at that path, and the plaintext appears on NEITHER stream.
    expect(stderr).toContain('Parameters.***');
    expect(stderr).not.toContain('cdkd-lanec-plaintext-8f3a');
    expect(stdout).not.toContain('cdkd-lanec-plaintext-8f3a');
  });

  /**
   * The two WITHHELD variants, which are separate `out.write` calls rather than
   * a branch inside the blocks above: when the resource carries a dynamic
   * reference cdkd could not resolve, the key / path names come from an
   * unredacted live readback and cannot be checked for secrets, so they are
   * suppressed and the reason is printed instead. One fixture reaches both,
   * since both are gated on the same `notComparedCause`.
   */
  it('--json --revert routes both withheld warning variants to stderr', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Svc: {
          physicalId: 'svc-1',
          resourceType: 'AWS::ECS::Service',
          properties: {
            // cdkd never resolves this spelling, so the token SURVIVES and the
            // outcome carries a `notComparedCause` -- with no AWS call needed.
            Secret: '{{resolve:ssm-secure:/cdkd/lanec/pw:1}}',
            Tags: [{ Key: 'Env', Value: 'prod' }],
            Parameters: { classification: 'parquet' },
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async (): Promise<Record<string, unknown>> => ({
        Secret: 'whatever-aws-returns',
        Tags: [
          { Key: 'Env', Value: 'dev' },
          { Key: 'AmazonECSManaged', Value: 'true' },
        ],
        Parameters: { classification: 'json', metadata_location: 's3://b/metadata/00000.json' },
      }),
    });

    const { stdout, stderr } = await runDrift([...ARGS, '--json', '--revert', '--dry-run']);

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain('AWS-authored tag(s) will be preserved, but cdkd could not');
    expect(stderr).toContain('AWS-authored value(s) will be left untouched, but cdkd');
    // The withholding actually withheld: neither name is printed anywhere.
    expect(stderr).not.toContain('Tags.AmazonECSManaged');
    expect(stderr).not.toContain('Parameters.metadata_location');
    expect(stdout).not.toContain('will be preserved');
  });

  /**
   * NEGATIVE CONTROL. Every case above would also pass if the fix had moved
   * these lines to stderr UNCONDITIONALLY, which would break the ordinary
   * human run — the mode the vast majority of invocations use. Same fixture,
   * no `--json`: the lines must be back on stdout.
   */
  it('without --json the same lines stay on stdout', async () => {
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);

    const { stdout } = await runDrift([...ARGS, '--accept', '--dry-run']);

    expect(stdout).toContain('Plan (--accept): update cdkd state for TestStack (us-east-1):');
    expect(stdout).toContain('--dry-run: state will NOT be written.');
  });

  it('without --json the incomplete-remediation message stays on stdout', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Bucket1: resource(BUCKET, { VersioningConfiguration: { Status: 'Enabled' } }),
        Queue: resource(QUEUE, { QueueName: 'ok' }),
      })
    );
    mockRegistryGetProvider.mockImplementation((type: string) =>
      type === QUEUE
        ? CLEAN_PROVIDER
        : {
            readCurrentState: async (): Promise<never> => {
              throw awsError('ThrottlingException', 'Rate exceeded');
            },
          }
    );

    const { stdout } = await runDrift([...ARGS, '--accept']);

    expect(stdout).toContain('Comparison INCOMPLETE — nothing to accept');
  });

  /**
   * The payload must be UNCHANGED by the remediation flags, not merely
   * parseable. A fix that suppressed the payload under `--accept` would satisfy
   * `JSON.parse` on an empty-ish stream in some shapes; this pins the bytes
   * against the detection-only run over the same fixture.
   */
  it('the --accept payload is byte-identical to the detection-only payload', async () => {
    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);
    const detection = await runDrift([...ARGS, '--json']);
    // Detection-only exits 1 on drift; the payload is written before the throw.
    expect(detection.error).toBeDefined();

    mockGetState.mockResolvedValue(driftedState());
    mockRegistryGetProvider.mockReturnValue(DRIFTED_PROVIDER);
    const accept = await runDrift([...ARGS, '--json', '--accept', '--dry-run']);

    expect(accept.stdout).toBe(detection.stdout);
  });
});
