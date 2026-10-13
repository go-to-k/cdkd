import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeTableCommand,
  DeleteTableCommand,
  UpdateTableCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteScalingPolicyCommand,
  DeregisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';

/**
 * Issues #2053 and #1952, `AWS::DynamoDB::GlobalTable` half.
 *
 * Three wait families on ONE delete path, all of which had to learn the same
 * signal — issue #1952 says so explicitly: interrupting only one of them buys
 * little, because the path simply stalls in the next one.
 *
 *  - the four auto-scaling `withRetry` calls in `applyAutoScalingDiff` (#2053);
 *  - `waitForReplicaGone`, 600 polls (~12 min) per non-local replica;
 *  - `waitForTableGone`, 600 polls (~12 min) after the delete is accepted.
 *
 * The two gone-waits answer the signal DIFFERENTLY, and the asymmetry is the
 * point rather than an oversight: `waitForReplicaGone` runs BEFORE
 * `DeleteTable` (which AWS refuses while a replica lives), so nothing has been
 * accepted and it throws; `waitForTableGone` runs AFTER AWS accepted the
 * delete, so it warns and returns rather than turning an accepted delete into a
 * reported failure. That mirrors the throw/warn split those two methods already
 * had for budget exhaustion.
 *
 * THE DISCRIMINATOR IS THE CALL COUNT / THE OUTCOME, never "it finished":
 * un-threaded, all three finish too — minutes later.
 */

const { mockSend, mockAutoScalingSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

// One logger object for the whole module, reachable from the test body: the
// "AWS ACCEPTED the DeleteTable" line is the only thing that tells a user their
// delete WILL complete despite the Ctrl-C, so the assertion has to be on the
// text, not on the return.
vi.mock('../../../src/utils/logger.js', () => {
  const logger: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger['child'] = () => logger;
  return { getLogger: () => logger };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

import {
  DynamoDBGlobalTableProvider,
  TABLE_GONE_WAIT_ATTEMPTS,
  autoScalingRetryDelays,
  deleteTableRetryDelays,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { AUTO_SCALING_TEARDOWN_MAX_RETRIES } from '../../../src/provisioning/providers/dynamodb-delete-budget.js';
import { getLogger } from '../../../src/utils/logger.js';
import { ElapsedBudget } from '../../../src/utils/elapsed-budget.js';

const logger = getLogger() as unknown as { warn: ReturnType<typeof vi.fn> };

function warnLines(): string {
  return logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../src/provisioning/interrupt-watch.js';

const GLOBAL_TABLE = 'AWS::DynamoDB::GlobalTable';


/**
 * Stand in for the SIGINT handler every real command installs before it reaches
 * a provider (`forwardSigtermToSigint`, the engine's, `destroy-runner.ts`'s).
 *
 * The watch deliberately refuses to install the FIRST SIGINT listener — that
 * would disable Node's default terminate for a command that has no interrupt
 * handling of its own — and a vitest worker registers none, so without this the
 * watch would never arm and every case below would exercise the UNARMED path
 * while appearing to test the armed one.
 *
 * The disarm is because arming is a one-way door in production (the listener is
 * installed once and never removed, so a signal landing between two sequential
 * waits is still recorded), which makes a per-test cold start a test concern
 * rather than a production one. The latch is sticky for the same reason and
 * would otherwise leak a simulated Ctrl-C into every later test in the file.
 */
function armInterruptWatchForSuite(): void {
  disarmInterruptWatchForTests();
  interruptWatchTestSeam.commandOwnsInterrupts = () => true;
}

let baseline: readonly unknown[] = [];
let watchersSeenAtFire = -1;

/** Fire ONLY the listeners this call installed; the count is RECORDED, not asserted. */
function fireInterrupt(): void {
  const ours = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
  watchersSeenAtFire = ours.length;
  for (const listener of ours) (listener as unknown as () => void)();
}

function throttleError(): Error {
  return Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
}

describe('the GlobalTable delete path honours Ctrl-C (#2053 / #1952)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    logger.warn.mockClear();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    // Collapse the auto-scaling backoff: a REGRESSED run would spend ~47s per
    // call in real sleep, and a timed-out test reports "timed out" rather than
    // the attempt count this suite is about.
    autoScalingRetryDelays.sleep = () => Promise.resolve();
    deleteTableRetryDelays.sleep = () => Promise.resolve();
    armInterruptWatchForSuite();
    baseline = process.listeners('SIGINT');
    watchersSeenAtFire = -1;
  });

  afterEach(() => {
    delete autoScalingRetryDelays.sleep;
    delete deleteTableRetryDelays.sleep;
    expect(process.listeners('SIGINT').length).toBeLessThanOrEqual(baseline.length + 1);
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('auto-scaling teardown: stops at the attempt the signal landed in', async () => {
    // The teardown runs in a BURST — table-level read + write, then two per GSI
    // — before any budgeted poll, and every error in it is swallowed into a
    // warn. So the count is the only observable, and the warn is the only
    // narration.
    let policyDeletes = 0;
    mockAutoScalingSend.mockImplementation((command: unknown) => {
      if (
        command instanceof DeleteScalingPolicyCommand &&
        command.input.ScalableDimension === 'dynamodb:table:ReadCapacityUnits'
      ) {
        policyDeletes += 1;
        // The SECOND attempt, so the case also proves the loop retried at all.
        if (policyDeletes === 2) fireInterrupt();
        return Promise.reject(throttleError());
      }
      return Promise.resolve({ ScalableTargets: [], ScalingPolicies: [] });
    });
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        return Promise.resolve({
          Table: {
            TableName: 'orders',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) {
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await expect(
      new DynamoDBGlobalTableProvider().delete('Orders', 'orders', GLOBAL_TABLE, {})
    ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

    // THE discriminator: un-threaded this is 1 + AUTO_SCALING_TEARDOWN_MAX_RETRIES.
    expect(policyDeletes).toBe(2);
    expect(AUTO_SCALING_TEARDOWN_MAX_RETRIES).toBeGreaterThan(2);
    expect(watchersSeenAtFire).toBe(1);

    // The burst STOPS (issue #2053 review item 6). Every error in this teardown
    // is swallowed into a warn with an `aws application-autoscaling ...`
    // recovery command, and it runs table-level read + write, then twice per
    // GSI, then again per replica — so a swallowed interrupt printed a wall of
    // lines blaming AWS for a Ctrl-C and then carried straight on to the next
    // teardown WRITE.
    expect(warnLines()).not.toContain('Could not delete auto-scaling policy');
    expect(warnLines()).not.toContain('aws application-autoscaling');
    // ...and no `DeregisterScalableTarget` followed the aborted policy delete.
    expect(
      mockAutoScalingSend.mock.calls.filter(
        (c) => c[0] instanceof DeregisterScalableTargetCommand
      )
    ).toHaveLength(0);
    // The delete never reached `DeleteTable` either — the abort is at the front
    // of the path, not after a write.
    expect(mockSend.mock.calls.filter((c) => c[0] instanceof DeleteTableCommand)).toHaveLength(0);
  }, 120_000);

  it('LATCH: a signal in an EARLY wait is still seen by the waits after it', async () => {
    // Blocker 2, at the level it actually bites. `delete()` runs the #1521 gate,
    // then the index-busy retry loop, then the gone-wait — each disposing before
    // the next begins. Clearing the latch on dispose (the first cut) left both
    // multi-minute waits after the gate DEAF, which is issue #1952's own
    // scenario surviving its own fix. The signal is fired during the GATE here,
    // and the gone-wait after it must never poll.
    let describes = 0;
    let gateProbes = 0;
    let deleted = false;
    let goneProbes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        describes += 1;
        if (deleted) {
          goneProbes += 1;
        } else if (describes >= 2) {
          // The gate's own polls. The signal lands on its first one.
          gateProbes += 1;
          if (gateProbes === 1) fireInterrupt();
        }
        return Promise.resolve({
          Table: {
            TableName: 'orders',
            TableStatus: deleted ? 'DELETING' : 'ACTIVE',
            // Never settles, so the gate really polls rather than returning at
            // once — and the gone-wait never sees the table disappear either.
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'UPDATING' }],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) {
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await new DynamoDBGlobalTableProvider().delete('Orders', 'orders', GLOBAL_TABLE, {});

    // The gate saw the signal...
    expect(gateProbes).toBe(1);
    // ...and the gone-wait, which STARTS AFTER the gate disposed, inherited it
    // rather than beginning its own 600-poll cap. ZERO rather than one: the
    // watch it starts is already interrupted, so it bails at the top of its
    // first iteration without issuing a `DescribeTable` at all. Without the
    // sticky latch this polls for its whole cap — the reviewer measured it
    // still going six seconds after the signal.
    expect(goneProbes).toBe(0);
    expect(warnLines()).toContain('AWS ACCEPTED the DeleteTable');
    // The `DeleteTable` itself still went out, and that is correct rather than
    // incidental: the #1521 gate is best-effort by contract (AWS refusing the
    // delete is its backstop), and the retry loop only consults the interrupt
    // inside a backoff — which a first-attempt success never enters.
    expect(mockSend.mock.calls.filter((c) => c[0] instanceof DeleteTableCommand)).toHaveLength(1);
  }, 120_000);

  it('waitForTableGone: warns and returns rather than polling out its 600-poll cap', async () => {
    // AWS has ACCEPTED the DeleteTable by the time this wait runs, so a Ctrl-C
    // means "stop watching", not "the delete failed" — throwing here would turn
    // an accepted delete into a reported failure with state preserved.
    let goneProbes = 0;
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        // Deliberately NEVER reports the table gone, so the wait really runs.
        if (deleted) {
          goneProbes += 1;
          if (goneProbes === 1) fireInterrupt();
        }
        return Promise.resolve({
          Table: {
            TableName: 'orders',
            TableStatus: deleted ? 'DELETING' : 'ACTIVE',
            GlobalSecondaryIndexes: [],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) {
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await new DynamoDBGlobalTableProvider().delete('Orders', 'orders', GLOBAL_TABLE, {});

    // THE discriminator: 600 polls (~12 min) without the fix.
    expect(goneProbes).toBe(1);
    expect(TABLE_GONE_WAIT_ATTEMPTS).toBeGreaterThan(100);
    // ...and the RETURN is only half the contract. Silence here would tell the
    // user nothing about a table AWS is still deleting, which is the one fact
    // they need after interrupting: deleting is out of cdkd's hands and WILL
    // finish. Pinned on the text because the return alone stayed green when the
    // reviewer deleted this warn outright.
    expect(warnLines()).toContain('interrupted while waiting for orders to disappear');
    expect(warnLines()).toContain('AWS ACCEPTED the DeleteTable');
  }, 120_000);

  it('waitForReplicaGone: THROWS on the signal, because nothing has been accepted yet', async () => {
    // `DeleteTable` has not been issued and AWS refuses it while a replica
    // lives, so proceeding after a Ctrl-C would trade a long wait for a
    // confusing failure. Same reasoning as this wait's own exhaustion arm,
    // which throws where the gone-wait warns.
    let replicaProbes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        replicaProbes += 1;
        // The replica NEVER drops out, so the wait really runs. Fire on the
        // second probe: the first is the pre-delete describe.
        if (replicaProbes === 2) fireInterrupt();
        return Promise.resolve({
          Table: {
            TableName: 'orders',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [],
            Replicas: [
              { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
              { RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' },
            ],
          },
        });
      }
      if (command instanceof UpdateTableCommand) return Promise.resolve({});
      if (command instanceof DeleteTableCommand) return Promise.resolve({});
      return Promise.resolve({});
    });

    await expect(
      new DynamoDBGlobalTableProvider().delete('Orders', 'orders', GLOBAL_TABLE, {})
    ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

    // THE discriminator: without the fix this polls 600 times (~12 min) and
    // then fails with "did not disappear within 600s" — a different, and much
    // later, outcome.
    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof DeleteTableCommand),
      'DeleteTable must NOT be issued after an interrupted replica teardown'
    ).toHaveLength(0);
  }, 120_000);
});

// go-to-k/cdkd#2007: both gone-waits name the table, in the warning and in the
// interrupted error, and the delete hands them its `DeleteContext.maskSecrets`.
describe('the GlobalTable delete waits mask a secret-derived table name (go-to-k/cdkd#2007)', () => {
  const NAME = 'secret-orders-2007';
  const maskSecrets = (text: string): string => text.split(NAME).join('***');

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    logger.warn.mockClear();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    autoScalingRetryDelays.sleep = () => Promise.resolve();
    deleteTableRetryDelays.sleep = () => Promise.resolve();
    armInterruptWatchForSuite();
    baseline = process.listeners('SIGINT');
  });

  afterEach(() => {
    delete autoScalingRetryDelays.sleep;
    delete deleteTableRetryDelays.sleep;
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('waitForTableGone: the interrupted warning', async () => {
    let deleted = false;
    let goneProbes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        if (deleted && ++goneProbes === 1) fireInterrupt();
        return Promise.resolve({
          Table: {
            TableName: NAME,
            TableStatus: deleted ? 'DELETING' : 'ACTIVE',
            GlobalSecondaryIndexes: [],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) deleted = true;
      return Promise.resolve({});
    });

    await new DynamoDBGlobalTableProvider().delete('Orders', NAME, GLOBAL_TABLE, {}, {
      maskSecrets,
    });

    expect(warnLines()).toContain('interrupted while waiting for *** to disappear');
    expect(warnLines()).not.toContain(NAME);
  }, 120_000);

  it('waitForReplicaGone: the interrupted error', async () => {
    let replicaProbes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        if (++replicaProbes === 2) fireInterrupt();
        return Promise.resolve({
          Table: {
            TableName: NAME,
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [],
            Replicas: [
              { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
              { RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const error = await new DynamoDBGlobalTableProvider()
      .delete('Orders', NAME, GLOBAL_TABLE, {}, { maskSecrets })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );

    expect(error?.message).toMatch(/interrupted by user \(SIGINT\)/);
    expect(error?.message).not.toContain(NAME);
  }, 120_000);

  it('the pre-delete index wait: its give-up warning', async () => {
    let deleted = false;
    let describes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        describes += 1;
        // The index wait's own describe fails, so it gives up the WAIT (not
        // the delete) with a warning naming the table.
        if (describes === 2) return Promise.reject(new Error('boom'));
        return Promise.resolve({
          Table: {
            TableName: NAME,
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi', IndexStatus: 'CREATING' }],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) deleted = true;
      return Promise.resolve({});
    });

    await new DynamoDBGlobalTableProvider().delete('Orders', NAME, GLOBAL_TABLE, {}, {
      maskSecrets,
    });

    const waitLines = warnLines()
      .split('\n')
      .filter((l) => l.includes('while waiting for indexes on'));
    expect(waitLines.length).toBeGreaterThan(0);
    expect(waitLines.join('\n')).toContain('***');
    expect(waitLines.join('\n')).not.toContain(NAME);
  }, 120_000);

  it("the index-busy DeleteTable re-arm: the wait's give-up warning", async () => {
    let deleted = false;
    let deleteAttempts = 0;
    let describes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        describes += 1;
        // The pre-delete describe answers; the re-arm's own describe fails.
        if (describes > 1) return Promise.reject(new Error('boom'));
        return Promise.resolve({
          Table: {
            TableName: NAME,
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          return Promise.reject(
            Object.assign(new Error('Cannot delete table while indexes are being created'), {
              name: 'ResourceInUseException',
            })
          );
        }
        deleted = true;
      }
      return Promise.resolve({});
    });

    await new DynamoDBGlobalTableProvider().delete('Orders', NAME, GLOBAL_TABLE, {}, {
      maskSecrets,
    });

    expect(deleteAttempts).toBe(2);
    const waitLines = warnLines()
      .split('\n')
      .filter((l) => l.includes('while waiting for indexes on'));
    expect(waitLines.length).toBeGreaterThan(0);
    expect(waitLines.join('\n')).not.toContain(NAME);
  }, 120_000);

  it('hands the protection-flip ACTIVE wait and the gone wait the delete masker', async () => {
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        return Promise.resolve({
          Table: {
            TableName: NAME,
            TableStatus: 'ACTIVE',
            DeletionProtectionEnabled: true,
            GlobalSecondaryIndexes: [],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) deleted = true;
      return Promise.resolve({});
    });
    const provider = new DynamoDBGlobalTableProvider();
    const seam = provider as unknown as Record<string, (...a: unknown[]) => Promise<void>>;
    const active = vi.spyOn(seam, 'waitForTableActiveAfterUpdate');
    const gone = vi.spyOn(seam, 'waitForTableGone');

    await provider.delete('Orders', NAME, GLOBAL_TABLE, {}, {
      maskSecrets,
      removeProtection: true,
    });

    expect(active.mock.calls[0]?.[4]).toBe(maskSecrets);
    expect(gone.mock.calls[0]?.[4]).toBe(maskSecrets);
  }, 120_000);

  it('the gone wait masks the table name in its throw', async () => {
    mockSend.mockResolvedValue({ Table: { TableName: NAME, TableStatus: 'DELETING' } });
    const seam = new DynamoDBGlobalTableProvider() as unknown as {
      waitForTableGone: (n: string, l: string, a: number, b: undefined, m: typeof maskSecrets) => Promise<void>;
    };
    const error = await seam.waitForTableGone(NAME, 'Orders', 1, undefined, maskSecrets).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(error?.message).toContain('did not disappear');
    expect(error?.message).not.toContain(NAME);
  }, 120_000);

  it("the gone wait's cut-short warning", async () => {
    mockSend.mockResolvedValue({ Table: { TableName: NAME, TableStatus: 'DELETING' } });
    let now = 0;
    const budget = new ElapsedBudget(1000, () => now);
    now = 10_000; // spent before the wait starts, so it is cut short
    const seam = new DynamoDBGlobalTableProvider() as unknown as {
      waitForTableGone: (n: string, l: string, a: number, b: ElapsedBudget, m: typeof maskSecrets) => Promise<void>;
    };
    await seam.waitForTableGone(NAME, 'Orders', 600, budget, maskSecrets);
    const line = warnLines()
      .split('\n')
      .find((l) => l.includes('cdkd stopped waiting'));
    expect(line).toBeDefined();
    expect(line).not.toContain(NAME);
  }, 120_000);

  it("the delete's own protection-flip debug lines", async () => {
    const debugLines = (): string =>
      (logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
    (logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug.mockClear();
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        return Promise.resolve({
          Table: { TableName: NAME, TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [], Replicas: [] },
        });
      }
      if (command instanceof UpdateTableCommand) {
        return Promise.reject(new Error(`AccessDenied on ${NAME}`));
      }
      if (command instanceof DeleteTableCommand) deleted = true;
      return Promise.resolve({});
    });

    await new DynamoDBGlobalTableProvider().delete('Orders', NAME, GLOBAL_TABLE, {}, {
      maskSecrets,
      removeProtection: true,
    });

    expect(debugLines()).toContain('Deleting DynamoDB GlobalTable Orders: ***');
    expect(debugLines()).toContain('Could not disable DeletionProtectionEnabled on ***');
    expect(
      debugLines()
        .split('\n')
        .filter((l) => l.startsWith('Deleting DynamoDB') || l.includes('DeletionProtectionEnabled'))
        .join('\n')
    ).not.toContain(NAME);
  }, 120_000);

  it("the delete's protection-observe and ACTIVE-wait debug lines", async () => {
    const debugSpy = (logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug;
    debugSpy.mockClear();
    let deleted = false;
    let describes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        describes += 1;
        // 1: the pre-flip observation, 2: the ACTIVE wait after the flip.
        if (describes === 1) return Promise.reject(new Error(`observe failed for ${NAME}`));
        if (describes === 2) return Promise.reject(new Error(`wait failed for ${NAME}`));
        return Promise.resolve({
          Table: { TableName: NAME, TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [], Replicas: [] },
        });
      }
      if (command instanceof DeleteTableCommand) deleted = true;
      return Promise.resolve({});
    });

    await new DynamoDBGlobalTableProvider().delete('Orders', NAME, GLOBAL_TABLE, {}, {
      maskSecrets,
      removeProtection: true,
    });

    const lines = debugSpy.mock.calls.map((c) => String(c[0]));
    const observe = lines.find((l) => l.startsWith('Could not read DeletionProtectionEnabled'));
    const wait = lines.find((l) => l.startsWith('Could not wait for table'));
    expect(observe).toBeDefined();
    expect(wait).toBeDefined();
    expect(`${observe}\n${wait}`).not.toContain(NAME);
  }, 120_000);

  // A table name that IS a short secret, below the masker's 4-character
  // substring floor: only the per-value mask of the name catches it.
  it("the delete's debug lines mask a SHORT secret-derived table name by value", async () => {
    const SHORT = 'q7z';
    const shortMask = (text: string): string => (text === SHORT ? '***' : text);
    const debugSpy = (logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug;
    debugSpy.mockClear();
    let deleted = false;
    let describes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        describes += 1;
        if (describes === 1) return Promise.reject(new Error('observe failed'));
        if (describes === 2) return Promise.reject(new Error('wait failed'));
        return Promise.resolve({
          Table: { TableName: SHORT, TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [], Replicas: [] },
        });
      }
      if (command instanceof DeleteTableCommand) deleted = true;
      return Promise.resolve({});
    });

    await new DynamoDBGlobalTableProvider().delete('Orders', SHORT, GLOBAL_TABLE, {}, {
      maskSecrets: shortMask,
      removeProtection: true,
    });

    const lines = debugSpy.mock.calls.map((c) => String(c[0]));
    const picked = [
      lines.find((l) => l.startsWith('Deleting DynamoDB GlobalTable')),
      lines.find((l) => l.startsWith('Could not read DeletionProtectionEnabled')),
      lines.find((l) => l.startsWith('Could not wait for table')),
    ];
    for (const line of picked) {
      expect(line).toBeDefined();
      expect(line).toContain('***');
      expect(line).not.toContain(SHORT);
    }
  }, 120_000);
});
