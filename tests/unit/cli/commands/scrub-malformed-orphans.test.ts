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
/**
 * A SECOND, independent secret, so a per-row needle map can be told apart from
 * its neighbour's. One pair cannot: with a single plaintext every row's map holds
 * the same entry, so dropping one row's map is invisible.
 */
const OTHER_EXPR = '{{resolve:secretsmanager:prod/api:SecretString:token}}';
const OTHER_PLAINTEXT = 'the-real-resolved-api-token';
/**
 * A THIRD pair, and the reason it exists is the measurement that killed the first
 * version of the duplicate-id case: the row's secret must be one NO OTHER SOURCE
 * in the run knows. Reusing {@link SECRET_EXPR} there made the case green with
 * the defect restored, because the template declares that expression too, so the
 * resource loop's own needle map carried the plaintext and the union redacted the
 * row anyway. A secret only THAT ROW holds is what makes the per-row map
 * load-bearing.
 */
const ROW_ONLY_EXPR = '{{resolve:secretsmanager:prod/legacy:SecretString:key}}';
const ROW_ONLY_PLAINTEXT = 'the-real-resolved-legacy-key';
/**
 * A FOURTH pair whose plaintext COLLIDES with {@link ROW_ONLY_PLAINTEXT} — the
 * same secret reached through a second expression, which happens whenever two
 * references name one secret by different spellings (an ARN and a name, two
 * versionIds).
 *
 * It exists because the two keys of the per-row map need separate pins: with
 * distinct plaintexts the UNION already carries both rows' needles, so mutating
 * only the `get` side back to `logicalId` stayed green (round-2 proxy pass).
 * Where the plaintext collides, the union holds ONE entry for it — the last row's
 * expression — so only the per-row lookup can put each row's OWN expression back
 * into that row.
 */
const COLLIDING_EXPR = '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:111122223333:secret:prod/legacy-AbCdEf:SecretString:key}}';
const RESOLVES: Record<string, string> = {
  [SECRET_EXPR]: SECRET_PLAINTEXT,
  [OTHER_EXPR]: OTHER_PLAINTEXT,
  [ROW_ONLY_EXPR]: ROW_ONLY_PLAINTEXT,
  [COLLIDING_EXPR]: ROW_ONLY_PLAINTEXT,
};

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

async function scrub(state: StackState, dryRun: boolean, info: unknown = stackInfo) {
  const h = harness(state);
  const result = await scrubStack(
    info as never,
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

/**
 * Issue go-to-k/cdkd#3500, `cdkd scrub` half — a READABLE list holding a row the
 * rewrite cannot read. The two arms split the way the container's do, and for the
 * same reason: a real run's save writes the whole record, so reading a row as
 * absent would persist the loss, while `--dry-run` writes nothing and reports.
 */
describe('cdkd scrub over an unusable orphan ROW (go-to-k/cdkd#3500)', () => {
  beforeEach(() => vi.clearAllMocks());

  const healthy = {
    logicalId: 'Keep',
    orphanedAt: 1,
    state: { physicalId: 'live-keep', resourceType: 'AWS::SQS::Queue', properties: {} },
  };

  const UNUSABLE: Array<[string, unknown]> = [
    ['a null row', null],
    ['a number row', 5],
    ['a row with no `state`', { logicalId: 'Gone', orphanedAt: 1 }],
    ['a row whose `logicalId` is not a string', { logicalId: 5, orphanedAt: 1, state: healthy.state }],
    [
      'a row whose `state.properties` is not an object',
      {
        logicalId: 'Gone',
        orphanedAt: 1,
        state: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: 'abcdef' },
      },
    ],
    // Symmetry across the per-command tables (go-to-k/cdkd#3641, items o3 and o7):
    // all five now carry BOTH torn maps and the empty-object row — deploy,
    // destroy, scrub, rollback and import — so a predicate clause cannot be
    // covered at one command and unfenced at another. The first cut claimed that
    // for five tables while extending three, which the maintainer's o7 measured.
    ['an empty-object row', {}],
    [
      'a row whose `state.attributes` is not an object',
      {
        logicalId: 'Gone',
        orphanedAt: 1,
        state: {
          physicalId: 'p',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: 'abcdef',
        },
      },
    ],
  ];

  for (const [label, row] of UNUSABLE) {
    it(`refuses ${label} on a REAL run, saving nothing`, async () => {
      const h = await scrub(record([healthy, row]), false);
      expect(h.result).toBeInstanceOf(Error);
      expect((h.result as { code?: string }).code).toBe(STATE_RESOURCES_MALFORMED);
      // The ROW text, not the container's: this list IS a list.
      expect(String((h.result as Error).message)).toContain('rollback-orphan record(s)');
      expect(String((h.result as Error).message)).not.toContain("has no readable 'orphans' list");
      expect(
        h.saveState,
        'the real run rewrote the record it could not fully read'
      ).not.toHaveBeenCalled();
    });

    it(`drops and REPORTS ${label} under --dry-run instead of refusing`, async () => {
      const h = await scrub(record([healthy, row]), true);
      expect(h.result, `--dry-run refused: ${String(h.result)}`).not.toBeInstanceOf(Error);
      // The finding is what carries the row damage to the command's verdict.
      // Without it every orphan-side counter is legitimately zero and
      // `--dry-run --fail` exits through the silent ScrubNeededError instead.
      expect(
        (h.result as unknown as { malformedOrphanRows?: true }).malformedOrphanRows,
        'scrubStack did not report the dropped row'
      ).toBe(true);
      // ...and the WARNING, which is the only diagnostic naming the rows: the
      // finding flag alone stays green with `logger.warn` removed, and the
      // audited-record refusal names stacks rather than rows (maintainer proxy
      // pass, round 3).
      const warned = logger.warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(warned, 'the dropped row was never named to the operator').toContain(
        'rollback-orphan record'
      );
      // ...and the diagnosis matches THIS caller's predicate: scrub rejects a
      // torn `properties` / `attributes` map, so its warning has to say so, and
      // `cdkd diff`'s must not (go-to-k/cdkd#3500).
      expect(warned, "scrub's warning omits the map causes it rejects on").toContain(
        "'properties' or 'attributes' map that is not an object"
      );
      // The flag governs the CONSEQUENCE clause too, not only the diagnosis: what
      // continuing without the row costs is per command, and scrub's cost is the
      // scan it excludes the row from. `cdkd diff`'s clause here would tell a
      // scrub operator the row was not PREVIEWED, which scrub never does.
      expect(warned, "scrub's warning states diff's consequence").toContain(
        'excluded from the secret scan'
      );
      expect(warned).not.toContain('previewed for adoption');
      // SEPARATE from the container finding: the field here is a list, and the
      // remedies differ — rewrite the field, versus repair a row inside it.
      expect(
        (h.result as unknown as { malformedOrphans?: true }).malformedOrphans
      ).toBeUndefined();
      expect(h.saveState).not.toHaveBeenCalled();
    });
  }

  it('reports the dropped row on a record that resolves NO secret', async () => {
    // The OTHER return site. `scrubStack` returns from two places, and both
    // fixtures above resolve a secret, so only the late one was exercised:
    // disabling the finding on the zero-secret return was invisible (maintainer
    // proxy pass, round 4). A record whose outputs hold no plaintext takes that
    // path, and the finding still has to reach the caller.
    const clean = record([healthy, 5]);
    clean.outputs = {};
    // A template with NO secret reference: the shared one declares
    // `MasterUserPassword: SECRET_EXPR`, so every other case resolves a secret
    // and takes the LATE return. Measured — with the shared template this case
    // did not reach the early one at all.
    const noSecret = {
      stackName: STACK,
      template: {
        Resources: {
          Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceIdentifier: 'app-db' } },
        },
      } as CloudFormationTemplate,
    };
    const h = await scrub(clean, true, noSecret);
    expect(h.result, `--dry-run refused: ${String(h.result)}`).not.toBeInstanceOf(Error);
    // The DISCRIMINATOR, not the comment above it: the early return is the
    // `totalSecrets === 0` branch, so it reports `secretsFound: 0`. Without this
    // the case silently stops covering that branch the moment the shared fixture
    // or the needle accounting changes and it starts taking the late one — which
    // is exactly the drift the "Measured" note cannot notice.
    expect(
      (h.result as unknown as { secretsFound: number }).secretsFound,
      'this case no longer takes the zero-needle return, so the OTHER return site is unfenced'
    ).toBe(0);
    expect(
      (h.result as unknown as { malformedOrphanRows?: true }).malformedOrphanRows,
      'the zero-secret return dropped the finding'
    ).toBe(true);
    expect(h.saveState).not.toHaveBeenCalled();
  });

  it('the shared fixture takes the OTHER return, so the pair covers both sites', async () => {
    // The converse half of the discriminator above. Two cases claiming two
    // return sites prove it only if one of them provably takes the late one:
    // both asserting `secretsFound: 0` would be one site twice.
    const h = await scrub(record([healthy, 5]), true);
    expect(
      (h.result as unknown as { secretsFound: number }).secretsFound,
      'the shared fixture stopped resolving a secret, so both cases now take one return'
    ).toBeGreaterThan(0);
  });

  it('CONTROL: a list whose every row is usable scrubs and SAVES', async () => {
    const h = await scrub(record([healthy]), false);
    expect(h.result, `refused a usable list: ${String(h.result)}`).not.toBeInstanceOf(Error);
    expect(h.saveState, 'the control never saved, so it proves nothing').toHaveBeenCalled();
    // ...and the usable row survives the rewrite rather than being dropped by it.
    expect(h.saved?.orphans).toHaveLength(1);
  });

  it('the REAL run refuses BEFORE any drop, so it cannot launder the list', async () => {
    // The arm ORDER, which the two blocks above cannot show: the dry-run arm
    // narrows the list in memory, so a real run reaching that code first would
    // hold a repaired list by the time it decided anything. It refuses instead,
    // and the walked record still carries both rows when it does.
    const state = record([healthy, 5]);
    const h = await scrub(state, false);
    expect(h.result).toBeInstanceOf(Error);
    expect((state.orphans as unknown as unknown[]).length, 'the real run dropped a row').toBe(2);
    expect(h.saveState).not.toHaveBeenCalled();
  });
});

describe('two usable orphan rows sharing a `logicalId` (go-to-k/cdkd#3500 security)', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * Nothing validates that `orphans` logical ids are UNIQUE — the row guard asks
   * only whether each row is usable, and two rows carrying the same id are both
   * usable. `cdkd scrub` collects one needle map PER ROW, and while that map was
   * keyed by `logicalId` the second row's fresh map REPLACED the first's filled
   * one: the first row's needles left the collection entirely, so neither its own
   * lookup nor the union the rewrite builds could find them, and its stored
   * PLAINTEXT was written back to S3 by a run reporting success.
   *
   * Each row carries its OWN secret: the expression in `properties` (which is
   * where the needle comes from) and the resolved plaintext in `attributes`
   * (which is what has to be rewritten). With one shared secret the defect is
   * invisible, since the surviving map holds the same entry.
   *
   * Probe: keying both `set` and `get` back on `record.logicalId` reds this case
   * on the FIRST row's plaintext while the second stays clean — the asymmetry is
   * the defect's signature, so the case asserts both rows rather than a count.
   */
  const dupRows = [
    {
      logicalId: 'Dup',
      orphanedAt: 1,
      state: {
        physicalId: 'live-one',
        resourceType: 'AWS::SQS::Queue',
        properties: { Password: ROW_ONLY_EXPR },
        attributes: { CachedPassword: ROW_ONLY_PLAINTEXT },
      },
    },
    {
      logicalId: 'Dup',
      orphanedAt: 2,
      state: {
        physicalId: 'live-two',
        resourceType: 'AWS::SQS::Queue',
        properties: { Token: OTHER_EXPR },
        attributes: { CachedToken: OTHER_PLAINTEXT },
      },
    },
  ];

  it('redacts BOTH rows — neither row loses its needles to the other', async () => {
    const h = await scrub(record(dupRows), false);
    expect(h.result, `refused usable duplicate rows: ${String(h.result)}`).not.toBeInstanceOf(Error);
    expect(h.saveState, 'the run never saved, so it pins nothing').toHaveBeenCalled();
    const saved = h.saved?.orphans as unknown as Array<{
      state: { attributes: Record<string, unknown> };
    }>;
    expect(saved, 'a row was dropped from the saved record').toHaveLength(2);
    // Row ONE is the one the id key lost. Its plaintext must be gone and the
    // expression must be what replaced it — "not the plaintext" alone would also
    // pass for a row rewritten to something useless.
    expect(saved[0]!.state.attributes['CachedPassword']).toBe(ROW_ONLY_EXPR);
    // Row TWO, which was clean even with the defect present: asserting it is what
    // makes the first assertion a statement about the KEY rather than about
    // orphan redaction in general.
    expect(saved[1]!.state.attributes['CachedToken']).toBe(OTHER_EXPR);
    // And no plaintext anywhere in what was written.
    expect(JSON.stringify(h.saved)).not.toContain(ROW_ONLY_PLAINTEXT);
    expect(JSON.stringify(h.saved)).not.toContain(OTHER_PLAINTEXT);
  });

  it("each row keeps its OWN expression when the two rows' secrets COLLIDE", async () => {
    // The `get` half of the key, which the case above cannot reach: with distinct
    // plaintexts the union carries both rows' needles, so reading the map back by
    // `logicalId` still redacted each row correctly. Here both rows resolve the
    // SAME plaintext through DIFFERENT expressions, so the union holds one entry
    // for it and the per-row lookup is the only thing that can give row one its
    // own expression back.
    //
    // A wrong expression is not a cosmetic defect: `state.outputs` and a record's
    // properties are re-resolved by later commands, so a row rewritten to another
    // reference's expression resolves to whatever THAT reference holds after a
    // rotation — a silently wrong value, from a run that reported success.
    const colliding = [
      {
        logicalId: 'Dup',
        orphanedAt: 1,
        state: {
          physicalId: 'live-one',
          resourceType: 'AWS::SQS::Queue',
          properties: { Key: ROW_ONLY_EXPR },
          attributes: { CachedKey: ROW_ONLY_PLAINTEXT },
        },
      },
      {
        logicalId: 'Dup',
        orphanedAt: 2,
        state: {
          physicalId: 'live-two',
          resourceType: 'AWS::SQS::Queue',
          properties: { Key: COLLIDING_EXPR },
          attributes: { CachedKey: ROW_ONLY_PLAINTEXT },
        },
      },
    ];
    const h = await scrub(record(colliding), false);
    expect(h.result, `refused colliding rows: ${String(h.result)}`).not.toBeInstanceOf(Error);
    const saved = h.saved?.orphans as unknown as Array<{
      state: { attributes: Record<string, unknown> };
    }>;
    expect(saved).toHaveLength(2);
    // Each row's own expression, not the other's. Reading the map back by
    // `logicalId` gives BOTH rows the second expression, which is what this pins.
    expect(saved[0]!.state.attributes['CachedKey']).toBe(ROW_ONLY_EXPR);
    expect(saved[1]!.state.attributes['CachedKey']).toBe(COLLIDING_EXPR);
    expect(JSON.stringify(h.saved)).not.toContain(ROW_ONLY_PLAINTEXT);
  });
});
