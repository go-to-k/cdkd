import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { parse as parseYaml } from 'yaml';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Issue [#2410](https://github.com/go-to-k/cdkd/issues/2410): `cdkd synth`
 * writes the CloudFormation template to stdout with NO flag involved, so the
 * issue-[#2280](https://github.com/go-to-k/cdkd/issues/2280) reservation —
 * which was keyed on `--json` — could not cover it. The template was
 * SANDWICHED between `Synthesizing CDK app...` and the `Synthesis complete!`
 * summary block, both at INFO on stdout, so `cdkd synth | yq` corrupted on
 * every default run. `cdk synth` prints only the template on stdout and
 * routes its logs to stderr; this suite fences that contract.
 *
 * THE LOGGER IS DELIBERATELY NOT MOCKED (the same choice, for the same
 * reason, as `tests/unit/cli/list-json-stream.test.ts`): the defect is which
 * `console` method `ConsoleLogger.emit` picks, so the real logger runs and
 * the console methods are spied into ONE ordered fd-1 / fd-2 transcript. A
 * suite that mocked `reserveStdoutForPayload` would pass over the defect by
 * construction.
 *
 * The prose is driven from REAL production sources, never from string
 * literals invented here:
 *  - the synth-chatter case emits through `getLogger().child('AppExecutor')`,
 *    mirroring `src/synthesis/app-executor.ts`'s
 *    `this.logger = getLogger().child('AppExecutor')` stderr re-emission;
 *  - the summary block, the `Synthesizing CDK app...` line and the
 *    `Output: <dir>` line are `synth.ts`'s own `logger.info` calls;
 *  - the `--role-arn` case drives `applyRoleArnIfSet`
 *    (`src/utils/role-arn.ts`) with only STS mocked.
 */

const mockSynthesize = vi.fn();
vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/synthesis/synthesizer.js')>();
  return {
    ...actual,
    Synthesizer: vi.fn().mockImplementation(() => ({
      synthesize: mockSynthesize,
    })),
  };
});

const mockResolveApp = vi.fn();
// `importOriginal` spread rather than a full replacement, matching the
// sibling suites: a factory that enumerates exports silently becomes a
// `TypeError: x is not a function` INSIDE the command the day the module
// under test imports one more of them, and it surfaces as empty stdout or a
// parse error rather than as a missing symbol (memory rule
// `mock-factory-missing-export-fails-as-undefined-call`). `synth.ts` uses
// only `resolveApp` today; this keeps that from being load-bearing.
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/config-loader.js')>();
  return {
    ...actual,
    resolveApp: (cliApp?: string) => mockResolveApp(cliApp),
  };
});

const mockStsSend = vi.hoisted(() => vi.fn());
// Same reason as above: `applyRoleArnIfSet` is driven for real here, so it is
// the SDK module whose export surface must not be enumerated.
vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-sts')>()),
  STSClient: vi.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: vi.fn(),
  })),
  AssumeRoleCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { createSynthCommand } from '../../../src/cli/commands/synth.js';
import { getLogger, releaseStdoutForPayload } from '../../../src/utils/logger.js';

const TEMPLATE = {
  Resources: {
    Bucket2410: {
      Type: 'AWS::S3::Bucket',
      Properties: { BucketName: 'cdkd-lane2410-payload-bucket' },
    },
  },
  Outputs: {
    BucketName2410: { Value: { Ref: 'Bucket2410' } },
  },
} as const;

function makeStack(overrides: Partial<StackInfo> & { stackName: string }): StackInfo {
  return {
    artifactId: overrides.stackName,
    displayName: overrides.displayName ?? overrides.stackName,
    template: TEMPLATE,
    dependencyNames: [],
    region: 'eu-west-3',
    account: '111111111111',
    ...overrides,
  } as unknown as StackInfo;
}

interface Streams {
  stdout: string;
  stderr: string;
  error: unknown;
}

async function runSynth(args: string[]): Promise<Streams> {
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
    const cmd = createSynthCommand();
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
const ROLE_ARN = 'arn:aws:iam::111122223333:role/cdkd-lane2410-synth-reader';
const ASSUMED_LINE = `Assumed role ${ROLE_ARN}`;
const SUMMARY_MARKER = 'Synthesis complete!';
const SYNTHESIZING_MARKER = 'Synthesizing CDK app...';

describe('synth keeps stdout to the template payload (issue #2410)', () => {
  let envBefore: Record<string, string | undefined>;

  beforeEach(() => {
    mockSynthesize.mockReset();
    mockResolveApp.mockReset().mockReturnValue('node app.js');
    mockStsSend.mockReset().mockResolvedValue({
      Credentials: {
        AccessKeyId: 'AKIA_LANE2410_TEST',
        SecretAccessKey: 'secret-lane2410-test',
        SessionToken: 'token-lane2410-test',
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
      assemblyDir: 'cdk.out',
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

  it('leaves stdout a single YAML template document, summary and chatter on stderr', async () => {
    mockSynthesize.mockImplementation(async () => {
      // Models `app-executor.ts`'s `this.logger.info(line)` re-emission of the
      // CDK app's stderr — same logger, same level, same path through
      // `ConsoleLogger.emit`.
      getLogger().child('AppExecutor').info(CHATTER);
      return { stacks: [makeStack({ stackName: 'MyStack' })], assemblyDir: 'cdk.out' };
    });

    const { stdout, stderr, error } = await runSynth([]);

    expect(error).toBeUndefined();

    // The payload: stdout parses as ONE YAML document and is byte-exact the
    // template. A parse alone would not catch prose appended after a valid
    // document, so the round-trip equality is the load-bearing half.
    expect(parseYaml(stdout)).toEqual(TEMPLATE);

    // MOVED, not dropped — every prose line is still visible to an operator.
    for (const line of [CHATTER, SYNTHESIZING_MARKER, SUMMARY_MARKER, 'Output: cdk.out']) {
      expect(stderr).toContain(line);
      expect(stdout).not.toContain(line);
    }
  });

  /**
   * Issue [#2421](https://github.com/go-to-k/cdkd/issues/2421). The case
   * above already parsed stdout and still could not see this defect: its
   * `TEMPLATE` holds no YAML indicator character and no number, so the
   * serializer's quoting was never exercised — a green parse over a fixture
   * that cannot fail. The template here is the shape the bug was reproduced
   * on (`tests/integration/basic` is one S3 bucket whose CORS rule alone
   * broke `cdkd synth | yq`), plus a number, so this case discriminates on
   * the serializer rather than on the stream.
   */
  it('emits a template whose indicator characters and numbers survive a parse (issue #2421)', async () => {
    const wildcardTemplate = {
      Resources: {
        Bucket2421: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            CorsConfiguration: {
              CorsRules: [{ AllowedHeaders: ['*'], AllowedOrigins: ['*'], MaxAge: 3600 }],
            },
          },
        },
        Policy2421: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }],
            },
          },
        },
      },
    };
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack({ stackName: 'MyStack', template: wildcardTemplate })],
      assemblyDir: 'cdk.out',
    });

    const { stdout, error } = await runSynth([]);

    expect(error).toBeUndefined();
    // Parsing at all is half of it — a bare `- *` throws `BAD_ALIAS`. The
    // equality is the other half: `MaxAge` must stay a number and the IAM
    // policy `Version` must stay a string.
    expect(parseYaml(stdout)).toEqual(wildcardTemplate);
    expect(stdout).toContain('- "*"');
    // The document starts at column 0 — `toYaml` no longer returns a leading
    // newline for a non-empty container, so `synth` no longer opens with a
    // blank line while `list` (which used to strip it) does not.
    expect(stdout.startsWith('Resources:')).toBe(true);
  });

  it('--role-arn moves the real role-assumption notice to stderr', async () => {
    const { stdout, stderr, error } = await runSynth(['--role-arn', ROLE_ARN]);

    expect(error).toBeUndefined();
    expect(parseYaml(stdout)).toEqual(TEMPLATE);
    expect(stderr).toContain(ASSUMED_LINE);
    expect(stdout).not.toContain(ASSUMED_LINE);
  });

  /**
   * The accepted consequence of the unconditional reservation, asserted
   * explicitly because it is a real behavior change rather than an oversight:
   * `synth.ts` emits the template only for a SINGLE stack, so a multi-stack
   * app now writes NOTHING to stdout and the whole summary block goes to
   * stderr. stdout on `cdkd synth` is the template or it is empty; the
   * summary is never a payload.
   */
  it('multi-stack writes nothing at all to stdout and the whole summary to stderr', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack({ stackName: 'StackA' }), makeStack({ stackName: 'StackB' })],
      assemblyDir: 'cdk.out',
    });

    const { stdout, stderr, error } = await runSynth([]);

    expect(error).toBeUndefined();
    expect(stdout).toBe('');
    expect(stderr).toContain(SUMMARY_MARKER);
    expect(stderr).toContain('StackA');
    expect(stderr).toContain('StackB');
  });

  /**
   * The OVER-TIGHTENING control. Issue #2280's negative control was "no
   * `--json` ⇒ prose stays on stdout"; #2410 moves the default contract
   * itself, so that control is gone and this replaces it: a fix that routed
   * the PAYLOAD away from stdout too, or that duplicated a diagnostic onto
   * stdout, reds here.
   *
   * The warn is real production prose: `processStackMessages`
   * (`src/synthesis/stack-messages.ts:154`) emits `[Warning at <path>] ...`
   * for a CDK `addWarning` annotation.
   */
  it('a stack warning lands on stderr exactly once and never on stdout, payload untouched', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        makeStack({
          stackName: 'MyStack',
          messages: [
            {
              level: 'warning',
              path: '/MyStack/Bucket2410',
              message: 'lane2410-annotation-warning',
            },
          ],
        } as Partial<StackInfo> & { stackName: string }),
      ],
      assemblyDir: 'cdk.out',
    });

    const { stdout, stderr, error } = await runSynth([]);

    expect(error).toBeUndefined();

    // The payload is STILL on stdout and byte-exact — nothing of it leaked to
    // stderr.
    expect(parseYaml(stdout)).toEqual(TEMPLATE);
    expect(stderr).not.toContain('cdkd-lane2410-payload-bucket');

    const warnLine = '[Warning at /MyStack/Bucket2410] lane2410-annotation-warning';
    expect(stderr.split(warnLine).length - 1).toBe(1);
    expect(stdout).not.toContain(warnLine);
  });
});
