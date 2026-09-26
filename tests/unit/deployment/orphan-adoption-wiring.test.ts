/**
 * The ENGINE side of issue #2934 — driven through `DeployEngine` itself.
 *
 * An earlier version of this file called `planOrphanAdoption` again with its
 * own stubs while its titles read "the engine must SPLICE ...". That asserted
 * nothing about the engine: the splice, the refusal `throw`, the record
 * replacement and the whole sibling scan stayed deletable with the suite green.
 * A test review caught it, and the lesson is the file's reason for existing —
 * a case that re-implements its subject proves the subject's SHAPE, never its
 * WIRING.
 *
 * `adoptRollbackOrphans` is private and is called through a cast. That is
 * deliberate: reaching it through `deploy()` would need the entire synth / DAG
 * / diff pipeline stood up, and every normalisation on the way is a chance for
 * the case to pass for a reason that has nothing to do with what it names.
 *
 * The sibling scan used to be a second private method here. go-to-k/cdkd#2943
 * moved it to `orphan-adoption.ts` so `cdkd diff` runs the SAME scan, and its
 * cases now drive the exported factory — see `readSiblings` below for why that
 * costs no coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { explicitNamePropertyFor } from '../../../src/provisioning/resource-name.js';
import { makeSiblingClaimReader } from '../../../src/deployment/orphan-adoption.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState, StackOrphanRecord } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  // PARTIAL: the engine reaches for several exports of this module, and a
  // hand-written replacement silently omits whichever the code asks for next.
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, logger: quiet, getLogger: () => quiet };
});

function orphanRecord(logicalId = 'KeptRole', physicalId = 'MyStack-KeptRole'): StackOrphanRecord {
  const state: ResourceState = {
    physicalId,
    resourceType: 'AWS::IAM::Role',
    properties: { Path: '/svc/' },
    deletionPolicy: 'Retain',
  };
  return { logicalId, orphanedAt: 1, state };
}

function stackState(orphans: StackOrphanRecord[]): StackState {
  return {
    version: 9,
    stackName: 'MyStack',
    region: 'us-east-1',
    resources: {},
    outputs: {},
    orphans,
    lastModified: 1,
  } as StackState;
}

const declaringTemplate = {
  Resources: { KeptRole: { Type: 'AWS::IAM::Role', Properties: { Path: '/svc/' } } },
} as unknown as CloudFormationTemplate;

type Backend = {
  getState: ReturnType<typeof vi.fn>;
  saveState: ReturnType<typeof vi.fn>;
  listStacks: ReturnType<typeof vi.fn>;
};

let backend: Backend;
let importFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  backend = {
    getState: vi.fn(),
    saveState: vi.fn().mockResolvedValue('etag'),
    listStacks: vi.fn().mockResolvedValue([]),
  };
  importFn = vi.fn(async () => ({ physicalId: 'MyStack-KeptRole' }));
});

function makeEngine(): InstanceType<typeof DeployEngine> {
  const provider = { import: importFn };
  return new DeployEngine(
    backend as unknown as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as unknown as never,
    {
      calculateDiff: vi.fn().mockResolvedValue(new Map()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    } as unknown as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as unknown as never,
    {},
    'us-east-1'
  );
}

/** The private pre-pass, as the engine's own `executeDeployment` calls it. */
function adopt(
  engine: InstanceType<typeof DeployEngine>,
  state: StackState,
  template = declaringTemplate
): Promise<unknown> {
  return (
    engine as unknown as {
      adoptRollbackOrphans: (s: StackState, t: CloudFormationTemplate) => Promise<unknown>;
    }
  ).adoptRollbackOrphans(state, template);
}

/**
 * The sibling scan, as `DeployEngine` and `cdkd diff` both build it.
 *
 * It was a private method on the engine until go-to-k/cdkd#2943 needed the
 * SAME scan for the diff preview. The cases below are unchanged by that move:
 * they always exercised the scan's own rules, never the engine's plumbing, and
 * the plumbing keeps its own proof in the refusal case above — which reaches
 * this reader through `adoptRollbackOrphans` and fails if the engine stops
 * wiring one.
 *
 * `engine` is no longer consulted; it stays in the signature so each case
 * still reads as "what the engine's scan does", and so the mock backend the
 * file already builds is the thing under test rather than a second fixture.
 */
function readSiblings(
  _engine: InstanceType<typeof DeployEngine>,
  self = 'MyStack'
): Promise<ReadonlySet<string>> {
  return makeSiblingClaimReader({
    stateBackend: backend as unknown as never,
    selfStackName: self,
    selfRegion: 'us-east-1',
    logger: { debug: () => {} },
  })();
}

describe('adoptRollbackOrphans MUTATES the state the diff will read (#2934)', () => {
  it('splices the adopted record into `resources`', async () => {
    const state = stackState([orphanRecord()]);
    await adopt(makeEngine(), state);

    // THE mechanism. The diff decides CREATE by absence from `resources`, so
    // deleting this assignment silently restores the collision loop while every
    // pure-function test of the pre-pass stays green.
    expect(state.resources['KeptRole']?.physicalId).toBe('MyStack-KeptRole');
    expect(state.resources['KeptRole']?.properties).toEqual({ Path: '/svc/' });
  });

  it('REPLACES the record set with the survivors, so an adopted record is consumed', async () => {
    const state = stackState([orphanRecord()]);
    await adopt(makeEngine(), state);

    // Writing the original array back instead would leave the record forever:
    // every future deploy of this stack would re-verify it against AWS.
    expect(state.orphans).toEqual([]);
  });

  it('THROWS when the pre-pass refuses, naming the resource', async () => {
    // Another stack already records this physical id.
    backend.listStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);
    backend.getState.mockResolvedValue({
      state: { resources: { X: { physicalId: 'MyStack-KeptRole' } } },
    });
    const state = stackState([orphanRecord()]);

    await expect(adopt(makeEngine(), state)).rejects.toThrow(/KeptRole/);
    // And nothing was spliced: a refused record must not reach the diff.
    expect(state.resources['KeptRole']).toBeUndefined();
  });

  it('leaves a record-free state untouched — no AWS calls, no field invented', async () => {
    const state = { ...stackState([]), orphans: undefined } as StackState;
    await adopt(makeEngine(), state);

    // The no-bump argument depends on this: a stack that never orphaned must
    // not gain the key.
    expect('orphans' in state && state.orphans !== undefined).toBe(false);
    expect(importFn).not.toHaveBeenCalled();
    expect(backend.listStacks).not.toHaveBeenCalled();
  });

  it('passes the REAL name-property lookup, not an always-empty list', async () => {
    // `AWS::IAM::Role`'s name property is `RoleName`, and a template that sets
    // it disqualifies adoption — the deploy will not request the recorded name,
    // and for most types that property is create-only, so adopting anyway ends
    // in a REPLACEMENT that deletes the resource being rescued.
    expect(explicitNamePropertyFor('AWS::IAM::Role')).toBe('RoleName');

    const named = {
      Resources: {
        KeptRole: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'chosen-by-hand' } },
      },
    } as unknown as CloudFormationTemplate;
    const state = stackState([orphanRecord()]);
    await adopt(makeEngine(), state, named);

    // Not adopted, and KEPT — the resource is still in AWS and still ours.
    expect(state.resources['KeptRole']).toBeUndefined();
    expect(state.orphans).toHaveLength(1);
  });
});

describe('readSiblingPhysicalIds (#2934)', () => {
  it('collects the ids other stacks record', async () => {
    backend.listStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);
    backend.getState.mockResolvedValue({
      state: { resources: { A: { physicalId: 'other-a' }, B: { physicalId: 'other-b' } } },
    });

    // Returning an empty set unconditionally is the mutation that matters: it
    // kills refusal (d), and cdkd then adopts a resource another stack manages
    // — after which either stack's `cdkd destroy` deletes the other's live one.
    expect([...(await readSiblings(makeEngine()))].sort()).toEqual(['other-a', 'other-b']);
  });

  it('skips THIS stack, so its own record cannot refuse its own adoption', async () => {
    backend.listStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    backend.getState.mockResolvedValue({ state: { resources: { A: { physicalId: 'mine' } } } });

    expect(await readSiblings(makeEngine())).toEqual(new Set());
    expect(backend.getState).not.toHaveBeenCalled();
  });

  it('skips a region-less ref for THIS stack, which the name+region skip cannot catch', async () => {
    backend.listStacks.mockResolvedValue([{ stackName: 'MyStack' }]);

    // The two skips are not interchangeable, and this case is the proof. The
    // self-skip needs the name AND the region to match, and `stackRegion` is
    // always a string, so a region-less ref for our OWN stack falls straight
    // through it — only the region-less skip stops it. Delete that skip and
    // this case reds while the self-skip stays untouched, which is what says
    // the self-skip does not already cover it.
    //
    // Nor is this the 'Legacy' case below under another name. Measured
    // 2026-09-11: narrowing the skip to `ref.stackName !== selfStackName &&
    // ref.region === undefined` — what someone who believes self is handled
    // above would write — greens 'Legacy' and reds ONLY this case.
    //
    // What it costs if neither stops it: `getState` reads our own record and
    // our own physical ids become "claims", which refusal (d) then reports as
    // belonging to another cdkd stack.
    expect(await readSiblings(makeEngine())).toEqual(new Set());
    expect(backend.getState).not.toHaveBeenCalled();
  });

  it('skips a legacy region-less ref rather than calling getState with undefined', async () => {
    backend.listStacks.mockResolvedValue([{ stackName: 'Legacy' }]);

    expect(await readSiblings(makeEngine())).toEqual(new Set());
    expect(backend.getState).not.toHaveBeenCalled();
  });

  it('a failed listing yields an EMPTY set — fail-open, deliberately', async () => {
    backend.listStacks.mockRejectedValue(new Error('AccessDenied'));

    // Written down rather than implied: with no listing, refusal (d) cannot
    // fire, so a missing `s3:ListBucket` grant silently weakens the check. The
    // alternative — failing the deploy — would let one permission gap block
    // every adoption in the account.
    await expect(readSiblings(makeEngine())).resolves.toEqual(new Set());
  });

  it('does NOT skip a same-named stack in a DIFFERENT region', async () => {
    backend.listStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'eu-west-1' }]);
    backend.getState.mockResolvedValue({
      state: { resources: { A: { physicalId: 'global-name' } } },
    });

    // A same-named stack in another region is a DIFFERENT state file, and
    // globally-namespaced ids — an IAM role, an S3 bucket — are exactly what it
    // could be claiming. Skipping on name alone made that claim invisible.
    expect([...(await readSiblings(makeEngine()))]).toEqual(['global-name']);
  });

  it('one unreadable sibling does not lose the others, and does not fail the deploy', async () => {
    backend.listStacks.mockResolvedValue([
      { stackName: 'Broken', region: 'us-east-1' },
      { stackName: 'Fine', region: 'us-east-1' },
    ]);
    backend.getState
      .mockRejectedValueOnce(new Error('corrupt state.json'))
      .mockResolvedValueOnce({ state: { resources: { A: { physicalId: 'fine-a' } } } });

    // Dropping the per-sibling catch would brick every deploy that holds a
    // record as soon as ANY unrelated stack's state stops parsing.
    expect([...(await readSiblings(makeEngine()))]).toEqual(['fine-a']);
  });

  /**
   * go-to-k/cdkd#3202. The sibling's record is a hand-editable file, and the
   * walk used to trust every row: a `null` one threw on `record.physicalId`
   * into the per-sibling catch, which logged at DEBUG and moved on — so every
   * id collected BEFORE it stayed claimed and every id AFTER it was dropped.
   * That silently NARROWS the one set that stops this deploy adopting a
   * resource another stack still owns.
   *
   * The assertion is NOT "no throw", which passed before the fix: it is that
   * the ids AFTER the bad row ARE claimed. Object key order is insertion
   * order, so `Bad` is planted FIRST.
   */
  it('keeps collecting a sibling`s ids past an unreadable ROW, rather than stopping at it', async () => {
    backend.listStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);
    backend.getState.mockResolvedValue({
      state: {
        resources: {
          Bad: null,
          Typeless: { physicalId: 'after-typeless' },
          Str: 'abc',
          Empty: { physicalId: '' },
          // A NON-STRING id: `!== undefined` would claim the number 42, which
          // no live resource is named by, and report nothing for the row.
          Num: { physicalId: 42 },
          Fine: { physicalId: 'after-bad' },
        },
      },
    });

    // `Typeless` still names a physical id, so it is a CLAIM this set must
    // keep — the predicate here is the id, not `isReadableResourceEntry`'s
    // `resourceType`, which this walk never reads. An EMPTY id claims nothing,
    // and neither does a non-string one.
    const claimed = await readSiblings(makeEngine());
    expect([...claimed].sort()).toEqual(['after-bad', 'after-typeless']);
    expect(claimed.has(42 as unknown as string)).toBe(false);
  });

  it('still walks a LIST-shaped sibling bag, so its ids stay claimed (fail-closed)', async () => {
    // Maintainer review M2 on go-to-k/cdkd#3758: `Object.values` claimed the
    // element's id before this lane, and a claim dropped is a record this stack
    // may adopt while the sibling still owns it — the operator repairs the
    // sibling's list into a map, and `cdkd destroy` of the sibling then deletes
    // this stack's live resource. `isReadableBag` rejects an array, which is
    // why it is NOT the test here.
    backend.listStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);
    backend.getState.mockResolvedValue({
      state: { resources: [{ physicalId: 'from-list' }, null, { physicalId: '' }] },
    });
    const debug = vi.fn();
    const claimed = await makeSiblingClaimReader({
      stateBackend: backend as unknown as never,
      selfStackName: 'MyStack',
      selfRegion: 'us-east-1',
      logger: { debug },
    })();
    expect([...claimed]).toEqual(['from-list']);
    // The two unusable elements are reported by index, as rows.
    const said = debug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toMatch(/2 resource record\(s\) with no readable physical id/);
    expect(said).not.toContain("no readable 'resources' map");
  });

  it('skips a NULL sibling bag with the bag diagnosis, and keeps collecting from the next sibling', async () => {
    // `typeof null === 'object'`, so the `|| bag === null` half of the guard
    // is what routes a null bag to the bag diagnosis; without it
    // `Object.entries(null)` throws into the per-sibling catch, the claim set
    // stays the same (inert) and the diagnosis names an unreadable STATE
    // rather than the bag — which is what this pins.
    backend.listStacks.mockResolvedValue([
      { stackName: 'NullBag', region: 'us-east-1' },
      { stackName: 'Fine', region: 'us-east-1' },
    ]);
    backend.getState
      .mockResolvedValueOnce({ state: { resources: null } })
      .mockResolvedValueOnce({ state: { resources: { A: { physicalId: 'fine-a' } } } });
    const debug = vi.fn();
    const claimed = await makeSiblingClaimReader({
      stateBackend: backend as unknown as never,
      selfStackName: 'MyStack',
      selfRegion: 'us-east-1',
      logger: { debug },
    })();
    expect([...claimed]).toEqual(['fine-a']);
    const said = debug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('NullBag');
    expect(said).toContain("no readable 'resources' map");
    expect(said, 'the null bag fell into the catch instead of the bag diagnosis').not.toContain(
      'skipping unreadable state'
    );
  });

  it('skips a sibling whose resources BAG is unreadable, and claims no fabricated id from it', async () => {
    backend.listStacks.mockResolvedValue([
      { stackName: 'Broken', region: 'us-east-1' },
      { stackName: 'Fine', region: 'us-east-1' },
    ]);
    backend.getState
      // `Object.values('abc')` used to walk the string one character at a time,
      // each one's `physicalId` `undefined` — so the set gained a claim on
      // `undefined` and nothing else. A `[]` bag was walked as an empty map.
      .mockResolvedValueOnce({ state: { resources: 'abc' } })
      .mockResolvedValueOnce({ state: { resources: { A: { physicalId: 'fine-a' } } } });

    const claimed = await readSiblings(makeEngine());
    expect([...claimed]).toEqual(['fine-a']);
    expect(claimed.has(undefined as unknown as string)).toBe(false);
  });

  /**
   * The DIAGNOSIS half, which the two cases above cannot see: for the CLAIMED
   * set the bag guard is equivalent to walking the bag anyway (a string's
   * characters are not objects, so they are skipped as rows; a `null` bag
   * throws into the per-sibling catch) — measured, both mutants stayed green
   * on the set alone. What the guard and the row list buy is that the
   * narrowing is SAID, at the level the sibling-skip beside them already uses,
   * naming the record and the rows rather than one character per row.
   */
  it('says at DEBUG which sibling record, and which rows, it could not read', async () => {
    backend.listStacks.mockResolvedValue([
      { stackName: 'BagBroken', region: 'us-east-1' },
      { stackName: 'RowBroken', region: 'us-east-1' },
    ]);
    backend.getState
      .mockResolvedValueOnce({ state: { resources: 'abc' } })
      .mockResolvedValueOnce({
        state: {
          resources: { Bad: null, Fine: { physicalId: 'fine' }, Typeless: {}, Num: { physicalId: 42 } },
        },
      });
    const debug = vi.fn();
    const claimed = await makeSiblingClaimReader({
      stateBackend: backend as unknown as never,
      selfStackName: 'MyStack',
      selfRegion: 'us-east-1',
      logger: { debug },
    })();
    expect([...claimed]).toEqual(['fine']);
    const said = debug.mock.calls.map((c) => String(c[0])).join('\n');
    // The BAG, named as a bag — not as three rows called `0`, `1`, `2`.
    expect(said).toContain('BagBroken');
    expect(said).toContain("no readable 'resources' map");
    expect(said).not.toMatch(/\b0\b.*\b1\b.*\b2\b/);
    // The ROWS, each by logical id, and the healthy one not among them.
    expect(said).toContain('RowBroken');
    expect(said).toMatch(/3 resource record\(s\) with no readable physical id/);
    expect(said).toContain('Bad');
    expect(said).toContain('Typeless');
    // The non-string id is REPORTED, not claimed: `!== undefined` would do the
    // reverse on exactly this row.
    expect(said).toContain('Num');
    expect(said).not.toContain('Fine');
  });

  it('caps the rows the debug line names at five, and counts the rest', async () => {
    // A planted sibling record with thousands of torn rows must not render one
    // debug line per byte of it — the cap `namedEntriesClause` takes for the
    // user-facing texts (review of go-to-k/cdkd#3202).
    const resources: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) resources[`Torn${i}`] = null;
    backend.listStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);
    backend.getState.mockResolvedValue({ state: { resources } });
    const debug = vi.fn();
    await makeSiblingClaimReader({
      stateBackend: backend as unknown as never,
      selfStackName: 'MyStack',
      selfRegion: 'us-east-1',
      logger: { debug },
    })();
    const said = debug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('8 resource record(s)');
    for (let i = 0; i < 5; i++) expect(said).toContain(`Torn${i}`);
    expect(said).not.toContain('Torn5');
    expect(said).toContain('and 3 more');
  });
});
