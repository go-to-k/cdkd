/**
 * Issue go-to-k/cdkd#3379, scrub half — the branch, not one verdict.
 *
 * `cdkd scrub` loads state on its own and can write it back, so it takes both
 * answers the way it already does for the `resources` bag and the `outputs`
 * map: `--dry-run` REPAIRS the container and reports it, a real run REFUSES.
 *
 * The write gate is `recordsChanged > 0`, which an OUTPUTS change alone
 * satisfies — so an unconditional repair here would persist `orphans: []` over
 * a damaged container whenever some other field changed, erasing the record's
 * only evidence that an earlier failed deploy left resources live in AWS. The
 * "saves nothing" and "never persists an empty list" assertions are what
 * separate this from a repair that merely looks correct.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const SECRET_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';
const SECRET_PLAINTEXT = 'the-real-resolved-db-password';
const RESOLVES: Record<string, string> = { [SECRET_EXPR]: SECRET_PLAINTEXT };

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/deployment/intrinsic-function-resolver.js')>()),
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
        const walk = (v: unknown): unknown => {
          if (typeof v === 'string' && RESOLVES[v] !== undefined) {
            ctx.recordedSecretValues?.set(RESOLVES[v]!, v);
            return RESOLVES[v]!;
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

import { scrubStack } from '../../../../src/cli/commands/scrub.js';
import { STATE_RESOURCES_MALFORMED } from '../../../../src/state/malformed-resources-bag.js';

const REGION = 'us-east-1';
const STACK = 'MyStack';
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * A stack whose stored `outputs` holds the RESOLVED plaintext, so a real run
 * has a genuine change to make and reaches the write gate. Without that the
 * "never persists an empty list" case would pass on an early return.
 */
const stackInfo = {
  stackName: STACK,
  template: {
    Resources: {
      Db: {
        Type: 'AWS::RDS::DBInstance',
        Properties: { DBInstanceIdentifier: 'app-db', MasterUserPassword: SECRET_EXPR },
      },
    },
    Outputs: { DbPassword: { Value: SECRET_EXPR } },
  } as CloudFormationTemplate,
};

function record(orphans: unknown): StackState {
  return {
    version: 10,
    stackName: STACK,
    region: REGION,
    resources: {
      Db: { physicalId: 'app-db', resourceType: 'AWS::RDS::DBInstance', properties: {} },
    },
    outputs: { DbPassword: SECRET_PLAINTEXT },
    orphans: orphans as StackState['orphans'],
    lastModified: 1,
  };
}

function harness(state: StackState) {
  const saveState = vi.fn().mockResolvedValue('etag-2');
  const stateBackend = {
    getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
    saveState,
  };
  const lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
  return { saveState, stateBackend, lockManager };
}

async function scrub(state: StackState, dryRun: boolean) {
  const h = harness(state);
  const result = await scrubStack(
    stackInfo as never,
    REGION,
    h.stateBackend as never,
    h.lockManager as never,
    { dryRun, logger: logger as never }
  ).catch((e: unknown) => e);
  const call = h.saveState.mock.calls.at(-1);
  return { result, saved: call ? (call[2] as StackState) : undefined, saveState: h.saveState };
}

const MALFORMED: Array<[string, unknown]> = [
  ['a string container', 'abc'],
  ['a number container', 5],
  ['a plain object container', {}],
  ['an object carrying length', { length: 1 }],
  ['a null container', null],
];

describe('cdkd scrub over an unreadable orphans container (go-to-k/cdkd#3379)', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const [label, orphans] of MALFORMED) {
    it(`refuses ${label} on a REAL run, saving nothing`, async () => {
      const { result, saveState } = await scrub(record(orphans), false);
      expect(result).toBeInstanceOf(Error);
      expect((result as { code?: string }).code).toBe(STATE_RESOURCES_MALFORMED);
      expect((result as Error).message).toContain("'orphans'");
      // The record this run would otherwise have rewritten stays exactly as
      // stored — including the damaged container, which is the evidence.
      expect(
        saveState,
        'scrub wrote the record while refusing, so the damaged container was laundered'
      ).not.toHaveBeenCalled();
    });

    it(`reports ${label} under --dry-run instead of refusing`, async () => {
      const { result, saveState } = await scrub(record(orphans), true);
      // The audit is what the user came for, so the run completes.
      expect(result).not.toBeInstanceOf(Error);
      expect((result as { malformedOrphans?: true }).malformedOrphans).toBe(true);
      // A dry run provably cannot persist anything.
      expect(saveState).not.toHaveBeenCalled();
      const warned = logger.warn.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toContain("'orphans'");
    });
  }

  it('CONTROL: a readable container scrubs and SAVES, so the refusal is not blanket', async () => {
    const { result, saved, saveState } = await scrub(record([]), false);
    expect(result).not.toBeInstanceOf(Error);
    // Non-vacuity: this run really did reach the write gate, which is what the
    // refusal cases above prevent.
    expect(saveState).toHaveBeenCalled();
    expect(saved!.outputs['DbPassword']).toBe(SECRET_EXPR);
    // ...and it did not materialize a container the record did not have.
    expect(saved!.orphans).toEqual([]);
  });

  it('never persists a repaired empty list: an ABSENT container stays absent', async () => {
    const state = record(undefined);
    delete (state as Partial<StackState>).orphans;
    const { result, saved, saveState } = await scrub(state, false);
    expect(result).not.toBeInstanceOf(Error);
    expect(saveState).toHaveBeenCalled();
    expect(
      saved !== undefined && 'orphans' in saved && saved.orphans !== undefined,
      'scrub wrote an `orphans` key onto a record that had none'
    ).toBe(false);
  });
});
