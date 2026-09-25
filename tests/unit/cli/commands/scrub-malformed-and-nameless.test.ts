/**
 * BEHAVIOURAL coverage for the two things go-to-k/cdkd#3159 actually changes
 * in `cdkd scrub`, both of which shipped fenced only by source-shape greps.
 *
 * The test review measured the gap and it was total: replacing
 * `isNamelessDynamicReferenceFailure`'s body with `return false` left all
 * 23,055 tests GREEN. Every fence over it is a string-grep, and a string-grep
 * survives a body swap — so the predicate that decides whether `cdkd scrub`
 * reports a stack CLEAN over surviving plaintext (go-to-k/cdkd#2692) had no
 * executable test at all. Likewise neither arm of the malformed-record branch
 * (go-to-k/cdkd#3018) was ever run.
 *
 * These cases call `scrubStack` directly with the resolver mocked, the shape
 * eight sibling files already use. What they pin:
 *
 * - a NAMELESS dynamic reference re-raises rather than degrading to `debug`;
 * - an unrelated `... is required` from `resolveParameters` does NOT, which is
 *   what the `Dynamic reference: ` prefix anchor exists for — a template
 *   parameter literally NAMED `PARAMETER_NAME` would otherwise flip every
 *   best-effort miss into a whole-stack refusal;
 * - the failure is seen through a WRAPPED cause, since the predicate walks
 *   `errorCauseChain` rather than testing the top-level message;
 * - a real run REFUSES a malformed `resources` bag with exit 2;
 * - a `--dry-run` REPAIRS it, reports the finding, and writes nothing.
 *
 * WHAT THE FIXTURE REACHES, measured rather than assumed (2026-09-15). The
 * predicate guards FOUR best-effort catches. Keeping exactly one guard and
 * deleting the other three: with the first cut of this fixture (`Outputs: {}`,
 * no orphans) only guards 1, 2 and 4 were individually sufficient and guard 3
 * was never reached; adding the `Export.Name` below made all four sufficient.
 *
 * The limit of that measurement, stated because it is easy to over-read:
 * deleting a SINGLE guard reds nothing, since the same rejection then travels
 * to the next catch that still has one. So these cases prove every site is
 * REACHED and re-raises, not that any one site is independently necessary. The
 * whole-predicate mutation (`return false`) is what covers the set, and it
 * reds 3 cases.
 *
 * The go-to-k/cdkd#3160 COUNTER has the same property and the same bound,
 * measured the same way: deleting all four `unverifiableLeaves++` sites reds 4
 * cases, deleting one reds none. Its own negative control is separate — a
 * stack whose references all resolve must count ZERO, or a counter that
 * incremented unconditionally would satisfy every positive case.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

/** Thrown by the fake resolver when a case asks for it. */
let resolveThrows: Error | undefined;
/**
 * Per-VALUE throw hook. `resolveThrows` aborts every call; this one lets a case
 * abort ONE property and let its siblings resolve, which is the only way to
 * exercise the per-property scoping go-to-k/cdkd#3196 added.
 */
let resolveThrowsFor: ((value: unknown) => Error | undefined) | undefined;
/**
 * Per-VALUE abandonment hook: the resolver RECOVERS (resolves) but records the
 * value as one abandoned unit in the caller's bag, which is the per-unit
 * recovery path `reportAbandonedBag` reports from.
 */
let abandonFor: ((value: unknown) => boolean) | undefined;
/**
 * Per-VALUE recording hook: the resolver records the returned plaintext into
 * the caller's `recordedSecretValues`, as a real resolve of a secret does.
 */
let recordFor: ((value: unknown) => string | undefined) | undefined;
/** Every value the fake resolver was handed, for cases that assert REACH. */
const resolvedValues: unknown[] = [];

// `importActual` for everything but the resolver class: `carriesDynamicReference`
// is a pure predicate scrub uses to decide whether an abandoned resolve had a
// `{{resolve:...}}` in it at all, and stubbing it would make these cases assert
// against a fake answer to the very question under test.
vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', async () => ({
  ...(await vi.importActual<
    typeof import('../../../../src/deployment/intrinsic-function-resolver.js')
  >('../../../../src/deployment/intrinsic-function-resolver.js')),
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi.fn().mockImplementation(
      (
        value: unknown,
        ctx?: { abandonedResolutions?: unknown[]; recordedSecretValues?: Map<string, string> }
      ) => {
        resolvedValues.push(value);
        const plaintext = recordFor?.(value);
        if (plaintext !== undefined) ctx?.recordedSecretValues?.set(plaintext, String(value));
        if (abandonFor?.(value) && ctx?.abandonedResolutions) {
          const error = new Error("Dynamic reference: SSM parameter '/p' not found or has no value");
          ctx.abandonedResolutions.push({
            unit: 'token',
            subject: '{{resolve:ssm-secure}}',
            message: error.message,
            error,
            carriedDynamicReference: true,
            carriedFetchableReference: true,
          });
          return Promise.resolve(value);
        }
        const scoped = resolveThrowsFor?.(value);
        if (scoped) return Promise.reject(scoped);
        if (resolveThrows) return Promise.reject(resolveThrows);
        return Promise.resolve(value);
      }
    ),
  })),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';
import { CdkdError } from '../../../../src/utils/error-handler.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function stackInfo(): { stackName: string; template: CloudFormationTemplate } {
  return {
    stackName: 'MyStack',
    template: {
      Resources: {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: {
            DBInstanceIdentifier: 'app-db',
            MasterUserPassword: '{{resolve:ssm-secure}}',
          },
        },
      },
      // A declared OUTPUT with an EXPORT NAME, and (below) a recorded ORPHAN,
      // are what reach the predicate's other call sites. The first cut of this
      // fixture had `Outputs: {}` and no orphans and so exercised ONE of the
      // four guarded catches -- the same partial-coverage shape the sync fence
      // had. The `Export.Name` specifically is what reaches the fourth: it is
      // resolved through its OWN `resolveCrossStackReads` call, on the
      // argument that a name a deploy never wrote must not be invented.
      Outputs: {
        DbEndpoint: {
          Value: '{{resolve:ssm-secure}}',
          // An INTRINSIC name, and the `unknown` cast below is what it costs.
          // `TemplateOutput.Export.Name` is typed `string`, which is narrower
          // than CloudFormation: `Export: { Name: !Sub '${AWS::StackName}-x' }`
          // is the ordinary CDK output shape, and scrub RESOLVES it through
          // its own `resolveCrossStackReads` call -- which is the catch this
          // fixture needs to reach. Measured: a LITERAL name leaves that site
          // unreached (it needs no resolving), so the intrinsic is
          // load-bearing here, not decoration.
          // The `{{resolve:ssm-secure}}` inside the name is what reaches the
          // FOURTH counter site, and it is load-bearing twice over. The
          // intrinsic alone only gets the catch to RUN (the sibling
          // `Export.Name of output ... could not be resolved` warn fires either
          // way); the counter is POSITIONAL, so without a `{{resolve:` in the
          // name `carriesDynamicReference(nameSource)` is false and that site
          // silently contributes nothing. An earlier revision of this fixture
          // had the plain `${AWS::StackName}-db-endpoint` name and recorded
          // that as "the harness cannot reach the site" — it reached it, and
          // the predicate declined. Measured: with this name the count is 4.
          Export: { Name: { 'Fn::Sub': '${AWS::StackName}-{{resolve:ssm-secure}}' } },
        },
      },
    } as unknown as CloudFormationTemplate,
  };
}

function makeState(resources: unknown): StackState {
  return {
    version: 8,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources: resources as StackState['resources'],
    outputs: { DbEndpoint: 'a-stored-value' },
    orphans: [
      {
        logicalId: 'OldDb',
        orphanedAt: 0,
        state: {
          physicalId: 'old-db',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { MasterUserPassword: '{{resolve:ssm-secure}}' },
        },
      },
    ] as StackState['orphans'],
    lastModified: 0,
  };
}

describe('cdkd scrub - refusals this PR adds (go-to-k/cdkd#2692, go-to-k/cdkd#3018)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resolveThrows = undefined;
    resolveThrowsFor = undefined;
    abandonFor = undefined;
    recordFor = undefined;
    resolvedValues.length = 0;
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  function run(
    state: StackState,
    opts: { dryRun?: boolean; stack?: ReturnType<typeof stackInfo> } = {}
  ): ReturnType<typeof scrubStack> {
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });
    return scrubStack(
      (opts.stack ?? stackInfo()) as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      {
        dryRun: opts.dryRun ?? false,
        logger: logger as never,
      }
    );
  }

  const healthy = (): StackState =>
    makeState({
      Db: { physicalId: 'app-db', resourceType: 'AWS::RDS::DBInstance', properties: {} },
    });

  describe('a NAMELESS dynamic reference is re-raised, not swallowed', () => {
    for (const message of [
      'Dynamic reference: ssm-secure PARAMETER_NAME is required',
      'Dynamic reference: secretsmanager SECRET_ID is required',
    ]) {
      it(`re-raises \`${message}\``, async () => {
        // The defect: the resolver aborts at the FIRST token, so a real secret
        // beside this one records no needle and the run reports CLEAN. Without
        // the predicate this resolves with secretsFound: 0.
        resolveThrows = new Error(message);
        await expect(run(healthy())).rejects.toThrow(message);
      });
    }

    it('sees the failure through a WRAPPED cause, not only at the top', async () => {
      // The predicate walks `errorCauseChain`; a best-effort caller in between
      // may wrap. Asserting only the top level would pass on an `err.message`
      // test that never walks.
      resolveThrows = new Error('Failed to resolve property MasterUserPassword', {
        cause: new Error('Dynamic reference: secretsmanager SECRET_ID is required'),
      });
      await expect(run(healthy())).rejects.toThrow();
    });

    it('does NOT re-raise an unrelated `... is required` from parameter binding', async () => {
      // `resolveParameters` raises `Parameter <name> is required but no value
      // was provided`. A template parameter NAMED `PARAMETER_NAME` makes that
      // message contain the marker's whole tail — which is why the predicate
      // also requires the `Dynamic reference: ` prefix on the SAME message.
      // Without the anchor this rejects, turning every such stack into a
      // refusal.
      resolveThrows = new Error(
        'Parameter PARAMETER_NAME is required but no value was provided for it'
      );
      await expect(run(healthy())).resolves.toBeDefined();
    });

    // The population is the ABANDONMENT, not a message vocabulary. The first
    // cut keyed on the `Dynamic reference: ` prefix and so counted only the
    // resolver's OWN prose -- missing the dominant class, because
    // `GetParameter` / `GetSecretValue` go through `sendWithThrottleRetry`,
    // which rethrows an AWS rejection RAW. A genuinely deleted parameter
    // raises `ParameterNotFound` from the SDK; the prefixed
    // "SSM parameter ... not found or has no value" string fires only on a 200
    // whose `Parameter.Value` is absent. The table below therefore carries BOTH
    // shapes, and the SDK ones are this issue's own headline repro.
    const ABANDONING: ReadonlyArray<readonly [string, Error]> = [
      // The resolver's own prose.
      ['no SecretString', new Error("Dynamic reference: secret 'x' does not contain a SecretString value")],
      ['missing JSON_KEY', new Error("Dynamic reference: key '${Field' not found in secret 'x'")],
      ['non-JSON secret', new Error("Dynamic reference: secret 'x' is not valid JSON but JSON_KEY 'k' was specified")],
      ['200 with no Value', new Error("Dynamic reference: SSM parameter '/p' not found or has no value")],
      // Raw SDK rejections -- rethrown verbatim, no prefix.
      ['deleted SSM parameter', Object.assign(new Error('Parameter /deleted not found.'), { name: 'ParameterNotFound' })],
      ['deleted secret', Object.assign(new Error("Secrets Manager can't find the specified secret."), { name: 'ResourceNotFoundException' })],
      ['denied secret', Object.assign(new Error('User is not authorized to perform secretsmanager:GetSecretValue'), { name: 'AccessDeniedException' })],
      ['secret pending deletion', Object.assign(new Error('You can\'t perform this operation on the secret because it was marked for deletion.'), { name: 'InvalidRequestException' })],
      ['KMS decryption failure', Object.assign(new Error('Secrets Manager cannot decrypt the protected secret text.'), { name: 'DecryptionFailure' })],
      // A refusal that is neither prefixed nor an SDK error.
      ['ssm-secure over a public parameter', new Error('Refusing to resolve ssm-secure against a String parameter')],
    ];

    for (const [label, error] of ABANDONING) {
      it(`counts, but does NOT re-raise, an abandoned scan: ${label}`, async () => {
        resolveThrows = error;
        const result = await run(healthy());
        expect(result).toBeDefined();
        // EXACT, not `> 0`, so deleting any ONE counter site reds this —
        // per-site coverage the sibling PREDICATE genuinely cannot have (a
        // rejection travels to the next catch) but a counter can, because
        // counters do not short-circuit.
        //
        // FOUR — one per counter site: the resource bag, the orphan record,
        // the output's `Export.Name` and the output's VALUE. The `Export.Name`
        // site is reached only because `healthy()`'s export name carries a
        // `{{resolve:...}}`; see the comment on it for why the intrinsic alone
        // is not enough.
        expect(
          result.unverifiableLeaves,
          `the leaf abandoned by ${label} was counted ${result.unverifiableLeaves} time(s), ` +
            'expected one per counter site. A lower number means a site stopped counting and ' +
            'the run can report a stack clean over a scan that stopped early ' +
            '(go-to-k/cdkd#3160).'
        ).toBe(4);

        // The count is only actionable if the operator can tell WHICH record
        // it belongs to, and the summary line says "see the warnings above" —
        // so the per-record line must be a `warn`, not the `debug` the first
        // cut used. Three of the four sites logged only at `debug`, which made
        // that sentence false at default verbosity.
        const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned, 'the abandoned resource record was not named at default verbosity').toContain(
          "resource Db"
        );
        expect(warned, 'the abandoned orphan record was not named at default verbosity').toContain(
          "orphan record OldDb"
        );
        // Anchored on `scan of output`, NOT the bare `output DbEndpoint`:
        // the Export.Name site's message CONTAINS that substring
        // ("...scan of the Export.Name of output DbEndpoint"), so the bare
        // form is satisfied by either site and discriminates neither.
        expect(warned, 'the abandoned output VALUE was not named at default verbosity').toContain(
          "scan of output DbEndpoint"
        );
        expect(
          warned,
          'the abandoned Export.Name was not named at default verbosity'
        ).toContain("scan of the Export.Name of output DbEndpoint");
      });
    }

    // The round-2 blocker, as a case rather than as a comment. A bag can carry
    // a `{{resolve:...}}` and still fail for a reason that has nothing to do
    // with fetching it — this catch is documented as existing for exactly that
    // (a `Ref` to something not in state). Counting those reds `--dry-run
    // --fail`, the documented STANDING CI gate, on a healthy stack, and the
    // operator cannot clear it: `scrubStack` catches `resolveParameters`
    // wholesale and carries on with an EMPTY parameter bag, so ONE parameter
    // with no `Default` makes every `{Ref: <param>}` in the stack throw.
    const TEMPLATE_SHAPE: ReadonlyArray<readonly [string, string]> = [
      ['a Ref to a resource not in state', 'Ref MyBucket not found'],
      ['a Fn::GetAtt to a resource not in state', 'Resource MyBucket not found for Fn::GetAtt'],
      [
        'a parameter with no Default and no supplied value',
        'Parameter DbName is required but no value was provided and no default exists',
      ],
    ];

    for (const [label, message] of TEMPLATE_SHAPE) {
      it(`does NOT count ${label}, even over a reference-bearing bag`, async () => {
        resolveThrows = new Error(message);
        const result = await run(healthy());
        expect(
          result.unverifiableLeaves,
          `"${message}" is cdkd's own refusal to resolve a template SHAPE. Counting it makes ` +
            '`cdkd scrub --dry-run --fail` exit 1 on a stack with nothing wrong with it, with ' +
            'no action the operator can take to clear it (go-to-k/cdkd#3178 round 2).'
        ).toBe(0);
      });

      it(`but STILL WARNS about ${label} — visibility is not the gate`, async () => {
        // The round-4 finding two axes reached independently: one throw aborts
        // the whole properties bag, so excluding it also silences the finding
        // for a LIVE secret reference in that same bag, and the stack can print
        // `No plaintext secrets found` at exit 0. Counting is the round-2
        // blocker; saying nothing is the original bug. So it says it and does
        // not gate.
        resolveThrows = new Error(message);
        await run(healthy());
        const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        // EVERY site, not just the first. This is the behavioural replacement
        // for a source-shape grep that counted `if (leafVerdict !== 'silent')`
        // occurrences: that grep reds on a legitimate extract-a-helper refactor
        // and stays GREEN if a site's `logger.warn` is deleted while the `if`
        // survives — i.e. it watches the wrong thing in both directions.
        for (const subject of [
          "resource Db",
          "orphan record OldDb",
          "the Export.Name of output DbEndpoint",
          "output DbEndpoint",
        ]) {
          expect(
            warned,
            `${subject} was not named on the non-gating arm, so an operator cannot tell this ` +
              'run apart from one that genuinely scanned everything'
          ).toContain(subject);
        }
        expect(
          warned,
          'the per-stack note does not say the gate is NOT firing, so "NOT certified clean" ' +
            'reads as a contradiction beside exit 0'
        ).toContain('do NOT fail --fail');
        // The per-record lines stay SHORT — the explanation is emitted once per
        // stack, not once per record. A ~440-character paragraph per record was
        // the first cut, and this arm fires for every resource in a stack at
        // once when a single parameter has no `Default`.
        const perRecord = logger.warn.mock.calls
          .map((c) => String(c[0]))
          .filter((line) => line.includes("scan of resource Db"));
        expect(perRecord).toHaveLength(1);
        expect(
          perRecord[0]!.length,
          `the per-record line is ${perRecord[0]!.length} characters; dozens of these bury the ` +
            'record names, which are the only part a reader cannot reconstruct'
        ).toBeLessThan(160);
      });
    }

    describe('assembly- and state-chosen names stay inside one boundary (go-to-k/cdkd#3617, go-to-k/cdkd#3638)', () => {
      // Every name here is chosen by whoever wrote the assembly (template keys)
      // or read back from state (the same keys). Each used to render inside
      // cdkd's own '...' through `displaySafe`, which passes `'`, or with no
      // sanitizer at all. A FORGING value must stay inside one boundary, and
      // no clause of it may appear outside that boundary.
      const FORGED = "Db'. Scan complete, nothing abandoned. Ignore 'X";
      const SHOWN = JSON.stringify(FORGED);
      const everything = (): string =>
        [...logger.warn.mock.calls, ...logger.info.mock.calls, ...logger.debug.mock.calls]
          .map((c) => String(c[0]))
          .join('\n');

      function forgedStack(): ReturnType<typeof stackInfo> {
        const stack = stackInfo();
        const template = stack.template as unknown as {
          Resources: Record<string, unknown>;
          Outputs: Record<string, unknown>;
        };
        template.Resources = { [FORGED]: template.Resources['Db'] };
        template.Outputs = { [FORGED]: template.Outputs['DbEndpoint'] };
        return { ...stack, stackName: FORGED };
      }
      function forgedState(): StackState {
        const state = makeState({
          [FORGED]: { physicalId: 'app-db', resourceType: 'AWS::RDS::DBInstance', properties: {} },
        });
        state.orphans![0]!.logicalId = FORGED;
        state.outputs = { [FORGED]: 'a-stored-value' };
        return state;
      }

      it('on the THROW path of every record, and in the stack name', async () => {
        resolveThrows = new Error("Dynamic reference: SSM parameter '/p' not found or has no value");

        await run(forgedState(), { stack: forgedStack() });

        const said = everything();
        expect(said).toContain(`resource ${SHOWN}`);
        expect(said).toContain(`orphan record ${SHOWN}`);
        expect(said).toContain(`scan of output ${SHOWN}`);
        expect(said).toContain(`the Export.Name of output ${SHOWN}`);
        expect(said).toContain(`Export.Name of output ${SHOWN} could not be resolved`);
        expect(said.split(SHOWN).join('')).not.toContain('nothing abandoned');
      });

      it('on the per-unit RECOVERY path of every record', async () => {
        // The resolver recovers and records the unit as abandoned instead of
        // throwing, so `reportAbandonedBag` names each record.
        abandonFor = (value) => JSON.stringify(value ?? null).includes('{{resolve:ssm-secure}}');

        await run(forgedState(), { stack: forgedStack() });

        const said = everything();
        expect(said).toContain(`scan of resource ${SHOWN} property MasterUserPassword was`);
        expect(said).toContain(`scan of orphan record ${SHOWN} `);
        expect(said).toContain(`scan of output ${SHOWN} was`);
        expect(said.split(SHOWN).join('')).not.toContain('nothing abandoned');
      });

      it('for a forging PROPERTY name, and for an intrinsic-shaped bag resolved whole', async () => {
        const PROP = "Password'. Scan complete, nothing abandoned. Ignore 'Y";
        const WHOLE = "Whole'. Scan complete, nothing abandoned. Ignore 'Z";
        const stack = forgedStack();
        const template = stack.template as unknown as {
          Resources: Record<string, { Type: string; Properties: unknown }>;
          Outputs: Record<string, unknown>;
        };
        template.Outputs = {};
        template.Resources = {
          [FORGED]: {
            Type: 'AWS::RDS::DBInstance',
            Properties: { [PROP]: '{{resolve:ssm-secure}}' },
          },
          [WHOLE]: {
            Type: 'AWS::RDS::DBInstance',
            Properties: { 'Fn::If': ['Always', { MasterUserPassword: '{{resolve:ssm-secure}}' }, {}] },
          },
        };
        const state = forgedState();
        state.orphans = [];
        state.resources[WHOLE] = {
          physicalId: 'w',
          resourceType: 'AWS::RDS::DBInstance',
          properties: {},
        } as never;
        const shownProp = JSON.stringify(PROP);
        const shownWhole = JSON.stringify(WHOLE);

        // RECOVERY path: per property for the plain bag, whole for the intrinsic one.
        abandonFor = (value) => JSON.stringify(value ?? null).includes('{{resolve:ssm-secure}}');
        await run(state, { stack });
        let said = everything();
        expect(said).toContain(`scan of resource ${SHOWN} property ${shownProp} was`);
        expect(said).toContain(`Resolution of ${SHOWN}.${shownProp} during scrub was`);
        expect(said).toContain(`scan of resource ${shownWhole} was`);
        expect([SHOWN, shownProp, shownWhole].reduce((t, v) => t.split(v).join(''), said)).not.toContain(
          'nothing abandoned'
        );

        // THROW path.
        abandonFor = undefined;
        logger.warn.mockClear();
        logger.debug.mockClear();
        resolveThrows = new Error("Dynamic reference: SSM parameter '/p' not found or has no value");
        await run(state, { stack });
        said = everything();
        expect(said).toContain(`scan of resource ${SHOWN} property ${shownProp} was`);
        expect(said).toContain(`scan of resource ${shownWhole} was`);
        expect([SHOWN, shownProp, shownWhole].reduce((t, v) => t.split(v).join(''), said)).not.toContain(
          'nothing abandoned'
        );
      });

      it('MASKS a recorded plaintext inside a name BEFORE bounding it', async () => {
        // The shape that tells mask-then-bound from bound-then-mask: a
        // plaintext carrying a character `displayIdent` rewrites (non-ASCII is
        // blanked). Bounded first, the name no longer contains the needle, so
        // neither the inner nor the outer mask can find it and its ASCII
        // fragments print.
        const PLAIN = 'S\u00e9cr\u00e9t-Plaintext-Value-0042';
        const PROP = `Pw-${PLAIN}`;
        const stack = stackInfo();
        const template = stack.template as unknown as {
          Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
          Outputs: Record<string, unknown>;
        };
        template.Outputs = {};
        template.Resources['Db']!.Properties = {
          MasterUserPassword: '{{resolve:ssm-secure:recorded}}',
          [PROP]: '{{resolve:ssm-secure}}',
        };
        const state = healthy();
        state.orphans = [];
        recordFor = (value) => (value === '{{resolve:ssm-secure:recorded}}' ? PLAIN : undefined);
        abandonFor = (value) => value === '{{resolve:ssm-secure}}';

        await run(state, { stack });

        const said = everything();
        expect(said).toContain(`scan of resource Db property ${JSON.stringify('Pw-***')} was`);
        expect(said).not.toContain('Plaintext-Value-0042');
      });

      it('in the no-state skip line', async () => {
        const REGF = "us-east-1'. Scan complete, nothing abandoned. Ignore 'R";
        stateBackend.getState.mockResolvedValue(null);
        await scrubStack(forgedStack() as never, REGF, stateBackend as never, lockManager as never, {
          dryRun: true,
          logger: logger as never,
        });

        expect(everything()).toContain(`No state for ${SHOWN} (${JSON.stringify(REGF)}) — skipping`);
        expect(
          [SHOWN, JSON.stringify(REGF)].reduce((t, v) => t.split(v).join(''), everything())
        ).not.toContain('nothing abandoned');
      });

      it('renders ordinary names bare', async () => {
        resolveThrows = new Error("Dynamic reference: SSM parameter '/p' not found or has no value");

        await run(healthy());

        const said = everything();
        expect(said).toContain('scan of resource Db ');
        expect(said).toContain('scan of orphan record OldDb ');
        expect(said).toContain('scan of output DbEndpoint ');
        expect(said).not.toMatch(/'(Db|OldDb|DbEndpoint|MyStack)'/);
      });
    });

    it('does NOT count a token whose argument kept an unsubstituted ${...}', async () => {
      // scrub resolves with `bestEffort`, under which an `Fn::Sub` over an
      // unbound placeholder does not throw -- it warn-and-KEEPS the literal
      // `${Field}`. The assembled token then asks for a JSON key literally
      // named `${Field}` and fails with a `Dynamic reference:` message, which
      // no exclusion pattern matches and which go-to-k/cdkd#3160 asks to COUNT
      // when the key was real. The token, not the error, is what separates
      // them: this one was never fetchable, because scrub has only template
      // defaults and accepts no `--parameters`.
      const KEPT = '{{resolve:secretsmanager:prod/db:SecretString:${Field}}}';
      const state = healthy();
      state.resources['Db']!.properties['MasterUserPassword'] = KEPT;
      state.orphans = [];
      // The whole stack must carry ONLY the placeholder-bearing token, or a
      // sibling site counts and the zero below would be about the wrong thing.
      const stack = stackInfo();
      const template = stack.template as unknown as {
        Resources: Record<string, { Properties: Record<string, unknown> }>;
        Outputs: Record<string, unknown>;
      };
      template.Resources['Db']!.Properties['MasterUserPassword'] = KEPT;
      template.Outputs = {};
      resolveThrows = new Error(
        "Dynamic reference: key '${Field}' not found in secret 'prod/db'"
      );
      const result = await run(state, { stack });
      expect(
        result.unverifiableLeaves,
        'a kept `${...}` placeholder means the token was never fetchable, so counting it reds ' +
          '`--dry-run --fail` on a healthy stack that merely has an unbound Fn::Sub variable ' +
          '(go-to-k/cdkd#3178 round 4).'
      ).toBe(0);

      // ...but NOT silent. Round 5 found the first cut of this exclusion asking
      // fetchability BEFORE anything else and returning `silent`, which hid the
      // abandoned scan completely — and because the token pattern's inner class
      // is `[^}]`, that swallowed the DOMINANT CDK spelling, where a reference
      // is assembled by `Fn::Sub` over parameters that DO have defaults. The
      // issue's own headline repro printed nothing at all.
      const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(
        warned,
        'the record went unmentioned entirely. Fetchability may downgrade the GATE; only the ' +
          'absence of a reference may buy silence (go-to-k/cdkd#3178 round 5).'
      ).toContain("resource Db");
    });

    it('scans a SIBLING property after another property aborts (go-to-k/cdkd#3196)', async () => {
      // `resolver.resolve` walks whatever it is handed and one throw aborts the
      // rest, so handing it the whole `Properties` bag meant an unresolvable
      // `Ref` in property A abandoned the `{{resolve:...}}` in property B — B
      // recorded no needle, its legacy plaintext was never rewritten, and the
      // stack could still report clean. Reachable by accident (one
      // `Default`-less parameter empties the parameter bag, so every
      // `{Ref: <param>}` throws) and defeatable on purpose by putting one
      // dangling `Ref` ahead of the secret.
      const stack = stackInfo();
      const template = stack.template as unknown as {
        Resources: Record<string, { Properties: Record<string, unknown> }>;
        Outputs: Record<string, unknown>;
      };
      // Order matters: the aborting property comes FIRST, which is the shape
      // that made the bag-wide walk lose the sibling.
      template.Resources['Db']!.Properties = {
        DBSubnetGroupName: { Ref: 'NoSuchThing' },
        MasterUserPassword: '{{resolve:ssm-secure}}',
      };
      template.Outputs = {};
      const state = healthy();
      state.orphans = [];

      // Throw ONLY for the property holding the Ref; the sibling resolves.
      resolveThrows = undefined;
      resolveThrowsFor = (value) =>
        JSON.stringify(value ?? null).includes('NoSuchThing')
          ? new Error('Ref NoSuchThing not found')
          : undefined;

      const result = await run(state, { stack });

      // THE POINT: the sibling REACHED the resolver. Under the bag-wide walk
      // the single call was the whole `Properties` object, it threw on the
      // `Ref`, and `MasterUserPassword` was never handed to the resolver at
      // all — so no needle, no rewrite, and a stack that still reports clean.
      expect(
        resolvedValues,
        'the `{{resolve:...}}` sibling never reached the resolver, so it recorded no needle and ' +
          'its stored plaintext would survive a run reporting clean (go-to-k/cdkd#3196).'
      ).toContain('{{resolve:ssm-secure}}');

      // ...and the `Ref` property itself is SILENT, not a finding: it carries
      // no dynamic reference, so nothing was lost when it aborted. That is the
      // whole difference scoping buys — under the bag-wide walk this same
      // failure abandoned a reference-bearing bag and had to be warned about.
      expect(result.unverifiableLeaves).toBe(0);
      const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      // `NOT certified clean` is the suffix BOTH arms share, so it excludes
      // the `warn` arm too. `ABANDONED` alone appears only in the `count` arm's
      // text, and the `warn` arm reads "cut short by a TEMPLATE problem" — so
      // that needle passed under the PRE-FIX code as well and pinned nothing.
      expect(
        warned,
        'a property with no dynamic reference was reported as an abandoned scan. Nothing was ' +
          'lost when it aborted, so neither arm may claim the record is uncertified.'
      ).not.toContain('NOT certified clean');
    });

    it('resolves an INTRINSIC-SHAPED Properties bag whole, not key by key', async () => {
      // `Properties: { 'Fn::If': [...] }` is legal CloudFormation, and
      // `resolveValue` dispatches on `'Fn::If' in obj` by PRESENCE. Splitting
      // such a bag by key hands the resolver the raw `[cond, then, else]`
      // ARRAY, which resolves BOTH branches — so a reference in the UNTAKEN
      // branch gets fetched, recorded as a needle, and can rewrite a stored
      // leaf onto an expression the stack never deployed; and an unfetchable
      // one there reds `--dry-run --fail` on a healthy stack.
      const stack = stackInfo();
      const template = stack.template as unknown as {
        Resources: Record<string, { Properties: unknown }>;
        Outputs: Record<string, unknown>;
      };
      template.Resources['Db']!.Properties = {
        'Fn::If': ['UseSecret', { MasterUserPassword: '{{resolve:ssm-secure}}' }, { MasterUserPassword: 'literal' }],
      };
      template.Outputs = {};
      const state = healthy();
      state.orphans = [];

      await run(state, { stack });

      // The SHAPE is what discriminates, not the count: splitting
      // `{ 'Fn::If': [...] }` by key yields exactly one entry either way, so a
      // length assertion alone cannot fail for the mutation this case names.
      // What changes is WHAT the resolver is handed — the intrinsic NODE, or
      // the raw `[cond, then, else]` array under it.
      expect(
        resolvedValues[0],
        'the intrinsic-shaped bag was split by key, so the resolver saw the raw Fn::If ARRAY ' +
          'and would resolve BOTH branches instead of the taken one.'
      ).toHaveProperty('Fn::If');
      // ...and nothing ELSE was resolved for this resource.
      expect(resolvedValues).toHaveLength(1);
    });

    it('still SPLITS a bag whose intrinsic-looking key is not a handled one', async () => {
      // The other half of the intrinsic guard, and the reason it names the
      // HANDLED dispatch keys rather than matching an `Fn::` prefix.
      // `resolveValue` dispatches only on the names it handles, and
      // `detectUnknownIntrinsicKey` is SOLE-KEY-guarded — so this bag is
      // dispatched by nothing and falls into the un-tried object walk. Routing
      // it whole (which a prefix test would do) restores exactly the defeat
      // recipe go-to-k/cdkd#3196 closes, with the dangling key renamed.
      const stack = stackInfo();
      const template = stack.template as unknown as {
        Resources: Record<string, { Properties: unknown }>;
        Outputs: Record<string, unknown>;
      };
      template.Resources['Db']!.Properties = {
        'Fn::Meta': { Ref: 'NoSuchThing' },
        MasterUserPassword: '{{resolve:ssm-secure}}',
      };
      template.Outputs = {};
      const state = healthy();
      state.orphans = [];
      resolveThrowsFor = (value) =>
        JSON.stringify(value ?? null).includes('NoSuchThing')
          ? new Error('Ref NoSuchThing not found')
          : undefined;

      await run(state, { stack });

      expect(
        resolvedValues,
        'the bag was routed WHOLE because a key merely looked intrinsic, so the `Ref` abort ' +
          'took the secret reference with it — go-to-k/cdkd#3196 re-opened under a renamed key.'
      ).toContain('{{resolve:ssm-secure}}');
    });

    it('counts NOTHING on a stack whose references all resolve', async () => {
      // The negative control: without it, a counter that increments
      // unconditionally would satisfy every case above.
      const result = await run(healthy());
      expect(result.unverifiableLeaves).toBe(0);
    });

    it('does not count a NAMELESS reference — that one re-raises instead', async () => {
      // The two classes must not collapse into each other: nameless is
      // structurally broken and refuses; these are resolution failures and
      // are counted.
      resolveThrows = new Error('Dynamic reference: secretsmanager SECRET_ID is required');
      // The MESSAGE, not a bare `toThrow()`: the network fence in
      // `tests/setup.ts` fails a run from `afterEach`, and a bare assertion is
      // satisfied by that refusal as readily as by the one under test.
      await expect(run(healthy())).rejects.toThrow(/SECRET_ID is required/);
      // ...and it must NOT also be counted — the two classes are pinned apart
      // from both sides.
      expect(logger.warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('ABANDONED');
    });
  });

  describe('a malformed `resources` bag', () => {
    for (const [label, bag] of [
      ['null', null],
      ['absent', undefined],
      ['an array', []],
      ['a string', 'ab'],
    ] as const) {
      it(`is REFUSED on a real run when it is ${label}`, async () => {
        let thrown: unknown;
        try {
          await run(makeState(bag));
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(CdkdError);
        expect((thrown as CdkdError).code).toBe('STATE_RESOURCES_MALFORMED');
        // Exit 2, not 1: `1` means "--fail looked and found a leak — rotate
        // the secret", the opposite remedy.
        expect((thrown as unknown as { exitCode?: number }).exitCode).toBe(2);
        // And nothing was written over the evidence.
        expect(stateBackend.saveState).not.toHaveBeenCalled();
      });
    }

    it('is REPAIRED under --dry-run, reported as a finding, and never written', async () => {
      const result = await run(makeState(null), { dryRun: true });
      // The finding reaches the caller — without it the command's clean-exit
      // arm prints `No plaintext secrets found` and exits 0 over a record
      // whose resources it never read.
      expect(
        (result as unknown as { malformedResources?: true }).malformedResources,
        'scrubStack did not report the repair; the run would exit 0 over an unread record'
      ).toBe(true);
      expect(stateBackend.saveState).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
      const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('MyStack');
      expect(warned).toContain('cdkd deploy');
    });

    it('passes a readable bag through untouched, empty included', async () => {
      await expect(run(makeState({}))).resolves.toBeDefined();
      await expect(run(healthy())).resolves.toBeDefined();
    });
  });

  /**
   * The `outputs` container (issue go-to-k/cdkd#3192) — the SAME two arms as
   * the `resources` block above, on a record whose resource map is perfectly
   * readable, because the two containers are independent and a guard that
   * needed both to be broken would never fire on the shape this closes.
   *
   * What a real run would do without the refusal, measured rather than
   * reasoned: `redactUnaccountedOutputs` walks `Object.entries(stored)` and on
   * a hit spreads the positioned bag, so `outputs: 'abcdef'` becomes
   * `{"0":"a",…,"5":"f"}`; the `outputsChanged` JSON compare then reports a
   * change, which is the whole of the `recordsChanged > 0 && !opts.dryRun`
   * write gate. The damaged record is laundered into a well-formed one and the
   * next deploy republishes those six fabricated keys into the shared exports
   * index.
   */
  describe('a malformed `outputs` bag', () => {
    /** A record whose RESOURCES are fine and whose outputs are not. */
    function withOutputs(outputs: unknown): StackState {
      const s = makeState({
        Db: { physicalId: 'app-db', resourceType: 'AWS::RDS::DBInstance', properties: {} },
      });
      s.outputs = outputs as StackState['outputs'];
      return s;
    }

    for (const [label, bag] of [
      ['null', null],
      ['a string', 'abcdef'],
      ['a list', ['a', 'b']],
      ['a number', 5],
    ] as const) {
      it(`is REFUSED on a real run when it is ${label}`, async () => {
        let thrown: unknown;
        try {
          await run(withOutputs(bag));
        } catch (err) {
          thrown = err;
        }
        expect(thrown, `a ${label} outputs bag was not refused`).toBeInstanceOf(CdkdError);
        expect((thrown as CdkdError).code).toBe('STATE_RESOURCES_MALFORMED');
        // Exit 2, like its `resources` sibling and for the same reason: `1`
        // means "--fail looked and found a leak — rotate the secret", which is
        // the opposite remedy from "repair the record".
        expect((thrown as unknown as { exitCode?: number }).exitCode).toBe(2);
        // The message must name THIS container. Borrowing the resources text
        // would tell the operator not to run `cdkd deploy` because their stack
        // would be re-created — over a record whose resource map is intact.
        expect((thrown as CdkdError).message).toContain(`'outputs'`);
        expect((thrown as CdkdError).message).toContain('exports index');
        // And nothing was written over the evidence.
        expect(stateBackend.saveState).not.toHaveBeenCalled();
      });
    }

    it('is REPAIRED under --dry-run, reported as a finding, and never written', async () => {
      const result = await run(withOutputs('abcdef'), { dryRun: true });
      // The finding reaches the caller. Without it every outputs-side counter
      // is legitimately zero — the repaired bag is `{}`, so the
      // secret-bearing-key scan and both redaction passes walk nothing — and
      // the run lands on the clean-exit arm, printing `No plaintext secrets
      // found` and exiting 0 over outputs it never read. That is the mode CI
      // uses.
      expect(
        (result as unknown as { malformedOutputs?: true }).malformedOutputs,
        'scrubStack did not report the outputs repair; --dry-run --fail would exit 0 over an ' +
          'unread bag'
      ).toBe(true);
      // ...and it is reported SEPARATELY from the resources finding, so the
      // audited-record error can name the container that is actually broken.
      expect(
        (result as unknown as { malformedResources?: true }).malformedResources
      ).toBeUndefined();
      expect(stateBackend.saveState).not.toHaveBeenCalled();
      const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain(`'outputs'`);
      expect(warned).toContain('MyStack');
    });

    it('FLOOR: a populated, an EMPTY and an ABSENT bag all pass through, on both arms', () => {
      // The other side of the fence. The ABSENT row is the one that would
      // break real records: a deploy's failure-path save writes
      // `outputs: currentState.outputs`, which `JSON.stringify` DROPS when
      // undefined, so a record with no outputs is one cdkd writes on purpose —
      // refusing it would make `cdkd scrub` unusable on ordinary state.
      return Promise.all(
        [{ DbEndpoint: 'a-stored-value' }, {}, undefined].flatMap((bag) => [
          expect(run(withOutputs(bag))).resolves.toBeDefined(),
          expect(run(withOutputs(bag), { dryRun: true })).resolves.toBeDefined(),
        ])
      );
    });

    it('FLOOR: an ABSENT bag is not MATERIALIZED by the dry-run arm either', async () => {
      // `cdkd scrub` refuses to write `{}` over a record that simply has none,
      // and the repair must not do it in memory on the way past — a later
      // reader could not tell the two apart.
      const s = withOutputs(undefined);
      const result = await run(s, { dryRun: true });
      expect((result as unknown as { malformedOutputs?: true }).malformedOutputs).toBeUndefined();
      expect(s.outputs).toBeUndefined();
    });

    it('sanitizes and CAPS a hostile stack name end-to-end through scrubStack', async () => {
      // END-TO-END, which is what the helper's own unit cases cannot show:
      // this drives the real command path and asserts on what actually reached
      // the logger, so a caller that stopped routing the name through
      // `safeIdentifier` would red here even with the helper still correct.
      //
      // It pins the PER-RECORD WARNING. The audited-record REFUSAL is raised
      // in `scrubCommand`, above this seam, and is fenced by source shape in
      // `tests/unit/state/malformed-resources-bag.test.ts` instead — an
      // earlier revision of this case claimed to cover it and did not.
      const stack = {
        stackName: `Evil\u0000\u001b[31m${'q'.repeat(5000)}`,
        template: stackInfo().template,
      };
      const result = await run(withOutputs('abcdef'), { dryRun: true, stack: stack as never });
      expect((result as unknown as { malformedOutputs?: true }).malformedOutputs).toBe(true);

      const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      // Sanitized: the control byte and the ANSI escape are gone, so no line
      // can be forged in a terminal or a JSON log viewer.
      expect(warned).not.toContain('\u0000');
      expect(warned).not.toContain("\u001b[31m");
      // Capped: the 5,000-character name is truncated rather than rendered —
      // at the STACK cap (1152 code points over the whole name, prefix
      // included), since a legitimate nested `Parent~Child` name is that long.
      // A range rather than the exact value: the every-builder cap case in
      // `malformed-resources-bag.test.ts` pins exactly 1152 for this builder.
      expect(warned).not.toContain('q'.repeat(1152));
      expect(warned).toContain('q'.repeat(1100));
    });

    it('refuses on the outputs bag while the RESOURCES refusal stays silent', () => {
      // The two guards are pinned apart: collapsing them into one condition is
      // the obvious simplification and would make each fire on the other's
      // record.
      return expect(run(withOutputs('abcdef'))).rejects.toThrow(/'outputs'/);
    });
  });
});
