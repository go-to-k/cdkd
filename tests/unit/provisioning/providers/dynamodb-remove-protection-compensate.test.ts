import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeTableCommand,
  DeleteTableCommand,
  ResourceNotFoundException,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

/**
 * Issue #1978 — `--remove-protection` must not leave a LIVE table with its
 * deletion guard silently stripped.
 *
 * `cdkd destroy --remove-protection` flips `DeletionProtectionEnabled` off,
 * waits for ACTIVE, and issues `DeleteTable`. When that delete ends for good —
 * a terminal AWS refusal, or a Ctrl-C landing anywhere after the flip — the run
 * used to finish with the table still there and the guard still off. The
 * failure was loud; the side effect was not.
 *
 * ONE suite for BOTH DynamoDB types on purpose. They are one root cause with
 * two `delete()` bodies, the issue asks specifically that the halves not
 * diverge, and the #1955 review had already found a half-applied twin in this
 * pair — so every case below runs against both providers and a fix applied to
 * only one of them fails here rather than in a file nobody opened.
 *
 * THE DISCRIMINATOR IS ALWAYS *WHICH* `UpdateTable` WENT OUT. This path issues
 * `UpdateTable` for the flip-off, for the replica teardown and for the
 * compensation, so "an UpdateTable happened" is true of every case including
 * the ones that must NOT compensate; the assertions read
 * `input.DeletionProtectionEnabled === true`.
 */

const { mockSend, mockAutoScalingSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
}));

/**
 * KNOWN BLIND SPOT of this mock, stated rather than left to be rediscovered:
 * `getAwsClients().dynamoDB` and EVERY `new DynamoDBClient({ region })` below
 * are routed to the SAME `mockSend`, so the assertions here can see WHICH
 * command went out but not WHICH CLIENT sent it. A compensation issued against
 * the wrong regional client would pass every case in this file.
 *
 * Latent today, and by construction rather than by luck: the flip-off, the
 * pre-flip observation and the re-enable all go through `this.dynamoDBClient`,
 * the one client the provider builds for the resource's own region — so there
 * is no second client for the compensation to pick. It stops being latent the
 * moment any of those three moves onto a per-replica client (the GlobalTable
 * provider already builds those for replica work), and a per-client spy would
 * be the fence to add then.
 */
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@aws-sdk/client-application-auto-scaling')>();
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

// One logger object for the whole module, reachable from the test body: the
// compensation's ONLY output is a log line — the thrown error is deliberately
// left untouched — so the narration has to be asserted on the text.
vi.mock('../../../../src/utils/logger.js', () => {
  const logger: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger['child'] = () => logger;
  return { getLogger: () => logger };
});

import { DynamoDBTableProvider } from '../../../../src/provisioning/providers/dynamodb-table-provider.js';
import { deleteTableRetryDelays as tableRetryDelays } from '../../../../src/provisioning/providers/dynamodb-table-provider.js';
import {
  DynamoDBGlobalTableProvider,
  autoScalingRetryDelays,
  deleteTableRetryDelays as globalTableRetryDelays,
} from '../../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { getLogger } from '../../../../src/utils/logger.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../../src/provisioning/interrupt-watch.js';
import type { DeleteContext } from '../../../../src/provisioning/region-check.js';
import {
  DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS,
  type ProtectionCompensationOutcome,
  ProtectionFlipRegistry,
  compensateRemovedDeletionProtection,
  dynamoDbDeleteBudgetOverride,
} from '../../../../src/provisioning/providers/dynamodb-delete-budget.js';

const logger = getLogger() as unknown as {
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function warnLines(): string {
  return logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}
function errorLines(): string {
  return logger.error.mock.calls.map((c) => String(c[0])).join('\n');
}
function debugLines(): string {
  return logger.debug.mock.calls.map((c) => String(c[0])).join('\n');
}

const TABLE_NAME = 'orders';
const LOGICAL_ID = 'Orders';
const REMOVE_PROTECTION: DeleteContext = { removeProtection: true };

/** Every `UpdateTable` this run issued that turns the guard back ON. */
function reEnableCalls(): UpdateTableCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter(
      (command): command is UpdateTableCommand =>
        command instanceof UpdateTableCommand && command.input.DeletionProtectionEnabled === true
    );
}

/** Every `UpdateTable` that turns the guard OFF — the flip this run is undoing. */
function flipOffCalls(): UpdateTableCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter(
      (command): command is UpdateTableCommand =>
        command instanceof UpdateTableCommand && command.input.DeletionProtectionEnabled === false
    );
}

/**
 * How many records the provider's own `ProtectionFlipRegistry` is holding.
 *
 * White-box, and used here for the one thing the black-box narration cannot
 * say: whether `delete()`'s `catch` DROPPED the record on its way out (issue
 * #2244). `ProtectionFlipRegistry.size` exists for exactly this.
 */
function registrySize(instance: unknown): number {
  return (instance as { protectionFlips: { size: number } }).protectionFlips.size;
}

/** Every `DescribeTable` this run issued, in order. */
function describeCalls(): DescribeTableCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((command): command is DescribeTableCommand => command instanceof DescribeTableCommand);
}

/**
 * A refusal `destroy-runner.ts` will NOT re-enter `delete()` for: not a
 * throttle, not a transient server status, and matching no
 * `RETRYABLE_ERROR_MESSAGE_PATTERNS` entry — nor the index-busy regex, so the
 * provider's own retry loop treats it as terminal on the first attempt too.
 *
 * The issue's own example: a `ResourceInUseException` that is NOT the
 * index-busy shape. Deliberately not an `AccessDeniedException` — AWS spells
 * those `... is not authorized to perform: ...`, which IS a
 * `RETRYABLE_ERROR_MESSAGE_PATTERNS` entry (the IAM-propagation subset), so
 * that error is re-entered by the outer loop and would exercise the wrong arm.
 */
function terminalDeleteRefusal(): Error {
  return Object.assign(
    new Error('Attempt to change a resource which is still in use: Table is being created'),
    { name: 'ResourceInUseException' }
  );
}

/** The shape `destroy-runner.ts` DOES re-enter `delete()` for. */
function throttleRefusal(): Error {
  return Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
}

/** AWS's index-busy refusal — the one the provider's own loop retries. */
function indexBusyRefusal(): Error {
  return Object.assign(
    new Error('Cannot delete table while indexes are being created, updated, or deleted'),
    { name: 'ResourceInUseException' }
  );
}

interface TableShape {
  /** What `DescribeTable` reports for `DeletionProtectionEnabled` before the flip. */
  protectionOn: boolean;
  /** Extra replicas beyond the local one (GlobalTable only). */
  extraReplicas?: string[];
}

interface Behaviour extends TableShape {
  /** What `DeleteTable` does. */
  onDelete: () => Promise<unknown>;
  /** Whether the compensating `UpdateTable(true)` itself fails. */
  reEnableFails?: boolean;
  /**
   * What the compensating `UpdateTable(true)` rejects with when
   * `reEnableFails` is set. Defaults to a `ResourceInUseException`; the
   * `ResourceNotFoundException` shape is the one issue #2224 is about.
   */
  reEnableError?: () => Error;
  /** Called on each `DescribeTable`, with the 1-based call number. */
  onDescribe?: (n: number) => void;
  /**
   * Whether the FIRST `DescribeTable` — the pre-flip observation — rejects.
   * Throttled rather than absent on purpose: the guard really is ON in this
   * fixture, so the run is choosing between "compensate on a value cdkd never
   * read" and "leave a genuinely protected table alone", which is the pair the
   * observation gate decides.
   */
  observeFails?: boolean;
  /** Whether the flip-off `UpdateTable(false)` itself is REJECTED by AWS. */
  flipFails?: boolean;
  /**
   * A failure injected into the first `DescribeTable` AFTER `DeleteTable` was
   * accepted — i.e. into `waitForTableGone`'s own poll. See the suite that uses
   * it for why the failure is injected rather than waited for.
   */
  afterDeleteDescribeError?: () => Error;
}

/**
 * Wire `mockSend` for one case.
 *
 * `DescribeTable` reports the guard as OFF once the flip has been accepted, so
 * the pre-flip observation is genuinely a READ of the pre-flip world rather
 * than a constant — a fix that observed AFTER the flip would see `false` here
 * and stop compensating, which is the mutation probe for that half.
 */
function install(behaviour: Behaviour): void {
  let flipped = false;
  let deleted = false;
  let describes = 0;
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeTableCommand) {
      describes += 1;
      behaviour.onDescribe?.(describes);
      if (describes === 1 && behaviour.observeFails === true) {
        return Promise.reject(
          Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
        );
      }
      if (deleted && behaviour.afterDeleteDescribeError !== undefined) {
        return Promise.reject(behaviour.afterDeleteDescribeError());
      }
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableStatus: 'ACTIVE',
          DeletionProtectionEnabled: behaviour.protectionOn && !flipped,
          GlobalSecondaryIndexes: [],
          Replicas: [
            { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
            ...(behaviour.extraReplicas ?? []).map((r) => ({
              RegionName: r,
              ReplicaStatus: 'ACTIVE',
            })),
          ],
        },
      });
    }
    if (command instanceof UpdateTableCommand) {
      if (command.input.DeletionProtectionEnabled === false) {
        if (behaviour.flipFails === true) {
          return Promise.reject(
            Object.assign(new Error('Table is being updated'), { name: 'ResourceInUseException' })
          );
        }
        flipped = true;
        return Promise.resolve({});
      }
      if (command.input.DeletionProtectionEnabled === true) {
        return behaviour.reEnableFails
          ? Promise.reject(
              behaviour.reEnableError?.() ??
                Object.assign(new Error('Table is being updated'), {
                  name: 'ResourceInUseException',
                })
            )
          : Promise.resolve({});
      }
      // Replica teardown (`ReplicaUpdates`) — neither flip nor compensation.
      return Promise.resolve({});
    }
    if (command instanceof DeleteTableCommand) {
      // `deleted` flips only when AWS RESOLVED the call — a rejected
      // `DeleteTable` was never accepted, and the whole point of the record it
      // stands in for is the difference between those two.
      return behaviour.onDelete().then((result) => {
        deleted = true;
        return result;
      });
    }
    return Promise.resolve({});
  });
}

interface ProviderCase {
  readonly resourceType: string;
  readonly typeLabel: string;
  readonly make: () => {
    delete: (
      logicalId: string,
      physicalId: string,
      resourceType: string,
      properties?: Record<string, unknown>,
      context?: DeleteContext
    ) => Promise<void>;
  };
  /**
   * How a Ctrl-C reaches this type's post-flip window, which is NOT the same
   * route on the two providers (see each entry).
   */
  readonly armInterruptRoute: (fire: () => void) => Behaviour;
  /**
   * Exactly how many `DescribeTable` calls this type's delete path makes when
   * `--remove-protection` was NOT asked for and the delete then fails
   * terminally. A LITERAL, and load-bearing: it is what makes "the pre-flip
   * observation must not appear either" an assertion rather than a claim, and
   * it reds on any unconditional `DescribeTable` added to the delete path.
   */
  readonly describesWithoutRemoveProtection: number;
}

// Written as LITERALS rather than derived from anything in `src/`: a list built
// from the module under test goes blind the moment an entry is removed.
const PROVIDERS: readonly ProviderCase[] = [
  {
    resourceType: 'AWS::DynamoDB::Table',
    typeLabel: 'table',
    make: () => new DynamoDBTableProvider(),
    // This type has no replica wait. Its post-flip interruptible wait is the
    // index-busy retry loop: AWS refuses the delete, `withRetry` consults the
    // signal in its backoff and aborts with an `InterruptedWaitError`.
    armInterruptRoute: (fire) => ({
      protectionOn: true,
      onDelete: () => {
        fire();
        return Promise.reject(indexBusyRefusal());
      },
    }),
    // ZERO. This provider's delete path holds no describe of its own: the
    // index-busy re-arm only polls once AWS has actually refused with the
    // index-busy message, and this fixture's refusal is terminal. So the
    // pre-flip observation is the ONLY `DescribeTable` the flag can add here,
    // and 0 is the strongest form this assertion takes on either type.
    describesWithoutRemoveProtection: 0,
  },
  {
    resourceType: 'AWS::DynamoDB::GlobalTable',
    typeLabel: 'GlobalTable',
    make: () => new DynamoDBGlobalTableProvider(),
    // The route the issue's own comment records: `waitForReplicaGone` sits
    // between the flip and the `DeleteTable`, is up to ~12 min long, and has
    // been interruptible since #2053 — so the abort lands with the guard off
    // and the table untouched. The replica never disappears, so the wait really
    // runs; the signal is fired on its first poll (the pre-delete describe is
    // the first `DescribeTable` overall).
    armInterruptRoute: (fire) => ({
      protectionOn: true,
      extraReplicas: ['us-west-2'],
      // Describes on this path: 1 the pre-flip observation, 2 the ACTIVE wait,
      // 3 the pre-delete describe, 4+ the replica-gone poll. The signal has to
      // land while a watch is INSTALLED — firing it earlier reaches no listener
      // and the latch never records it — so it fires on the replica wait's own
      // first poll, and the wait's top-of-loop check catches it on the next.
      onDescribe: (n) => {
        if (n === 4) fire();
      },
      onDelete: () => Promise.resolve({}),
    }),
    // ONE: the pre-delete describe that feeds the replica teardown and the
    // #1521 index gate. It is NOT the pre-flip observation — it runs
    // unconditionally, `--remove-protection` or not — which is exactly why the
    // number cannot be 0 on this type and why asserting "no describes" would
    // have been wrong rather than strict.
    describesWithoutRemoveProtection: 1,
  },
];

/**
 * Stand in for the SIGINT handler every real command installs before it reaches
 * a provider. The watch refuses to install the FIRST listener (that would
 * disable Node's default terminate for a command with no interrupt handling of
 * its own) and a vitest worker registers none, so without this every interrupt
 * case would exercise the UNARMED path while appearing to test the armed one.
 */
function armInterruptWatchForSuite(): void {
  disarmInterruptWatchForTests();
  interruptWatchTestSeam.commandOwnsInterrupts = () => true;
}

let baseline: readonly unknown[] = [];

function fireInterrupt(): void {
  const ours = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
  for (const listener of ours) (listener as unknown as () => void)();
}

describe.each(PROVIDERS)(
  '$resourceType --remove-protection compensation (#1978)',
  (provider: ProviderCase) => {
    beforeEach(() => {
      mockSend.mockReset();
      mockAutoScalingSend.mockReset();
      logger.debug.mockClear();
      logger.warn.mockClear();
      logger.error.mockClear();
      mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
      // Collapse the backoffs: a regressed run would otherwise spend its time
      // in real sleeps and report "timed out" instead of the call it made.
      autoScalingRetryDelays.sleep = () => Promise.resolve();
      tableRetryDelays.sleep = () => Promise.resolve();
      globalTableRetryDelays.sleep = () => Promise.resolve();
      armInterruptWatchForSuite();
      baseline = process.listeners('SIGINT');
    });

    afterEach(() => {
      delete autoScalingRetryDelays.sleep;
      delete tableRetryDelays.sleep;
      delete globalTableRetryDelays.sleep;
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    });

    it('re-enables the guard when the delete fails terminally, and still reports the delete failure', async () => {
      install({ protectionOn: true, onDelete: () => Promise.reject(terminalDeleteRefusal()) });

      await expect(
        provider
          .make()
          .delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
        // The ORIGINAL failure is what surfaces. The compensation is a
        // secondary line, never a replacement and never an annotation: this
        // message is what `destroy-runner.ts` re-classifies, so splicing the
        // re-enable's text into it could change its retry class.
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      // THE discriminator: which `UpdateTable` went out, with what input.
      expect(flipOffCalls()).toHaveLength(1);
      expect(reEnableCalls()).toHaveLength(1);
      expect(reEnableCalls()[0]?.input).toMatchObject({
        TableName: TABLE_NAME,
        DeletionProtectionEnabled: true,
      });
      expect(warnLines()).toContain(`re-enabled on ${TABLE_NAME}`);
      expect(errorLines()).not.toContain('could NOT re-enable');
    }, 120_000);

    it('does NOT re-enable a guard that was already off before the run', async () => {
      // The user had already turned protection off. A failed destroy must leave
      // the table exactly as it found it — "re-enabling" here would be cdkd
      // making a configuration change nobody asked for.
      install({ protectionOn: false, onDelete: () => Promise.reject(terminalDeleteRefusal()) });

      await expect(
        provider
          .make()
          .delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      // The flip still went out (it is idempotent and unconditional), so
      // "an UpdateTable happened" cannot be the assertion — only its input can.
      expect(flipOffCalls()).toHaveLength(1);
      expect(reEnableCalls()).toHaveLength(0);
      expect(warnLines()).not.toContain('re-enabled on');
    }, 120_000);

    it('surfaces the delete failure AND names the table when the re-enable itself fails', async () => {
      install({
        protectionOn: true,
        onDelete: () => Promise.reject(terminalDeleteRefusal()),
        reEnableFails: true,
      });

      await expect(
        provider
          .make()
          .delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
        // The secondary write threw and was SWALLOWED: had it propagated it
        // would have replaced the reported outcome with `Table is being
        // updated`, hiding the permission problem that actually stopped the
        // destroy.
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      expect(reEnableCalls()).toHaveLength(1);
      // A guard is down on a live table, so the physical id and the recovery
      // command have to be in the message — the user cannot act on "a
      // compensation failed".
      expect(errorLines()).toContain('could NOT re-enable');
      expect(errorLines()).toContain(`DeletionProtectionEnabled on ${TABLE_NAME}`);
      expect(errorLines()).toContain(
        `aws dynamodb update-table --table-name ${TABLE_NAME} --deletion-protection-enabled`
      );
    }, 120_000);

    it('re-enables the guard when a Ctrl-C aborts the path after the flip', async () => {
      install(provider.armInterruptRoute(fireInterrupt));

      await expect(
        provider
          .make()
          .delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

      expect(flipOffCalls()).toHaveLength(1);
      expect(reEnableCalls()).toHaveLength(1);
      expect(reEnableCalls()[0]?.input).toMatchObject({
        TableName: TABLE_NAME,
        DeletionProtectionEnabled: true,
      });
    }, 120_000);

    it('re-enables after a Ctrl-C even when the resource NAME reads as retryable', async () => {
      // An interrupt's message embeds names the user chose — the logical id in
      // the provider's own wrap, the physical id in `waitForReplicaGone`'s
      // watch text — and `RETRYABLE_ERROR_MESSAGE_PATTERNS` is a SUBSTRING
      // match. `DependencyViolation` is one of its entries and is a legal
      // logical id / table-name fragment, so classifying the abort purely by
      // message reads a Ctrl-C as a throttle, skips the compensation and leaves
      // the guard down. This is the same hazard `destroy-runner.ts` documents
      // for its own not-found match (issues #2053 / #1952).
      const logicalId = 'DependencyViolationHandler';
      const physicalId = 'orders-DependencyViolation';
      install(provider.armInterruptRoute(fireInterrupt));

      await expect(
        provider.make().delete(logicalId, physicalId, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

      expect(reEnableCalls()).toHaveLength(1);
      expect(reEnableCalls()[0]?.input).toMatchObject({
        TableName: physicalId,
        DeletionProtectionEnabled: true,
      });
    }, 120_000);

    it('does NOT re-enable on a RETRYABLE failure, which the outer loop re-enters', async () => {
      // `destroy-runner.ts` re-invokes `delete()` for a throttle, and that
      // re-entry flips the guard off again — so compensating here would toggle
      // the flag back and forth across a retry sequence for nothing.
      install({ protectionOn: true, onDelete: () => Promise.reject(throttleRefusal()) });

      await expect(
        provider
          .make()
          .delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Rate exceeded/);

      expect(flipOffCalls()).toHaveLength(1);
      expect(reEnableCalls()).toHaveLength(0);
    }, 120_000);

    it('does NOT touch the guard at all when --remove-protection was not asked for', async () => {
      // No flip, so nothing to compensate — and the pre-flip observing
      // `DescribeTable` must not appear either. That second half is an
      // ASSERTION (`describesWithoutRemoveProtection`), not a remark: without a
      // describe count, adding an unconditional `DescribeTable` to the delete
      // path left this case green while the observation it names ran on every
      // destroy.
      install({ protectionOn: true, onDelete: () => Promise.reject(terminalDeleteRefusal()) });

      await expect(
        provider.make().delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, {})
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      expect(flipOffCalls()).toHaveLength(0);
      expect(reEnableCalls()).toHaveLength(0);
      expect(describeCalls()).toHaveLength(provider.describesWithoutRemoveProtection);
    }, 120_000);

    it('re-enables when a RETRY re-enters delete() and the SECOND attempt fails terminally', async () => {
      // The issue's retry-then-fail case, and the one a per-call flip record
      // cannot see. `destroy-runner.ts` re-invokes `delete()` on the SAME
      // provider instance after a throttle (up to 4 calls inside one
      // per-resource deadline), and attempt 2's pre-flip `DescribeTable` reports
      // the guard already OFF -- because attempt 1 turned it off. A record
      // created per call therefore reads "nothing was flipped by this run" on
      // exactly the attempt that ends the delete for good.
      //
      // Driven as two real `delete()` calls rather than by reaching into the
      // registry: the re-entry is the thing under test, so the test has to
      // perform it.
      let deleteAttempts = 0;
      install({
        protectionOn: true,
        onDelete: () => {
          deleteAttempts += 1;
          return Promise.reject(deleteAttempts === 1 ? throttleRefusal() : terminalDeleteRefusal());
        },
      });
      const instance = provider.make();

      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Rate exceeded/);
      // Nothing yet: the outer loop is about to come back, and compensating
      // between attempts is the flip-flop the issue rejects.
      expect(reEnableCalls()).toHaveLength(0);

      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      expect(deleteAttempts).toBe(2);
      // Both attempts flipped (the flip is unconditional and idempotent); only
      // the terminal one compensated.
      expect(flipOffCalls()).toHaveLength(2);
      expect(reEnableCalls()).toHaveLength(1);
      expect(reEnableCalls()[0]?.input).toMatchObject({
        TableName: TABLE_NAME,
        DeletionProtectionEnabled: true,
      });
      expect(warnLines()).toContain(`re-enabled on ${TABLE_NAME}`);
    }, 120_000);

    it('re-enables after a retry sequence that OUTLIVES the reuse window (#2211)', async () => {
      // Issue #2211, driven THROUGH `delete()` rather than through the registry:
      // `resolveDynamoDbDeleteBudgetClock()` is threaded into
      // `protectionFlips.acquire`, and until this case nothing exercised that
      // third argument at all.
      //
      // `destroy-runner.ts` re-invokes `delete()` on the SAME provider instance
      // for anything it classes as retryable, under ONE per-resource deadline a
      // `--resource-timeout` overshoot can push past
      // `DELETE_BUDGET_REUSE_WINDOW_MS`. Each attempt below arrives one minute
      // INSIDE the window, so no idle gap ever exceeds it — but the total age at
      // attempt 3 is ~58 minutes. Measured from FIRST acquisition, attempt 3
      // gets a fresh `{ flippedOffByThisRun: false }`, its pre-flip
      // `DescribeTable` reports the guard already OFF (attempt 1 turned it off,
      // and this fixture's describe is a genuine read of that), and the terminal
      // failure compensates NOTHING — #1978's residue, reached through #1978's
      // own mechanism.
      const WINDOW_MS = DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS;
      let now = 0;
      dynamoDbDeleteBudgetOverride.clock = () => now;
      try {
        let deleteAttempts = 0;
        install({
          protectionOn: true,
          onDelete: () => {
            deleteAttempts += 1;
            return Promise.reject(
              deleteAttempts < 3 ? throttleRefusal() : terminalDeleteRefusal()
            );
          },
        });
        const instance = provider.make();

        await expect(
          instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
        ).rejects.toThrow(/Rate exceeded/);
        expect(reEnableCalls()).toHaveLength(0);

        now += WINDOW_MS - 60_000;
        await expect(
          instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
        ).rejects.toThrow(/Rate exceeded/);
        expect(reEnableCalls()).toHaveLength(0);

        now += WINDOW_MS - 60_000;
        await expect(
          instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
        ).rejects.toThrow(/Attempt to change a resource which is still in use/);

        expect(deleteAttempts).toBe(3);
        expect(flipOffCalls()).toHaveLength(3);
        // THE discriminator: the latch survived the whole sequence, so the
        // terminal attempt put the guard back.
        expect(reEnableCalls()).toHaveLength(1);
        expect(reEnableCalls()[0]?.input).toMatchObject({
          TableName: TABLE_NAME,
          DeletionProtectionEnabled: true,
        });
        expect(warnLines()).toContain(`re-enabled on ${TABLE_NAME}`);
      } finally {
        delete dynamoDbDeleteBudgetOverride.clock;
      }
    }, 120_000);

    it('does NOT claim the table is LIVE when the re-enable itself gets ResourceNotFound (#2224)', async () => {
      // Issue #2224, the whole race end to end: `DeleteTable` answers
      // ResourceNotFound (a success for the provider), `assertRegionMatch`
      // throws inside that branch BEFORE its `protectionFlips.release`, so the
      // record reaches the wrapper still latched and the compensation fires
      // against a table that is GONE. Its `UpdateTable` gets its own
      // ResourceNotFound, and the error line used to assert the opposite of the
      // truth — that the table is LIVE with its protection off, plus a restore
      // command naming a table that does not exist.
      install({
        protectionOn: true,
        onDelete: () =>
          Promise.reject(new ResourceNotFoundException({ message: 'not found', $metadata: {} })),
        reEnableFails: true,
        reEnableError: () =>
          new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} }),
      });

      const instance = provider.make();
      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, {
          ...REMOVE_PROTECTION,
          // The client is us-east-1 (see the module mock); state says otherwise.
          expectedRegion: 'eu-west-1',
        })
      ).rejects.toThrow(/Refusing to treat NotFound as idempotent delete success/);

      // The compensation still RAN — this issue is about the narration, and
      // skipping the compensation on an RNF-shaped DELETE error is the fix the
      // issue rules out.
      expect(reEnableCalls()).toHaveLength(1);
      expect(errorLines()).not.toContain('LIVE with its deletion protection still off');
      expect(errorLines()).not.toContain('could NOT re-enable');
      // Narration only: the line stays VISIBLE (warn, not debug) because RNF
      // from `UpdateTable` also covers a live table whose status is not ACTIVE.
      // What is dropped is the ASSERTION that the table is live, not the line.
      // Nothing may land at debug on this arm: RNF from `UpdateTable` also
      // covers a LIVE table whose status is not ACTIVE, so silencing it would
      // hide the case the line exists for. Asserting the ABSENCE OF THE LEVEL
      // rather than the absence of a string -- the old form named text that no
      // longer exists anywhere in src/, so it could not fail.
      expect(debugLines()).not.toContain('ResourceNotFound');
      expect(warnLines()).toContain('could not re-enable');
      expect(warnLines()).toContain('not in this region or account');
      // WHAT HAPPENS TO THE RECORD on this race, asserted rather than reasoned
      // about in a comment (issue #2244). The `assertRegionMatch` throw skips
      // the NotFound branch's own `release()`, so the only thing that could
      // drop the record is `delete()`'s `catch` -- and it does NOT, because the
      // compensation it just ran reports `failed`. That is the intended
      // direction: cdkd turned this guard off, could not put it back, and the
      // retained record is what lets a later delete of the same key retry the
      // re-enable it still owes. A release here would leave that later delete
      // observing the guard already off, recording `flippedOffByThisRun: false`
      // and compensating nothing.
      expect(registrySize(instance)).toBe(1);
    }, 120_000);

    it('does NOT re-enable when the pre-flip OBSERVATION itself failed', async () => {
      // The guard really is ON here, and the run still leaves it alone: a
      // throttled `DescribeTable` means cdkd never learned what the user had,
      // and writing a value it did not read is the strictly-worse outcome the
      // issue names. Unfenced, both directions of this branch were free --
      // flipping the catch to `observedProtectionOn = true` left the suite
      // green, and so did letting a failed observe disable compensation for a
      // table that WAS protected.
      install({
        protectionOn: true,
        observeFails: true,
        onDelete: () => Promise.reject(terminalDeleteRefusal()),
      });

      await expect(
        provider
          .make()
          .delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      // The delete still proceeded -- the observation is best-effort, so a
      // failed read must not become a second reason the destroy does not run.
      expect(flipOffCalls()).toHaveLength(1);
      expect(reEnableCalls()).toHaveLength(0);
      expect(warnLines()).not.toContain('re-enabled on');
    }, 120_000);

    it('does NOT re-enable when the flip-off UpdateTable was REJECTED', async () => {
      // AWS refused the flip, so the guard is still ON and there is nothing to
      // put back. The record is written only AFTER the `UpdateTable` resolves;
      // moving that assignment above the `send` left every case green, because
      // no case had the flip fail.
      install({
        protectionOn: true,
        flipFails: true,
        onDelete: () => Promise.reject(terminalDeleteRefusal()),
      });

      await expect(
        provider
          .make()
          .delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      // The flip was ATTEMPTED (and refused) -- so "an UpdateTable(false) went
      // out" is true here as well, and only the compensating call discriminates.
      expect(flipOffCalls()).toHaveLength(1);
      expect(reEnableCalls()).toHaveLength(0);
      expect(errorLines()).not.toContain('could NOT re-enable');
    }, 120_000);
  }
);


/**
 * ONE case that cannot run against both providers, and the asymmetry is the
 * point rather than an omission.
 *
 * The compensation must not fire once AWS has ACCEPTED the `DeleteTable` — the
 * table is `DELETING`, so a later throw is a WAIT failing, not the delete.
 * Reaching that state needs a step AFTER the accepted delete that can throw, and
 * only `AWS::DynamoDB::GlobalTable` has one: `waitForTableGone`. On the sibling
 * `AWS::DynamoDB::Table` the retry helper's body ENDS at `await
 * opts.deleteTable()`, so no throw can follow an accepted delete there today —
 * its `flip.deleteAccepted = true` is carried for symmetry and becomes reachable
 * the moment that provider grows a post-delete wait of its own (the direct
 * `compensateRemovedDeletionProtection` case below fences the gate itself, which
 * is the half that is type-independent).
 */
describe('AWS::DynamoDB::GlobalTable: an ACCEPTED delete is never compensated (#1978)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    logger.debug.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    autoScalingRetryDelays.sleep = () => Promise.resolve();
    globalTableRetryDelays.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    delete autoScalingRetryDelays.sleep;
    delete globalTableRetryDelays.sleep;
  });

  it('does NOT re-enable when the gone-wait fails after DeleteTable succeeded', async () => {
    // `waitForTableGone` raises `Table X did not disappear within Ns` AFTER the
    // delete was accepted. That message matches no retryable pattern, so it is
    // TERMINAL by the compensation's own predicate — which is why the guard has
    // to be the record and not the shape of the error. Ungated, this issued an
    // `UpdateTable(true)` against a dying table and, when that failed, logged
    // that the table is "LIVE with its deletion protection still off": false,
    // and pointing the user at a table AWS is already deleting.
    //
    // The failure is INJECTED into the wait's own `DescribeTable` rather than
    // waited out: the real message arrives only after 600 polls of a real 1s
    // sleep, and the property under test is "a terminal-looking failure that
    // FOLLOWS an accepted delete", not how long the wait took to give up.
    install({
      protectionOn: true,
      onDelete: () => Promise.resolve({}),
      afterDeleteDescribeError: () => new Error(`Table ${TABLE_NAME} did not disappear within 600s`),
    });

    await expect(
      new DynamoDBGlobalTableProvider().delete(
        LOGICAL_ID,
        TABLE_NAME,
        'AWS::DynamoDB::GlobalTable',
        {},
        REMOVE_PROTECTION
      )
    ).rejects.toThrow(/did not disappear within/);

    expect(flipOffCalls()).toHaveLength(1);
    expect(reEnableCalls()).toHaveLength(0);
    expect(warnLines()).not.toContain('re-enabled on');
    expect(errorLines()).not.toContain('LIVE with its deletion protection still off');
  }, 120_000);
});

/**
 * The two halves of the re-entry fix, fenced directly rather than only through a
 * provider: the KEYED STORE that carries a flip across a re-entered `delete()`,
 * and the `deleteAccepted` GATE. Both are type-independent, so a provider-level
 * case can only ever exercise them one type at a time.
 */
describe('ProtectionFlipRegistry (#1978)', () => {
  const KEY = 'us-east-1\u0000orders';
  const WINDOW_MS = 1_800_000;

  it('returns the SAME record on re-entry inside the reuse window', () => {
    const registry = new ProtectionFlipRegistry();
    const first = registry.acquire(KEY, WINDOW_MS);
    first.flippedOffByThisRun = true;

    // What a re-entered `delete()` gets. A per-call record would hand back a
    // fresh `false` here and the terminal attempt would compensate nothing.
    expect(registry.acquire(KEY, WINDOW_MS).flippedOffByThisRun).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('does NOT share a record across regions with the same table name', () => {
    // A DynamoDB table name is unique per REGION, so a bare-name key would let
    // one region's flip decide another region's compensation.
    const registry = new ProtectionFlipRegistry();
    registry.acquire('us-east-1\u0000orders', WINDOW_MS).flippedOffByThisRun = true;

    expect(registry.acquire('us-west-2\u0000orders', WINDOW_MS).flippedOffByThisRun).toBe(false);
    expect(registry.size).toBe(2);
  });

  it('starts a fresh record after release, and after the reuse window elapses', () => {
    const registry = new ProtectionFlipRegistry();
    registry.acquire(KEY, WINDOW_MS).flippedOffByThisRun = true;
    registry.release(KEY);
    expect(registry.size).toBe(0);
    expect(registry.acquire(KEY, WINDOW_MS).flippedOffByThisRun).toBe(false);

    // Retained entries must not be inherited forever: past the deadline the
    // path is sized against, whoever arrives is a NEW operation. Driven by an
    // injected clock — the real window is 30 minutes.
    //
    // The window SLIDES (#2211), so what has to elapse is the IDLE gap since
    // the LAST acquire. Hence one registry per arm: three acquires on a single
    // one would have the middle acquire (correctly) restart the clock, and the
    // aged-out arm would then be asserting the opposite of the contract.
    let now = 0;
    const atBoundary = new ProtectionFlipRegistry();
    atBoundary.acquire(KEY, WINDOW_MS, () => now).flippedOffByThisRun = true;
    now = WINDOW_MS;
    expect(atBoundary.acquire(KEY, WINDOW_MS, () => now).flippedOffByThisRun).toBe(true);

    now = 0;
    const pastWindow = new ProtectionFlipRegistry();
    pastWindow.acquire(KEY, WINDOW_MS, () => now).flippedOffByThisRun = true;
    now = WINDOW_MS + 1;
    expect(pastWindow.acquire(KEY, WINDOW_MS, () => now).flippedOffByThisRun).toBe(false);
  });

  it('still AGES OUT a record that was reused, so sliding does not make it permanent', () => {
    // The inverse hazard the registry JSDoc names, and the one the slide makes
    // easier to reach: a RETAINED record letting a much LATER destroy of the
    // same table re-enable a guard it never touched. Entries are retained on a
    // throw and the slide moves aging from the FIRST acquire to the LAST, so
    // "the window still works" has to be proven AFTER a reuse, not only on a
    // virgin record.
    //
    // Without this case the suite passes with the window made permanent-on-
    // reuse (measured: adding `|| existing.slid === true` to the reuse test and
    // setting `slid` leaves 33/33 green), which is exactly the forbidden
    // "drop the window entirely" fix arriving through the back door.
    let now = 0;
    const clock = (): number => now;
    const registry = new ProtectionFlipRegistry();

    registry.acquire(KEY, WINDOW_MS, clock).flippedOffByThisRun = true;

    // A reuse INSIDE the window keeps the latch and restarts the stopwatch.
    now = WINDOW_MS - 1;
    expect(registry.acquire(KEY, WINDOW_MS, clock).flippedOffByThisRun).toBe(true);

    // Now go idle past the window FROM THAT REUSE. The record must be dropped
    // and a fresh, unlatched one handed back.
    now += WINDOW_MS + 1;
    expect(registry.acquire(KEY, WINDOW_MS, clock).flippedOffByThisRun).toBe(false);
  });

  it('SLIDES the window on reuse, so a retry sequence outliving it keeps its latch (#2211)', () => {
    // Issue #2211. The window measured from FIRST acquisition is a wall clock
    // while the retry sequence is unbounded, so a `--resource-timeout`
    // overshoot lets a LIVE sequence age out mid-flight: attempt 3 gets a fresh
    // `{ flippedOffByThisRun: false }`, its pre-flip `DescribeTable` sees the
    // guard already off (attempt 1 turned it off), and a terminal failure there
    // compensates nothing — #1978's residue through #1978's own mechanism.
    //
    // Three attempts, each arriving one minute INSIDE the window but with a
    // total age of ~58 minutes, i.e. well past it. The discriminator is record
    // IDENTITY plus the latch, not "acquire returned something": a fixed window
    // returns a perfectly good object here, just not the one carrying the flip.
    let now = 0;
    const clock = (): number => now;
    const registry = new ProtectionFlipRegistry();

    const attempt1 = registry.acquire(KEY, WINDOW_MS, clock);
    attempt1.flippedOffByThisRun = true;

    now += WINDOW_MS - 60_000;
    const attempt2 = registry.acquire(KEY, WINDOW_MS, clock);
    expect(attempt2).toBe(attempt1);
    expect(attempt2.flippedOffByThisRun).toBe(true);

    now += WINDOW_MS - 60_000;
    const attempt3 = registry.acquire(KEY, WINDOW_MS, clock);
    expect(attempt3).toBe(attempt1);
    expect(attempt3.flippedOffByThisRun).toBe(true);
    // Still ONE entry: the slide refreshes the stopwatch, it does not stack
    // records under the same key.
    expect(registry.size).toBe(1);
  });

  it('skips the compensation once the delete was ACCEPTED', async () => {
    const calls: string[] = [];
    const stub = {
      debug: () => {},
      info: () => {},
      warn: (line: string) => calls.push(`warn:${line}`),
      error: (line: string) => calls.push(`error:${line}`),
    };
    const base = {
      error: terminalDeleteRefusal(),
      logicalId: LOGICAL_ID,
      physicalId: TABLE_NAME,
      typeLabel: 'GlobalTable',
      logger: stub as never,
    };

    let reEnables = 0;
    const accepted = await compensateRemovedDeletionProtection({
      ...base,
      flip: { flippedOffByThisRun: true, deleteAccepted: true },
      reEnable: async () => {
        reEnables += 1;
      },
    });
    expect(reEnables).toBe(0);
    expect(calls).toHaveLength(0);
    // `not-applicable`, NOT `failed`: nothing was attempted, so `delete()` may
    // drop the record (issue #2244). The table is already `DELETING` and there
    // is no live guard left for a later delete to owe anything to.
    expect(accepted).toBe('not-applicable');

    // The control: identical inputs with the delete NOT accepted must still
    // compensate, so the assertion above is about `deleteAccepted` rather than
    // about this error shape being un-compensatable.
    const notAccepted = await compensateRemovedDeletionProtection({
      ...base,
      flip: { flippedOffByThisRun: true, deleteAccepted: false },
      reEnable: async () => {
        reEnables += 1;
      },
    });
    expect(reEnables).toBe(1);
    expect(calls.join('\n')).toContain(`re-enabled on ${TABLE_NAME}`);
    expect(notAccepted).toBe('restored');
  });
});

/**
 * The LOG LEVEL of a failed compensation, fenced directly on
 * `compensateRemovedDeletionProtection` (issue #2224).
 *
 * The error line is the mechanism's last resort: it names a LIVE table whose
 * guard is down and the one command that restores it. That is worth an ERROR
 * exactly when it is TRUE.
 *
 * On the RNF arm cdkd cannot establish it, so the ASSERTION is dropped while
 * the line stays VISIBLE. `ResourceNotFoundException` from `UpdateTable` does
 * not mean "the table is gone": the SDK model covers a table whose status is
 * not ACTIVE, which a GlobalTable replica-removal timeout reaches with the
 * table still live and unprotected. Downgrading to `debug` there would hide, at
 * default verbosity, the one case this line exists to report — so the arm logs
 * at `warn` with the ambiguity spelled out, plus a `describe-table` check
 * before the restore command.
 *
 * Three arms, because each kills a different wrong fix: the RNF arm alone
 * passes under a blanket downgrade of the whole `catch`; the control alone
 * passes if RNF is not special-cased at all; and neither notices a downgrade
 * to `debug` that silences a live table, which is what the level assertions
 * pin.
 */
describe('compensateRemovedDeletionProtection: failed re-enable log level (#2224)', () => {
  interface Captured {
    debug: string[];
    warn: string[];
    error: string[];
    /**
     * What the compensation REPORTED, which is a separate contract from what it
     * logged: `delete()` releases the flip record only when this is not
     * `failed` (issue #2244), so a level change that silently also changed the
     * outcome would move a destructive-safety decision without touching a line
     * either suite reads.
     */
    outcome: ProtectionCompensationOutcome;
  }

  function run(reEnableError: unknown, region?: string): Promise<Captured> {
    const captured: Captured = { debug: [], warn: [], error: [], outcome: 'not-applicable' };
    const stub = {
      debug: (line: string) => captured.debug.push(line),
      info: () => {},
      warn: (line: string) => captured.warn.push(line),
      error: (line: string) => captured.error.push(line),
    };
    return compensateRemovedDeletionProtection({
      flip: { flippedOffByThisRun: true, deleteAccepted: false },
      error: terminalDeleteRefusal(),
      logicalId: LOGICAL_ID,
      physicalId: TABLE_NAME,
      typeLabel: 'table',
      logger: stub as never,
      ...(region ? { region } : {}),
      reEnable: () => Promise.reject(reEnableError),
    }).then((outcome) => {
      captured.outcome = outcome;
      return captured;
    });
  }

  it('WARNS, without asserting the table is live, when the re-enable gets ResourceNotFound', async () => {
    const captured = await run(
      new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} })
    );

    expect(captured.error).toHaveLength(0);
    // NOT debug: a live table whose status is merely not ACTIVE also answers
    // RNF here, and silencing that hides the case the line exists for.
    expect(captured.debug).toHaveLength(0);

    const warned = captured.warn.join('\n');
    // The claim issue #2224 objected to must NOT survive: cdkd does not know
    // the table is live, so it may not say so.
    expect(warned).not.toContain('that table is LIVE');
    // ...but it must still say what MIGHT be true, and how to find out.
    // The enumeration must NOT read as exhaustive: a third meaning is "not in
    // this region or account", and the race that reaches this arm IS a region
    // mismatch.
    expect(warned).toContain('most commonly');
    expect(warned).toContain('not in this region or account');
    expect(warned).toContain(`aws dynamodb describe-table --table-name ${TABLE_NAME}`);
    expect(warned).toContain(`aws dynamodb update-table --table-name ${TABLE_NAME}`);
    // The underlying AWS text is still carried, so the line is diagnosable.
    expect(warned).toContain('Requested resource not found');
    // ...and the re-enable is reported as FAILED even though it is narrated at
    // warn. The softer LEVEL is about what cdkd can claim; the OUTCOME is about
    // what it did, and it did not put the guard back -- which is what keeps
    // `delete()` from dropping the record (issue #2244).
    expect(captured.outcome).toBe('failed');
  });

  it('renders --region on BOTH remediation commands when the caller knows it', async () => {
    // Without it the suggested `describe-table` runs against the operator's
    // default profile region. The race that reaches this arm is a REGION
    // MISMATCH, so that lookup answers the same ResourceNotFound and the
    // operator concludes "gone" -- the one thing this message stops asserting.
    const captured = await run(
      new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} }),
      'eu-west-1'
    );

    const warned = captured.warn.join('\n');
    expect(warned).toContain(`describe-table --table-name ${TABLE_NAME} --region eu-west-1`);
    expect(warned).toContain(`update-table --table-name ${TABLE_NAME} --region eu-west-1`);
  });

  it('omits --region entirely when the caller does not know it', async () => {
    const captured = await run(
      new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} })
    );

    expect(captured.warn.join('\n')).not.toContain('--region');
  });

  it('keeps the ERROR line for a re-enable that fails any OTHER way (control)', async () => {
    // Without this arm a blanket downgrade of the whole `catch` passes the case
    // above, and the mechanism's one loud signal is lost for the failures that
    // DO leave a live table unprotected.
    const captured = await run(
      Object.assign(new Error('Table is being updated'), { name: 'ResourceInUseException' })
    );

    expect(captured.debug).toHaveLength(0);
    expect(captured.warn).toHaveLength(0);
    expect(captured.error.join('\n')).toContain('could NOT re-enable');
    expect(captured.error.join('\n')).toContain('LIVE with its deletion protection still off');
    expect(captured.error.join('\n')).toContain(
      `aws dynamodb update-table --table-name ${TABLE_NAME}`
    );
    expect(captured.outcome).toBe('failed');
  });

  it('matches on the SDK error NAME, not on the class identity', async () => {
    // The predicate is name-keyed so this module needs no SDK import and a
    // second copy of the class (two client versions in one tree) still matches.
    const captured = await run(
      Object.assign(new Error('Requested resource not found'), {
        name: 'ResourceNotFoundException',
      })
    );

    expect(captured.error).toHaveLength(0);
    expect(captured.debug).toHaveLength(0);
    expect(captured.warn.join('\n')).toContain('could not re-enable');
  });
});
