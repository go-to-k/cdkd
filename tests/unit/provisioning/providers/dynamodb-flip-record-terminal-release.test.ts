import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DescribeTableCommand, DeleteTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';

/**
 * Issue #2244 -- the flip record must not outlive the delete it belongs to.
 *
 * `ProtectionFlipRegistry` entries are RETAINED on a throw by design: that is
 * what carries "an earlier attempt already flipped the guard off" across the
 * re-entered `delete()` issue #1978's round 2 fixed. Until this change the ONLY
 * things that dropped a record were `release()` on the success path and on the
 * NotFound branch, so a TERMINAL failure left one behind for a full reuse
 * window -- and issue #2211's SLIDE moved that window's clock from the FIRST
 * acquire to the LAST, lengthening exactly this retention.
 *
 * Inside that window a second delete of the same `region\0name` key IN THE SAME
 * PROCESS inherits `flippedOffByThisRun: true`. A provider is REGISTERED once,
 * so every delete served by the same `ProviderRegistry` reaches the same
 * provider INSTANCE and therefore the same registry -- while `destroy-runner.ts`
 * builds a FRESH registry when a stack's region differs, so the sharing is per
 * registry rather than per process, which is also why the key is
 * region-qualified. The second delete is reachable that way (a rollback, a
 * sibling stack, a retried destroy, or two state records naming ONE physical
 * table after a `cdkd import` adopted it into a second stack) -- and it answers
 * its own terminal failure with an `UpdateTable(DeletionProtectionEnabled:
 * true)` the user never asked for.
 *
 * THE CASES PIN THREE ANSWERS, because the release reads a PREDICATE and an
 * OUTCOME rather than just a predicate:
 *
 *  - a TERMINAL failure whose compensation did not FAIL releases -- on the
 *    ordinary route, on the Ctrl-C route, and under a region-qualified key;
 *  - a RETRYABLE one still does NOT, however many attempts the outer loop makes
 *    before its cap gives up -- known narrowing 1 of `isTerminalDeleteFailure`,
 *    intended behaviour that nothing pinned until now (issue #2244 item 2); and
 *  - a terminal failure whose compensating `UpdateTable` FAILED does not release
 *    either. There the guard really is off and cdkd is the one that turned it
 *    off, so the record is the only in-process memory that a re-enable is still
 *    owed, and a later delete of the same key must be able to retry it.
 *
 * BOTH OVER-RELEASE DIRECTIONS ARE FENCED BLACK-BOX rather than only by the
 * white-box `registrySize` line: releasing on a RETRYABLE failure reds the case
 * where a throttle sequence ends terminally and must still re-enable (the #1978
 * regression), and releasing on a FAILED compensation reds the case where the
 * SECOND delete must still emit the re-enable cdkd owes.
 *
 * THE DISCRIMINATOR IS NEVER "THE DELETE THREW". Every case here throws under
 * the broken code too. What only the fixed path produces is the ABSENCE of a
 * second `UpdateTable(DeletionProtectionEnabled: true)` on a LATER delete --
 * so every such assertion is preceded by one proving the call array was
 * populated at all, and by an attempt COUNT proving the later delete really
 * reached `DeleteTable` rather than dying early and passing vacuously.
 *
 * ONE suite for BOTH DynamoDB types, for the reason
 * `dynamodb-remove-protection-compensate.test.ts` states: they are one root
 * cause with two `delete()` bodies, and the #1955 review already found one
 * half-applied twin in this pair.
 */

const { mockSend, mockAutoScalingSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
}));

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
  const actual = await importOriginal<typeof import('@aws-sdk/client-application-auto-scaling')>();
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

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
import { InterruptedWaitError } from '../../../../src/provisioning/interrupt-watch.js';
import type { DeleteContext } from '../../../../src/provisioning/region-check.js';
import {
  DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS as DELETE_BUDGET_REUSE_WINDOW_MS,
  dynamoDbDeleteBudgetOverride,
} from '../../../../src/provisioning/providers/dynamodb-delete-budget.js';

const logger = getLogger() as unknown as {
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const TABLE_NAME = 'orders';
const LOGICAL_ID = 'Orders';
const REMOVE_PROTECTION: DeleteContext = { removeProtection: true };
/** The context of a delete that did NOT ask for the guard to be touched. */
const PLAIN_DELETE: DeleteContext = {};
/**
 * The region the mocked client answers with, so `assertRegionMatch` agrees and
 * the only thing a case with `expectedRegion` set exercises is the region half
 * of `deleteBudgetKey`.
 */
const CLIENT_REGION = 'us-east-1';

function errorLines(): string {
  return logger.error.mock.calls.map((c) => String(c[0])).join('\n');
}

/** Every `UpdateTable` that turns the guard back ON -- the compensating call. */
function reEnableCalls(): UpdateTableCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter(
      (command): command is UpdateTableCommand =>
        command instanceof UpdateTableCommand && command.input.DeletionProtectionEnabled === true
    );
}

/** Every `UpdateTable` that turns the guard OFF -- the `--remove-protection` flip. */
function flipOffCalls(): UpdateTableCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter(
      (command): command is UpdateTableCommand =>
        command instanceof UpdateTableCommand && command.input.DeletionProtectionEnabled === false
    );
}

/**
 * How many records the provider's own registry is holding.
 *
 * White-box on purpose, and it is the SECOND assertion in every case rather
 * than the first: the black-box discriminator (no unrequested `UpdateTable`)
 * is what a user experiences, while this one says WHERE the difference lives
 * and reds even on a route whose later-delete arm is awkward to stage.
 */
function registrySize(instance: unknown): number {
  return (instance as { protectionFlips: { size: number } }).protectionFlips.size;
}

/**
 * A refusal `destroy-runner.ts` will NOT re-enter `delete()` for -- and which
 * the provider's own index-busy loop does not retry either. Copied from
 * `dynamodb-remove-protection-compensate.test.ts`, including the reason it is
 * not an `AccessDeniedException`: AWS spells those `... is not authorized to
 * perform: ...`, which IS a `RETRYABLE_ERROR_MESSAGE_PATTERNS` entry.
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

interface Behaviour {
  /** What `DescribeTable` reports for `DeletionProtectionEnabled` before the flip. */
  protectionOn: boolean;
  /** What `DeleteTable` does, given the 1-based attempt number. */
  onDelete: (attempt: number) => Promise<unknown>;
  /**
   * What the compensating `UpdateTable(DeletionProtectionEnabled: true)` does,
   * given the 1-based call number. Defaults to succeeding.
   *
   * Per-CALL rather than a boolean because the failed-compensation case needs
   * the two answers in one run: the first re-enable fails (so the record must
   * be RETAINED) and the second, issued by a LATER delete that inherited the
   * record, succeeds -- which is what makes "the retry actually happened" an
   * observation rather than an inference.
   */
  onReEnable?: (call: number) => Promise<unknown>;
}

/** Attempts `DeleteTable` has been asked for, across every `delete()` in a case. */
let deleteAttempts = 0;

function install(behaviour: Behaviour): void {
  let flipped = false;
  let reEnableAttempts = 0;
  deleteAttempts = 0;
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableStatus: 'ACTIVE',
          DeletionProtectionEnabled: behaviour.protectionOn && !flipped,
          GlobalSecondaryIndexes: [],
          Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
        },
      });
    }
    if (command instanceof UpdateTableCommand) {
      if (command.input.DeletionProtectionEnabled === false) {
        flipped = true;
        return Promise.resolve({});
      }
      if (command.input.DeletionProtectionEnabled === true) {
        reEnableAttempts += 1;
        if (behaviour.onReEnable !== undefined) {
          const call = reEnableAttempts;
          return behaviour.onReEnable(call).then((result) => {
            // Only a re-enable AWS ACCEPTED puts the guard back. A rejected one
            // leaves it off, which is what makes the next delete's pre-flip
            // observation read `false` -- the exact reason a released record
            // would make that delete compensate nothing.
            flipped = false;
            return result;
          });
        }
        // The compensation landed, so the guard really is back on -- which is
        // what makes a RETAINED `flippedOffByThisRun: true` describe a world
        // that no longer exists.
        flipped = false;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    }
    if (command instanceof DeleteTableCommand) {
      deleteAttempts += 1;
      return behaviour.onDelete(deleteAttempts);
    }
    return Promise.resolve({});
  });
}

interface ProviderCase {
  readonly resourceType: string;
  readonly make: () => {
    delete: (
      logicalId: string,
      physicalId: string,
      resourceType: string,
      properties?: Record<string, unknown>,
      context?: DeleteContext
    ) => Promise<void>;
  };
}

const PROVIDERS: readonly ProviderCase[] = [
  { resourceType: 'AWS::DynamoDB::Table', make: () => new DynamoDBTableProvider() },
  { resourceType: 'AWS::DynamoDB::GlobalTable', make: () => new DynamoDBGlobalTableProvider() },
];

describe.each(PROVIDERS)(
  '$resourceType: the flip record and a TERMINAL delete failure (#2244)',
  (provider: ProviderCase) => {
    beforeEach(() => {
      mockSend.mockReset();
      mockAutoScalingSend.mockReset();
      logger.debug.mockClear();
      logger.warn.mockClear();
      logger.error.mockClear();
      mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
      autoScalingRetryDelays.sleep = () => Promise.resolve();
      tableRetryDelays.sleep = () => Promise.resolve();
      globalTableRetryDelays.sleep = () => Promise.resolve();
    });

    afterEach(() => {
      delete autoScalingRetryDelays.sleep;
      delete tableRetryDelays.sleep;
      delete globalTableRetryDelays.sleep;
      delete dynamoDbDeleteBudgetOverride.clock;
    });

    it('releases it, so a LATER delete cannot re-enable a guard the user never asked it to touch', async () => {
      // THE case issue #2244 item 1 is about, and the whole point of asserting
      // on the SECOND delete: "the delete threw" and "the guard was restored"
      // are both true of the broken code. What only the fix produces is that
      // the second delete -- same process, same instance, same key, and no
      // `--remove-protection` anywhere in it -- issues NO `UpdateTable`.
      install({ protectionOn: true, onDelete: () => Promise.reject(terminalDeleteRefusal()) });
      const instance = provider.make();

      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      // NON-VACUITY, both halves. The compensation really ran (so the array the
      // assertion below reads is populated), and the record really went.
      expect(flipOffCalls()).toHaveLength(1);
      const compensations = reEnableCalls().length;
      expect(compensations).toBe(1);
      expect(reEnableCalls()[0]?.input).toMatchObject({
        TableName: TABLE_NAME,
        DeletionProtectionEnabled: true,
      });

      // A second destroy reaching the same table in the same process. It never
      // asks for the guard to be touched, and it fails terminally too.
      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, PLAIN_DELETE)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      // It really got as far as `DeleteTable` -- otherwise a run that died
      // before the compensation could fire would satisfy the next line for the
      // wrong reason.
      expect(deleteAttempts).toBe(2);
      // No new flip: this delete did not ask for one.
      expect(flipOffCalls()).toHaveLength(1);
      // THE DISCRIMINATOR. Broken, the inherited latch adds a second
      // `UpdateTable(DeletionProtectionEnabled: true)` here.
      expect(reEnableCalls()).toHaveLength(compensations);
      // The white-box corroboration comes LAST on purpose. Asserted before the
      // second delete it would red FIRST under a reverted fix, and the probe
      // would then prove only that the registry field changed -- never that the
      // user-visible discriminator above discriminates. Measured: with the
      // release removed, this ordering reds on the `reEnableCalls` line.
      expect(registrySize(instance)).toBe(0);
    }, 120_000);

    it('keeps ONE record across an attempt-cap-exhausting retry sequence, and it is not inherited past the reuse window', async () => {
      // Issue #2244 item 2, first half. Attempt-cap exhaustion is known
      // narrowing 1 of `isTerminalDeleteFailure`: the provider cannot see which
      // attempt is the outer loop's last, so a sequence that dies on the cap
      // ends with the guard off and the record HELD. That is intended, and the
      // fix above must not quietly change it -- a `release()` on every throw
      // would be the re-entered-delete regression #1978 round 2 fixed.
      //
      // Two properties, and the second is the one the issue asks for by name:
      // the registry does not LEAK (one entry per key, not one per attempt),
      // and the held record is not INHERITED by a later delete once the reuse
      // window has elapsed.
      const CAP = 4;
      let now = 0;
      dynamoDbDeleteBudgetOverride.clock = (): number => now;
      install({
        protectionOn: true,
        onDelete: (attempt) =>
          Promise.reject(attempt <= CAP ? throttleRefusal() : terminalDeleteRefusal()),
      });
      const instance = provider.make();

      for (let i = 0; i < CAP; i += 1) {
        await expect(
          instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
        ).rejects.toThrow(/Rate exceeded/);
        // Each re-entry arrives a minute later -- well inside the window, so
        // the SLIDE (#2211) keeps handing back the same record.
        now += 60_000;
      }

      // Every attempt flipped (the flip is unconditional and idempotent), so
      // the call arrays are populated and the count below is a real bound.
      expect(deleteAttempts).toBe(CAP);
      expect(flipOffCalls()).toHaveLength(CAP);
      // Nothing compensated: a retryable failure is re-entered, and toggling
      // the guard between attempts is what the predicate exists to prevent.
      expect(reEnableCalls()).toHaveLength(0);
      // NO LEAK: one record for the key, not one per attempt.
      expect(registrySize(instance)).toBe(1);

      // The outer loop has now given up. Nothing releases the record -- and
      // that is the residue this narrowing accepts. What must NOT happen is a
      // later delete inheriting it, and what stops that is the window.
      now += DELETE_BUDGET_REUSE_WINDOW_MS + 1;

      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, PLAIN_DELETE)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      expect(deleteAttempts).toBe(CAP + 1);
      expect(flipOffCalls()).toHaveLength(CAP);
      // The post-cap record was NOT inherited: no unrequested re-enable.
      expect(reEnableCalls()).toHaveLength(0);
      // ...and this delete's own fresh record was released by the fix above.
      expect(registrySize(instance)).toBe(0);
    }, 120_000);

    it('releases it on the Ctrl-C route as well, which is the one that most needs it', async () => {
      // The production comment calls the interrupt "the route that most needs
      // it", and until this case nothing composed `isInterruptedWaitError` ->
      // `isTerminalDeleteFailure` -> release: a claim in a comment that no test
      // reaches is one a refactor can quietly drop.
      //
      // The error is INJECTED as an `InterruptedWaitError` rather than staged
      // through a real SIGINT, because the half this case is about is the
      // PREDICATE composition, not the plumbing that produces the error. That a
      // genuine Ctrl-C arrives in this `catch` as an `InterruptedWaitError` --
      // through the index-busy backoff on `Table` and through
      // `waitForReplicaGone` on `GlobalTable` -- is established by the two
      // Ctrl-C cases in `dynamodb-remove-protection-compensate.test.ts`. It
      // reaches the wrapper wrapped in a `ProvisioningError`, so what is
      // exercised here is the `cause`-chain walk the predicate really does.
      install({
        protectionOn: true,
        onDelete: () => Promise.reject(new InterruptedWaitError('DeleteTable')),
      });
      const instance = provider.make();

      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

      // NON-VACUITY: the run really got past the flip and really compensated,
      // so the array the discriminator reads is populated.
      expect(flipOffCalls()).toHaveLength(1);
      const compensations = reEnableCalls().length;
      expect(compensations).toBe(1);

      // A rollback or a sibling stack reaching the same key while the process
      // is still winding down.
      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, PLAIN_DELETE)
      ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

      expect(deleteAttempts).toBe(2);
      expect(flipOffCalls()).toHaveLength(1);
      // THE DISCRIMINATOR.
      expect(reEnableCalls()).toHaveLength(compensations);
      expect(registrySize(instance)).toBe(0);
    }, 120_000);

    it('releases under the REGION-QUALIFIED key, not under the bare table name', async () => {
      // Every other case leaves `expectedRegion` undefined, so the region half
      // of `deleteBudgetKey` is never exercised and a release built from the
      // WRONG region source -- `undefined`, the client's region, a literal --
      // would stay green while dropping nothing. Here the record is acquired
      // under `us-east-1\0orders`, so a release keyed any other way deletes an
      // entry that does not exist and the second delete inherits the latch.
      const REGIONAL: DeleteContext = { removeProtection: true, expectedRegion: CLIENT_REGION };
      const REGIONAL_PLAIN: DeleteContext = { expectedRegion: CLIENT_REGION };
      install({ protectionOn: true, onDelete: () => Promise.reject(terminalDeleteRefusal()) });
      const instance = provider.make();

      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REGIONAL)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      expect(flipOffCalls()).toHaveLength(1);
      const compensations = reEnableCalls().length;
      expect(compensations).toBe(1);

      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REGIONAL_PLAIN)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      expect(deleteAttempts).toBe(2);
      expect(flipOffCalls()).toHaveLength(1);
      // THE DISCRIMINATOR.
      expect(reEnableCalls()).toHaveLength(compensations);
      expect(registrySize(instance)).toBe(0);
    }, 120_000);

    it('still re-enables when a THROTTLE sequence ENDS terminally, so the release cannot go unconditional', async () => {
      // The OVER-release direction, fenced BLACK-BOX inside this file rather
      // than only by the `registrySize` line above. Making the release
      // unconditional reds `registrySize` in the attempt-cap case, but that is
      // a white-box line: what a user experiences is this one. Released after
      // the first throttle, attempt 2 acquires a FRESH record, its pre-flip
      // observation reads the guard as already off (attempt 1 turned it off and
      // nothing put it back), so `flippedOffByThisRun` stays false and the
      // TERMINAL attempt compensates nothing -- a live table left stripped,
      // which is exactly the issue #1978 regression its round 2 fixed.
      //
      // `dynamodb-remove-protection-compensate.test.ts` has the same shape from
      // the compensation's side; it is repeated here so this file fences its own
      // change rather than depending on a sibling suite nobody edits alongside
      // it.
      install({
        protectionOn: true,
        onDelete: (attempt) =>
          Promise.reject(attempt < 3 ? throttleRefusal() : terminalDeleteRefusal()),
      });
      const instance = provider.make();

      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Rate exceeded/);
      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Rate exceeded/);
      // Nothing between attempts: a retryable failure is re-entered, and
      // toggling the guard across a retry is what the predicate prevents.
      expect(reEnableCalls()).toHaveLength(0);

      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      // Non-vacuity: all three attempts really reached `DeleteTable` and really
      // flipped, so the count below is a bound rather than an artefact.
      expect(deleteAttempts).toBe(3);
      expect(flipOffCalls()).toHaveLength(3);
      // THE DISCRIMINATOR. The latch survived both retryable throws, so the
      // terminal attempt put the guard back.
      expect(reEnableCalls()).toHaveLength(1);
      expect(reEnableCalls()[0]?.input).toMatchObject({
        TableName: TABLE_NAME,
        DeletionProtectionEnabled: true,
      });
      // ...and only THEN was it dropped.
      expect(registrySize(instance)).toBe(0);
    }, 120_000);

    it('KEEPS it when the compensating re-enable FAILED, so a later delete can retry the one cdkd owes', async () => {
      // The second over-release direction, and the reason the release reads the
      // compensation's OUTCOME and not only the predicate. On this arm the
      // guard really is off and cdkd is the one that turned it off, so a later
      // re-enable is the action cdkd OWES -- not the unrequested one the
      // release exists to prevent, which is about a guard already put back.
      //
      // Reachable rather than theoretical: two state records can name one
      // physical table (a `cdkd import` adopting it into a second stack), same
      // region, same registry. Released here, stack B's delete observes the
      // guard already off, records `flippedOffByThisRun: false`, compensates
      // nothing, and the table ends UNGUARDED.
      install({
        protectionOn: true,
        onDelete: () => Promise.reject(terminalDeleteRefusal()),
        onReEnable: (call) =>
          call === 1
            ? Promise.reject(
                Object.assign(new Error('Table is being updated'), {
                  name: 'ResourceInUseException',
                })
              )
            : Promise.resolve({}),
      });
      const instance = provider.make();

      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, REMOVE_PROTECTION)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      // NON-VACUITY: the flip landed, the compensation was ATTEMPTED, and it is
      // the ATTEMPT that failed rather than the compensation being skipped.
      expect(flipOffCalls()).toHaveLength(1);
      expect(reEnableCalls()).toHaveLength(1);
      expect(errorLines()).toContain('could NOT re-enable');

      // A second delete of the same key -- and it never asks for the guard to
      // be touched, so everything it does to the guard comes from the record.
      await expect(
        instance.delete(LOGICAL_ID, TABLE_NAME, provider.resourceType, {}, PLAIN_DELETE)
      ).rejects.toThrow(/Attempt to change a resource which is still in use/);

      // It really reached `DeleteTable`, so the line below cannot pass because
      // the run died early.
      expect(deleteAttempts).toBe(2);
      // No new flip: this delete did not ask for one.
      expect(flipOffCalls()).toHaveLength(1);
      // THE DISCRIMINATOR, and it is the OPPOSITE polarity to every other case
      // here: the retained record makes the second delete retry the re-enable.
      expect(reEnableCalls()).toHaveLength(2);
      expect(reEnableCalls()[1]?.input).toMatchObject({
        TableName: TABLE_NAME,
        DeletionProtectionEnabled: true,
      });
      // That retry LANDED, so this time the record is dropped -- the outcome
      // gate is what decides, not the predicate, which was true both times.
      expect(registrySize(instance)).toBe(0);
    }, 120_000);
  }
);
