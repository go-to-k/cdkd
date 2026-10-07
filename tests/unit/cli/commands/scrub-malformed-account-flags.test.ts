/**
 * Issue go-to-k/cdkd#4159, the `cdkd scrub` half: every malformed-container
 * refusal (a real run) and warning (`--dry-run`) `scrubStack` raises prints its
 * pasteable command with the run's account flags, from `opts.refusalRecovery`
 * — so a pasted `cdkd state show` reads the bucket scrub read. With no context
 * the command carries no account flag.
 *
 * The harness is `scrub-malformed-orphans.test.ts`'s.
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
import type { LockRecoveryContext } from '../../../../src/state/lock-contention-message.js';
import { readFileSync } from 'node:fs';

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

function record(patch: Record<string, unknown>): StackState {
  return {
    version: 10,
    stackName: STACK,
    region: REGION,
    resources: {
      Db: { physicalId: 'app-db', resourceType: 'AWS::RDS::DBInstance', properties: {} },
    },
    outputs: { DbPassword: SECRET_PLAINTEXT },
    orphans: [],
    lastModified: 1,
    ...patch,
  } as StackState;
}

function harness(state: StackState) {
  const saveState = vi.fn().mockResolvedValue('etag-2');
  const stateBackend = {
    getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
    saveState,
    purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
  };
  const lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
  return { saveState, stateBackend, lockManager };
}

async function scrub(state: StackState, dryRun: boolean, refusalRecovery?: LockRecoveryContext) {
  const info: unknown = stackInfo;
  const h = harness(state);
  const result = await scrubStack(
    info as never,
    REGION,
    h.stateBackend as never,
    h.lockManager as never,
    { dryRun, logger: logger as never, ...(refusalRecovery && { refusalRecovery }) }
  ).catch((e: unknown) => e);
  const call = h.saveState.mock.calls.at(-1);
  return { result, saved: call ? (call[2] as StackState) : undefined, saveState: h.saveState };
}

const RECOVERY: LockRecoveryContext = {
  profile: 'prod',
  stateBucket: 'my-bucket',
  statePrefix: 'team-a',
};
const FLAGS = '--profile prod --state-bucket my-bucket --state-prefix team-a';

/** One record per container `scrubStack` checks, each malformed there alone. */
const SITES: Array<[string, () => Record<string, unknown>]> = [
  ['the resources bag', () => ({ resources: 5 })],
  [
    'a resource row',
    () => ({
      resources: {
        Db: { physicalId: 'app-db', resourceType: 'AWS::RDS::DBInstance', properties: {} },
        Bad: null,
      },
    }),
  ],
  ['the outputs bag', () => ({ outputs: 'abc' })],
  ['the orphans container', () => ({ orphans: 'abc' })],
  ['an orphan row', () => ({ orphans: [null] })],
];

const warned = (): string => logger.warn.mock.calls.map((args) => String(args[0])).join('\n');

describe('cdkd scrub carries the account flags on its malformed-record pointers (go-to-k/cdkd#4159)', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const [site, patch] of SITES) {
    it(`${site}, real run: the refusal carries the flags`, async () => {
      const { result, saveState } = await scrub(record(patch()), false, RECOVERY);
      expect(result).toBeInstanceOf(Error);
      expect((result as { code?: string }).code).toBe(STATE_RESOURCES_MALFORMED);
      expect((result as Error).message).toContain(FLAGS);
      expect(saveState).not.toHaveBeenCalled();
    });

    it(`${site}, real run: CONTROL — no context, no account flag`, async () => {
      const { result } = await scrub(record(patch()), false);
      expect((result as { code?: string }).code).toBe(STATE_RESOURCES_MALFORMED);
      expect((result as Error).message).toContain('cdkd state ');
      expect((result as Error).message).not.toContain('--state-bucket');
    });

    it(`${site}, --dry-run: the warning carries the flags`, async () => {
      const { result } = await scrub(record(patch()), true, RECOVERY);
      expect(result).not.toBeInstanceOf(Error);
      expect(warned()).toContain(`cdkd state show ${STACK} --stack-region ${REGION} --json ${FLAGS}`);
    });

    it(`${site}, --dry-run: CONTROL — no context, no account flag`, async () => {
      await scrub(record(patch()), true);
      expect(warned()).toContain(`cdkd state show ${STACK} --stack-region ${REGION} --json`);
      expect(warned()).not.toContain('--state-bucket');
    });
  }

  it('scrubCommand builds the context from --profile, the RESOLVED bucket and --state-prefix, and hands it over', () => {
    const source = readFileSync(
      new URL('../../../../src/cli/commands/scrub.ts', import.meta.url),
      'utf8'
    );
    expect(source).toMatch(
      /const refusalRecovery: LockRecoveryContext = \{\s*profile: options\.profile,\s*stateBucket,\s*statePrefix: options\.statePrefix,\s*\};/
    );
    // `stateBucket` there is the resolved one, bound before the context.
    const resolved = source.indexOf(
      'const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);'
    );
    expect(resolved).toBeGreaterThan(-1);
    expect(resolved).toBeLessThan(source.indexOf('const refusalRecovery: LockRecoveryContext'));
    const call = source.slice(source.indexOf('scrubbed = await scrubStack('));
    expect(call.slice(0, call.indexOf('});'))).toMatch(/^\s*refusalRecovery,$/m);
  });
});
