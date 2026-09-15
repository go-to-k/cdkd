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
 *   `errorCauseChain`, so a wrapped one must still be seen.
 * - a real run REFUSES a malformed `resources` bag with exit 2;
 * - a `--dry-run` REPAIRS it, reports the finding, and writes nothing.
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
      Outputs: {},
    } as CloudFormationTemplate,
  };
}

function makeState(resources: unknown): StackState {
  return {
    version: 8,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources: resources as StackState['resources'],
    outputs: {},
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

    it('does NOT re-raise a dynamic-reference RESOLUTION failure', async () => {
      // scrub resolves with template DEFAULTS and no `--parameters`, so an
      // Fn::Sub that keeps its raw `${Field}` produces this on a HEALTHY
      // stack. Refusing on it refuses those stacks — go-to-k/cdkd#3160.
      resolveThrows = new Error("Dynamic reference: key '${Field' not found in secret 'x'");
      await expect(run(healthy())).resolves.toBeDefined();
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
