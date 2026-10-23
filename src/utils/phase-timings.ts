/**
 * Opt-in per-phase timing report for `cdkd deploy` (go-to-k/cdkd#5200).
 *
 * `CDKD_PHASE_TIMINGS=1` makes a deploy print, at its end, where its wall
 * clock went: synthesis, asset publishing, and per stack the lock, the state
 * load, the diff, the resource DAG, the state saves and the teardown. It makes
 * no AWS or S3 call of its own.
 *
 * Off (the default), every entry point returns at once: `lap` and `record`
 * compare one flag, and `time` calls its function directly.
 *
 * Two shapes of measurement:
 *
 * - A {@link PhaseClock} splits one sequence into consecutive laps, so the
 *   laps of a scope add up to its total and no time falls between two phases.
 * - {@link recordPhase} aggregates a repeated operation (each resource's
 *   provider call, each per-resource state save) into a count, a sum and the
 *   slowest occurrence. Repeated operations can overlap, so their sum is busy
 *   time, not wall clock.
 */
// Monotonic, and measured from the process's time origin. Read off the global
// per call, so a test's fake clock reaches it.
const now = (): number => globalThis.performance.now();

export const PHASE_TIMINGS_ENV = 'CDKD_PHASE_TIMINGS';

/** Read per call, so a test can flip it without re-importing. */
export function phaseTimingsEnabled(): boolean {
  return process.env[PHASE_TIMINGS_ENV] === '1';
}

/** The report scope of one stack's deploy: two stacks may share a name across regions. */
export function phaseScopeForStack(stackName: string, region: string): string {
  return `stack ${stackName} (${region})`;
}

interface PhaseEntry {
  scope: string;
  phase: string;
  /** A lap of a {@link PhaseClock} (wall clock), or an aggregate of a repeated operation. */
  kind: 'lap' | 'aggregate';
  count: number;
  totalMs: number;
  maxMs: number;
  maxLabel: string | undefined;
}

// Insertion order is report order: scope, then phase within it.
const entries = new Map<string, Map<string, PhaseEntry>>();

function entryFor(scope: string, phase: string, kind: PhaseEntry['kind']): PhaseEntry {
  let byPhase = entries.get(scope);
  if (byPhase === undefined) {
    byPhase = new Map();
    entries.set(scope, byPhase);
  }
  let entry = byPhase.get(phase);
  if (entry === undefined) {
    entry = { scope, phase, kind, count: 0, totalMs: 0, maxMs: 0, maxLabel: undefined };
    byPhase.set(phase, entry);
  }
  return entry;
}

function add(
  scope: string,
  phase: string,
  kind: PhaseEntry['kind'],
  ms: number,
  label?: string
): void {
  const entry = entryFor(scope, phase, kind);
  entry.count += 1;
  entry.totalMs += ms;
  if (ms >= entry.maxMs) {
    entry.maxMs = ms;
    entry.maxLabel = label;
  }
}

/** Aggregate one occurrence of a repeated operation. No-op when off. */
export function recordPhase(scope: string, phase: string, ms: number, label?: string): void {
  if (!phaseTimingsEnabled()) return;
  add(scope, phase, 'aggregate', ms, label);
}

/** Time `fn` as one occurrence of a repeated operation. Calls `fn` directly when off. */
export async function timePhase<T>(
  scope: string,
  phase: string,
  fn: () => Promise<T>,
  label?: string
): Promise<T> {
  if (!phaseTimingsEnabled()) return fn();
  const start = now();
  try {
    return await fn();
  } finally {
    add(scope, phase, 'aggregate', now() - start, label);
  }
}

/** {@link timePhase} for a synchronous `fn`: CPU work on the event loop. */
export function timePhaseSync<T>(scope: string, phase: string, fn: () => T, label?: string): T {
  if (!phaseTimingsEnabled()) return fn();
  const start = now();
  try {
    return fn();
  } finally {
    add(scope, phase, 'aggregate', now() - start, label);
  }
}

/**
 * Consecutive laps over one sequence: each `lap(phase)` records the time since
 * the previous lap (or since the clock was created).
 */
export class PhaseClock {
  private last: number;
  private readonly enabled: boolean;
  private readonly scope: string;

  /**
   * `fromProcessStart`: the first lap starts at the process's time origin, so
   * it holds Node's startup and the module load before the command ran.
   */
  constructor(scope: string, options: { fromProcessStart?: boolean } = {}) {
    this.scope = scope;
    this.enabled = phaseTimingsEnabled();
    this.last = this.enabled && options.fromProcessStart !== true ? now() : 0;
  }

  lap(phase: string): void {
    if (!this.enabled) return;
    const at = now();
    add(this.scope, phase, 'lap', at - this.last);
    this.last = at;
  }
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * The report, one line per phase, grouped by scope in first-seen order. Empty
 * when nothing was recorded.
 */
export function renderPhaseTimings(): string[] {
  if (entries.size === 0) return [];
  const all = [...entries.values()].flatMap((byPhase) => [...byPhase.values()]);
  const phaseWidth = Math.max(...all.map((e) => e.phase.length));
  const lines: string[] = ['Phase timings (CDKD_PHASE_TIMINGS=1):'];
  for (const [scope, byPhase] of entries) {
    const list = [...byPhase.values()];
    const laps = list.filter((e) => e.kind === 'lap');
    const lapTotal = laps.reduce((sum, e) => sum + e.totalMs, 0);
    lines.push(`  ${scope}${laps.length > 0 ? ` (${formatMs(lapTotal)} wall)` : ''}`);
    for (const e of list) {
      const name = e.phase.padEnd(phaseWidth);
      if (e.kind === 'lap' && e.count === 1) {
        const share =
          lapTotal > 0 ? ` ${String(Math.round((e.totalMs / lapTotal) * 100)).padStart(3)}%` : '';
        lines.push(`    ${name}  ${formatMs(e.totalMs).padStart(8)}${share}`);
      } else {
        const slowest =
          e.count > 1
            ? `, max ${formatMs(e.maxMs)}${e.maxLabel !== undefined ? ` (${e.maxLabel})` : ''}`
            : '';
        lines.push(`    ${name}  ${formatMs(e.totalMs).padStart(8)}  x${e.count}${slowest}`);
      }
    }
  }
  return lines;
}

/** @internal Test seam and per-run reset. */
export function resetPhaseTimings(): void {
  entries.clear();
}
