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
 * not reproduce, a key whose name holds a recorded secret) and the key KEPT,
 * as a finding, when another stack still reads it.
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

import {
  scrubStack,
  planUnnamedOutputDrop,
  findDroppedOutputReaders,
  readConsumerRecords,
  type ConsumerRecord,
} from '../../../../src/cli/commands/scrub.js';

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
    purgeNoncurrentVersions: ReturnType<typeof vi.fn>;
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
      purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
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
    opts: { dryRun?: boolean; readConsumerRecords?: () => Promise<ConsumerRecord[]> } = {}
  ): Promise<{
    saved: StackState | undefined;
    changed: number;
    error: unknown;
    secretBearingKeys?: number;
    result?: Awaited<ReturnType<typeof scrubStack>>;
  }> {
    seed(producer);
    let changed = 0;
    let secretBearingKeys: number | undefined;
    let result: Awaited<ReturnType<typeof scrubStack>> | undefined;
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
          ...(opts.readConsumerRecords && { readConsumerRecords: opts.readConsumerRecords }),
        }
      );
      changed = res.recordsChanged;
      secretBearingKeys = res.secretBearingKeys;
      result = res;
    } catch (err) {
      error = err;
    }
    const call = stateBackend.saveState.mock.calls.at(-1);
    return {
      saved: call ? (call[2] as StackState) : undefined,
      changed,
      error,
      ...(secretBearingKeys !== undefined && { secretBearingKeys }),
      ...(result && { result }),
    };
  }

  const logs = (): string => [...infoLines, ...warnLines].join('\n');

  it("the issue's repro: cdkd diff no longer prints the deleted output's plaintext after scrub", async () => {
    const { saved, error } = await scrub(legacyRecord());

    expect(error).toBeUndefined();
    expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR });

    // End to end through the diff the user runs next. `desired` is what the
    // GHSA-fixed diff resolves: the expressions, not the plaintexts.
    // The arguments `diff-recursive.ts` passes: both declared outputs are
    // secret-sourced, and the record's own export set rides along.
    const diff = (current: Record<string, unknown>) =>
      computeOutputsDiff(
        current,
        { Out: SSM_EXPR, Sm: SM_EXPR },
        new Set(),
        new Set(['Out', 'Sm']),
        {
          declaredKeys: new Set(['Out', 'Sm']),
          templateHasSecretReference: true,
          secretBearingExportNames: [],
          refusedNoEchoExportNames: [],
          storedExportNames: saved!.exportNames,
        }
      );
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
        // An alias-shaped name is WITHHELD, as `cdkd diff` withholds it.
        '1 output key(s) in Producer that its template does not declare were LEFT as they are: (name withheld: an export name, which may carry a secret).'
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

    it('KEEPS it even when the record holds the unresolved name literally', async () => {
      // A deploy writes a warn-and-kept `${Foo}-Out` as a real key, so the
      // stored-key test alone would call that name reproduced.
      const { saved } = await scrub(
        record({ Out: SSM_PLAINTEXT, Sm: SM_EXPR, '${Foo}-Out': 'v', 'x-Gone': GONE_PLAINTEXT }),
        { ...DECLARED, Out: { Value: SSM_EXPR, Export: { Name: { 'Fn::Sub': '${Foo}-Out' } as never } } }
      );

      expect(saved!.outputs['x-Gone']).toBe(GONE_PLAINTEXT);
    });

    it('exempts a LITERAL Export.Name colliding with another output: the deploy never writes it', async () => {
      const { saved } = await scrub(
        record(
          { Out: SSM_PLAINTEXT, Sm: SM_EXPR, 'Old-Export': GONE_PLAINTEXT },
          { exportNames: ['Old-Export'] }
        ),
        { ...DECLARED, Out: { Value: SSM_EXPR, Export: { Name: 'Sm' } } }
      );

      expect(saved!.outputs).not.toHaveProperty('Old-Export');
    });

    it('does not exempt an INTRINSIC name colliding with another output', async () => {
      const { saved } = await scrub(
        record(
          { Out: SSM_PLAINTEXT, Sm: SM_EXPR, 'Old-Export': GONE_PLAINTEXT },
          { exportNames: ['Old-Export'] }
        ),
        { ...DECLARED, Out: { Value: SSM_EXPR, Export: { Name: { 'Fn::Sub': 'Sm' } as never } } }
      );

      expect(saved!.outputs['Old-Export']).toBe(GONE_PLAINTEXT);
    });

    it('on a record with no export set, a LITERAL own-name export still counts as reproduced', async () => {
      const { saved } = await scrub(
        record({ Out: SSM_PLAINTEXT, Sm: SM_EXPR, Gone: GONE_PLAINTEXT }),
        { ...DECLARED, Out: { Value: SSM_EXPR, Export: { Name: 'Out' } } }
      );

      expect(saved!.outputs).not.toHaveProperty('Gone');
    });

    it('on a record with no export set, an intrinsic name matching a plain Output proves nothing', async () => {
      const { saved } = await scrub(
        record({ Out: SSM_PLAINTEXT, Sm: SM_EXPR, Lit: 'bucket-1', 'prod-Lit': 'bucket-1' }),
        { ...DECLARED, Lit: { Value: 'bucket-1', Export: { Name: { 'Fn::Sub': 'Lit' } as never } } }
      );

      expect(saved!.outputs['prod-Lit']).toBe('bucket-1');
    });

    it('does not count a PLAIN output of the same name as the reproduced alias', async () => {
      // `Lit`'s Export.Name resolves to `Lit`, a plain Output key the record
      // holds; the record's export set lists only `prod-Lit`, the real alias.
      const { saved } = await scrub(
        record(
          { Out: SSM_PLAINTEXT, Sm: SM_EXPR, Lit: 'bucket-1', 'prod-Lit': 'bucket-1' },
          { exportNames: ['prod-Lit'] }
        ),
        { ...DECLARED, Lit: { Value: 'bucket-1', Export: { Name: 'Lit' } } }
      );

      expect(saved!.outputs['prod-Lit']).toBe('bucket-1');
      expect(saved!.exportNames).toEqual(['prod-Lit']);
    });
  });

  describe('another stack still reading a key to drop', () => {
    function consumer(extra: Partial<StackState>, name = 'Consumer', region = 'us-east-1'): void {
      seed(record({}, extra, name, region));
    }

    it('KEEPS a key a consumer imports, and still writes every other repair', async () => {
      consumer({
        imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Gone' }],
      } as never);

      const { saved, error, result } = await scrub(
        legacyRecord({ outputs: { Out: SSM_PLAINTEXT, Sm: SM_PLAINTEXT, Gone: GONE_PLAINTEXT, Old: 'x-1' } })
      );

      expect(error).toBeUndefined();
      // The declared plaintexts are still repaired, and the unread key dropped.
      expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR, Gone: GONE_PLAINTEXT });
      expect(result!.keptReadOutputKeys).toBe(1);
      expect(result!.droppedOutputKeys).toBe(1);
      const warn = warnLines.join('\n');
      expect(warn).toContain('Consumer (us-east-1) reads Gone via Fn::ImportValue');
      expect(warn).toContain('were NOT dropped');
      expect(warn).not.toContain(GONE_PLAINTEXT);
    });

    it('KEEPS a key a consumer reads with Fn::GetStackOutput (region compared canonically)', async () => {
      consumer({
        outputReads: [{ sourceStack: 'Producer', sourceRegion: 'US-EAST-1', outputName: 'Gone' }],
      } as never);

      const { saved, result } = await scrub(legacyRecord());

      expect(saved!.outputs['Gone']).toBe(GONE_PLAINTEXT);
      expect(result!.keptReadOutputKeys).toBe(1);
      expect(warnLines.join('\n')).toContain('via Fn::GetStackOutput');
    });

    it('never prints a read key through its raw name', async () => {
      const key = `k-${GONE_PLAINTEXT}`;
      consumer({
        imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: key }],
      } as never);

      await scrub(record({ Out: SSM_EXPR, Sm: SM_EXPR, [key]: GONE_PLAINTEXT }));

      expect(logs()).not.toContain(GONE_PLAINTEXT);
      expect(logs()).toContain('reads (name withheld: an export name, which may carry a secret) via Fn::ImportValue');
    });

    it('keeps EVERY key it would drop when a read of this producer stores its name redacted', async () => {
      consumer({
        imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: `x-${SM_EXPR}` }],
      } as never);

      const { saved, result } = await scrub(
        record({ Out: SSM_PLAINTEXT, Sm: SM_EXPR, Gone: GONE_PLAINTEXT, Gone2: 'another-leftover' })
      );

      expect(result!.keptReadOutputKeys).toBe(2);
      expect(saved!.outputs).toEqual({
        Out: SSM_EXPR,
        Sm: SM_EXPR,
        Gone: GONE_PLAINTEXT,
        Gone2: 'another-leftover',
      });
      expect(warnLines.join('\n')).toContain('a name stored redacted');
    });

    it('under --dry-run too, and takes no lock', async () => {
      consumer({
        imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Gone' }],
      } as never);

      const { result } = await scrub(legacyRecord(), DECLARED, { dryRun: true });

      expect(result!.keptReadOutputKeys).toBe(1);
      expect(lockManager.acquireLockWithRetry).not.toHaveBeenCalled();
    });

    it('drops when the reads name another key, another producer, or another region (negative controls)', async () => {
      consumer({
        imports: [
          { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Sm' },
          { sourceStack: 'Other', sourceRegion: 'us-east-1', exportName: 'Gone' },
          { sourceStack: 'Producer', sourceRegion: 'eu-west-1', exportName: 'Gone' },
        ],
        outputReads: [
          { sourceStack: 'Other', sourceRegion: 'us-east-1', outputName: 'Gone' },
          { sourceStack: 'Producer', sourceRegion: 'eu-west-1', outputName: 'Gone' },
        ],
      } as never);
      const { saved, result } = await scrub(legacyRecord());

      expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR });
      expect(result!.keptReadOutputKeys).toBe(0);
    });

    it('keeps every key, writes the rest, and flags the stack when the listing cannot be read', async () => {
      stateBackend.listStacks.mockRejectedValue(new Error('AccessDenied: ListBucket'));

      const { saved, error, result } = await scrub(legacyRecord());

      expect(error).toBeUndefined();
      expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR, Gone: GONE_PLAINTEXT });
      expect(result!.droppedOutputReadersUnverified).toBe(true);
      expect(warnLines.join('\n')).toContain('AccessDenied: ListBucket');
    });

    it("flags the stack when another stack's record cannot be read", async () => {
      consumer({});
      const real = stateBackend.getState.getMockImplementation() as (
        stack: string,
        region: string
      ) => Promise<unknown>;
      stateBackend.getState.mockImplementation((stack: string, region: string) =>
        stack === 'Consumer' ? Promise.reject(new Error('throttled')) : real(stack, region)
      );

      const { saved, result } = await scrub(legacyRecord());

      expect(result!.droppedOutputReadersUnverified).toBe(true);
      expect(saved!.outputs['Gone']).toBe(GONE_PLAINTEXT);
    });

    it("uses the caller's memoized records when passed", async () => {
      const readConsumerRecords = vi.fn().mockResolvedValue([]);

      const { error } = await scrub(legacyRecord(), DECLARED, { readConsumerRecords });

      expect(error).toBeUndefined();
      expect(readConsumerRecords).toHaveBeenCalledTimes(1);
      expect(stateBackend.listStacks).not.toHaveBeenCalled();
    });

    it('does not read the bucket at all when there is nothing to drop', async () => {
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

  it('masks a dropped key that carries its own stored value', async () => {
    // `exportNames: []` says the key is a plain Output name, not an alias, so
    // it is shown MASKED rather than withheld.
    const { saved, result } = await scrub(
      record(
        { Out: SSM_EXPR, Sm: SM_EXPR, [`k-${GONE_PLAINTEXT}`]: GONE_PLAINTEXT },
        { exportNames: [] }
      )
    );

    expect(Object.keys(saved!.outputs).sort()).toEqual(['Out', 'Sm']);
    expect(logs()).not.toContain(GONE_PLAINTEXT);
    expect(logs()).toContain('(masked: "k-***")');
    // The same corpus reaches the exports-index lines, and so does an entry's
    // own value.
    expect(result!.exportNameDisplay(`k-${GONE_PLAINTEXT}`)).toEqual({
      kind: 'masked',
      text: 'k-***',
    });
    expect(result!.exportNameDisplay('i-idx-value', 'idx-value')).toEqual({
      kind: 'masked',
      text: 'i-***',
    });
    expect(result!.exportNameDisplay('plain-export')).toEqual({ kind: 'safe', text: 'plain-export' });
  });

  it('masks a KEPT key that carries its own stored value', async () => {
    await scrub(
      record(
        { Out: SSM_EXPR, Sm: SM_EXPR, [`k${GONE_PLAINTEXT}`]: GONE_PLAINTEXT },
        { exportNames: [`k${GONE_PLAINTEXT}`] }
      ),
      { ...DECLARED, Out: { Value: SSM_EXPR, Export: { Name: 'not-stored' } } }
    );

    expect(warnLines.join('\n')).toContain('were LEFT as they are: (masked: "k***")');
    expect(logs()).not.toContain(GONE_PLAINTEXT);
  });

  it('never drops a key whose NAME holds a recorded secret: it stays a reported #1919 leak', async () => {
    // The exports index still publishes that name, so dropping the key would
    // turn the gate green over it.
    const { saved, secretBearingKeys } = await scrub(
      record({ Out: SSM_EXPR, Sm: SM_EXPR, [`r-${SM_PLAINTEXT}`]: 'v', Gone: GONE_PLAINTEXT })
    );

    expect(secretBearingKeys).toBe(1);
    expect(Object.keys(saved!.outputs).sort()).toEqual(['Out', 'Sm', `r-${SM_PLAINTEXT}`]);
    expect(warnLines.join('\n')).toContain('cdkd scrub cannot rewrite a key');
  });

  it('drops a key whose value is a list mixing a reference and plaintext', async () => {
    const { saved } = await scrub(record({ Out: SSM_EXPR, Sm: SM_EXPR, Gone: [SM_EXPR, GONE_PLAINTEXT] }));

    expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR });
  });

  it('never drops on the zero-needle path (nothing recorded, nothing rewritten)', async () => {
    const { saved, changed } = await scrub(record({ Pub: 'x', Gone: GONE_PLAINTEXT }), {
      Pub: { Value: 'x' },
    });

    expect(changed).toBe(0);
    expect(saved).toBeUndefined();
  });
});


describe('cdkd scrub - review round 4 (go-to-k/cdkd#4120)', () => {
  let states: Map<string, StackState>;
  let stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    purgeNoncurrentVersions: ReturnType<typeof vi.fn>;
    listStacks: ReturnType<typeof vi.fn>;
  };
  const lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
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
      purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn().mockImplementation(() =>
        Promise.resolve(
          [...states.keys()].map((k) => ({ stackName: k.split('|')[0]!, region: k.split('|')[1]! }))
        )
      ),
    };
  });

  const seed = (state: StackState): void => {
    states.set(`${state.stackName}|${state.region}`, state);
  };
  async function run(
    producer: StackState,
    outputs: Record<string, TemplateOutput> = DECLARED
  ): Promise<{ saved: StackState | undefined; result: Awaited<ReturnType<typeof scrubStack>> }> {
    seed(producer);
    const result = await scrubStack(
      stackInfo(outputs) as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );
    const call = stateBackend.saveState.mock.calls.at(-1);
    return { saved: call ? (call[2] as StackState) : undefined, result };
  }
  const exporting: Record<string, TemplateOutput> = {
    ...DECLARED,
    Out: { Value: SSM_EXPR, Export: { Name: 'Producer-Out' } },
  };

  it.each([
    ['[0]', [0]],
    ['[null]', [null]],
    ["['Producer-Out', 0]", ['Producer-Out', 0]],
  ])('reads a damaged exportNames %s as UNKNOWN: a possible alias is kept', async (_l, names) => {
    // `prod-Url` may be the live alias the damaged set failed to list. The
    // template's own export is not reproduced either (its key is absent), so
    // nothing proves the undeclared key dead.
    const { saved, result } = await run(
      record(
        { Out: SSM_PLAINTEXT, Sm: SM_EXPR, 'prod-Url': 'https://x' },
        { exportNames: names as never }
      ),
      exporting
    );

    expect(saved!.outputs['prod-Url']).toBe('https://x');
    expect(result.keptAliasOutputKeys).toBe(1);
  });

  it('KEEPS a key a pass rewrote only PARTLY: its index entry converges to it', async () => {
    const { saved } = await run(
      record({ Out: SSM_EXPR, Sm: SM_EXPR, Gone: `${SM_PLAINTEXT}-${GONE_PLAINTEXT}` })
    );

    expect(saved!.outputs).toEqual({ Out: SSM_EXPR, Sm: SM_EXPR, Gone: `${SM_EXPR}-${GONE_PLAINTEXT}` });
  });

  it('KEEPS, as a finding, a key a consumer reads by Fn::GetStackOutput through a non-string sourceStack', async () => {
    seed(
      record({}, {
        outputReads: [{ sourceStack: 42, sourceRegion: 'us-east-1', outputName: 'Gone' }],
      } as never, 'Consumer')
    );

    const { saved, result } = await run(legacyRecord());

    expect(saved!.outputs['Gone']).toBe(GONE_PLAINTEXT);
    expect(result.keptReadOutputKeys).toBe(1);
    expect(warnLines.join('\n')).toContain('a damaged record');
  });

  it.each([
    ['v3, before imports[]', 3, 'Fn::ImportValue', undefined],
    // The BOUNDARIES: from v4 `imports[]` is recorded, so only the
    // `outputReads[]` half is unknown.
    ['v4, before outputReads[]', 4, 'Fn::GetStackOutput', 'Fn::ImportValue'],
    ['v7, before outputReads[]', 7, 'Fn::GetStackOutput', 'Fn::ImportValue'],
  ])(
    'KEEPS every key when another record is %s: its reads are unknown',
    async (_l, version, intrinsic, known) => {
      seed({ ...record({}, {}, 'Old'), version } as StackState);

      const { saved, result } = await run(legacyRecord());

      expect(saved!.outputs['Gone']).toBe(GONE_PLAINTEXT);
      expect(result.keptReadOutputKeys).toBe(1);
      const warn = warnLines.join('\n');
      expect(warn).toContain(
        `Old (us-east-1) records no ${intrinsic} reads (written before cdkd recorded them)`
      );
      if (known !== undefined) expect(warn).not.toContain(`records no ${known} reads`);
    }
  );

  it("masks a recorded secret in a reading consumer's stack NAME", async () => {
    seed(
      record({}, {
        imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Gone' }],
      } as never, `C-${SM_PLAINTEXT}`)
    );

    await run(legacyRecord());

    expect(warnLines.join('\n')).toContain('reads Gone via Fn::ImportValue');
    expect(warnLines.join('\n')).not.toContain(SM_PLAINTEXT);
  });

  it('a v8 record (outputReads known, imports known) is no reader (negative control)', async () => {
    seed({ ...record({}, {}, 'Recent'), version: 8 } as StackState);

    const { saved } = await run(legacyRecord());

    expect(saved!.outputs).not.toHaveProperty('Gone');
  });

  it('counts a kept possible alias as a finding', async () => {
    const { result } = await run(
      record({ Out: SSM_PLAINTEXT, Sm: SM_EXPR, 'prod-Old': GONE_PLAINTEXT }),
      exporting
    );

    expect(result.keptAliasOutputKeys).toBe(1);
    expect(warnLines.join('\n')).toContain('so Producer is not reported clean');
  });

  it('KEEPS a possible alias when an EARLIER Export.Name is unreproduced, even if a later one is', async () => {
    // Kills "the last output decides": `First` is not reproduced (its alias is
    // absent), `Second` is.
    const { saved } = await run(
      record(
        { Out: SSM_PLAINTEXT, Sm: SM_EXPR, 'Producer-Sm': SM_EXPR, 'x-Old': GONE_PLAINTEXT },
        { exportNames: ['Producer-Sm', 'x-Old'] }
      ),
      {
        Out: { Value: SSM_EXPR, Export: { Name: 'Producer-Out' } },
        Sm: { Value: SM_EXPR, Export: { Name: 'Producer-Sm' } },
      }
    );

    expect(saved!.outputs['x-Old']).toBe(GONE_PLAINTEXT);
  });

  it('on a pre-v9 record, an intrinsic Export.Name resolving to a stored non-output key IS reproduced', async () => {
    const { saved } = await run(
      record({ Out: SSM_PLAINTEXT, Sm: SM_EXPR, 'Producer-Out': SSM_PLAINTEXT, Gone: GONE_PLAINTEXT }),
      {
        ...DECLARED,
        Out: { Value: SSM_EXPR, Export: { Name: { 'Fn::Sub': 'Producer-Out' } as never } },
      }
    );

    expect(saved!.outputs).not.toHaveProperty('Gone');
  });
});

describe('readConsumerRecords', () => {
  it('reads a legacy ref with no region in the fallback region', async () => {
    const getState = vi.fn().mockResolvedValue({ state: { version: 9 } });
    await readConsumerRecords(
      { listStacks: vi.fn().mockResolvedValue([{ stackName: 'Legacy' }]), getState } as never,
      'ap-northeast-1'
    );

    expect(getState).toHaveBeenCalledWith('Legacy', 'ap-northeast-1');
  });

  it('treats a listed record that reads as absent as UNREADABLE (fail-closed)', async () => {
    await expect(
      readConsumerRecords(
        {
          listStacks: vi.fn().mockResolvedValue([{ stackName: 'Gone', region: 'us-east-1' }]),
          getState: vi.fn().mockResolvedValue(null),
        } as never,
        'us-east-1'
      )
    ).rejects.toThrow('is listed but its state record could not be read');
  });

  it('stops taking refs once a read failed', async () => {
    let calls = 0;
    const getState = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('throttled');
      await new Promise((r) => setTimeout(r, 1));
      return { state: { version: 9 } };
    });
    const refs = Array.from({ length: 80 }, (_, i) => ({ stackName: `S${i}`, region: 'us-east-1' }));

    await expect(
      readConsumerRecords({ listStacks: vi.fn().mockResolvedValue(refs), getState } as never, 'us-east-1')
    ).rejects.toThrow('throttled');
    // Let the other workers finish what they had taken.
    await new Promise((r) => setTimeout(r, 50));
    // The 16 workers' first reads, and no more.
    expect(calls).toBeLessThanOrEqual(16);
  });

  it('returns the records sorted by stack name, whatever order they completed in', async () => {
    const getState = vi.fn().mockImplementation(async (name: string) => {
      await new Promise((r) => setTimeout(r, name === 'A' ? 5 : 0));
      return { state: { version: 9 } };
    });
    const refs = [
      { stackName: 'C', region: 'us-east-1' },
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
    ];

    const records = await readConsumerRecords(
      { listStacks: vi.fn().mockResolvedValue(refs), getState } as never,
      'us-east-1'
    );

    expect(records.map((r) => r.stackName)).toEqual(['A', 'B', 'C']);
  });

  it('never has more than 16 reads in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const getState = vi.fn().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { state: { version: 9 } };
    });
    const refs = Array.from({ length: 50 }, (_, i) => ({ stackName: `S${i}`, region: 'us-east-1' }));

    const records = await readConsumerRecords(
      { listStacks: vi.fn().mockResolvedValue(refs), getState } as never,
      'us-east-1'
    );

    expect(records).toHaveLength(50);
    expect(peak).toBe(16);
  });
});

describe('findDroppedOutputReaders', () => {
  const keys = new Set(['Gone']);
  const rec = (extra: Partial<ConsumerRecord>): ConsumerRecord => ({
    stackName: 'Consumer',
    region: 'us-east-1',
    version: 9,
    imports: undefined,
    outputReads: undefined,
    ...extra,
  });

  it('counts a read whose name or producer is stored redacted, in either list', () => {
    const redacted = `x-${SM_EXPR}`;
    expect(
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [
        rec({ imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: redacted }] }),
      ])
    ).toEqual([{ consumerStack: 'Consumer', consumerRegion: 'us-east-1', key: undefined, intrinsic: 'Fn::ImportValue' }]);
    expect(
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [
        rec({ outputReads: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: redacted }] }),
      ])
    ).toHaveLength(1);
    expect(
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [
        rec({ outputReads: [{ sourceStack: redacted, sourceRegion: 'us-east-1', outputName: 'Gone' }] }),
      ])
    ).toEqual([{ consumerStack: 'Consumer', consumerRegion: 'us-east-1', key: 'Gone', intrinsic: 'Fn::GetStackOutput' }]);
  });

  it('counts an entry whose producer or key is not a string as a possible read', () => {
    expect(
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [
        rec({ imports: [{ sourceStack: 42, sourceRegion: 'us-east-1', exportName: 'Gone' }] }),
      ])
    ).toEqual([
      {
        consumerStack: 'Consumer',
        consumerRegion: 'us-east-1',
        key: undefined,
        intrinsic: 'Fn::ImportValue',
        damaged: true,
      },
    ]);
    expect(
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [
        rec({ imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 7 }] }),
      ])
    ).toEqual([
      {
        consumerStack: 'Consumer',
        consumerRegion: 'us-east-1',
        key: undefined,
        intrinsic: 'Fn::ImportValue',
        damaged: true,
      },
    ]);
  });

  it('counts an outputReads entry with a non-string sourceStack as a damaged read', () => {
    expect(
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [
        rec({ outputReads: [{ sourceStack: 42, sourceRegion: 'us-east-1', outputName: 'Gone' }] }),
      ])
    ).toEqual([
      {
        consumerStack: 'Consumer',
        consumerRegion: 'us-east-1',
        key: undefined,
        intrinsic: 'Fn::GetStackOutput',
        damaged: true,
      },
    ]);
  });

  it('counts a record with no numeric version as the oldest: both kinds of read unknown', () => {
    expect(
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [rec({ version: 'x' })]).map(
        (r) => [r.intrinsic, r.legacy]
      )
    ).toEqual([
      ['Fn::ImportValue', true],
      ['Fn::GetStackOutput', true],
    ]);
  });

  it('counts an entry whose sourceRegion is unreadable as a possible read', () => {
    expect(
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [
        rec({ imports: [{ sourceStack: 'Producer', exportName: 'Gone' }] }),
      ])
    ).toHaveLength(1);
  });

  it('throws on a list that is present but not a list, or holds a non-object', () => {
    expect(() =>
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [rec({ imports: 'bad' })])
    ).toThrow('imports list');
    expect(() =>
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [rec({ outputReads: [null] })])
    ).toThrow('outputReads list');
  });

  it("skips the producer's own record in its own region only", () => {
    const own = { imports: [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Gone' }] };
    expect(
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [rec({ stackName: 'Producer', ...own })])
    ).toEqual([]);
    expect(
      findDroppedOutputReaders('Producer', 'us-east-1', keys, [
        rec({ stackName: 'Producer', region: 'eu-west-1', ...own }),
      ])
    ).toHaveLength(1);
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
