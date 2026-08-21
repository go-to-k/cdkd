/**
 * One stack's REFUSAL must not abandon the rest of a `cdkd scrub --all` run
 * (issue [#2109](https://github.com/go-to-k/cdkd/issues/2109) review).
 *
 * The region refusal is raised for a whole STACK, and the command's loop had no
 * boundary: a refusal in stack k meant stacks k+1..N were never scrubbed, while
 * 1..k-1 had already been rewritten. Silently — the operator sees one error and
 * has no way to tell which of the remaining stacks were examined. The rollback
 * replay's twin refusal does not behave that way (it is per-op, and the other
 * ops still run), and the over-refusal is easy to hit: ANY name-form
 * `secretsmanager` reference — the ordinary `secretValueFromJson` shape — in a
 * stack with any foreign producer region on record raises it.
 *
 * What must NOT be traded away in fixing it: the run still ends NON-ZERO, and
 * no summary line claims success over a stack this run could not examine. Only
 * the BLAST RADIUS narrows.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const commandLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
}));
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...commandLogger, child: () => commandLogger }),
}));

const synthStacks = vi.hoisted(() => [] as unknown[]);
const commandStateBackend = vi.hoisted(() => ({
  getState: vi.fn(),
  saveState: vi.fn().mockResolvedValue('etag-2'),
}));
vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(() => Promise.resolve({ stacks: synthStacks })),
    expandMacrosForStacks: vi.fn().mockResolvedValue(undefined),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
}));
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {} })),
  setAwsClients: vi.fn(),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));
vi.mock('../../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => commandStateBackend),
}));
vi.mock('../../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  })),
}));

const SECRET_PLAINTEXT = 'second-stack-plaintext-value';
/** The region-LESS name form — what a stack with a foreign producer read refuses. */
const NAME_EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';

// The RESOLVER is doubled here (unlike the sibling cross-region suite, which
// fakes the SDK clients to observe regions): this file's subject is the LOOP,
// and the refusal it needs is raised by the region CLASSIFIER before any
// resolver call, so a region-observable double would buy nothing.
vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const walk = (v: unknown): unknown => {
          if (v === NAME_EXPR) {
            ctx.recordedSecretValues?.set(SECRET_PLAINTEXT, NAME_EXPR);
            return SECRET_PLAINTEXT;
          }
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
            return out;
          }
          return v;
        };
        return Promise.resolve(walk(value));
      }),
  })),
}));

import { scrubCommand, type ScrubOptions } from '../../../../src/cli/commands/scrub.js';

function commandOptions(overrides: Partial<ScrubOptions> = {}): ScrubOptions {
  return { output: 'cdk.out', statePrefix: 'cdkd', verbose: false, all: true, ...overrides };
}

function makeStackInfo(stackName: string): { stackName: string; template: CloudFormationTemplate } {
  return {
    stackName,
    template: {
      Resources: {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: { MasterUserPassword: NAME_EXPR, MasterUsername: 'admin' },
        },
      },
    },
  };
}

/**
 * @param crossRegionRead a foreign producer region on record, which is what
 *   turns the ordinary name-form reference above into a refusal.
 */
function makeState(stackName: string, crossRegionRead: boolean): StackState {
  return {
    version: 8,
    region: 'us-east-1',
    stackName,
    resources: {
      Db: {
        physicalId: 'db-1',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { MasterUserPassword: SECRET_PLAINTEXT, MasterUsername: 'admin' },
      },
    },
    outputs: {},
    ...(crossRegionRead && {
      imports: [
        { sourceStack: 'Producer', sourceRegion: 'eu-west-1', exportName: 'Producer:Db' },
      ],
    }),
    lastModified: 0,
  };
}

describe('cdkd scrub --all: one stack refusing does not abandon the others (issue #2109)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    synthStacks.length = 0;
    synthStacks.push(makeStackInfo('Refuses'), makeStackInfo('Scrubbable'));
    commandStateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve({ state: makeState(stackName, stackName === 'Refuses'), etag: 'etag-1' })
    );
    commandStateBackend.saveState.mockResolvedValue('etag-2');
  });

  it('scrubs the LATER stack and still exits non-zero, naming the refused one', async () => {
    const err = await scrubCommand([], commandOptions()).catch((e: unknown) => e);

    // NON-ZERO, and exit 2 ("error") rather than the `--fail` code — the run
    // could not examine a stack, which is not the same finding as "plaintext
    // is in state".
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('SCRUB_STACKS_FAILED');
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    // Every failed stack is NAMED: a bare "1 stack failed" would make the
    // operator re-run the command to find out which.
    expect((err as Error).message).toContain('Refuses');
    // ...but its REASON is not restated here. It was already logged at `error`
    // level as the run reached that stack, and `handleError` prints this
    // message too, so repeating it put the whole failure set on the terminal
    // twice — directly under a summary whose own note says "see the errors
    // above".
    expect((err as Error).message).not.toContain('carries no region of its own');
    const errored = commandLogger.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errored).toContain('Scrub of Refuses failed:');
    expect(errored).toContain('carries no region of its own');
    expect(errored.match(/carries no region of its own/g)).toHaveLength(1);

    // THE assertion: the stack AFTER the refusal was scrubbed. Without the
    // boundary the refusal propagates out of the loop and this never happens.
    const saved = commandStateBackend.saveState.mock.calls.map((c) => c[0] as string);
    expect(saved).toEqual(['Scrubbable']);
    const savedState = commandStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(savedState.resources['Db']!.properties['MasterUserPassword']).toBe(NAME_EXPR);
    // The refused stack was NOT written — a partial scrub of a stack whose
    // references could not be classified is exactly what the refusal prevents.
    expect(saved).not.toContain('Refuses');
  });

  it('never reports a clean run over a stack it could not examine', async () => {
    // The "nothing to scrub" summary is the dangerous one: with both stacks
    // already clean, the run would otherwise print "No plaintext secrets found
    // in any target stack state" — a claim about a stack it never read.
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      const state = makeState(stackName, stackName === 'Refuses');
      state.resources['Db']!.properties['MasterUserPassword'] = NAME_EXPR;
      return Promise.resolve({ state, etag: 'etag-1' });
    });

    const err = await scrubCommand([], commandOptions()).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_STACKS_FAILED');
    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).not.toContain('in any target stack state');
    expect(summary).toContain('could NOT be scrubbed');
  });

  it('reports a failed stack WITH its cause chain, not just the wrapper message', async () => {
    // A provider / AWS failure is routinely a generic sentence over the link
    // that names the denied action, and this `logger.error` is now the ONLY
    // place a per-stack reason is rendered (the aggregate names stacks and
    // stops there). Keeping `err.message` alone dropped the actionable half.
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      if (stackName === 'Refuses') {
        return Promise.reject(
          new Error('failed to read state', {
            cause: new Error('AccessDenied: s3:GetObject on cdkd-state-bucket'),
          })
        );
      }
      return Promise.resolve({ state: makeState(stackName, false), etag: 'etag-1' });
    });

    const err = await scrubCommand([], commandOptions()).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_STACKS_FAILED');
    const errored = commandLogger.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errored).toContain('failed to read state');
    expect(errored).toContain('Caused by: AccessDenied: s3:GetObject on cdkd-state-bucket');
    // The boundary still held: the LATER stack was scrubbed.
    expect(commandStateBackend.saveState.mock.calls.map((c) => c[0] as string)).toEqual([
      'Scrubbable',
    ]);
  });

  it('--dry-run --fail: the REFUSAL outranks the finding, so the exit is 2 and not 1', async () => {
    // Both are true at once here — a stack could not be examined (exit 2) AND
    // the stacks that could be examined hold plaintext (`--fail`, exit 1) — and
    // the order of the two throws is what decides. They mean opposite things to
    // a CI gate ("re-spell the reference" vs. "rotate the secret"), so the
    // precedence must not be able to invert silently.
    const err = await scrubCommand([], commandOptions({ dryRun: true, fail: true })).catch(
      (e: unknown) => e
    );

    expect((err as { code?: string }).code).toBe('SCRUB_STACKS_FAILED');
    expect((err as { code?: string }).code).not.toBe('SCRUB_NEEDED');
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    // `--dry-run` wrote nothing, for the stack it could scrub as much as for
    // the one it refused.
    expect(commandStateBackend.saveState).not.toHaveBeenCalled();
    // The `--fail` finding was real, so the precedence is what the assertion
    // above actually measured rather than an absence of plaintext.
    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).toContain('would be scrubbed');
  });
});
