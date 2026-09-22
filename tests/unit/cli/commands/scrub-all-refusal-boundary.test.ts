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
vi.mock('../../../../src/state/export-index-store.js', () => ({
  // These suites' subject is the `--all` LOOP and the outputs key space; their
  // fixtures publish no exports, so the region's `exports.json` does not
  // exist. `readPersistedEntries` returning `undefined` IS that state (issue
  // #2667) — the store reports a missing object without rebuilding it — so the
  // index step contributes no finding and no failure here.
  ExportIndexStore: vi.fn().mockImplementation(() => ({
    readPersistedEntries: vi.fn().mockResolvedValue(undefined),
    patchEntry: vi.fn().mockResolvedValue(true),
  })),
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
/**
 * A second recordable expression, carrying the `spareMarker` INSIDE itself.
 *
 * Since go-to-k/cdkd#3196 the resolve is scoped per top-level property, so an
 * exemption parked on a SIBLING property no longer covers the one under test —
 * the marker has to sit in the same value the mock judges. This is what lets a
 * `--all` run have one stack genuinely scrub while another abandons, which is
 * the only way to reach the `totalStacksScrubbed > 0` summary arms.
 */
const CLEAN_EXPR = '{{resolve:secretsmanager:clean-marker/db:SecretString:password}}';

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
/**
 * Abandon the `{{resolve:...}}` scan the way AWS does (go-to-k/cdkd#3160): a
 * RAW SDK rejection, no resolver prose. `sendWithThrottleRetry` rethrows these
 * verbatim, which is why the counter is not keyed on message text.
 */
const abandonScan = vi.hoisted(() => ({ on: false, spareMarker: undefined as string | undefined }));
/**
 * Record a cross-stack OUTPUT read the way the real resolver does, so the
 * pre-pass reaches `storedProducerValue` and classifies the producer
 * (go-to-k/cdkd#3192 review round 5).
 *
 * Needed because this file DOUBLES the resolver: the double resolved values
 * but recorded no read, so `recordedProducer` always answered `undefined`
 * and the classifier — and with it the exit code a damaged producer earns —
 * was unreachable from the only scrubCommand harness in the repo.
 */
const recordProducerRead = vi.hoisted(() => ({ on: false }));

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
      .mockImplementation((
        value: unknown,
        ctx: {
          recordedSecretValues?: Map<string, string>;
          recordedOutputReads?: Array<{
            sourceStack: string;
            sourceRegion: string;
            outputName: string;
          }>;
        }
      ) => {
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
        if (
          abandonScan.on &&
          // `spareMarker` exempts one stack's bag from the rejection, keyed on a
          // value the fixture plants there -- the mock sees only the properties
          // bag, never the stack name. It is what lets a `--all` run have one
          // stack SCRUB and another ABANDON, the only way to reach the
          // `totalStacksScrubbed > 0` summary arms with a finding present.
          !(
            abandonScan.spareMarker !== undefined &&
            JSON.stringify(value ?? null).includes(abandonScan.spareMarker)
          ) &&
          JSON.stringify(value ?? null).includes('{{resolve:')
        ) {
          return Promise.reject(
            Object.assign(new Error('Parameter /deleted not found.'), {
              name: 'ParameterNotFound',
            })
          );
        }
        if (
          recordProducerRead.on &&
          node &&
          typeof node === "object" &&
          Object.keys(node).length === 1 &&
          "Fn::GetStackOutput" in node
        ) {
          // What the real resolver writes on a successful cross-stack read.
          // The pre-pass reads `.at(-1)` of this to name the producer.
          ctx.recordedOutputReads?.push({
            sourceStack: "Producer",
            sourceRegion: "us-east-1",
            outputName: "Db",
          });
          return Promise.resolve("resolved-cross-stack-value");
        }
        const walk = (v: unknown): unknown => {
          if (v === CLEAN_EXPR) {
            ctx.recordedSecretValues?.set(SECRET_PLAINTEXT, CLEAN_EXPR);
            return SECRET_PLAINTEXT;
          }
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

/**
 * The COMMAND-level half of go-to-k/cdkd#3160. `scrubStack` returning a nonzero
 * `unverifiableLeaves` is inert on its own — what the issue asks for is that the
 * number reaches the VERDICT, and that plumbing (per-stack clean line, run-level
 * clean gate, summary note, `--fail`) lives in `scrubCommand`, above every test
 * that asserts the field. Without this block a regression anywhere in it leaves
 * the count correct and the gate green, which is the original bug restored.
 */
describe('cdkd scrub: an ABANDONED scan reaches the verdict (go-to-k/cdkd#3160)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    abandonScan.on = true;
    synthStacks.length = 0;
    synthStacks.push(makeStackInfo('CrossAccount'));
    // ALREADY scrubbed, exactly as the sibling block above: the stored value is
    // the expression, so the ONLY thing this run can report is the abandoned
    // scan. Without that, a finding of some other kind would satisfy every
    // assertion below and none of them would be about this issue.
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      const state = makeState(stackName, false);
      state.resources['Db']!.properties['MasterUserPassword'] = NAME_EXPR;
      return Promise.resolve({ state, etag: 'etag-1' });
    });
    commandStateBackend.saveState.mockResolvedValue('etag-2');
  });

  afterEach(() => {
    abandonScan.on = false;
    abandonScan.spareMarker = undefined;
  });

  it('is not a refusal, is reported, and --fail exits 1 over it', async () => {
    const err = await scrubCommand([], commandOptions({ fail: true })).catch((e: unknown) => e);

    // NOT refused — the rest of the stack is still scrubbed. This is the half
    // that separates the counted finding from the NAMELESS spellings, which do
    // refuse (go-to-k/cdkd#2692).
    expect(commandLogger.error.mock.calls.map((c) => String(c[0])).join('\n')).toBe('');

    // The record is named at DEFAULT verbosity, not buried at `debug`.
    const warned = commandLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('ABANDONED');
    expect(warned, 'the operator got a count with no record identity').toContain("resource 'Db'");

    // Neither clean claim survives: not the per-stack one, not the run-level
    // one. Both were reachable on `secretBearingKeys === 0` alone.
    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).not.toContain('No plaintext secrets found in any target stack state');
    expect(summary).not.toContain('No plaintext secrets found in CrossAccount');
    expect(summary, 'the summary note is missing, so the count is invisible there').toContain(
      'ABANDONED'
    );

    // A FINDING (exit 1), not the exit-2 refusal.
    expect((err as { code?: string }).code).toBe('SCRUB_NEEDED');
  });

  it('carries the note on the --dry-run summary too, which IS the CI gate output', async () => {
    // `leafNote` is woven into FOUR render sites, and which one a run reaches
    // depends on `totalStacksScrubbed`. This fixture stores the EXPRESSION, so
    // `recordsChanged === 0` and the dry-run lands on the
    // "Plan: no state record can be rewritten" arm. The `totalStacksScrubbed > 0`
    // arms — the `Plan:` line a DIRTY gate prints, and the "Done: scrubbed" line
    // — are covered by `scrub-dirty-abandoned-summary.test.ts`; a comment here
    // once claimed this case covered "the two `Plan:` lines" and it covered one.
    const err = await scrubCommand([], commandOptions({ dryRun: true, fail: true })).catch(
      (e: unknown) => e
    );

    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary, 'the dry-run plan does not mention the abandoned scan').toContain('ABANDONED');
    expect(summary).not.toContain('No plaintext secrets found in any target stack state');
    expect((err as { code?: string }).code).toBe('SCRUB_NEEDED');

    // Nothing was written -- the note must not have come from a real run.
    expect(commandStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('carries the note on the DIRTY summary arms too (a run that scrubbed something)', async () => {
    // The other two `leafNote` render sites. Which arm a run reaches depends on
    // `totalStacksScrubbed`, so a fixture where nothing is rewritten can only
    // ever exercise two of the four. Two stacks, and only one of them abandons:
    // the run is dirty AND carries the finding.
    synthStacks.length = 0;
    const clean = makeStackInfo('CleanStack') as { stackName: string; template: CloudFormationTemplate };
    // The marker goes in the SAME property the mock judges, not a sibling.
    // Since go-to-k/cdkd#3196 the resolve is scoped per top-level property, so a
    // marker parked on `MasterUsername` no longer exempts `MasterUserPassword`
    // — which is the whole point of that change, and this fixture was relying
    // on the bag-wide behaviour it removed.
    (clean.template.Resources!['Db']!.Properties as Record<string, unknown>)[
      'MasterUserPassword'
    ] = CLEAN_EXPR;
    synthStacks.push(clean, makeStackInfo('CrossAccount'));
    abandonScan.spareMarker = 'clean-marker';

    // The CLEAN stack still stores the PLAINTEXT, so scrubbing it rewrites a
    // record; the other one stores the expression and only abandons.
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      const state = makeState(stackName, false);
      if (stackName !== 'CleanStack') state.resources['Db']!.properties['MasterUserPassword'] = NAME_EXPR;
      return Promise.resolve({ state, etag: 'etag-1' });
    });

    await scrubCommand([], commandOptions({ dryRun: true, fail: true })).catch(() => undefined);
    const plan = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(plan, 'the dry-run plan for a DIRTY run drops the note').toContain('ABANDONED');
    expect(plan).toContain('would be scrubbed');
  });

  it('NEGATIVE CONTROL: the same stack without the abandoned scan exits clean', async () => {
    abandonScan.on = false;

    const err = await scrubCommand([], commandOptions({ fail: true })).catch((e: unknown) => e);

    expect(err).toBeUndefined();
    expect(commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'No plaintext secrets found in any target stack state'
    );
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
    // The summary note stopped ASSERTING the by-design reason (review of
    // go-to-k/cdkd#3206): this bucket now also holds a producer whose
    // `outputs` map cannot be read, which IS repairable, so a note prescribing
    // the cross-account remedy would be wrong and actionless for that member.
    // What is pinned is that the stack is NAMED as unverified and pointed at
    // the per-read warning — and, below, that the per-read warning really does
    // still carry the by-design reason and the remedy. Moving the reason out
    // of the summary removed the ONLY test-enforced carrier of that sentence;
    // asserting the summary alone would have left it unfenced while this
    // comment claimed otherwise (review of go-to-k/cdkd#3206 round 7).
    expect(summary).toContain('cross-stack read that could NOT be verified');
    expect(summary).toContain('see the warnings above');
    expect(warned, 'the per-read warning stopped naming the by-design reason').toContain(
      'declines this read by design'
    );
    // The REMEDY sentence ("Export a non-secret value (e.g. the secret's
    // ARN)…") is deliberately NOT asserted here, and that is a scope
    // statement rather than an oversight: it comes from
    // `CrossAccountSecretRefusalError` in the resolver, which this fixture
    // STUBS, so an assertion would pin the stub rather than the message a user
    // sees. It reaches the user by interpolation into `detail`, which the
    // sentence above does fence. The resolver's own string carries no test
    // today; that predates this change and belongs with that module.
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

/**
 * Issue [#2624](https://github.com/go-to-k/cdkd/issues/2624): what the summary
 * may CLAIM is bounded by S3 versioning.
 *
 * `scrub`'s only write is `saveState`, a plain `PutObjectCommand`, and the
 * state bucket is versioned. The PUT therefore makes the pre-scrub body a
 * NONCURRENT VERSION of the same key -- still readable, plaintext and all, to
 * anyone who can `GetObject` it with a `VersionId` -- and nothing on this path
 * purges it (`grep -c purgeNoncurrent src/cli/commands/scrub.ts` -> 0). The
 * line used to say "The plaintext is no longer stored there", which is the
 * command's headline claim and was false for the copy that matters.
 */
describe('cdkd scrub: the summary states the versioning bound instead of claiming removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    declineCrossStackRead.on = false;
    synthStacks.length = 0;
    synthStacks.push(makeStackInfo('Scrubbable'));
    commandStateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve({ state: makeState(stackName, false), etag: 'etag-1' })
    );
    commandStateBackend.saveState.mockResolvedValue('etag-2');
  });

  it('a run that DID rewrite state says the pre-scrub version survives, and never says the plaintext is gone', async () => {
    await expect(scrubCommand([], commandOptions())).resolves.toBeUndefined();
    // Bound the arm before reading its line: a run that rewrote nothing would
    // take the other branch entirely and make every assertion below vacuous.
    expect(commandStateBackend.saveState).toHaveBeenCalledTimes(1);

    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).toContain('Done: scrubbed 1 stack(s).');
    expect(summary).toContain('The CURRENT state.json no longer holds the plaintext');
    expect(summary).toContain('Where the state bucket is VERSIONED');
    expect(summary).toContain('survives as a noncurrent version');
    expect(summary).toContain('scrub does not purge it');
    // The old claim, in the exact spelling that shipped. This is the half a
    // wording-only fix can silently lose on a later edit.
    expect(summary).not.toContain('The plaintext is no longer stored there');
    // And the remedy the surviving version makes load-bearing is still named.
    expect(summary).toContain('ROTATE it in Secrets Manager');
  });

  it('THE OTHER POLARITY: a CLEAN run carries no versioning caveat', async () => {
    // The caveat qualifies a WRITE; a run that made none has nothing to
    // qualify, and appending it to every summary line would still satisfy the
    // case above.
    //
    // This lands on the CLEAN early return ("No plaintext secrets found in any
    // target stack state"), NOT on the `No state record was rewritten` sibling of
    // the arm above — measured by mutation, not assumed: relaxing that arm's
    // `totalStacksScrubbed > 0` gate leaves this case green because it returns
    // before reaching it. The `No state record was rewritten` arm is pinned by
    // `scrub-export-name-collision.test.ts`'s CI-GATE case, which DOES red
    // under that mutation.
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      const state = makeState(stackName, false);
      state.resources['Db']!.properties['MasterUserPassword'] = NAME_EXPR;
      return Promise.resolve({ state, etag: 'etag-1' });
    });

    await expect(scrubCommand([], commandOptions())).resolves.toBeUndefined();
    expect(commandStateBackend.saveState).not.toHaveBeenCalled();

    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    // POSITIVE first: an all-negative case passes for a run that printed
    // NOTHING, which is a different bug wearing this case's green.
    expect(summary).toContain('No plaintext secrets found in any target stack state');
    expect(summary).not.toContain('Done: scrubbed');
    expect(summary).not.toContain('Where the state bucket is VERSIONED');
    expect(summary).not.toContain('survives as a noncurrent version');
  });
});

/**
 * EXIT CODES for the two `outputs`-bag classes, measured at `scrubCommand` —
 * the layer that decides them (go-to-k/cdkd#3192 review rounds 5 and 7).
 *
 * Both were previously fenced only at `scrubStack`, which returns COUNTS, and
 * by a source-text check over `scrubCommand`. Neither can see an exit code, and
 * mutating `scrubCommand`'s clean-exit gate to `if (false)` left 520 cases
 * green — so the `--dry-run --fail` behaviour that justifies the entire
 * REPAIR-under-dry-run disposition had no behavioural test at all.
 */
describe('cdkd scrub exit codes for an unreadable outputs bag (go-to-k/cdkd#3192)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    synthStacks.length = 0;
    declineCrossStackRead.on = false;
    abandonScan.on = false;
    abandonScan.spareMarker = undefined;
    recordProducerRead.on = false;
    commandStateBackend.saveState.mockResolvedValue('etag-2');
  });
  afterEach(() => {
    recordProducerRead.on = false;
  });

  /**
   * A stack whose own record is fine, importing from a PRODUCER whose record
   * is damaged. `Fn::GetStackOutput` is the route that reaches the classifier:
   * it consults no `importableOutputKeys`, so the read succeeds and
   * `storedProducerValue` is entered with a bag it cannot walk.
   */
  function arrangeDamagedProducer(producerOutputs: unknown): void {
    const consumer = makeStackInfo('Consumer');
    (
      consumer.template.Resources!['Db']!.Properties as Record<string, unknown>
    )['DBSubnetGroupName'] = { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Db' } };
    // The producer is in appStacks (so `producerTemplates` carries its
    // template and the verdict is not `no`) but is NOT a scrub target — these
    // cases pass positional names rather than `--all`. Otherwise its own
    // damaged record would refuse at the stack level and the exit code would
    // come from the wrong place entirely.
    const producer = makeStackInfo("Producer");
    producer.template.Outputs = { Db: { Value: NAME_EXPR, Export: { Name: "Producer:Db" } } };
    synthStacks.push(consumer, producer);
    recordProducerRead.on = true;
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      if (stackName === 'Producer') {
        const state = makeState('Producer', false);
        state.outputs = producerOutputs as Record<string, unknown>;
        return Promise.resolve({ state, etag: 'p-1' });
      }
      return Promise.resolve({ state: makeState(stackName, false), etag: 'etag-1' });
    });
  }

  for (const [label, bag] of [
    ['a string', 'abcdef'],
    ['a list', ['plaintext-element']],
  ] as const) {
    it(`exits 2 for a ${label} producer bag, with AND without --fail`, async () => {
      // THE REGRESSION GUARD. At the merge base both shapes exited 2
      // unconditionally — the list through
      // `plaintextProducerCrossStackReadError` (`'0' in [...]` is true, so the
      // element was returned), the string through an escaping `TypeError`.
      // Guarding the read moved them to exit 0 on a plain run, and to exit 1
      // under `--fail`.
      //
      // BOTH POLARITIES, because `docs/cli-scrub.md`'s row promises "with or
      // without `--fail`" and that holds only by source ORDERING — the raise
      // sits above `if (options.fail)` — which nothing pinned (review round
      // 10). Without `--fail` the wrong answer is a silent exit 0; with it, a
      // silent exit 1 through `ScrubNeededError`, the code that means "rotate
      // the secret" rather than "repair the record".
      for (const fail of [false, true]) {
        vi.clearAllMocks();
        synthStacks.length = 0;
        commandStateBackend.saveState.mockResolvedValue('etag-2');
        arrangeDamagedProducer(bag);

        const err = await scrubCommand(
          ['Consumer'],
          commandOptions({ all: false, fail })
        ).catch((e: unknown) => e);

        const where = `--fail=${fail}`;
        expect(err, `${where}: exited 0 over an unclassifiable producer`).toBeInstanceOf(Error);
        expect((err as { exitCode?: number }).exitCode, where).toBe(2);
        expect((err as { code?: string }).code, where).toBe('SCRUB_PRODUCER_RECORD_UNREADABLE');
        // Exit 2 and not 1: `ScrubNeededError` would name the opposite remedy.
        expect((err as { name?: string }).name, where).not.toBe('ScrubNeededError');
        const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
        expect(summary, where).not.toContain(
          'No plaintext secrets found in any target stack state'
        );
      }
    });
  }

  it('exits 2 under --dry-run too, which is the arm the CI gate uses', async () => {
    // The `--dry-run` COPY of the raise, which had zero coverage until review
    // round 9 measured it: mutating it to `if (false && …)` left all 148 cases
    // in this file and its two siblings green, while the identical mutation on
    // the real-run copy reds two, and those two stay GREEN under this one --
    // the coverage is disjoint. No existing case stands in: the other
    // `--dry-run` cases in this file drive `SCRUB_STACKS_FAILED` and
    // `SCRUB_NEEDED`, and the `malformedRecordsAuditedError` one is BELOW this
    // (`--dry-run over an unreadable outputs bag`), so it is a different raise
    // in every case.
    //
    // It is the arm that matters most: `--dry-run --fail` is documented as a
    // standing CI gate, and `docs/cli-scrub.md` promises this code "with or
    // without `--fail`, `--dry-run` included". No `fail` here, deliberately.
    arrangeDamagedProducer('abcdef');

    const err = await scrubCommand(['Consumer'], commandOptions({ all: false, dryRun: true })).catch(
      (e: unknown) => e
    );

    expect(err, 'a --dry-run exited 0 over an unclassifiable producer').toBeInstanceOf(Error);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect((err as { code?: string }).code).toBe('SCRUB_PRODUCER_RECORD_UNREADABLE');
    // ...and it wrote nothing, which is what makes the dry-run arm safe to
    // raise from at all.
    expect(commandStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('FLOOR: a HEALTHY producer bag exits 0 on the same fixture', async () => {
    // Without this the two cases above are satisfied by a run that refuses
    // every cross-stack read. The ONLY difference from them is the bag — and
    // it holds the EXPRESSION, not a plaintext: a readable bag storing a bare
    // plaintext is a correctly-refused UNSCRUBBED producer
    // (`SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`), which would pass an
    // exit-non-zero assertion for the wrong reason. This is the
    // already-scrubbed producer, the one shape that must exit 0.
    arrangeDamagedProducer({ Db: NAME_EXPR });

    await expect(
      scrubCommand(["Consumer"], commandOptions({ all: false }))
    ).resolves.toBeUndefined();
  });

  /**
   * The `--dry-run` REPAIR arm's own exit behaviour — the gate that justifies
   * the whole disposition and that no behavioural case reached.
   */
  it('--dry-run over an unreadable outputs bag exits 2 and prints no clean claim', async () => {
    synthStacks.push(makeStackInfo('Broken'));
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      const state = makeState(stackName, false);
      state.outputs = 'abcdef' as unknown as Record<string, unknown>;
      return Promise.resolve({ state, etag: 'etag-1' });
    });

    const err = await scrubCommand([], commandOptions({ dryRun: true })).catch((e: unknown) => e);

    // The audited-record refusal, raised INSIDE the dry-run branch and ABOVE
    // the `--fail` gate — note no `fail` in these options, so a run reaching
    // `ScrubNeededError` would have exited 0 here instead.
    expect(err, 'a --dry-run over an unread outputs bag exited 0').toBeInstanceOf(Error);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect((err as Error).message).toContain(`'outputs'`);
    expect(commandStateBackend.saveState).not.toHaveBeenCalled();
    const summary = commandLogger.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).not.toContain('No plaintext secrets found in any target stack state');
  });

  it('a REAL run over an unreadable outputs bag refuses and writes nothing', async () => {
    // The other side of the dry-run asymmetry, at the command layer: a real run
    // never repairs, so the refusal comes from `scrubStack` and surfaces as a
    // per-stack failure rather than as the audited-record message.
    synthStacks.push(makeStackInfo('Broken'));
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      const state = makeState(stackName, false);
      state.outputs = 'abcdef' as unknown as Record<string, unknown>;
      return Promise.resolve({ state, etag: 'etag-1' });
    });

    const err = await scrubCommand([], commandOptions()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect(commandStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('a CONDITION-SUPPRESSED position over a damaged producer records NOTHING', async () => {
    // The `!nodeCanRefuse` gate, which had zero reds when it shipped (review
    // round 7). A finding is a PERMANENT non-clean verdict, and a suppressed
    // output wrote no `state.outputs` key — so reddening a CI gate over it is
    // a standing failure with nothing at risk, which `isOutputSuppressed`
    // exists to spare.
    //
    // Suppression is decided by the condition AND by state: a key PRESENT in
    // `state.outputs` proves the deploy wrote it whatever this run concluded.
    // So the fixture must keep the output OUT of the stored bag.
    const consumer = makeStackInfo('Consumer');
    consumer.template.Conditions = { Never: { 'Fn::Equals': ['a', 'b'] } };
    consumer.template.Outputs = {
      Suppressed: {
        Condition: 'Never',
        Value: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Db' } },
      },
    };
    const producer = makeStackInfo('Producer');
    producer.template.Outputs = { Db: { Value: NAME_EXPR, Export: { Name: 'Producer:Db' } } };
    synthStacks.push(consumer, producer);
    recordProducerRead.on = true;
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      if (stackName === 'Producer') {
        const state = makeState('Producer', false);
        state.outputs = 'abcdef' as unknown as Record<string, unknown>;
        return Promise.resolve({ state, etag: 'p-1' });
      }
      // `Suppressed` is ABSENT from the consumer's stored bag, which is what
      // makes the position genuinely suppressed.
      return Promise.resolve({ state: makeState(stackName, false), etag: 'etag-1' });
    });

    // Exit 0: no finding, so no refusal. Reverting the `!nodeCanRefuse` arm
    // makes this exit 2 over a position with nothing at risk.
    await expect(
      scrubCommand(['Consumer'], commandOptions({ all: false }))
    ).resolves.toBeUndefined();
  });

  it('warns ONCE per damaged producer, however many references reach it', async () => {
    // The dedupe `Set`, which also had zero reds. Three references to ONE
    // damaged producer emitted three identical multi-line paragraphs before
    // it; a `--all` run repeated the set per consumer stack.
    const consumer = makeStackInfo('Consumer');
    const props = consumer.template.Resources!['Db']!.Properties as Record<string, unknown>;
    for (const slot of ['DBSubnetGroupName', 'AvailabilityZone', 'CharacterSetName']) {
      props[slot] = { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Db' } };
    }
    const producer = makeStackInfo('Producer');
    producer.template.Outputs = { Db: { Value: NAME_EXPR, Export: { Name: 'Producer:Db' } } };
    synthStacks.push(consumer, producer);
    recordProducerRead.on = true;
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      if (stackName === 'Producer') {
        const state = makeState('Producer', false);
        state.outputs = 'abcdef' as unknown as Record<string, unknown>;
        return Promise.resolve({ state, etag: 'p-1' });
      }
      return Promise.resolve({ state: makeState(stackName, false), etag: 'etag-1' });
    });

    await scrubCommand(['Consumer'], commandOptions({ all: false })).catch(() => undefined);

    const lines = commandLogger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes(`has no ` + `readable 'outputs' map`));
    // EXACTLY one. `toBeGreaterThan(0)` would pass for the three-paragraph
    // behaviour this pins against, which is the whole point of the case.
    expect(lines, `expected ONE line per damaged producer, got ${lines.length}`).toHaveLength(1);
  });

  it('FLOOR: a healthy outputs bag exits 0 under --dry-run', async () => {
    synthStacks.push(makeStackInfo('Healthy'));
    commandStateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve({ state: makeState(stackName, false), etag: 'etag-1' })
    );

    await expect(scrubCommand([], commandOptions({ dryRun: true }))).resolves.toBeUndefined();
    expect(commandStateBackend.saveState).not.toHaveBeenCalled();
  });
});

/**
 * The COMMAND-level half of the `orphans` container guard (go-to-k/cdkd#3379).
 * `scrub-malformed-orphans.test.ts` enters at `scrubStack` and asserts the
 * FIELD; what happens to that field afterwards lives here.
 *
 * Without the feed into `malformedOrphanRecords` the repaired list is empty, so
 * every orphan-side counter is legitimately zero, the run reaches the `--fail`
 * arm on the plaintext it DID find, and exits through the silent
 * `ScrubNeededError` — "rotate the secret" — over a record it could not read.
 */
describe('cdkd scrub: an unreadable orphans container reaches the VERDICT (go-to-k/cdkd#3379)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    synthStacks.length = 0;
    synthStacks.push(makeStackInfo('Damaged'));
    commandStateBackend.getState.mockImplementation((stackName: string) => {
      const state = makeState(stackName, false);
      // The container, damaged. `resources` and `outputs` are both healthy, so
      // a sibling container's refusal would be the wrong text — and the record
      // still holds the PLAINTEXT its template resolves, which is what makes
      // the `--fail` arm below genuinely reachable rather than hypothetical.
      (state as { orphans?: unknown }).orphans = 'abc';
      return Promise.resolve({ state, etag: 'etag-1' });
    });
    commandStateBackend.saveState.mockResolvedValue('etag-2');
  });

  it('--dry-run --fail exits 2 naming the container, not 1 through the silent finding', async () => {
    const err = await scrubCommand([], commandOptions({ dryRun: true, fail: true })).catch(
      (e: unknown) => e
    );

    // The AUDITED-RECORD error, which is exit 2 and says "repair the record".
    // `SCRUB_NEEDED` here would be the defect: exit 1 is "--fail found a leak",
    // and `ScrubNeededError` prints nothing about the container at all.
    expect((err as { code?: string }).code).toBe('STATE_RESOURCES_MALFORMED');
    expect((err as { code?: string }).code).not.toBe('SCRUB_NEEDED');
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect(String((err as { message?: string }).message)).toContain("'orphans'");
    // The stack is NAMED, so an operator can act on the right record.
    expect(String((err as { message?: string }).message)).toContain('Damaged');
    // `--dry-run` wrote nothing, so the evidence survives the report.
    expect(commandStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('a REAL run refuses the stack rather than auditing it', async () => {
    const err = await scrubCommand([], commandOptions({})).catch((e: unknown) => e);
    // Under `--all` a per-stack refusal is reported as the batch code; the
    // container's own MESSAGE reaches the error log (`describeFailure` renders
    // the message and its causes, never the code).
    expect((err as { code?: string }).code).toBe('SCRUB_STACKS_FAILED');
    const errored = commandLogger.error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errored).toContain("'orphans'");
    expect(commandStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('FLOOR: a readable and an ABSENT container reach the ordinary verdict', async () => {
    // Without this the two cases above are satisfied by a guard that refused
    // everything. The ABSENT row is the ordinary record — a stack that never
    // had a failed deploy — and must still scrub.
    for (const container of [[], undefined]) {
      vi.clearAllMocks();
      commandStateBackend.getState.mockImplementation((stackName: string) => {
        const state = makeState(stackName, false);
        if (container !== undefined) (state as { orphans?: unknown }).orphans = container;
        return Promise.resolve({ state, etag: 'etag-1' });
      });
      commandStateBackend.saveState.mockResolvedValue('etag-2');
      const err = await scrubCommand([], commandOptions({})).catch((e: unknown) => e);
      expect(err, `container ${JSON.stringify(container)} was refused`).toBeUndefined();
      // DRIVEN to the write: the control proves the run reached the rewrite,
      // not merely that it failed somewhere else.
      expect(commandStateBackend.saveState).toHaveBeenCalled();
    }
  });
});
