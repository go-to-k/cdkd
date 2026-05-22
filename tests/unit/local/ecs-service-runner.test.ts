import { describe, expect, it } from 'vite-plus/test';
import {
  backoffDelayMs,
  computeReplicaCount,
  createServiceRunState,
  EcsServiceRunnerError,
  shouldRestart,
} from '../../../src/local/ecs-service-runner.js';

describe('computeReplicaCount', () => {
  it('returns desiredCount when below maxTasks', () => {
    expect(computeReplicaCount(2, 5)).toBe(2);
  });

  it('clamps to maxTasks when desiredCount exceeds it', () => {
    expect(computeReplicaCount(10, 3)).toBe(3);
  });

  it('returns 1 when desiredCount is 0 (defensive — service with 0 replicas is meaningless locally)', () => {
    expect(computeReplicaCount(0, 3)).toBe(1);
  });

  it('returns 1 when desiredCount is negative', () => {
    expect(computeReplicaCount(-1, 3)).toBe(1);
  });

  it('rejects maxTasks=0 with an actionable error', () => {
    expect(() => computeReplicaCount(2, 0)).toThrow(EcsServiceRunnerError);
  });

  it('rejects negative maxTasks', () => {
    expect(() => computeReplicaCount(2, -1)).toThrow(/--max-tasks must be >= 1/);
  });

  it('equal values pass through unchanged', () => {
    expect(computeReplicaCount(3, 3)).toBe(3);
  });
});

describe('backoffDelayMs', () => {
  it('starts at 1000ms for the first restart', () => {
    expect(backoffDelayMs(0)).toBe(1000);
  });

  it('doubles each restart up to the cap', () => {
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
    expect(backoffDelayMs(3)).toBe(8000);
    expect(backoffDelayMs(4)).toBe(16000);
  });

  it('caps at 30000ms (30s) for high restart counts', () => {
    expect(backoffDelayMs(5)).toBe(30000);
    expect(backoffDelayMs(10)).toBe(30000);
    expect(backoffDelayMs(100)).toBe(30000);
  });
});

describe('shouldRestart', () => {
  it("'on-failure' restarts on non-zero exit", () => {
    expect(shouldRestart(1, 'on-failure')).toBe(true);
  });

  it("'on-failure' does NOT restart on zero exit (clean shutdown)", () => {
    expect(shouldRestart(0, 'on-failure')).toBe(false);
  });

  it("'on-failure' treats -1 (docker wait failure) as a restart trigger", () => {
    expect(shouldRestart(-1, 'on-failure')).toBe(true);
  });

  it("'always' restarts on every exit including 0", () => {
    expect(shouldRestart(0, 'always')).toBe(true);
    expect(shouldRestart(1, 'always')).toBe(true);
    expect(shouldRestart(-1, 'always')).toBe(true);
  });

  it("'none' never restarts", () => {
    expect(shouldRestart(0, 'none')).toBe(false);
    expect(shouldRestart(1, 'none')).toBe(false);
    expect(shouldRestart(-1, 'none')).toBe(false);
  });
});

describe('createServiceRunState', () => {
  it('returns an empty fresh run-state', () => {
    const state = createServiceRunState();
    expect(state.replicas).toEqual([]);
    expect(state.shuttingDown).toBe(false);
  });

  it('returns a new object every call (no shared mutable state across runs)', () => {
    const a = createServiceRunState();
    const b = createServiceRunState();
    expect(a).not.toBe(b);
    expect(a.replicas).not.toBe(b.replicas);
  });
});
