import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { parse as parseYaml } from 'yaml';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Issue [#2280](https://github.com/go-to-k/cdkd/issues/2280): `cdkd list
 * --long --json` must put NOTHING but the payload on stdout — and this is the
 * worst of the six sites the issue names, because it needs no flags at all:
 * `src/synthesis/app-executor.ts` re-emits the CDK app's stderr (bundling
 * progress, warnings) at `logger.info` on a DEFAULT run, so any CDK app that
 * prints to stderr corrupts the payload with no `--verbose` involved.
 *
 * Issue [#2410](https://github.com/go-to-k/cdkd/issues/2410) then made the
 * reservation UNCONDITIONAL, because `--json` was never what made this a
 * payload stream: it selects the ENCODING, while `--long` /
 * `--show-dependencies` emit the same structured document as YAML and the
 * default mode emits one display id per line — the shape a shell loop reads.
 * All three were corruptible by exactly the chatter above. The cases below
 * are therefore split: the `--json` ones fence #2280's contract, the YAML and
 * default-mode ones fence #2410's, and the last one is the OVER-TIGHTENING
 * control that replaces #2280's now-obsolete "no flag ⇒ prose stays on
 * stdout" negative control. The FILENAME still says `json` because #2280's
 * changelog entry names it; the subject is `cdkd list`'s stdout in every mode.
 *
 * THE LOGGER IS DELIBERATELY NOT MOCKED IN THIS FILE (unlike
 * `tests/unit/cli/list.test.ts`): the defect is which `console` method
 * `ConsoleLogger.emit` picks, so the real logger runs and the console methods
 * are spied into an ordered fd-1 / fd-2 transcript — the measurement behind
 * that harness shape is documented in `tests/unit/cli/drift-json-stream.test.ts`.
 *
 * Two emission sources are driven, one per case:
 *  - the synth-chatter case MODELS `app-executor.ts`'s stderr re-emission by
 *    having the mocked synthesizer emit through the REAL global logger's
 *    `child('AppExecutor')` — the exact logger shape the production line uses
 *    (`this.logger = getLogger().child('AppExecutor')`); the child-logger
 *    inheritance of the reservation is separately fenced in
 *    `tests/unit/utils/logger-stdout-reservation.test.ts`, so what this case
 *    adds is that `listCommand` actually claims stdout before synthesis runs.
 *  - the `--role-arn` case drives REAL production prose end to end:
 *    `applyRoleArnIfSet` (`src/utils/role-arn.ts`) emits `Assumed role ...`
 *    at INFO with only STS mocked.
 */

const mockSynthesize = vi.fn();
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
  })),
}));

const mockResolveApp = vi.fn();
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: (cliApp?: string) => mockResolveApp(cliApp),
}));

const mockStsSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: vi.fn(),
  })),
  AssumeRoleCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { createListCommand } from '../../../src/cli/commands/list.js';
import { getLogger, releaseStdoutForPayload } from '../../../src/utils/logger.js';

function makeStack(overrides: Partial<StackInfo> & { stackName: string }): StackInfo {
  return {
    artifactId: overrides.stackName,
    displayName: overrides.displayName ?? overrides.stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
    account: '111111111111',
    ...overrides,
  } as StackInfo;
}

interface Streams {
  stdout: string;
  stderr: string;
  error: unknown;
}

async function runList(args: string[]): Promise<Streams> {
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
    const cmd = createListCommand();
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

const CHATTER = 'Bundling asset MyStack/MyFunction/Code/Stage...';
const ROLE_ARN = 'arn:aws:iam::111122223333:role/cdkd-json-stream-reader';
const ASSUMED_LINE = `Assumed role ${ROLE_ARN}`;

describe('list keeps stdout to the payload in every mode (issues #2280, #2410)', () => {
  let envBefore: Record<string, string | undefined>;

  beforeEach(() => {
    mockSynthesize.mockReset();
    mockResolveApp.mockReset().mockReturnValue('node app.js');
    mockStsSend.mockReset().mockResolvedValue({
      Credentials: {
        AccessKeyId: 'AKIA_LANE2280_TEST',
        SecretAccessKey: 'secret-lane2280-test',
        SessionToken: 'token-lane2280-test',
        Expiration: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    envBefore = {
      AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
      AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
      AWS_SESSION_TOKEN: process.env['AWS_SESSION_TOKEN'],
    };
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack({ stackName: 'MyStack' })],
    });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    releaseStdoutForPayload();
    getLogger().setLevel('info');
  });

  it('--long --json with synth chatter leaves stdout a single JSON document', async () => {
    mockSynthesize.mockImplementation(async () => {
      // Models `app-executor.ts`'s `this.logger.info(line)` re-emission of
      // the CDK app's stderr — same logger, same level, same call path
      // through `ConsoleLogger.emit`.
      getLogger().child('AppExecutor').info(CHATTER);
      return { stacks: [makeStack({ stackName: 'MyStack' })] };
    });

    const { stdout, stderr, error } = await runList(['--long', '--json']);

    expect(error).toBeUndefined();
    const payload = JSON.parse(stdout) as Array<{ id: string; name: string }>;
    expect(payload).toEqual([
      {
        id: 'MyStack',
        name: 'MyStack',
        environment: { account: '111111111111', region: 'us-east-1' },
      },
    ]);

    // MOVED, not dropped — the operator still sees the bundling progress.
    expect(stderr).toContain(CHATTER);
    expect(stdout).not.toContain(CHATTER);
  });

  it('--long --json --role-arn moves the real role-assumption notice to stderr', async () => {
    const { stdout, stderr, error } = await runList([
      '--long',
      '--json',
      '--role-arn',
      ROLE_ARN,
    ]);

    expect(error).toBeUndefined();
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain(ASSUMED_LINE);
    expect(stdout).not.toContain(ASSUMED_LINE);
  });

  /**
   * Issue #2410, the YAML spelling of the same structured payload: `--long`
   * with no `--json`. Under #2280's `options.json` gate this case put the
   * chatter on stdout, in the middle of a YAML document.
   */
  it('--long WITHOUT --json leaves stdout a single YAML document (issue #2410)', async () => {
    mockSynthesize.mockImplementation(async () => {
      getLogger().child('AppExecutor').info(CHATTER);
      return { stacks: [makeStack({ stackName: 'MyStack' })] };
    });

    const { stdout, stderr, error } = await runList(['--long']);

    expect(error).toBeUndefined();
    // `account` reads back as the STRING it is in the payload. It used to
    // come back as a NUMBER — `toYaml` emitted the all-digit string unquoted
    // and YAML's implicit typing resolved it — and this suite asserted that
    // as-found, because parsing at all was the point here and the type
    // divergence belonged to the serializer. Issue #2421 fixed the
    // serializer, so the YAML and `--json` spellings above now agree.
    expect(parseYaml(stdout)).toEqual([
      {
        id: 'MyStack',
        name: 'MyStack',
        environment: { account: '111111111111', region: 'us-east-1' },
      },
    ]);

    expect(stderr).toContain(CHATTER);
    expect(stdout).not.toContain(CHATTER);
  });

  /**
   * Issue #2410, the default mode: one display id per line. No flags at all,
   * which is what made this the worst spelling of the class — a shell loop
   * over `cdkd list` read the bundling chatter as a stack name.
   */
  it('default mode leaves stdout to the display ids alone (issue #2410)', async () => {
    mockSynthesize.mockImplementation(async () => {
      getLogger().child('AppExecutor').info(CHATTER);
      return {
        stacks: [makeStack({ stackName: 'MyStack' }), makeStack({ stackName: 'OtherStack' })],
      };
    });

    const { stdout, stderr, error } = await runList([]);

    expect(error).toBeUndefined();
    // Byte-exact: the payload is the id list and nothing else, in dependency
    // order. `toContain` would pass with the chatter appended.
    expect(stdout).toBe('MyStack\nOtherStack\n');

    expect(stderr).toContain(CHATTER);
    expect(stdout).not.toContain(CHATTER);
  });

  /**
   * Issue #2410, the THIRD structured mode: `--show-dependencies` without
   * `--long`. It takes a different branch in `listCommand` from the `--long`
   * case above (its own `emitStructured` call with `DependencyRecord`s), and
   * it is one of the three modes this command's reservation comment and the
   * docs table both name — so leaving it unfenced would let a future change
   * re-gate the reservation on `options.long` with every other case green.
   */
  it('--show-dependencies WITHOUT --long leaves stdout a single YAML document', async () => {
    mockSynthesize.mockImplementation(async () => {
      getLogger().child('AppExecutor').info(CHATTER);
      return { stacks: [makeStack({ stackName: 'MyStack' })] };
    });

    const { stdout, stderr, error } = await runList(['--show-dependencies']);

    expect(error).toBeUndefined();
    expect(parseYaml(stdout)).toEqual([{ id: 'MyStack', dependencies: [] }]);

    expect(stderr).toContain(CHATTER);
    expect(stdout).not.toContain(CHATTER);
  });

  /**
   * The OVER-TIGHTENING control, replacing #2280's "no `--json` ⇒ prose stays
   * on stdout" case (which #2410 deliberately made false). Two independent
   * things would red it:
   *  - the PAYLOAD being routed off stdout too, or partly leaking onto
   *    stderr — pinned by the byte-exact `toBe` plus the `not.toContain` on
   *    the other stream;
   *  - a diagnostic being DUPLICATED onto both streams — pinned by the
   *    exactly-once count.
   *
   * Two writers are exercised because they reach the streams by different
   * mechanisms and only one of them goes through the code under test: the
   * warn runs `ConsoleLogger.emit`'s `level === 'warn'` arm while the
   * reservation is active, and `warnIfDeprecatedRegion` (`src/cli/options.ts`)
   * is a DIRECT `process.stderr.write` that the reservation must leave
   * untouched.
   */
  it('warnings land on stderr exactly once and never on stdout, payload untouched', async () => {
    const WARN_LINE = 'lane2410-list-warn-control';
    mockSynthesize.mockImplementation(async () => {
      getLogger().child('AppExecutor').warn(WARN_LINE);
      return { stacks: [makeStack({ stackName: 'MyStack' })] };
    });

    const { stdout, stderr, error } = await runList(['--region', 'us-east-1']);

    expect(error).toBeUndefined();

    // Payload still on stdout, byte-exact, and no part of it on stderr.
    expect(stdout).toBe('MyStack\n');
    expect(stderr).not.toContain('MyStack');

    expect(stderr.split(WARN_LINE).length - 1).toBe(1);
    expect(stdout).not.toContain(WARN_LINE);

    const deprecationNeedle = '--region is deprecated';
    expect(stderr.split(deprecationNeedle).length - 1).toBe(1);
    expect(stdout).not.toContain(deprecationNeedle);
  });
});
