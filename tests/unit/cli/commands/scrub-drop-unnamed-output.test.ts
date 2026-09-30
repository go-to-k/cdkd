/**
 * go-to-k/cdkd#4120: a stored output key today's template cannot NAME, whose
 * value no redaction pass rewrote, is DROPPED by the scrub that rewrites the
 * record — never left beside the `{{resolve:...}}` tokens scrub writes.
 *
 * Why it matters: a plain `ssm` token in the bag is the evidence `cdkd diff`'s
 * issue #1948 exoneration reads as "this bag is redacted", so a pre-#1901
 * plaintext left under a deleted output's key printed on its REMOVE row after
 * the user ran the `cdkd scrub` the diff recommended. The first case runs the
 * issue's repro end to end: scrub's rewrite, then `computeOutputsDiff` over the
 * bag it saved.
 *
 * The rest pins which keys may NOT be dropped (a declared key, a key a pass
 * rewrote, a value that cannot hold a plaintext, an export alias this run could
 * not reproduce) and the refusal when another stack still reads a key.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate, TemplateOutput } from '../../../../src/types/resource.js';
import { computeOutputsDiff } from '../../../../src/analyzer/outputs-diff.js';

/** A `SecureString` parameter an older binary stored in plaintext. */
const SSM_EXPR = '{{resolve:ssm:/A}}';
const SSM_PLAINTEXT = 'secure-string-plaintext-A';
const SM_EXPR = '{{resolve:secretsmanager:S}}';
const SM_PLAINTEXT = 'secrets-manager-plaintext-S';
/** A deleted output's value: a plaintext nothing in today's template resolves. */
const GONE_PLAINTEXT = 'PRE1901PLAIN';

const RESOLVES: Record<string, string> = {
  [SSM_EXPR]: SSM_PLAINTEXT,
  [SM_EXPR]: SM_PLAINTEXT,
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
            const keys = Object.keys(v as Record<string, unknown>);
            // `resolveSub` keeps an unresolvable `${Foo}` rather than throwing.
            if (keys.length === 1 && keys[0] === 'Fn::Sub') {
              return (v as Record<string, unknown>)['Fn::Sub'];
            }
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

import { scrubStack, planUnnamedOutputDrop } from '../../../../src/cli/commands/scrub.js';

const infoLines: string[] = [];
const warnLines: string[] = [];
const logger = {
  debug: vi.fn(),
  info: (...args: unknown[]) => infoLines.push(args.map(String).join(' ')),
  warn: (...args: unknown[]) => warnLines.push(args.map(String).join(' ')),
  error: vi.fn(),
};

/** The two declared outputs of the issue's repro. */
const DECLARED: Record<string, TemplateOutput> = {
  Out: { Value: SSM_EXPR },
  Sm: { Value: SM_EXPR },
};

function stackInfo(outputs: Record<string, TemplateOutput> = DECLARED): {
  stackName: string;
  template: CloudFormationTemplate;
} {
  return {
    stackName: 'Producer',
    template: {
      Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'literal' } } },
      Outputs: outputs,
    } as CloudFormationTemplate,
  };
}

function record(
  outputs: Record<string, unknown>,
  extra: Partial<StackState> = {},
  stackName = 'Producer',
  region = 'us-east-1'
): StackState {
  return {
    version: 9,
    region,
    stackName,
    resources: {
      P: { physicalId: 'p', resourceType: 'AWS::SSM::Parameter', properties: { Value: 'literal' } },
    },
    outputs,
    lastModified: 0,
    ...extra,
  } as StackState;
}

/** The issue's pre-scrub record: two declared outputs in plaintext, one deleted. */
function legacyRecord(extra: Partial<StackState> = {}): StackState {
  return record({ Out: SSM_PLAINTEXT, Sm: SM_PLAINTEXT, Gone: GONE_PLAINTEXT }, extra);
}

describe('cdkd scrub - drops an output key the template cannot name (go-to-k/cdkd#4120)', () => {
  let states: Map<string, StackState>;
  let stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    listStacks: ReturnType<typeof vi.fn>;
  };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    infoLines.length = 0;
    warnLines.length = 0;
    states = new Map();
    stateBackend = {
      getState: vi.fn().mockImplementation((stack: string, region: string) => {
        const state = states.get(`${stack}|${region}`);
        return Promise.resolve(state ? { state: structuredClone(state), etag: 'etag-1' } : null);
      }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
      listStacks: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            [...states.keys()].map((k) => ({ stackName: k.split('|')[0]!, region: k.split('|')[1]! }))
          )
        ),
    };
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
  });

  function seed(state: StackState): void {
    states.set(`${state.stackName}|${state.region}`, state);
  }

  async function scrub(
    producer: StackState,
    outputs: Record<string, TemplateOutput> = DECLARED,
    opts: { dryRun?: boolean; listStateRefs?: () => Promise<Array<{ stackName: string; region?: string }>> } = {}
  ): Promise<{
    saved: StackState | undefined;
    changed: number;
    error: unknown;
    secretBearingKeys?: number;
  }> {
    seed(producer);
    let changed = 0;
    let secretBearingKeys: number | undefined;
    let error: unknown;
    try {
      const res = await scrubStack(
        stackInfo(outputs) as never,
        'us-east-1',
        stateBackend as never,
        lockManager as never,
        {
          dryRun: opts.dryRun ?? false,
          logger: logger as never,
          ...(opts.listStateRefs && { listStateRefs: opts.listStateRefs }),
        }
      );
      changed = res.recordsChanged;
      secretBearingKeys = res.secretBearingKeys;
    } catch (err) {
      error = err;
    }
    const call = stateBackend.saveState.mock.calls.at(-1);
    return {
      saved: call ? (call[2] as StackState) : undefined,
      changed,
      error,
      ...(secretBearingKeys !== undefined && { secretBearingKeys }),
    };
  }

  const logs = (): string => [...infoLines, ...warnLines].join('\n');

  it("the issue's repro: cdkd diff no longer prints the deleted output's plaintext after scrub", async () => {
    const { saved, error } = await scrub(legacyRecord());

    expect(error).toBeUndefined();
    expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR });

    // End to end through the diff the user runs next. `desired` is what the
    // GHSA-fixed diff resolves: the expressions, not the plaintexts.
    const diff = (current: Record<string, unknown>) =>
      computeOutputsDiff(current, { Out: SSM_EXPR, Sm: SM_EXPR }, new Set(), new Set(), {
        declaredKeys: new Set(['Out', 'Sm']),
        templateHasSecretReference: true,
      });
    expect(JSON.stringify(diff(saved!.outputs))).not.toContain(GONE_PLAINTEXT);
    // CONTROL: the bag the pre-fix scrub saved (the key left as it was) prints
    // it — the defect, measured on the same diff call.
    expect(JSON.stringify(diff({ ...saved!.outputs, Gone: GONE_PLAINTEXT }))).toContain(
      GONE_PLAINTEXT
    );

    // Reported by NAME, never by value.
    expect(logs()).toContain('Dropped 1 output key(s) from Producer that its template no longer declares: Gone.');
    expect(logs()).not.toContain(GONE_PLAINTEXT);
  });

  it('drops the key even when nothing else in the record needs rewriting (a record an older scrub left)', async () => {
    // The upgrade path: the declared outputs already hold their expressions, so
    // only the drop changes the record.
    const { saved, changed } = await scrub(
      record({ Out: SSM_EXPR, Sm: SM_EXPR, Gone: GONE_PLAINTEXT })
    );

    expect(changed).toBe(1);
    expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR });
  });

  it('keeps an undeclared key a pass REWROTE onto its expression (negative control)', async () => {
    // `Old` holds a plaintext this run recorded, so the widened pass rewrites
    // it: it no longer holds anything scrub cannot identify.
    const { saved } = await scrub(legacyRecord({ outputs: { Out: SSM_EXPR, Old: SM_PLAINTEXT } }));

    expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Old: SM_EXPR });
  });

  it('keeps an undeclared key holding only a whole secret token, and writes nothing for it', async () => {
    const { saved, changed } = await scrub(
      record({ Out: SSM_EXPR, Sm: SM_EXPR, Gone: SM_EXPR, Num: 5432 })
    );

    expect(changed).toBe(0);
    expect(saved).toBeUndefined();
  });

  it('never drops a DECLARED key, whatever it holds (negative control)', async () => {
    const { saved } = await scrub(record({ Out: 'public-literal', Sm: SM_PLAINTEXT }), {
      Out: { Value: 'public-literal' },
      Sm: { Value: SM_EXPR },
    });

    expect(saved!.outputs).toEqual({ Out: 'public-literal', Sm: SM_EXPR });
  });

  describe('export aliases', () => {
    const exporting: Record<string, TemplateOutput> = {
      ...DECLARED,
      Out: { Value: SSM_EXPR, Export: { Name: 'Producer-Out' } },
    };

    it('drops a stale alias, and removes it from exportNames, when every Export.Name is reproduced', async () => {
      const { saved } = await scrub(
        record(
          { Out: SSM_EXPR, 'Producer-Out': SSM_EXPR, Sm: SM_EXPR, 'Old-Export': GONE_PLAINTEXT },
          { exportNames: ['Producer-Out', 'Old-Export'] }
        ),
        exporting
      );

      expect(saved!.outputs).toEqual({ Out: SSM_EXPR, 'Producer-Out': SSM_EXPR, Sm: SM_EXPR });
      expect(saved!.exportNames).toEqual(['Producer-Out']);
    });

    it('KEEPS a possible alias when an Export.Name was not reproduced as a stored key', async () => {
      // The deploy wrote `prod-Out` (a parameter override scrub cannot see);
      // scrub computes `Producer-Out`, which the record does not hold. The
      // unaccounted `prod-Out` may be that live alias.
      const state = record(
        { Out: SSM_EXPR, 'prod-Out': SSM_EXPR, Sm: SM_EXPR, 'prod-Old': GONE_PLAINTEXT },
        { exportNames: ['prod-Out', 'prod-Old'] }
      );
      const { saved, changed } = await scrub(state, exporting);

      expect(changed).toBe(0);
      expect(saved).toBeUndefined();
      expect(warnLines.join('\n')).toContain(
        '1 output key(s) in Producer that its template does not declare were LEFT as they are: prod-Old.'
      );
      expect(logs()).not.toContain(GONE_PLAINTEXT);
    });

    it('KEEPS every undeclared key of a pre-v9 record (no exportNames) when an alias was not reproduced', async () => {
      const { saved } = await scrub(
        record({ Out: SSM_PLAINTEXT, Sm: SM_EXPR, Gone: GONE_PLAINTEXT }),
        exporting
      );

      expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR, Gone: GONE_PLAINTEXT });
    });

    it('still DROPS a key exportNames does not list, though an alias was not reproduced', async () => {
      // Not an alias, so a plain Output name — and every declared one is
      // accounted literally: a deleted output.
      const { saved } = await scrub(
        record({ Out: SSM_PLAINTEXT, Sm: SM_EXPR, Gone: GONE_PLAINTEXT }, { exportNames: [] }),
        exporting
      );

      expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR });
      expect(saved!.exportNames).toEqual([]);
    });

    it('KEEPS a possible alias when an Export.Name did not fully resolve', async () => {
      const { saved } = await scrub(
        record({ Out: SSM_PLAINTEXT, Sm: SM_EXPR, 'x-Gone': GONE_PLAINTEXT }),
        { ...DECLARED, Out: { Value: SSM_EXPR, Export: { Name: { 'Fn::Sub': '${Foo}-Out' } as never } } }
      );

      expect(saved!.outputs['x-Gone']).toBe(GONE_PLAINTEXT);
    });
  });

  describe('another stack still reading a key to drop', () => {
    it('REFUSES, writing nothing, when a consumer imports it', async () => {
      seed(
        record({}, {
          imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Gone' }],
        } as never, 'Consumer')
      );

      const { saved, error } = await scrub(legacyRecord());

      expect((error as { code?: string }).code).toBe('SCRUB_DROPPED_OUTPUT_STILL_READ');
      expect((error as { exitCode?: number }).exitCode).toBe(2);
      expect((error as Error).message).toContain('Consumer (us-east-1) reads Gone via Fn::ImportValue');
      expect((error as Error).message).not.toContain(GONE_PLAINTEXT);
      expect(saved).toBeUndefined();
      expect(lockManager.releaseLock).toHaveBeenCalled();
    });

    it('REFUSES when a consumer reads it with Fn::GetStackOutput', async () => {
      seed(
        record({}, {
          outputReads: [{ sourceStack: 'Producer', sourceRegion: 'US-EAST-1', outputName: 'Gone' }],
        } as never, 'Consumer')
      );

      const { error } = await scrub(legacyRecord());

      expect((error as { code?: string }).code).toBe('SCRUB_DROPPED_OUTPUT_STILL_READ');
      expect((error as Error).message).toContain('via Fn::GetStackOutput');
    });

    it('REFUSES when a same-region read of this producer stores its name redacted', async () => {
      seed(
        record({}, {
          imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: `x-${SM_EXPR}` }],
        } as never, 'Consumer')
      );

      const { error } = await scrub(legacyRecord());

      expect((error as { code?: string }).code).toBe('SCRUB_DROPPED_OUTPUT_STILL_READ');
      expect((error as Error).message).toContain('a name stored redacted');
    });

    it('REFUSES under --dry-run too, and takes no lock', async () => {
      seed(
        record({}, {
          imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Gone' }],
        } as never, 'Consumer')
      );

      const { error } = await scrub(legacyRecord(), DECLARED, { dryRun: true });

      expect((error as { code?: string }).code).toBe('SCRUB_DROPPED_OUTPUT_STILL_READ');
      expect(lockManager.acquireLockWithRetry).not.toHaveBeenCalled();
    });

    it('drops when the reads name another key, another producer, or another region (negative controls)', async () => {
      seed(
        record({}, {
          imports: [
            { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Sm' },
            { sourceStack: 'Other', sourceRegion: 'us-east-1', exportName: 'Gone' },
            { sourceStack: 'Producer', sourceRegion: 'eu-west-1', exportName: 'Gone' },
          ],
          outputReads: [{ sourceStack: 'Other', sourceRegion: 'us-east-1', outputName: 'Gone' }],
        } as never, 'Consumer')
      );
      // The producer's OWN record in another region is another stack.
      seed(record({ Gone: 'x' }, {}, 'Producer', 'eu-west-1'));

      const { saved, error } = await scrub(legacyRecord());

      expect(error).toBeUndefined();
      expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR });
    });

    it('REFUSES when the state listing cannot be read', async () => {
      stateBackend.listStacks.mockRejectedValue(new Error('AccessDenied: ListBucket'));

      const { saved, error } = await scrub(legacyRecord());

      expect((error as { code?: string }).code).toBe('SCRUB_DROPPED_OUTPUT_READERS_UNVERIFIED');
      expect((error as Error).message).toContain('AccessDenied: ListBucket');
      expect(saved).toBeUndefined();
    });

    it("REFUSES when another stack's record cannot be read", async () => {
      seed(record({}, {}, 'Consumer'));
      const real = stateBackend.getState.getMockImplementation()!;
      stateBackend.getState.mockImplementation((stack: string, region: string) =>
        stack === 'Consumer' ? Promise.reject(new Error('throttled')) : real(stack, region)
      );

      const { error } = await scrub(legacyRecord());

      expect((error as { code?: string }).code).toBe('SCRUB_DROPPED_OUTPUT_READERS_UNVERIFIED');
    });

    it("uses the caller's memoized listing when one is passed", async () => {
      const listStateRefs = vi.fn().mockResolvedValue([]);

      const { error } = await scrub(legacyRecord(), DECLARED, { listStateRefs });

      expect(error).toBeUndefined();
      expect(listStateRefs).toHaveBeenCalledTimes(1);
      expect(stateBackend.listStacks).not.toHaveBeenCalled();
    });

    it('does not list the bucket at all when there is nothing to drop', async () => {
      await scrub(record({ Out: SSM_PLAINTEXT, Sm: SM_EXPR }));

      expect(stateBackend.listStacks).not.toHaveBeenCalled();
    });
  });

  it('under --dry-run reports "Would drop", writes nothing and takes no lock', async () => {
    const { saved, changed } = await scrub(legacyRecord(), DECLARED, { dryRun: true });

    expect(changed).toBeGreaterThan(0);
    expect(saved).toBeUndefined();
    expect(lockManager.acquireLockWithRetry).not.toHaveBeenCalled();
    expect(infoLines.join('\n')).toContain('Would drop 1 output key(s) from Producer');
  });

  it('masks a dropped key that carries its own stored value or a recorded secret', async () => {
    const { saved, secretBearingKeys } = await scrub(
      record({
        Out: SSM_EXPR,
        Sm: SM_EXPR,
        [`k-${GONE_PLAINTEXT}`]: GONE_PLAINTEXT,
        [`r-${SM_PLAINTEXT}`]: 'unrelated-value',
      })
    );

    expect(Object.keys(saved!.outputs).sort()).toEqual(['Out', 'Sm']);
    expect(logs()).not.toContain(GONE_PLAINTEXT);
    expect(logs()).not.toContain(SM_PLAINTEXT);
    expect(logs()).toContain('(masked: "k-***")');
    // A key holding a recorded secret that scrub DROPPED is not reported as one
    // it "CANNOT" scrub — it removed it.
    expect(secretBearingKeys).toBe(0);
    expect(warnLines.join('\n')).not.toContain('cdkd scrub cannot rewrite a key');
  });

  it('still reports a secret-bearing key it does NOT drop (negative control)', async () => {
    // `r-<secret>` is an export alias scrub cannot rule live, so it is kept.
    const { secretBearingKeys } = await scrub(
      record(
        { Out: SSM_EXPR, Sm: SM_EXPR, [`r-${SM_PLAINTEXT}`]: 'v' },
        { exportNames: [`r-${SM_PLAINTEXT}`] }
      ),
      { ...DECLARED, Out: { Value: SSM_EXPR, Export: { Name: 'not-stored' } } }
    );

    expect(secretBearingKeys).toBe(1);
    expect(warnLines.join('\n')).toContain('cdkd scrub cannot rewrite a key');
  });
});

describe('planUnnamedOutputDrop', () => {
  const base = {
    accountedKeys: new Set(['Out']),
    exportNames: undefined as unknown,
    everyExportAliasReproduced: true,
  };

  it('drops an unaccounted, unrewritten key that may hold a plaintext', () => {
    const stored = { Out: 'a', Gone: 'plain' };
    expect(planUnnamedOutputDrop({ ...base, stored, rewritten: stored })).toEqual({
      drop: ['Gone'],
      keep: [],
    });
  });

  it('neither drops nor keeps a key a pass rewrote, or one with no plaintext-shaped leaf', () => {
    const stored = { Rewritten: 'plain', Token: SM_EXPR, List: [SM_EXPR, 1], Empty: '' };
    const rewritten = { ...stored, Rewritten: SM_EXPR };
    expect(planUnnamedOutputDrop({ ...base, stored, rewritten })).toEqual({ drop: [], keep: [] });
  });

  it('keeps a possible alias only while an Export.Name is unreproduced', () => {
    const stored = { Alias: 'v', Plain: 'v' };
    const input = { ...base, stored, rewritten: stored, exportNames: ['Alias'] };
    expect(planUnnamedOutputDrop({ ...input, everyExportAliasReproduced: false })).toEqual({
      drop: ['Plain'],
      keep: ['Alias'],
    });
    expect(planUnnamedOutputDrop(input)).toEqual({ drop: ['Alias', 'Plain'], keep: [] });
    // A malformed export set is UNKNOWN, so every key may be an alias.
    expect(
      planUnnamedOutputDrop({ ...input, exportNames: 'bad', everyExportAliasReproduced: false })
    ).toEqual({ drop: [], keep: ['Alias', 'Plain'] });
  });
});
