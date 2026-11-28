import { describe, it, expect, vi } from 'vite-plus/test';
import {
  DESTROY_DELETE_CONCURRENCY_FLOOR,
  destroyDeleteConcurrency,
  runDeletesInDependencyOrder,
} from '../../../src/cli/commands/destroy-runner/delete-dag.js';
import { buildDeleteGraph } from '../../../src/cli/commands/destroy-runner/under-lock-steps.js';
import type { StackState, SupersededResourceRecord } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#7208: destroy deletes event-driven, not one level at a time.
 * Each case pins one guarantee the level walk gave: a resource never goes
 * before what depends on it (every edge source), the SIGINT drain, the
 * superseded slots, and the concurrency bound.
 */

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

type Rec = { type: string; deps?: string[]; props?: Record<string, unknown>; physicalId?: string };

function makeState(resources: Record<string, Rec>): StackState {
  return {
    version: 18,
    stackName: 'S',
    region: 'us-east-1',
    resources: Object.fromEntries(
      Object.entries(resources).map(([id, r]) => [
        id,
        {
          physicalId: r.physicalId ?? id.toLowerCase(),
          resourceType: r.type,
          properties: r.props ?? {},
          ...(r.deps && { dependencies: r.deps }),
        },
      ])
    ),
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

/** Runs the walk with per-id delays, recording start/end times. */
async function run(
  state: StackState,
  opts: {
    delayMs?: Record<string, number>;
    slots?: SupersededResourceRecord[][];
    interruptAfter?: string;
  } = {}
) {
  const { dagBuilder, graph, executionLevels } = buildDeleteGraph(state, logger as never);
  const events: string[] = [];
  const started = new Map<string, number>();
  const ended = new Map<string, number>();
  let clock = 0;
  let inFlight = 0;
  let peak = 0;
  let interrupted = false;
  const work = async (id: string): Promise<void> => {
    started.set(id, clock++);
    events.push(`start ${id}`);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs?.[id] ?? 1));
    inFlight--;
    ended.set(id, clock++);
    events.push(`end ${id}`);
    if (opts.interruptAfter === id) interrupted = true;
  };
  await runDeletesInDependencyOrder({
    dagBuilder,
    graph,
    executionLevels,
    supersededSlots: opts.slots ?? [],
    deleteResource: work,
    deleteSupersededRow: (entry) => work(`old:${entry.logicalId}`),
    interrupted: () => interrupted,
  });
  const before = (a: string, b: string): boolean =>
    ended.has(a) && started.has(b) && ended.get(a)! < started.get(b)!;
  return { events, started, ended, peak, before, executionLevels };
}

describe('runDeletesInDependencyOrder (#7208)', () => {
  it('does not hold an unrelated chain behind a slow delete on the same level', async () => {
    // Chain P -> Q -> R, and Slow -> T. Q and T share deletion step 1; under
    // the level walk Q waited for Slow.
    const state = makeState({
      R: { type: 'AWS::SQS::Queue' },
      Q: { type: 'AWS::SQS::Queue', deps: ['R'] },
      P: { type: 'AWS::SQS::Queue', deps: ['Q'] },
      T: { type: 'AWS::SQS::Queue' },
      Slow: { type: 'AWS::SQS::Queue', deps: ['T'] },
    });
    const r = await run(state, { delayMs: { Slow: 60 } });
    expect(r.before('P', 'Q')).toBe(true);
    expect(r.before('Q', 'R')).toBe(true);
    expect(r.before('Slow', 'T')).toBe(true);
    // R (step 2) finished before the slow step-0 delete did.
    expect(r.ended.get('R')!).toBeLessThan(r.ended.get('Slow')!);
  });

  it('keeps every edge source: recorded, type pair, composite alarm, custom resource policy', async () => {
    const state = makeState({
      // Recorded: Fn depends on Role.
      Role: { type: 'AWS::IAM::Role' },
      Fn: { type: 'AWS::Lambda::Function', deps: ['Role'] },
      // Type pair: Subnet after every Lambda (no reference between them).
      Subnet: { type: 'AWS::EC2::Subnet' },
      // Per-resource: a composite alarm before the alarm its rule names.
      Child: { type: 'AWS::CloudWatch::Alarm', physicalId: 'child-alarm' },
      Composite: {
        type: 'AWS::CloudWatch::CompositeAlarm',
        props: { AlarmRule: 'ALARM("child-alarm")' },
      },
      // Custom resource before its handler role's policy.
      Grants: { type: 'AWS::IAM::Policy', deps: ['Role'] },
      Cr: { type: 'Custom::Thing', deps: ['Fn'] },
    });
    // Make the "before" side slow each time, so only an edge holds the order.
    const r = await run(state, {
      delayMs: { Fn: 30, Composite: 30, Cr: 30 },
    });
    expect(r.before('Fn', 'Role')).toBe(true);
    expect(r.before('Fn', 'Subnet')).toBe(true);
    expect(r.before('Composite', 'Child')).toBe(true);
    expect(r.before('Cr', 'Grants')).toBe(true);
    expect(r.before('Cr', 'Fn')).toBe(true);
    expect(r.started.size).toBe(7);
  });

  it('starts no new delete once interrupted, and finishes the ones in flight', async () => {
    const state = makeState({
      C: { type: 'AWS::SQS::Queue' },
      B: { type: 'AWS::SQS::Queue', deps: ['C'] },
      A: { type: 'AWS::SQS::Queue', deps: ['B'] },
      Side: { type: 'AWS::SQS::Queue' },
    });
    const r = await run(state, { delayMs: { Side: 40 }, interruptAfter: 'A' });
    expect(r.started.has('A')).toBe(true);
    // In flight when the interrupt came: finished.
    expect(r.ended.has('Side')).toBe(true);
    expect(r.started.has('B')).toBe(false);
    expect(r.started.has('C')).toBe(false);
  });

  it('runs a superseded slot after every earlier step and before its own step', async () => {
    // Deletion steps (creation levels reversed): 0 {A, Lone}, 1 {B, M},
    // 2 {C, N}. Slot 1 holds two rows.
    const state = makeState({
      C: { type: 'AWS::SQS::Queue' },
      B: { type: 'AWS::SQS::Queue', deps: ['C'] },
      A: { type: 'AWS::SQS::Queue', deps: ['B'] },
      N: { type: 'AWS::SQS::Queue' },
      M: { type: 'AWS::SQS::Queue', deps: ['N'] },
      Lone: { type: 'AWS::SQS::Queue', deps: ['M'] },
    });
    const row = (logicalId: string) =>
      ({
        logicalId,
        state: { physicalId: `old-${logicalId}`, resourceType: 'AWS::SQS::Queue' },
      }) as unknown as SupersededResourceRecord;
    const r = await run(state, {
      slots: [[], [row('X'), row('Y')], []],
      delayMs: { Lone: 30 },
    });
    // After every step-0 delete, the slow unrelated one included.
    expect(r.before('A', 'old:X')).toBe(true);
    expect(r.before('Lone', 'old:X')).toBe(true);
    // One after another, in slot order.
    expect(r.before('old:X', 'old:Y')).toBe(true);
    // Before every step-1 resource, and through them every later step.
    expect(r.before('old:Y', 'B')).toBe(true);
    expect(r.before('old:Y', 'M')).toBe(true);
    expect(r.before('old:Y', 'C')).toBe(true);
    expect(r.before('old:Y', 'N')).toBe(true);
  });

  it('leaves the last slot to the caller', async () => {
    const state = makeState({ A: { type: 'AWS::SQS::Queue' } });
    const row = {
      logicalId: 'Gone',
      state: { physicalId: 'old', resourceType: 'AWS::SQS::Queue' },
    } as unknown as SupersededResourceRecord;
    const r = await run(state, { slots: [[], [row]] });
    expect(r.started.has('old:Gone')).toBe(false);
  });

  it('never gives a superseded row a node id equal to a logical id', async () => {
    const id = '\u0000superseded#0';
    const state = makeState({ [id]: { type: 'AWS::SQS::Queue' }, B: { type: 'AWS::SQS::Queue' } });
    const row = {
      logicalId: 'X',
      state: { physicalId: 'old', resourceType: 'AWS::SQS::Queue' },
    } as unknown as SupersededResourceRecord;
    const r = await run(state, { slots: [[row]] });
    expect(r.started.has(id)).toBe(true);
    expect(r.started.has('old:X')).toBe(true);
    expect(r.before('old:X', id)).toBe(true);
  });

  it('runs a wide flat level all at once, as the level walk did', async () => {
    const wide = DESTROY_DELETE_CONCURRENCY_FLOOR + 5;
    const state = makeState(
      Object.fromEntries(
        Array.from({ length: wide }, (_, i) => [`Q${i}`, { type: 'AWS::SQS::Queue' }])
      )
    );
    const r = await run(state, { delayMs: Object.fromEntries([...Array(wide)].map((_, i) => [`Q${i}`, 20])) });
    expect(r.peak).toBe(wide);
  });

  it('passes the larger of the floor and the widest level as the bound', () => {
    expect(destroyDeleteConcurrency([['a'], ['b', 'c']])).toBe(DESTROY_DELETE_CONCURRENCY_FLOOR);
    const wide = Array.from({ length: DESTROY_DELETE_CONCURRENCY_FLOOR + 7 }, (_, i) => `r${i}`);
    expect(destroyDeleteConcurrency([['a'], wide])).toBe(wide.length);
    expect(destroyDeleteConcurrency([])).toBe(DESTROY_DELETE_CONCURRENCY_FLOOR);
  });

  it('starts a dependency as soon as its dependents finish, beside slow deletes of an earlier level', async () => {
    // 10 slow isolated S and 10 chains X -> Y. Creation levels: 0 {S, Y},
    // 1 {X}; the level walk deleted every X, then S and Y together.
    const k = 10;
    const resources: Record<string, Rec> = {};
    const delayMs: Record<string, number> = {};
    for (let i = 0; i < k; i++) {
      resources[`S${i}`] = { type: 'AWS::SQS::Queue' };
      delayMs[`S${i}`] = 80;
      resources[`Y${i}`] = { type: 'AWS::SQS::Queue' };
      resources[`X${i}`] = { type: 'AWS::SQS::Queue', deps: [`Y${i}`] };
    }
    const r = await run(makeState(resources), { delayMs });
    for (let i = 0; i < k; i++) {
      expect(r.before(`X${i}`, `Y${i}`)).toBe(true);
      // Started at once with the X deletes, not after them.
      expect(r.started.get(`S${i}`)!).toBeLessThan(r.ended.get(`X${i}`)!);
    }
    expect(r.peak).toBeLessThanOrEqual(DESTROY_DELETE_CONCURRENCY_FLOOR);
  });
});
