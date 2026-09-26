import { describe, it, expect, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return {
    ...actual,
    withRetry: (
      fn: Parameters<typeof actual.withRetry>[0],
      logicalId: string,
      opts: Parameters<typeof actual.withRetry>[2] = {}
    ) => actual.withRetry(fn, logicalId, { ...opts, sleep: async () => {} }),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: vi.fn() }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

/**
 * Issue [#3092](https://github.com/go-to-k/cdkd/issues/3092): every line this
 * executor logs about an operation names the operation's `logicalId` /
 * `resourceType` / `changeType`, and those come from `rollback-journal.json` —
 * a sibling of `state.json` in the same bucket, writable by anyone with
 * `s3:PutObject`, validated no more than an unchecked cast. cdkd's output is
 * line-oriented, so an injected newline invents a line that reads like one of
 * the executor's own. The executor runs under `cdkd rollback` AND under the
 * deploy engine's automatic rollback, so these lines print on every failed
 * deploy.
 *
 * Two dimensions per site, as go-to-k/cdkd#3072 established one layer up. The
 * HOLE is the guard dropped; the CLASS is `asciiOnly` swapped for the denylist,
 * which still removes a newline but leaves the invisible formatters — so every
 * hostile value carries a zero-width space, since a control byte is in BOTH
 * classes and discriminates neither. A third arm is the SAME-LINE spoof no
 * allowlist can see — an all-ASCII id carrying the line's own annotation
 * wording — answered by `displayIdent`'s boundary quoting, and a fourth the
 * length cap; both have a case here and a direct one in
 * `tests/unit/utils/display-safe.test.ts`.
 *
 * What is deliberately NOT asserted sanitized: the `reason` strings handed to
 * `ctx.recordEvent`. Those are PERSISTED raw into `deployments/*.jsonl` and
 * `cdkd events` sanitizes them at render (`events.ts`); sanitizing them here
 * would put a display transform on a stored value. Two cases pin that they
 * stay raw, so a future "helpful" wrap is caught rather than absorbed.
 */

const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const INVISIBLE = /[\u200b-\u200f\ufeff]/;

// A forged line that reads exactly like one of the executor's own.
const FORGED_ID = 'Vic\u200btim\n  Rollback: Deleting created resource RealDB (AWS::RDS::DBInstance)';
const FORGED_TYPE = 'AWS::S3::Buc\u200bket\n  Rollback: RealDB deleted successfully';
const FORGED_CHANGE = 'CRE\u200bATE\n  Rollback: forged change type';
const FORGED_PHYS = 'phys-old\n  Rollback: RealDB deleted successfully';

const forgedLines = (lines: string[]): string[] =>
  lines.join('\n').split('\n').filter((l) => /^\s*Rollback: (Deleting created resource RealDB|RealDB deleted|forged change)/.test(l));

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: 'AWS::S3::Bucket',
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(provider: { update?: unknown; create?: unknown; delete?: unknown }): {
  ctx: RollbackExecutorContext;
  lines: string[];
  events: Array<Omit<DeploymentEvent, 'timestamp'>>;
} {
  const lines: string[] = [];
  const events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
  const push = (m: string): void => {
    lines.push(m);
  };
  const logger = {
    debug: push,
    info: push,
    warn: push,
    error: push,
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  return {
    lines,
    events,
    ctx: {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: (e) => events.push(e),
    },
  };
}

/**
 * The statement enclosing line `i` of `lines`, with comment lines removed.
 *
 * Comment lines are TRANSPARENT: skipped on the walk back to the opener and
 * dropped from the returned text. Two earlier shapes were each defeated by a
 * comment, measured by review: walking raw lines let a `// reason:` comment
 * above an un-wrapped render satisfy the event-reason test, and BLANKING
 * comment lines made one inside a multi-line `logger.info(` read as the blank
 * line that ends a statement, so the opener was never reached.
 *
 * Known limitation: a block comment whose continuation lines do not start
 * with `*` is walked as code, so a boundary line inside one (blank, or ending
 * in `;` / `{` / `}`) still cuts the walk. The executor has no such comment (every block-comment
 * line starts with `*`), and the lines the fences guard also have runtime
 * cases; a new render hidden that way would be caught by neither fence.
 */
function statementAround(lines: readonly string[], i: number): string {
  const isComment = (l: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(l);
  const isBoundary = (l: string): boolean => /(;|\{|\}|^\s*$)\s*$/.test(l);
  let j = i;
  while (j > 0) {
    const prev = lines[j - 1]!;
    if (isComment(prev)) {
      j--;
      continue;
    }
    if (isBoundary(prev)) break;
    j--;
  }
  return lines
    .slice(j, i + 1)
    .filter((l) => !isComment(l))
    .join('\n');
}

/** Every line that names the operation, across all four levels. */
const opLines = (lines: string[]): string[] =>
  lines.filter((l) => l.includes('Vic') || l.includes('Buc') || l.includes('CRE'));

function expectClean(lines: string[]): void {
  expect(forgedLines(lines)).toEqual([]);
  const named = opLines(lines);
  expect(named.length).toBeGreaterThan(0);
  for (const l of named) {
    expect(l).not.toMatch(CTRL);
    expect(l).not.toMatch(INVISIBLE);
  }
  // Removed, not censored: the operator still sees what the journal claimed.
  expect(named.some((l) => l.includes('Vic tim'))).toBe(true);
}

describe('rollback-executor logs cannot forge a line from a planted journal (#3092)', () => {
  it('the completed-CREATE delete path', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, lines } = makeCtx({ delete: del });
    const ops: CompletedOperation[] = [
      { logicalId: FORGED_ID, changeType: 'CREATE', resourceType: FORGED_TYPE, physicalId: 'phys' },
    ];
    const state = { [FORGED_ID]: res({ resourceType: FORGED_TYPE }) };

    await replayRollback(ops, state, 'S', ctx);

    expect(del).toHaveBeenCalledTimes(1);
    // The provider is called with the RAW id and type: sanitizing is display-only.
    expect(del.mock.calls[0]![0]).toBe(FORGED_ID);
    expectClean(lines);
    expect(lines.some((l) => /Deleting created resource "Vic tim/.test(l))).toBe(true);
    expect(lines.some((l) => /Vic tim .*deleted successfully/.test(l))).toBe(true);
  });

  it('the three SKIP paths (already reverted / physical id changed / absent)', async () => {
    const { ctx, lines } = makeCtx({});
    const ops: CompletedOperation[] = [
      // already reverted: UPDATE whose state already holds the previous state
      {
        logicalId: FORGED_ID,
        changeType: 'UPDATE',
        resourceType: FORGED_TYPE,
        physicalId: 'phys',
        previousState: res({ resourceType: FORGED_TYPE, physicalId: 'phys', properties: { a: 1 } }),
      },
      // mismatch: state has a DIFFERENT physical id than journaled
      {
        logicalId: `${FORGED_ID}-2`,
        changeType: 'UPDATE',
        resourceType: FORGED_TYPE,
        physicalId: 'phys-journaled',
        previousState: res({ resourceType: FORGED_TYPE, physicalId: 'phys-old', properties: { a: 1 } }),
      },
      // absent: not in state at all
      { logicalId: `${FORGED_ID}-3`, changeType: 'UPDATE', resourceType: FORGED_TYPE, physicalId: 'phys' },
    ];
    const state = {
      [FORGED_ID]: res({ resourceType: FORGED_TYPE, physicalId: 'phys', properties: { a: 1 } }),
      [`${FORGED_ID}-2`]: res({ resourceType: FORGED_TYPE, physicalId: 'phys-live' }),
    };

    await replayRollback(ops, state, 'S', ctx);

    expectClean(lines);
    expect(lines.some((l) => /already reverted/.test(l))).toBe(true);
    expect(lines.some((l) => /physical id changed/.test(l))).toBe(true);
    expect(lines.some((l) => /no longer in state/.test(l))).toBe(true);
  });

  it('the UPDATE revert path', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys' });
    const { ctx, lines } = makeCtx({ update });
    const ops: CompletedOperation[] = [
      {
        logicalId: FORGED_ID,
        changeType: 'UPDATE',
        resourceType: FORGED_TYPE,
        physicalId: 'phys',
        previousState: res({ resourceType: FORGED_TYPE, physicalId: 'phys', properties: { a: 1 } }),
      },
    ];
    const state = { [FORGED_ID]: res({ resourceType: FORGED_TYPE, physicalId: 'phys', properties: { a: 2 } }) };

    await replayRollback(ops, state, 'S', ctx);

    expect(update).toHaveBeenCalledTimes(1);
    expectClean(lines);
    expect(lines.some((l) => /Restoring "Vic tim/.test(l))).toBe(true);
  });

  it('the --orphan path', async () => {
    const { ctx, lines } = makeCtx({});
    const ops: CompletedOperation[] = [
      { logicalId: FORGED_ID, changeType: 'CREATE', resourceType: FORGED_TYPE, physicalId: 'phys' },
    ];
    const state = { [FORGED_ID]: res({ resourceType: FORGED_TYPE }) };

    await replayRollback(ops, state, 'S', ctx, { orphanLogicalIds: new Set([FORGED_ID]) });

    expectClean(lines);
    expect(lines.some((l) => /Orphaning created resource "Vic tim/.test(l))).toBe(true);
  });

  it('the failed-op paths under --revert-failed (force-revert, delete-failed-create, skip-failed-noop)', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys' });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, lines } = makeCtx({ update, delete: del });
    const failed: FailedOperation[] = [
      {
        logicalId: FORGED_ID,
        changeType: 'UPDATE',
        resourceType: FORGED_TYPE,
        physicalId: 'phys',
        previousState: res({ resourceType: FORGED_TYPE, physicalId: 'phys', properties: { a: 1 } }),
        attemptedProperties: { a: 2 },
      },
      {
        logicalId: `${FORGED_ID}-2`,
        changeType: 'CREATE',
        resourceType: FORGED_TYPE,
        physicalId: 'phys-2',
        attemptedProperties: {},
      },
      // failed CREATE with no physical id recorded
      // A failed DELETE classifies `skip-failed-noop`, the one failed-op arm
      // that renders `changeType`. A HOSTILE changeType cannot reach it: the
      // classifier routes on the literal, and an unknown one lands on the
      // UPDATE arm, which does not render the field. The hostile changeType is
      // driven through the catch line in the free-form case below instead.
      {
        logicalId: `${FORGED_ID}-3`,
        changeType: 'DELETE',
        resourceType: FORGED_TYPE,
        physicalId: 'phys-3',
        attemptedProperties: {},
      },
    ];
    const state = {
      [FORGED_ID]: res({ resourceType: FORGED_TYPE, physicalId: 'phys', properties: { a: 1 } }),
      [`${FORGED_ID}-2`]: res({ resourceType: FORGED_TYPE, physicalId: 'phys-2' }),
    };

    await replayFailedOperations(failed, state, 'S', ctx);

    expectClean(lines);
    expect(lines.some((l) => /force-reverting failed UPDATE of "Vic tim/.test(l))).toBe(true);
    expect(lines.some((l) => /deleting partially-created "Vic tim/.test(l))).toBe(true);
    expect(lines.some((l) => /failed DELETE of "Vic tim/.test(l))).toBe(true);
  });

  it('the catch line: a hostile changeType is flattened and the provider error takes the DENYLIST', async () => {
    // The only arm a HOSTILE changeType can reach: `classifyRollbackOp` routes
    // an unknown literal to `revert` when a previous state exists, the provider
    // throws, and the catch renders `(${changeType})` beside the SDK message.
    // The message is free prose, so it takes the denylist -- the newline goes
    // and an accented character SURVIVES, which is what makes `asciiOnly` the
    // wrong class for it.
    const update = vi.fn().mockRejectedValue(
      new Error('AccessDenied for caf\u00e9\n  Rollback: RealDB deleted successfully')
    );
    const { ctx, lines } = makeCtx({ update });
    const ops: CompletedOperation[] = [
      // The journal is an unchecked cast, so a hostile changeType is reachable
      // at runtime; it is not expressible in the union type, hence the cast.
      {
        logicalId: 'D',
        changeType: FORGED_CHANGE,
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys',
        previousState: res({ physicalId: 'phys', properties: { a: 1 } }),
      } as unknown as CompletedOperation,
    ];
    const state = { D: res({ physicalId: 'phys', properties: { a: 2 } }) };

    await replayRollback(ops, state, 'S', ctx);

    expect(update).toHaveBeenCalledTimes(1);
    const failLine = lines.find((l) => l.includes('Rollback failed for D'));
    expect(failLine).toBeDefined();
    expect(failLine!.split('\n')).toHaveLength(1);
    expect(failLine).not.toMatch(INVISIBLE);
    // The forged tail stays INSIDE the parentheses, flattened onto the same line.
    expect(failLine).toContain('("CRE ATE   Rollback: forged change type")');
    expect(failLine).toContain('caf\u00e9');
    expect(forgedLines(lines)).toEqual([]);
  });

  it('an id that sanitizes to NOTHING renders the placeholder, not an empty slot', async () => {
    // `logicalId: '\u200b'` is all invisibles. Without `|| UNRENDERABLE` the
    // line reads `Rollback:  already reverted` -- the id shown as ABSENT while
    // the replay keyed on the raw value. Same fallback as every twin predicate.
    const { ctx, lines } = makeCtx({});
    const ops: CompletedOperation[] = [
      {
        logicalId: '\u200b',
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys',
        previousState: res({ physicalId: 'phys', properties: { a: 1 } }),
      },
    ];
    const state = { '\u200b': res({ physicalId: 'phys', properties: { a: 1 } }) };

    await replayRollback(ops, state, 'S', ctx);

    expect(lines.some((l) => l.includes('<unrenderable> already reverted'))).toBe(true);
  });

  it('the event RECORD keeps the raw value: it is persisted, and `cdkd events` sanitizes at render', async () => {
    const { ctx, events } = makeCtx({});
    const ops: CompletedOperation[] = [
      { logicalId: FORGED_ID, changeType: 'CREATE', resourceType: FORGED_TYPE, physicalId: 'phys' },
    ];
    const state = { [FORGED_ID]: res({ resourceType: FORGED_TYPE }) };

    await replayRollback(ops, state, 'S', ctx, { orphanLogicalIds: new Set([FORGED_ID]) });

    const orphanEvent = events.find((e) => 'reason' in e && typeof e.reason === 'string');
    expect(orphanEvent).toBeDefined();
    // Sanitizing this would put a display transform on a stored value and
    // double it on the way out (`events.ts` runs `safeText` over it).
    expect((orphanEvent as { reason: string }).reason).toContain(FORGED_ID);
  });

  it('an all-ASCII id cannot plant the line\'s own annotation wording -- its boundary is quoted', async () => {
    // The same-line spoof the allowlist cannot see: no newline, no invisible,
    // just cdkd's own wording inside the value. `displayIdent` quotes a value
    // that is not a plain identifier, so the executor's line reads
    // `Rollback: "X (AWS::RDS::DBInstance) -- already reverted" already
    // reverted, skipping` and the reader can see where the id ends.
    const spoof = 'X (AWS::RDS::DBInstance) -- already reverted';
    const { ctx, lines } = makeCtx({});
    const ops: CompletedOperation[] = [
      {
        logicalId: spoof,
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys',
        previousState: res({ physicalId: 'phys', properties: { a: 1 } }),
      },
    ];
    const state = { [spoof]: res({ physicalId: 'phys', properties: { a: 1 } }) };

    await replayRollback(ops, state, 'S', ctx);

    const line = lines.find((l) => l.includes('already reverted'));
    expect(line).toBeDefined();
    expect(line).toContain(`Rollback: "${spoof}" already reverted, skipping`);
    // A legitimate id on the same arm renders exactly as before -- the quoting
    // is conditional, so no existing line, pin or fixture grep moves.
    const { ctx: ctx2, lines: lines2 } = makeCtx({});
    await replayRollback(
      [{ ...ops[0]!, logicalId: 'Plain' }],
      { Plain: res({ physicalId: 'phys', properties: { a: 1 } }) },
      'S',
      ctx2
    );
    expect(lines2.some((l) => l.includes('Rollback: Plain already reverted, skipping'))).toBe(true);
  });

  it('a value past the identifier cap is cut, and the cut is named', async () => {
    const long = 'B'.repeat(300);
    const { ctx, lines } = makeCtx({});
    const ops: CompletedOperation[] = [
      {
        logicalId: long,
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys',
        previousState: res({ physicalId: 'phys', properties: { a: 1 } }),
      },
    ];

    await replayRollback(ops, { [long]: res({ physicalId: 'phys', properties: { a: 1 } }) }, 'S', ctx);

    const line = lines.find((l) => l.includes('already reverted'));
    expect(line).toBeDefined();
    expect(line).not.toContain(long);
    expect(line).toContain(`Rollback: ${'B'.repeat(255)} [cut: 45 more characters withheld] already reverted`);
  });

  it('the #3203 refusal messages: the logicalId reaches them as a helper PARAMETER too', async () => {
    // `requireRestorableBaseline` renders `${safe(logicalId)}` from its own
    // PARAMETER, so the source fence below -- which matches `${op.<field>}` --
    // cannot see it, and dropping `safe(` from it was measured 0 red across
    // `tests/unit/`. Same structural gap as the readopt case above, on a newer
    // helper; the planted-journal threat model (go-to-k/cdkd#3092) reaches both
    // of these arms, so the render is exercised rather than pattern-matched.
    //
    // Both halves, because they render independently: the SKIP warn (absent
    // bag) and the THROW (present but unusable).
    const { ctx: skipCtx, lines: skipLines } = makeCtx({ update: vi.fn() });
    await replayRollback(
      [
        {
          logicalId: FORGED_ID,
          changeType: 'UPDATE',
          resourceType: FORGED_TYPE,
          physicalId: 'phys',
          previousState: (() => {
            const { properties: _dropped, ...rest } = res({ resourceType: FORGED_TYPE, physicalId: 'phys' });
            return rest as ResourceState;
          })(),
        },
      ],
      { [FORGED_ID]: res({ resourceType: FORGED_TYPE, physicalId: 'phys', properties: { a: 1 } }) },
      'S',
      skipCtx
    );
    const skipWarn = skipLines.find((l) => l.includes('has no `properties` bag'));
    expect(skipWarn).toBeDefined();
    expect(skipWarn!.split('\n')).toHaveLength(1);
    expect(skipWarn).not.toMatch(INVISIBLE);
    expect(forgedLines(skipLines)).toEqual([]);
    // The BOUNDARY, not just the class. Single-line + no-INVISIBLE + no forged
    // line all still pass under `displaySafe(id, { asciiOnly: true })`, which
    // is `displayIdent` minus the 255-codepoint cap, minus `UNRENDERABLE` and
    // minus the quoting -- measured 0 red. Only `displayIdent` QUOTES a
    // non-plain id, and the quote is what keeps a same-line spoof from reading
    // as cdkd's own annotation.
    expect(skipWarn).toContain('"Vic tim');

    const { ctx: throwCtx, lines: throwLines } = makeCtx({ update: vi.fn() });
    const throwResult = await replayRollback(
      [
        {
          logicalId: FORGED_ID,
          changeType: 'UPDATE',
          resourceType: FORGED_TYPE,
          physicalId: 'phys',
          previousState: { ...res({ resourceType: FORGED_TYPE, physicalId: 'phys' }), properties: 'abc' } as unknown as ResourceState,
        },
      ],
      { [FORGED_ID]: res({ resourceType: FORGED_TYPE, physicalId: 'phys', properties: { a: 1 } }) },
      'S',
      throwCtx
    );
    expect(throwResult.failures).toBe(1);
    const throwLine = throwLines.find((l) => l.includes('not a property bag'));
    expect(throwLine).toBeDefined();
    expect(throwLine!.split('\n')).toHaveLength(1);
    expect(throwLine).not.toMatch(INVISIBLE);
    expect(forgedLines(throwLines)).toEqual([]);
    // Same boundary on the throw render, which is a separate interpolation.
    expect(throwLine).toContain('"Vic tim');
  });

  it('the readopt-Retain WARN: a field passed through a helper PARAMETER is still sanitized', async () => {
    // The first round's population was every `${op.<field>}` interpolation --
    // and this line escaped it, because `retainedSurvivorMessages()` receives
    // the fields as PARAMETERS and renders them as `${logicalId}`. Reached with
    // no AWS call: a replacement op whose old resource the engine retained,
    // pointing at a state record that carries `UpdateReplacePolicy: Retain`
    // (CDK's default for stateful L2s), so the readopt arm keeps the new
    // resource too and warns about it.
    const { ctx, lines, events } = makeCtx({});
    const ops: CompletedOperation[] = [
      {
        logicalId: FORGED_ID,
        changeType: 'UPDATE',
        resourceType: FORGED_TYPE,
        physicalId: 'phys-new',
        // `prev = op.previousState` -- the alias the first round missed. Its
        // physical id reaches the arm's info line and the warn's stateClause.
        previousState: res({ resourceType: FORGED_TYPE, physicalId: FORGED_PHYS, properties: { a: 1 } }),
        oldResourceRetained: true,
      },
    ];
    const state = {
      [FORGED_ID]: res({ resourceType: FORGED_TYPE,
        physicalId: 'phys-new',
        properties: { a: 2 },
        updateReplacePolicy: 'Retain',
      }),
    };

    await replayRollback(ops, state, 'S', ctx);

    const info = lines.find((l) => l.includes('re-adopting the retained old one'));
    expect(info).toBeDefined();
    expect(info!.split('\n')).toHaveLength(1);
    expect(info).toContain('re-adopting the retained old one (phys-old');
    const warn = lines.find((l) => l.includes('has UpdateReplacePolicy: Retain'));
    expect(warn).toBeDefined();
    expect(warn!.split('\n')).toHaveLength(1);
    expect(warn).toContain('restored to the old resource (phys-old');
    expect(warn).not.toMatch(INVISIBLE);
    expect(warn).toContain('Vic tim');
    expect(forgedLines(lines)).toEqual([]);
    // The helper's REASON half is the persisted twin and keeps the raw value.
    const ev = events.find((e) => 'reason' in e && typeof e.reason === 'string');
    expect(ev).toBeDefined();
    expect((ev as { reason: string }).reason).toContain(FORGED_TYPE);
  });

  it('the orphan-retain event RECORD keeps the raw value too', async () => {
    // The second of the three event-bound `reason` strings (the `--orphan`
    // one is pinned above; the reverse-replacement `survivorReason` needs a
    // failed delete of the new resource and is covered by the source-shape
    // count below). `DeletionPolicy: Retain` on a rolled-back CREATE orphans
    // the resource instead of deleting it.
    const { ctx, events } = makeCtx({});
    const ops: CompletedOperation[] = [
      { logicalId: FORGED_ID, changeType: 'CREATE', resourceType: FORGED_TYPE, physicalId: 'phys' },
    ];
    const state = { [FORGED_ID]: res({ resourceType: FORGED_TYPE, deletionPolicy: 'Retain' }) };

    await replayRollback(ops, state, 'S', ctx);

    const ev = events.find((e) => 'reason' in e && typeof e.reason === 'string');
    expect(ev).toBeDefined();
    expect((ev as { reason: string }).reason).toContain(FORGED_ID);
  });

  it('the pasted `--orphan` remedy is WITHHELD when sanitizing would change the id', async () => {
    // `safe()` trims, so `\u200bRealDB` and `RealDB` render identically -- and
    // this is a command the user is invited to paste. Two ops: a legitimate
    // `RealDB` and a hostile id that differs from it only by a leading
    // zero-width space. The remedy for the hostile one must not print an id
    // that pastes as the legitimate resource. Reached through the
    // name-collision refusal of a reverse-replacement.
    const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists'));
    const { ctx, lines } = makeCtx({ create, delete: vi.fn().mockResolvedValue(undefined) });
    const hostile = '\u200bRealDB';
    // The same message renders the OLD physical id, also journal-sourced. A
    // planted one that reads as the remedy must show its boundary, or it
    // stands as a forged `--orphan RealDB` AHEAD of the guarded one.
    const forgedPhys = 'old). To leave THIS resource alone, re-run with `cdkd rollback --orphan RealDB`: x';
    const replacement = (id: string): CompletedOperation => ({
      logicalId: id,
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'phys-new',
      previousState: res({ resourceType: 'AWS::SQS::Queue', physicalId: forgedPhys, properties: { a: 1 } }),
      oldResourceRetained: false,
    });
    const state = {
      RealDB: res({ resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' }),
      [hostile]: res({ resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' }),
    };

    await replayRollback([replacement('RealDB'), replacement(hostile)], state, 'S', ctx, {
      isInterrupted: () => false,
    });

    // Strip the (JSON-quoted) planted physical id first: what is left is what
    // the executor itself said.
    const quotedPhys = JSON.stringify(forgedPhys);
    const remedies = lines.filter((l) => l.includes('cdkd rollback --orphan'));
    expect(remedies).toHaveLength(2);
    for (const l of remedies) expect(l).toContain(`(${quotedPhys}) collided`);
    const own = remedies.map((l) => l.split(quotedPhys).join(''));
    // The legitimate op prints its id; the hostile op prints the placeholder.
    expect(own.some((l) => l.includes('--orphan RealDB`'))).toBe(true);
    expect(own.some((l) => l.includes('--orphan <id>`'))).toBe(true);
    // And never the collapsed form that would paste as the legitimate resource.
    expect(own.filter((l) => l.includes('--orphan RealDB`'))).toHaveLength(1);
  });

  it('the pasted `--orphan` remedy is WITHHELD for a plain id the shell would expand', async () => {
    // `~user` and `=x` are plain identifiers -- `safe()` is the identity on
    // them -- and the user's shell expands both before cdkd sees them. The
    // paste gate is CloudFormation's own logical-id charset, not identity.
    const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists'));
    const { ctx, lines } = makeCtx({ create, delete: vi.fn().mockResolvedValue(undefined) });
    const ids = ['~RealDB', '=RealDB', 'Real-DB'];
    const ops: CompletedOperation[] = ids.map((id) => ({
      logicalId: id,
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'phys-new',
      previousState: res({ resourceType: 'AWS::SQS::Queue', physicalId: 'phys-old', properties: { a: 1 } }),
      oldResourceRetained: false,
    }));
    const state = Object.fromEntries(
      ids.map((id) => [id, res({ resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' })])
    );

    await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });

    const remedies = lines.filter((l) => l.includes('cdkd rollback --orphan'));
    expect(remedies).toHaveLength(3);
    for (const l of remedies) {
      expect(l).toContain('--orphan <id>`');
      expect(l).not.toMatch(/--orphan [~=]/);
    }
    // ...while each id still renders, unquoted, in the message's own text.
    for (const id of ids) expect(remedies.some((l) => l.includes(`replacement of ${id} (`))).toBe(true);
  });

  it('the pasted `--orphan` remedy is WITHHELD for a NON-STRING id (the gate must not coerce)', async () => {
    // `parseRollbackJournal` refuses a non-string `logicalId` (issue #3140),
    // but the deploy engine's in-process rollback reaches this executor with
    // ops it built itself, so the executor keeps its own guard. `RegExp.test`
    // coerces (`test(123)` -> "123" passes), and the property lookups coerce
    // the same way, so the op reaches the collision path with state keyed
    // `'123'` -- and the remedy would read `--orphan 123`, a command that
    // pastes but names nothing.
    const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists'));
    const { ctx, lines } = makeCtx({ create, delete: vi.fn().mockResolvedValue(undefined) });
    const ops: CompletedOperation[] = [
      {
        logicalId: 123 as unknown as string,
        changeType: 'UPDATE',
        resourceType: 'AWS::SQS::Queue',
        physicalId: 'phys-new',
        previousState: res({ resourceType: 'AWS::SQS::Queue', physicalId: 'phys-old', properties: { a: 1 } }),
        oldResourceRetained: false,
      },
    ];
    const state = { '123': res({ resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', properties: { a: 2 }, updateReplacePolicy: 'Retain' }) };

    await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });

    const remedies = lines.filter((l) => l.includes('cdkd rollback --orphan'));
    expect(remedies).toHaveLength(1);
    expect(remedies[0]).toContain('--orphan <id>`');
    expect(remedies[0]).not.toContain('--orphan 123');
  });

  it('the retry label handed to withRetry is sanitized where retry.ts renders it', async () => {
    // `withRetry(op, logicalId, ...)` is a cross-module reader: `retry.ts`
    // names the operation in its give-up summary and its per-attempt debug
    // line. Sanitized ONCE at `withRetry`'s entry, so this and every other
    // caller inherit it. Driven with the REAL `withRetry` (the mock above only
    // makes its sleeps instant) and a transient error that exhausts it. Not
    // only flattened: the label is the executor's RENDERING (`safe()`), so it
    // carries the boundary quote -- `retry.ts` keeps the bare allowlist for
    // labels that are not identifiers, and the executor does not rely on it.
    const transient = Object.assign(new Error('InternalFailure'), {
      name: 'InternalFailure',
      $metadata: { httpStatusCode: 500 },
    });
    const update = vi.fn().mockRejectedValue(transient);
    const { ctx, lines } = makeCtx({ update });
    const ops: CompletedOperation[] = [
      {
        logicalId: FORGED_ID,
        changeType: 'UPDATE',
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'phys',
        previousState: res({ physicalId: 'phys', properties: { a: 1 } }),
      },
    ];
    const state = { [FORGED_ID]: res({ physicalId: 'phys', properties: { a: 2 } }) };

    await replayRollback(ops, state, 'S', ctx);

    const retrying = lines.filter((l) => l.includes('Retrying'));
    const gaveUp = lines.find((l) => l.includes('gave up after'));
    expect(retrying.length).toBeGreaterThan(0);
    expect(gaveUp).toBeDefined();
    for (const l of [...retrying, gaveUp!]) {
      expect(l.split('\n')).toHaveLength(1);
      expect(l).not.toMatch(INVISIBLE);
      // The QUOTE is what pins the executor's half: `retry.ts`'s own allowlist
      // flattens a raw label too, so flattening alone cannot tell "the
      // executor rendered it" from "retry.ts caught it". Only `displayIdent`
      // quotes, and only the executor calls it on this path.
      expect(l).toContain('"Vic tim');
    }
  });

  it('the re-create path hands withRetry the executor\'s rendering too', async () => {
    // `createWithRollbackRetry` is the create-side twin of the update helper
    // the case above drives; round 2 wrapped only the update side (measured by
    // review). A reverse-replacement whose re-create keeps failing transiently
    // exhausts the real `withRetry`, and its retry lines must carry the quote.
    const transient = Object.assign(new Error('InternalFailure'), {
      name: 'InternalFailure',
      $metadata: { httpStatusCode: 500 },
    });
    const create = vi.fn().mockRejectedValue(transient);
    const { ctx, lines } = makeCtx({ create, delete: vi.fn().mockResolvedValue(undefined) });
    const ops: CompletedOperation[] = [
      {
        logicalId: FORGED_ID,
        changeType: 'UPDATE',
        resourceType: 'AWS::SQS::Queue',
        physicalId: 'phys-new',
        previousState: res({ resourceType: 'AWS::SQS::Queue', physicalId: 'phys-old', properties: { a: 1 } }),
        oldResourceRetained: false,
      },
    ];
    const state = { [FORGED_ID]: res({ resourceType: 'AWS::SQS::Queue', physicalId: 'phys-new', properties: { a: 2 } }) };

    await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });

    expect(create).toHaveBeenCalled();
    const retrying = lines.filter((l) => l.includes('Retrying'));
    expect(retrying.length).toBeGreaterThan(0);
    for (const l of retrying) {
      expect(l.split('\n')).toHaveLength(1);
      expect(l).toContain('"Vic tim');
    }
  });

  it('the delete-first re-create arm hands withRetry the executor\'s rendering too', async () => {
    // `createWithRollbackRetry` has TWO call sites: the create-first attempt
    // (the case above) and, after a name collision on a resource whose state
    // carries no `UpdateReplacePolicy: Retain`, the delete-new-then-re-create
    // arm. Round 3 wrapped both; only the first had a case (measured: the
    // second site's mutation was 0 red). One collision, then transient
    // failures: the delete releases the name and arm 2's retry lines print.
    const transient = Object.assign(new Error('InternalFailure'), {
      name: 'InternalFailure',
      $metadata: { httpStatusCode: 500 },
    });
    const create = vi
      .fn()
      .mockRejectedValueOnce(awsSdkError('Queue already exists'))
      .mockRejectedValue(transient);
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, lines } = makeCtx({ create, delete: del });
    // The NEW resource's physical id comes from state.json -- same bucket,
    // same trust class -- and the arm's first info line names it. The journal
    // op carries the same value: the classifier routes on the two agreeing
    // (a mismatch is the `physical id changed` skip).
    const hostilePhys = 'phys-new\n  Rollback: RealDB deleted successfully';
    const ops: CompletedOperation[] = [
      {
        logicalId: FORGED_ID,
        changeType: 'UPDATE',
        resourceType: 'AWS::SQS::Queue',
        physicalId: hostilePhys,
        previousState: res({ resourceType: 'AWS::SQS::Queue', physicalId: 'phys-old', properties: { a: 1 } }),
        oldResourceRetained: false,
      },
    ];
    const state = { [FORGED_ID]: res({ resourceType: 'AWS::SQS::Queue', physicalId: hostilePhys, properties: { a: 2 } }) };

    await replayRollback(ops, state, 'S', ctx, { isInterrupted: () => false });

    // The arm was reached: the new resource was deleted -- by its RAW physical
    // id, sanitizing is display-only -- and create re-tried.
    expect(del).toHaveBeenCalledWith(FORGED_ID, hostilePhys, 'AWS::SQS::Queue', expect.anything(), expect.anything());
    expect(forgedLines(lines)).toEqual([]);
    const first = lines.find((l) => l.includes('deleting the new resource'));
    expect(first).toBeDefined();
    expect(first!.split('\n')).toHaveLength(1);
    expect(create.mock.calls.length).toBeGreaterThan(2);
    const retrying = lines.filter((l) => l.includes('Retrying'));
    expect(retrying.length).toBeGreaterThan(0);
    for (const l of retrying) {
      expect(l.split('\n')).toHaveLength(1);
      expect(l).toContain('"Vic tim');
    }
  });

  it('SOURCE SHAPE: both retry helpers render the label themselves, and their callers pass the raw id', () => {
    // The label is a bare ARGUMENT to `withRetry`, not a `${}` interpolation,
    // so the field fence above cannot see it. Each helper renders it once, so
    // a caller cannot forget; and a caller that pre-rendered it would hand a
    // quoted id to the helper, which is harmless today but would make the two
    // twins disagree about who owns the rule.
    const src = readFileSync(
      new URL('../../../src/deployment/rollback-executor.ts', import.meta.url),
      'utf8'
    );
    const helper = (name: string): string => {
      const start = src.indexOf(`async function ${name}(`);
      expect(start).toBeGreaterThan(0);
      const end = src.indexOf('\n}\n', start);
      return src.slice(start, end);
    };
    const update = helper('updateWithRollbackRetry');
    const create = helper('createWithRollbackRetry');
    // update: the single `withRetry(` takes `safe(logicalId)` as its label.
    expect(update).toMatch(/withRetry\(\s*(\/\/[^\n]*\n\s*)*\(\) =>[^]*?\),\s*(\/\/[^\n]*\n\s*)*safe\(logicalId\),/);
    expect(update).not.toMatch(/\n\s*logicalId,\n/);
    // create: rendered once into `shownId`, and BOTH loops take it.
    expect(create).toContain('const shownId = safe(logicalId);');
    expect((create.match(/\bshownId\b/g) ?? []).length).toBe(3);
    expect(create).not.toMatch(/withRetry\(create, logicalId/);
    expect(create).not.toMatch(/\n\s*logicalId,\n/);
    // callers: the raw id (the third argument), never a pre-rendered one.
    const lineStart = (at: number): string => src.slice(src.lastIndexOf('\n', at - 1) + 1, at);
    const calls = [...src.matchAll(/\b(create|update)WithRollbackRetry\(/g)].filter(
      (m) =>
        !/function\s*$/.test(src.slice(Math.max(0, m.index! - 20), m.index!)) &&
        // a comment spelling the call (with its paren) is not a call site
        !/^\s*(\/\/|\*|\/\*)/.test(lineStart(m.index!))
    );
    expect(calls).toHaveLength(4);
    for (const m of calls) {
      let depth = 1;
      let k = m.index! + m[0].length;
      const argStart = k;
      while (depth > 0 && k < src.length) {
        const c = src[k]!;
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        k++;
      }
      const body = src
        .slice(argStart, k - 1)
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
      const args: string[] = [];
      let d = 0;
      let cur = '';
      for (const c of body) {
        if (c === '(' || c === '[' || c === '{') d++;
        else if (c === ')' || c === ']' || c === '}') d--;
        if (c === ',' && d === 0) {
          args.push(cur);
          cur = '';
        } else cur += c;
      }
      args.push(cur);
      expect(args[2]!.trim()).toBe('op.logicalId');
    }
  });

  it('SOURCE SHAPE: every free-form error render takes displaySafe()', () => {
    // The static twin of the two free-form cases: every `<x>.message :
    // String(<x>)` interpolation in the executor must be wrapped, so the
    // three reverse-replacement sites no unit case drives (a re-create
    // failure, a delete-new failure, the collision `msg`) are pinned by shape.
    const src = readFileSync(
      new URL('../../../src/deployment/rollback-executor.ts', import.meta.url),
      'utf8'
    );
    const lines = src.split('\n');
    const free = /\$\{(\w+) instanceof Error \? \1\.message : String\(\1\)\}/;
    // The single exception is the `survivorReason` string, which is PERSISTED
    // (an event) -- its render happens in `cdkd events`.
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!free.test(line)) return;
      if (!/\bsurvivorReason\s*=/.test(statementAround(lines, i))) {
        offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders).toEqual([]);
    const wrapped = /\$\{displaySafe\((\w+) instanceof Error \? \1\.message : String\(\1\)\)\}/g;
    // recreateError, deleteError (warn), rollbackError, revertError -- and the
    // fence proves it read the file.
    expect((src.match(wrapped) ?? []).length).toBe(4);
    // `msg` used to be classified RAW and rendered wrapped. Since issue #3208
    // it is not classified at all: the collision decision moved to the ERROR
    // (`isNameCollisionErrorFrom` walks the cause chain for an exception NAME,
    // which a rendered message cannot carry), leaving the wrapped render as
    // `msg`'s ONLY use. That is strictly safer for this file's subject, so all
    // three halves are pinned — the absence too, so a revert to classifying the
    // rendered text cannot pass quietly.
    expect(src).toContain('isNameCollisionErrorFrom(createError, op.logicalId)');
    expect(src).not.toContain('isNameCollisionError(msg)');
    expect(src).toContain('displaySafe(msg)');
    expect(src).toContain('${displaySafe(msg)}');
  });

  it('a forged OLD type (issue #2668) cannot forge a line through the Type-change renders', async () => {
    // `previousResourceType` / `previousState.resourceType` are journal-sourced
    // like every other field here, and the parser accepts any string. The
    // renders that carry them interpolate LOCALS (`oldType`, `stamped`,
    // `recorded`), which the SOURCE SHAPE fence below cannot see — it matches
    // `${op.<field>}` only — so they need runtime cases.
    const FORGED_OLD_TYPE = 'AWS::SSM::Para\u200bmeter\n  Rollback: RealDB deleted successfully';
    const typeChangeOp = (overrides: Partial<CompletedOperation> = {}): CompletedOperation => ({
      logicalId: 'Victim',
      changeType: 'UPDATE',
      resourceType: 'AWS::SNS::Topic',
      physicalId: 'phys-new',
      previousResourceType: FORGED_OLD_TYPE,
      previousState: res({
        resourceType: FORGED_OLD_TYPE,
        physicalId: 'phys-old',
        properties: { a: 1 },
      }),
      ...overrides,
    });
    const newState = (): Record<string, ResourceState> => ({
      Victim: res({ resourceType: 'AWS::SNS::Topic', physicalId: 'phys-new' }),
    });
    const assertNoForgery = (lines: string[], mustMention: RegExp): void => {
      expect(forgedLines(lines)).toEqual([]);
      const named = lines.filter((l) => mustMention.test(l));
      expect(named.length).toBeGreaterThan(0);
      for (const l of named) {
        expect(l.split('\n')).toHaveLength(1);
        expect(l).not.toMatch(INVISIBLE);
      }
    };

    // The "Reversing replacement ... (NEW -> OLD)" info line, create-first arm.
    const create = vi.fn().mockResolvedValue({ physicalId: 'phys-recreated', attributes: {} });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, lines } = makeCtx({ create, delete: del });
    await replayRollback([typeChangeOp()], newState(), 'S', ctx);
    assertNoForgery(lines, /Reversing replacement of Victim/);

    // The delete-new-first note, which renders both types.
    const collide = vi
      .fn()
      .mockRejectedValueOnce(awsSdkError('CREATE failed for Victim: Resource already exists.'))
      .mockResolvedValue({ physicalId: 'phys-recreated', attributes: {} });
    const { ctx: ctx2, lines: lines2 } = makeCtx({ create: collide, delete: del });
    await replayRollback([typeChangeOp()], newState(), 'S', ctx2);
    assertNoForgery(lines2, /re-create collided with the new resource's name/);

    // The unroutable refusal's "two different types" reason renders BOTH
    // journal sources.
    const { ctx: ctx3, lines: lines3 } = makeCtx({ create, delete: del });
    const refused = await replayRollback(
      [typeChangeOp({ previousResourceType: `${FORGED_OLD_TYPE}-other` })],
      newState(),
      'S',
      ctx3
    );
    expect(refused.failures).toBe(1);
    assertNoForgery(lines3, /two different types/);
  });

  it('SOURCE SHAPE: a bare journal-field interpolation exists only in an event-bound statement', () => {
    // The per-arm wiring fence, as in go-to-k/cdkd#3072. `safe()` is pinned by
    // the cases above, but ~50 sites wire it separately and a hostile fixture
    // reaches only the arms its classification lands on. Reading the source
    // closes the rest: every bare `${op.logicalId}` / `${op.resourceType}` /
    // `${op.changeType}` must sit inside a statement that builds an event
    // `reason` (persisted raw by design, see the cases above). Anything else is
    // a rendered journal field that escaped the predicate.
    //
    // Comment lines are transparent to the walk (`statementAround`), so a
    // `// reason: ...` comment can neither satisfy nor cut it. The
    // `previewState[op.logicalId]`-style bracket access is not `${...}` and is
    // correctly not matched.
    const src = readFileSync(
      new URL('../../../src/deployment/rollback-executor.ts', import.meta.url),
      'utf8'
    );
    const lines = src.split('\n');
    const bare = /\$\{op\.(?:logicalId|resourceType|changeType)\}/g;
    const offenders: string[] = [];
    let bareCount = 0;
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const n = (line.match(bare) ?? []).length;
      if (n === 0) return;
      bareCount += n;
      const stmt = statementAround(lines, i);
      if (/^\s*reason:|\bsurvivorReason\s*=/m.test(stmt)) return;
      // The one rendered bare id: the pasted `--orphan` remedy, printed only
      // when the id IS a CloudFormation logical id (the case above drives both
      // arms). The guard must sit in the same statement, on the id itself.
      if (
        /\$\{op\.logicalId\}/.test(line) &&
        n === 1 &&
        /typeof op\.logicalId === 'string' && PASTEABLE_LOGICAL_ID\.test\(op\.logicalId\)\s*\?/.test(
          stmt
        )
      )
        return;
      offenders.push(`${i + 1}: ${line.trim()}`);
    });

    expect(offenders).toEqual([]);
    // Exactly the three event statements -- `--orphan` (2 fields), `orphan-
    // retain` (2 fields), `survivorReason` (1 field) -- plus the TWO guarded
    // remedies (1 each: the Retain collision refusal, and the unroutable-
    // replacement refusal of go-to-k/cdkd#2668). An eighth is a new render that
    // escaped; a sixth is one of these being sanitized -- both wrong.
    expect(bareCount).toBe(7);
    // The fence sees its input: the wrapped form must be present in numbers.
    expect((src.match(/\$\{safe\(op\.(?:logicalId|resourceType|changeType)\)\}/g) ?? []).length)
      .toBeGreaterThan(40);
  });

  it('SOURCE SHAPE: the aliases the first round missed are wrapped', () => {
    // `prev = op.previousState`: its `physicalId` is journal-sourced, and
    // `current = stateResources[op.logicalId]` is state.json-sourced -- same
    // bucket, same `s3:PutObject`, same trust class. On a LOG line either must
    // be wrapped (free-form, so `displaySafe`); inside a throw it reaches the
    // catch's denylist render (the collision message, which carries the pasted
    // remedy, takes `safe()` for both -- pinned below), inside the
    // `stateClause` handed to `retainedSurvivorMessages` the helper wraps the
    // warn copy itself, and inside `survivorReason` it is persisted raw.
    const src = readFileSync(
      new URL('../../../src/deployment/rollback-executor.ts', import.meta.url),
      'utf8'
    );
    const lines = src.split('\n');
    const bareOnLog = lines
      .map((l, i) => [i, l] as const)
      .filter(
        ([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /\$\{(prev|current)\.physicalId\}/.test(l)
      )
      // a `logger.*(` opener means the statement is a render
      .filter(([i]) => /logger\.(info|warn|error|debug)\(/.test(statementAround(lines, i)))
      .map(([i, l]) => `${i + 1}: ${l.trim()}`);
    expect(bareOnLog).toEqual([]);
    // And the fence sees its input: the bare form exists -- the `stateClause`
    // argument to `retainedSurvivorMessages`, which wraps its warn copy itself.
    expect(lines.filter((l) => /\$\{prev\.physicalId\}/.test(l)).length).toBeGreaterThanOrEqual(1);
    // The thrown collision message -- the one carrying the pasted `--orphan`
    // remedy -- renders both physical ids with a BOUNDARY, not the denylist.
    expect(src).toContain('(${safe(prev.physicalId)}) collided with the');
    expect(src).toContain('(${safe(current.physicalId)}), and');
    // And the helper's warn half wraps its parameters.
    expect(src).toContain('`  ⚠ ${safe(logicalId)} (${safe(resourceType)}) has UpdateReplacePolicy');
  });
});
