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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
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
/**
 * What `expandMacrosForStacks` does to the templates it is handed (issue #2133
 * review). The real one rewrites them IN PLACE, so anything that READS a
 * template must run after it; `macroExpansion.apply` is the seam that makes
 * that observable.
 */
const macroExpansion = vi.hoisted(() => ({
  apply: undefined as ((stacks: unknown[]) => void) | undefined,
}));
vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(() => Promise.resolve({ stacks: synthStacks })),
    expandMacrosForStacks: vi.fn().mockImplementation((stacks: unknown[]) => {
      macroExpansion.apply?.(stacks);
      return Promise.resolve(undefined);
    }),
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
/**
 * Issue #2133 review: when set, the doubled resolver raises the PERMANENT
 * by-design refusal (`CrossAccountSecretRefusalError`, what the cross-account
 * `Fn::GetStackOutput` arm raises) for an ISOLATED cross-stack node — the shape
 * the pre-pass resolves. Single-key only, so the main resolution's whole-bag
 * call still succeeds and the stack is still scrubbed for everything else.
 *
 * The SUBCLASS, not its base: five of the base class's six throw sites are
 * user-FIXABLE and must refuse the stack rather than become a finding, which is
 * the distinction the pre-pass now makes.
 */
const declineCrossStackRead = vi.hoisted(() => ({ on: false }));

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  // The module's non-class exports must survive the double: `scrub.ts` imports
  // `carriesDynamicReference` from here (issue #2133), and a factory that names
  // only the class turns every consumer into a "no such export" failure —
  // which the loop then reports as a scrub FAILURE, not as the clean run this
  // file's negative controls assert.
  const actual = (await importOriginal()) as Record<string, unknown>;
  // Imported INSIDE the factory: a `vi.mock` factory is hoisted above this
  // file's own imports, so a top-level binding may not be initialized yet when
  // the factory runs.
  const { CrossAccountSecretRefusalError } = await import(
    '../../../../src/utils/error-handler.js'
  );
  return {
  ...actual,
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const node = value as Record<string, unknown>;
        if (
          declineCrossStackRead.on &&
          node &&
          typeof node === 'object' &&
          Object.keys(node).length === 1 &&
          'Fn::GetStackOutput' in node
        ) {
          return Promise.reject(
            new CrossAccountSecretRefusalError(
              'Fn::GetStackOutput: cross-account reference to a redacted dynamic reference'
            )
          );
        }
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
  };
});

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

describe('cdkd scrub --all orders targets AFTER macro expansion (issue #2133 review)', () => {
  afterEach(() => {
    macroExpansion.apply = undefined;
  });

  it('a macro-introduced Fn::ImportValue still puts its producer FIRST', async () => {
    // `orderScrubTargets` decides producer-before-consumer by SCANNING each
    // target's template for `Fn::ImportValue`, and `expandMacrosForStacks`
    // rewrites those templates in place. Ordering first therefore sorted
    // PRE-expansion templates, so an import a macro introduces was invisible to
    // the sort and its producer could be scrubbed SECOND — which is the whole
    // ordering guarantee, since a consumer can only learn an imported secret's
    // expression from an already-scrubbed producer.
    vi.clearAllMocks();
    synthStacks.length = 0;
    // INPUT ORDER is consumer-first, so an unsorted run is distinguishable.
    synthStacks.push(makeStackInfo('Consumer'), makeStackInfo('Producer'));
    commandStateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve({ state: makeState(stackName, false), etag: 'etag-1' })
    );
    commandStateBackend.saveState.mockResolvedValue('etag-2');
    macroExpansion.apply = (stacks): void => {
      const stacksTyped = stacks as Array<{
        stackName: string;
        template: CloudFormationTemplate;
      }>;
      const consumer = stacksTyped.find((s) => s.stackName === 'Consumer')!;
      (
        consumer.template.Resources!['Db']!.Properties as Record<string, unknown>
      )['DBSubnetGroupName'] = { 'Fn::ImportValue': 'Producer:Db' };
      const producer = stacksTyped.find((s) => s.stackName === 'Producer')!;
      producer.template.Outputs = { Db: { Value: 'v', Export: { Name: 'Producer:Db' } } };
    };

    await scrubCommand([], commandOptions()).catch(() => undefined);

    // POSITIVE MARKER: both stacks really were visited, and the PRODUCER's
    // state was read first.
    const visited = commandStateBackend.getState.mock.calls.map((c) => String(c[0]));
    expect(visited).toContain('Consumer');
    expect(visited[0]).toBe('Producer');
  });
});

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

describe('cdkd scrub reports a read it DECLINED BY DESIGN (issue #2133 review)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    declineCrossStackRead.on = true;
    synthStacks.length = 0;
    const stack = makeStackInfo('CrossAccount') as {
      stackName: string;
      template: CloudFormationTemplate;
    };
    (
      stack.template.Resources!['Db']!.Properties as Record<string, unknown>
    )['DBSubnetGroupName'] = {
      'Fn::GetStackOutput': {
        StackName: 'Producer',
        OutputName: 'DbSecret',
        RoleArn: 'arn:aws:iam::999999999999:role/Reader',
      },
    };
    synthStacks.push(stack);
    // ALREADY scrubbed: the record holds the expression, so the ONLY finding
    // this run can produce is the declined cross-stack read. Without it the run
    // is a clean, exit-0 "no plaintext secrets found".
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      const state = makeState(stackName, false);
      state.resources['Db']!.properties['MasterUserPassword'] = NAME_EXPR;
      return Promise.resolve({ state, etag: 'etag-1' });
    });
    commandStateBackend.saveState.mockResolvedValue('etag-2');
  });

  afterEach(() => {
    declineCrossStackRead.on = false;
  });

  it('does not report the stack clean, and --fail exits non-zero over it', async () => {
    const err = await scrubCommand([], commandOptions({ fail: true })).catch((e: unknown) => e);

    // The stack was NOT refused — nothing failed, and the run reached its
    // summary.
    const errored = commandLogger.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errored).toBe('');
    // ...it is REPORTED, in the per-stack warning and in the summary note...
    const warned = commandLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('could NOT be verified');
    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).not.toContain('No plaintext secrets found in any target stack state');
    // ...nor the PER-STACK clean claim, which was printed on the strength of
    // `secretBearingKeys === 0` alone and so contradicted the warning above it
    // (issue #2133 review). scrub does not know what the declined read's leaf
    // carries, so it cannot call this stack clean.
    expect(summary).not.toContain('No plaintext secrets found in CrossAccount');
    expect(summary).toContain('cross-stack read cdkd declines to perform');
    // ...and `--fail` treats it as a finding, exit 1, not the exit-2 refusal.
    expect((err as { code?: string }).code).toBe('SCRUB_NEEDED');
  });

  it('NEGATIVE CONTROL: without the declined read the same stack exits clean', async () => {
    declineCrossStackRead.on = false;

    const err = await scrubCommand([], commandOptions({ fail: true })).catch((e: unknown) => e);

    expect(err).toBeUndefined();
    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).toContain('No plaintext secrets found in any target stack state');
  });
});
