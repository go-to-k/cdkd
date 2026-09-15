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

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi.fn().mockImplementation((value: unknown) => {
      if (resolveThrows) return Promise.reject(resolveThrows);
      return Promise.resolve(value);
    }),
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
          Export: { Name: { 'Fn::Sub': '${AWS::StackName}-db-endpoint' } },
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
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  function run(
    state: StackState,
    opts: { dryRun?: boolean } = {}
  ): ReturnType<typeof scrubStack> {
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-1' });
    return scrubStack(stackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: opts.dryRun ?? false,
      logger: logger as never,
    });
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

    for (const message of [
      "Dynamic reference: SSM parameter '/deleted' not found or has no value",
      "Dynamic reference: secret 'x' does not contain a SecretString value",
      "Dynamic reference: key '${Field' not found in secret 'x'",
      "Dynamic reference: secret 'x' is not valid JSON but JSON_KEY 'k' was specified",
    ]) {
      it(`counts, but does NOT re-raise, \`${message.slice(0, 44)}...\``, async () => {
        // scrub resolves with template DEFAULTS and no `--parameters`, so an
        // Fn::Sub that keeps its raw `${Field}` produces this on a HEALTHY
        // stack. Refusing refuses those stacks — but staying SILENT is the
        // go-to-k/cdkd#3160 defect: the resolver stops at the first failing
        // token, so a real secret after it in the same leaf records no needle
        // and the run reported `No plaintext secrets found`, exit 0.
        resolveThrows = new Error(message);
        const result = await run(healthy());
        expect(result).toBeDefined();
        expect(
          result.unverifiableLeaves,
          'the abandoned leaf was not counted, so the run can still report the stack clean ' +
            'over a scan that stopped early (go-to-k/cdkd#3160).'
        ).toBeGreaterThan(0);
      });
    }

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
      await expect(run(healthy())).rejects.toThrow();
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
});
