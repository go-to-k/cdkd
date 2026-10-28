// Issue #5184: waitForFlipToSettleBeforeFinalSnapshot, the wait every
// RDS-family provider runs between a `--remove-protection` flip and a delete
// that takes a final snapshot. Right after the flip AWS can read protection
// OFF and `available` before the modification surfaces as `modifying`; a
// delete sent then is refused. The per-provider wiring is pinned by
// tests/unit/provisioning/remove-protection-final-snapshot-wait-5155.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  FLIP_TRANSITION_GRACE_MS,
  deleteAfterProtectionFlipWithFinalSnapshot,
  isFinalSnapshotNotAvailableRefusal,
  isProceedDbStatus,
  isTerminalDbStatus,
  isTerminalDbWaitStatus,
  waitForFlipToSettleBeforeFinalSnapshot,
  type FlipSettleReading,
} from '../../../../src/provisioning/providers/deletion-protection-compensation.js';
import type { Logger } from '../../../../src/types/config.js';

const OFF = (status: string): FlipSettleReading => ({ deletionProtection: false, status });
const ON = (status: string): FlipSettleReading => ({ deletionProtection: true, status });

let clock = 0;

/** Runs the wait over `readings` (the last one repeats); sleeping advances the clock. */
async function run(
  readings: Array<FlipSettleReading | undefined>,
  opts: { remainingMs?: number; maxWaitMs?: number } = {}
) {
  const queue = [...readings];
  const reads: Array<FlipSettleReading | undefined> = [];
  const sleeps: number[] = [];
  const logger = { debug: vi.fn() } as unknown as Logger;
  const outcome = await waitForFlipToSettleBeforeFinalSnapshot({
    noun: 'cluster',
    label: 'DBCluster',
    logicalId: 'Db',
    read: async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      reads.push(next);
      return next;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    logger,
    remainingMs: opts.remainingMs ?? Number.POSITIVE_INFINITY,
    ...(opts.maxWaitMs !== undefined ? { maxWaitMs: opts.maxWaitMs } : {}),
  }).then(
    () => undefined,
    (e: unknown) => e as Error
  );
  return { error: outcome, reads, sleeps };
}

describe('waitForFlipToSettleBeforeFinalSnapshot (#5184)', () => {
  beforeEach(() => {
    clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits through modifying when the first read is guard OFF and available', async () => {
    const { error, reads, sleeps } = await run([
      OFF('available'),
      OFF('modifying'),
      OFF('modifying'),
      OFF('available'),
    ]);

    expect(error).toBeUndefined();
    expect(reads).toHaveLength(4);
    expect(sleeps).toEqual([5_000, 10_000, 10_000]);
  });

  it('adds no grace once modifying was seen: the first settled read after it ends the wait', async () => {
    const { error, reads, sleeps } = await run([OFF('modifying'), OFF('available')]);

    expect(error).toBeUndefined();
    expect(reads).toHaveLength(2);
    expect(sleeps).toEqual([5_000]);
  });

  it('lets a flip that never shows modifying through after exactly the grace window', async () => {
    const { error, reads, sleeps } = await run([OFF('available')]);

    expect(error).toBeUndefined();
    // The last sleep is trimmed so the grace ends on time, not at 35s.
    expect(sleeps).toEqual([5_000, 10_000, 10_000, 5_000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(FLIP_TRANSITION_GRACE_MS);
    expect(reads).toHaveLength(5);
  });

  it('keeps waiting while the guard still reads ON, then gives the OFF read its own grace window', async () => {
    // Seven ON reads span 65s of sleep; only the guard readback holds the wait.
    // The grace clock then starts at the first OFF read: three more sleeps
    // (30s) before the delete.
    const { error, reads, sleeps } = await run([
      ...Array(7).fill(ON('available')),
      OFF('available'),
    ]);

    expect(error).toBeUndefined();
    expect(reads).toHaveLength(11);
    expect(sleeps.slice(7)).toEqual([10_000, 10_000, 10_000]);
  });

  it('does not count the time the guard read ON toward the grace window (#5184)', async () => {
    // ON for 35s of sleep, then OFF and `available`: the wait's own clock is
    // already past 30s, but the modification has had no time to surface after
    // the OFF readback, so the first OFF read must not end the wait.
    const { error, reads } = await run([...Array(4).fill(ON('available')), OFF('available')]);

    expect(error).toBeUndefined();
    // 4 ON reads, then OFF reads after 0, 10, 20 and 30s of grace.
    expect(reads).toHaveLength(8);
  });

  it('waits out a transitional status other than modifying, then ends on available', async () => {
    const { error, reads } = await run([
      OFF('configuring-enhanced-monitoring'),
      OFF('configuring-enhanced-monitoring'),
      OFF('available'),
    ]);

    expect(error).toBeUndefined();
    // No grace added once a transitional status was seen.
    expect(reads).toHaveLength(3);
  });

  it('sends at the bound when a transitional status other than modifying outlasts it (pre-#5184 behaviour)', async () => {
    const { error, reads } = await run([OFF('upgrading')], { maxWaitMs: 60_000 });

    expect(error).toBeUndefined();
    expect(reads.length).toBeGreaterThan(1);
  });

  it('treats a read with no status as transitional: waits, and fails closed at the bound', async () => {
    const { error } = await run([{ deletionProtection: false, status: undefined }], {
      maxWaitMs: 60_000,
    });

    expect(error?.message).toContain("did not return to 'available'");
  });

  it('ends at once in storage-optimization with the guard off (fully operational, can last hours)', async () => {
    const { error, reads, sleeps } = await run([OFF('storage-optimization')]);

    expect(error).toBeUndefined();
    expect(reads).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('throws at once when the guard reads ON in a terminal status (fail closed)', async () => {
    const { error, reads } = await run([ON('stopped')]);

    expect(error?.message).toContain("still reads it ON in status 'stopped'");
    expect(reads).toHaveLength(1);
  });

  it('does not count a still-available storage status as transitional for the grace window', async () => {
    // ON in storage-optimization, then OFF and available: no transitional
    // status was seen, so the OFF read still gets its 30s of grace.
    const { error, reads } = await run([ON('storage-optimization'), OFF('available')]);

    expect(error).toBeUndefined();
    // 1 ON read, then OFF reads after 0, 10, 20 and 30s of grace.
    expect(reads).toHaveLength(5);
  });

  it('ends at once on a terminal status with the guard off', async () => {
    const { error, reads, sleeps } = await run([OFF('stopped')]);

    expect(error).toBeUndefined();
    expect(reads).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('ends at once when the resource is gone', async () => {
    const { error, reads, sleeps } = await run([undefined]);

    expect(error).toBeUndefined();
    expect(reads).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('fails closed on a timeout while still modifying, naming the next step', async () => {
    const { error, sleeps } = await run([OFF('modifying')], { maxWaitMs: 3 * 60_000 });

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("the cluster did not return to 'available' within 3 minutes");
    expect(error?.message).toContain('re-run the destroy');
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(3 * 60_000);
  });

  it('fails closed on a timeout while the guard still reads ON', async () => {
    const { error } = await run([ON('available')], { maxWaitMs: 60_000 });

    expect(error?.message).toContain("did not return to 'available'");
  });

  it('lets a settled read through when the bound falls inside the grace window', async () => {
    // Nothing showed the resource is not ready; refusing would block a delete
    // the bound alone cut short.
    const { error, reads } = await run([OFF('available')], { maxWaitMs: 12_000 });

    expect(error).toBeUndefined();
    expect(reads).toHaveLength(2);
  });

  it('refuses before any read when the resource timeout leaves less than the margin', async () => {
    const { error, reads } = await run([OFF('available')], { remainingMs: 30_000 });

    expect(error?.message).toContain('the resource timeout leaves no time');
    expect(reads).toHaveLength(0);
  });
});

function refusal(name: string, message: string): Error {
  return Object.assign(new Error(message), { name, $fault: 'client' });
}
const CLUSTER_NOT_AVAILABLE = refusal(
  'InvalidDBClusterStateFault',
  "Can't create a snapshot because the database cluster c isn't currently in the available state."
);
const MEMBER = refusal(
  'InvalidDBClusterStateFault',
  'Cluster cannot be deleted, it still contains DB instances in non-deleting state.'
);

describe('isFinalSnapshotNotAvailableRefusal (#5184)', () => {
  it('matches the not-available refusal of the named class only', () => {
    expect(isFinalSnapshotNotAvailableRefusal(CLUSTER_NOT_AVAILABLE, 'InvalidDBClusterStateFault')).toBe(true);
    // The instance wording measured live for #1160, copied verbatim.
    expect(
      isFinalSnapshotNotAvailableRefusal(
        refusal('InvalidDBInstanceStateFault', 'Database instance is not in available state'),
        'InvalidDBInstanceStateFault'
      )
    ).toBe(true);
    // AWS's typographic apostrophe.
    expect(
      isFinalSnapshotNotAvailableRefusal(
        refusal('InvalidDBClusterStateFault', 'The database cluster c isn’t currently in the available state.'),
        'InvalidDBClusterStateFault'
      )
    ).toBe(true);
    expect(isFinalSnapshotNotAvailableRefusal(MEMBER, 'InvalidDBClusterStateFault')).toBe(false);
    expect(isFinalSnapshotNotAvailableRefusal(CLUSTER_NOT_AVAILABLE, 'InvalidDBInstanceStateFault')).toBe(false);
    expect(isFinalSnapshotNotAvailableRefusal('isn\'t currently in the available state', 'InvalidDBClusterStateFault')).toBe(false);
  });
});

describe('isTerminalDbStatus (#5184)', () => {
  it('denies only the statuses no wait outlasts', () => {
    for (const status of [
      'deleting',
      'failed',
      'stopped',
      'storage-full',
      'insufficient-capacity',
      'restore-error',
      'inaccessible-encryption-credentials',
      'inaccessible-encryption-credentials-recoverable',
      'incompatible-parameters',
      'incompatible-network',
      'cloning-failed',
      'migration-failed',
    ]) {
      expect(isTerminalDbStatus(status), status).toBe(true);
    }
    for (const status of [
      'available',
      'modifying',
      'configuring-enhanced-monitoring',
      'configuring-iam-database-auth',
      'backing-up',
      'upgrading',
      'maintenance',
      'storage-optimization',
      'resetting-master-credentials',
      'renaming',
      'starting',
      'stopping',
      'some-status-aws-adds-later',
      undefined,
    ]) {
      expect(isTerminalDbStatus(status), String(status)).toBe(false);
    }
  });
});

describe('isProceedDbStatus (#5184)', () => {
  it('admits available and the documented still-available storage statuses only', () => {
    expect(isProceedDbStatus('available')).toBe(true);
    expect(isProceedDbStatus('storage-optimization')).toBe(true);
    expect(isProceedDbStatus('storage-initialization')).toBe(true);
    for (const status of ['modifying', 'configuring-enhanced-monitoring', 'backing-up', 'stopped', undefined]) {
      expect(isProceedDbStatus(status), String(status)).toBe(false);
    }
  });
});

describe('deleteAfterProtectionFlipWithFinalSnapshot (#5184)', () => {
  beforeEach(() => {
    clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `sendResults`: one entry per send, an Error to throw or undefined to accept (the last repeats). */
  async function runDelete(
    readings: Array<FlipSettleReading | undefined>,
    sendResults: Array<Error | undefined>,
    opts: { maxWaitMs?: number } = {}
  ) {
    const queue = [...readings];
    const results = [...sendResults];
    let reads = 0;
    let sends = 0;
    const sleeps: number[] = [];
    const error = await deleteAfterProtectionFlipWithFinalSnapshot({
      noun: 'cluster',
      label: 'DBCluster',
      logicalId: 'Db',
      stateFault: 'InvalidDBClusterStateFault',
      read: async () => {
        reads += 1;
        return queue.length > 1 ? queue.shift() : queue[0];
      },
      send: async () => {
        sends += 1;
        const next = results.length > 1 ? results.shift() : results[0];
        if (next) throw next;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      logger: { debug: vi.fn() } as unknown as Logger,
      remainingMs: Number.POSITIVE_INFINITY,
      ...(opts.maxWaitMs !== undefined ? { maxWaitMs: opts.maxWaitMs } : {}),
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    return { error, reads, sends, sleeps };
  }

  it('sends once when AWS accepts the delete', async () => {
    const { error, sends } = await runDelete([OFF('modifying'), OFF('available')], [undefined]);

    expect(error).toBeUndefined();
    expect(sends).toBe(1);
  });

  it('retries a not-available refusal once the resource reads available again', async () => {
    // Refused, then the readback shows the modification, then available.
    const { error, sends, reads } = await runDelete(
      [OFF('modifying'), OFF('available'), OFF('modifying'), OFF('available')],
      [CLUSTER_NOT_AVAILABLE, undefined]
    );

    expect(error).toBeUndefined();
    expect(sends).toBe(2);
    // Two reads before the first send, then modifying, then available.
    expect(reads).toBe(4);
  });

  it('rethrows the last refusal when it persists to the bound, so the guard is put back', async () => {
    const { error, sends } = await runDelete(
      [OFF('modifying'), OFF('available')],
      [CLUSTER_NOT_AVAILABLE],
      { maxWaitMs: 3 * 60_000 }
    );

    expect(error).toBe(CLUSTER_NOT_AVAILABLE);
    expect(sends).toBeGreaterThan(1);
    expect(sends).toBeLessThan(30);
  });

  it('waits out configuring-enhanced-monitoring after a refusal, then retries (#5184 live shape)', async () => {
    const { error, sends, reads } = await runDelete(
      [
        OFF('modifying'),
        OFF('available'),
        OFF('configuring-enhanced-monitoring'),
        OFF('configuring-enhanced-monitoring'),
        OFF('available'),
      ],
      [CLUSTER_NOT_AVAILABLE, undefined]
    );

    expect(error).toBeUndefined();
    expect(sends).toBe(2);
    expect(reads).toBe(5);
  });

  it('retries at once when the resource reads storage-optimization after a refusal', async () => {
    const { error, sends, reads } = await runDelete(
      [OFF('modifying'), OFF('available'), OFF('storage-optimization')],
      [CLUSTER_NOT_AVAILABLE, undefined]
    );

    expect(error).toBeUndefined();
    expect(sends).toBe(2);
    expect(reads).toBe(3);
  });

  it('rethrows at once when the resource reads a terminal status after the refusal', async () => {
    const { error, sends, reads } = await runDelete(
      [OFF('modifying'), OFF('available'), OFF('stopped')],
      [CLUSTER_NOT_AVAILABLE, undefined]
    );

    expect(error).toBe(CLUSTER_NOT_AVAILABLE);
    expect(sends).toBe(1);
    // One read after the refusal, not a wait to the cap.
    expect(reads).toBe(3);
  });

  it('keeps -recoverable terminal after a refusal: rethrows at once (#5426)', async () => {
    const { error, sends, reads } = await runDelete(
      [
        OFF('modifying'),
        OFF('available'),
        OFF('inaccessible-encryption-credentials-recoverable'),
        OFF('available'),
      ],
      [CLUSTER_NOT_AVAILABLE, undefined]
    );

    expect(error).toBe(CLUSTER_NOT_AVAILABLE);
    expect(sends).toBe(1);
    expect(reads).toBe(3);
  });

  it('rethrows at once when the guard reads ON again after the refusal', async () => {
    const { error, sends, reads } = await runDelete(
      [OFF('modifying'), OFF('available'), ON('available')],
      [CLUSTER_NOT_AVAILABLE, undefined]
    );

    expect(error).toBe(CLUSTER_NOT_AVAILABLE);
    expect(sends).toBe(1);
    expect(reads).toBe(3);
  });

  it('does not retry the member refusal of the same class', async () => {
    const { error, sends } = await runDelete([OFF('modifying'), OFF('available')], [MEMBER]);

    expect(error).toBe(MEMBER);
    expect(sends).toBe(1);
  });

  it('propagates a read failure after a refusal (a gone resource\'s NotFoundFault reaches the caller)', async () => {
    const notFound = refusal('DBClusterNotFoundFault', 'DBCluster c not found.');
    let sends = 0;
    let reads = 0;
    const error = await deleteAfterProtectionFlipWithFinalSnapshot({
      noun: 'cluster',
      label: 'DBCluster',
      logicalId: 'Db',
      stateFault: 'InvalidDBClusterStateFault',
      read: async () => {
        reads += 1;
        if (reads <= 2) return reads === 1 ? OFF('modifying') : OFF('available');
        throw notFound;
      },
      send: async () => {
        sends += 1;
        throw CLUSTER_NOT_AVAILABLE;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      logger: { debug: vi.fn() } as unknown as Logger,
      remainingMs: Number.POSITIVE_INFINITY,
    }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(error).toBe(notFound);
    expect(sends).toBe(1);
  });

  it('sends again after a refusal on an empty read (defensive branch; real describes throw NotFound)', async () => {
    const { error, sends, reads } = await runDelete(
      [OFF('modifying'), OFF('available'), undefined],
      [CLUSTER_NOT_AVAILABLE, undefined]
    );

    expect(error).toBeUndefined();
    expect(sends).toBe(2);
    expect(reads).toBe(3);
  });
});

describe('isTerminalDbWaitStatus (#5426)', () => {
  it('is isTerminalDbStatus except for inaccessible-encryption-credentials-recoverable', () => {
    expect(isTerminalDbWaitStatus('inaccessible-encryption-credentials-recoverable')).toBe(false);
    for (const status of [
      'deleting',
      'failed',
      'stopped',
      'storage-full',
      'insufficient-capacity',
      'restore-error',
      'inaccessible-encryption-credentials',
      'incompatible-parameters',
      'incompatible-network',
      'cloning-failed',
    ]) {
      expect(isTerminalDbWaitStatus(status), status).toBe(true);
    }
    for (const status of ['available', 'creating', 'modifying', 'backing-up', undefined]) {
      expect(isTerminalDbWaitStatus(status), String(status)).toBe(false);
    }
  });
});

describe('the final-snapshot settle keeps -recoverable terminal (#5426)', () => {
  beforeEach(() => {
    clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the delete at once on -recoverable with the guard off', async () => {
    const { error, reads, sleeps } = await run([
      OFF('inaccessible-encryption-credentials-recoverable'),
      OFF('available'),
    ]);
    expect(error).toBeUndefined();
    expect(reads).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('fails closed at once on -recoverable with the guard still on', async () => {
    const { error, reads } = await run([
      ON('inaccessible-encryption-credentials-recoverable'),
      OFF('available'),
    ]);
    expect(error?.message).toContain(
      "still reads it ON in status 'inaccessible-encryption-credentials-recoverable'"
    );
    expect(reads).toHaveLength(1);
  });
});
