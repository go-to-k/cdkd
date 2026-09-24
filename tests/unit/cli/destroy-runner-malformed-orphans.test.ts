/**
 * Issue go-to-k/cdkd#3379: `runDestroyForStack` reads the `orphans` CONTAINER
 * on a bare `?? []` at both of its reads, and what each shape then counts
 * splits three ways (measured): `null`, `''` and `{length: 0}` count 0; a
 * string or `{length: N}` counts non-zero; a number, an object or a boolean
 * yields `undefined`.
 *
 * That count is what `stillEmpty` consults before `deleteState`, and the orphan
 * warning above it is what would have told the operator that resources from an
 * earlier failed deploy are still live in AWS. So an unreadable container sends
 * the run down the ordinary path to deletion with the record's own evidence
 * never reported — and the record is then gone.
 *
 * TWO reads, two cases. The entry read is guarded beside the `resources` guard;
 * the UNDER-LOCK re-read is a different object (a concurrent writer or a hand
 * edit can land between them) and is the record `stillEmpty` and `deleteState`
 * actually act on. A guard at the first read alone leaves the second open,
 * which is why the re-read case supplies a DIFFERENT record from the entry one.
 *
 * The assertions name `orphans` rather than only "refused": a record with no
 * resources is refused by the `resources` guard too, so a bare refusal
 * assertion would pass without this one. `null` is the shape that reaches
 * `deleteState`, and it gets its own re-read case for that reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({ getProviderFor: vi.fn() })),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => {
  const renderer = {
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  };
  return { getLiveRenderer: () => renderer };
});

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { getLogger } from '../../../src/utils/logger.js';

const REGION = 'us-east-1';
const STACK = 'TestStack';

/** Every shape `parseStateBody` lets through, by the OUTCOME it produces. */
const MALFORMED: Array<[string, unknown]> = [
  // `?? []` admits it, `.length` is undefined -> counts 0 -> the run proceeds.
  ['a number container', 5],
  ['a plain object container', {}],
  // `.length` is 1, which a `.length`-keyed guard would accept while every
  // reader that WALKS the container still fails.
  ['an object carrying length', { length: 1 }],
  // Walked one character at a time by `for...of`.
  ['a string container', 'abc'],
  ['a null container', null],
  // The other two shapes that count 0 and so reach `deleteState`.
  ['an empty-string container', ''],
  ['an object carrying a zero length', { length: 0 }],
];

function stateWith(orphans: unknown, resources: Record<string, unknown> = {}): StackState {
  return {
    version: 9,
    stackName: STACK,
    region: REGION,
    resources: resources as StackState['resources'],
    outputs: {},
    orphans: orphans as StackState['orphans'],
    lastModified: 1,
  };
}

function makeCtx(recheckState?: StackState) {
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const acquireLock = vi.fn().mockResolvedValue(true);
  const releaseLock = vi.fn().mockResolvedValue(undefined);
  const listStacks = vi.fn().mockResolvedValue([]);
  const getProviderFor = vi.fn();
  const getState = vi
    .fn()
    .mockResolvedValue(recheckState ? { state: recheckState, migrationPending: false } : null);
  return {
    deleteState,
    acquireLock,
    releaseLock,
    getState,
    getProviderFor,
    ctx: {
      stateBackend: {
        getState,
        deleteState,
        saveState: vi.fn(),
        listStacks,
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock,
        releaseLock,
        getLockInfo: vi.fn().mockResolvedValue(null),
      } as unknown as LockManager,
      providerRegistry: { getProviderFor } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

describe('runDestroyForStack refuses a malformed `orphans` container (go-to-k/cdkd#3379)', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const [label, orphans] of MALFORMED) {
    it(`refuses ${label} at the entry read, deleting nothing`, async () => {
      const h = makeCtx();
      const thrown = await runDestroyForStack(STACK, stateWith(orphans), h.ctx).catch(
        (e: unknown) => e
      );
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      // The CONTAINER by name. `resources: {}` is READABLE, so the resources
      // guard does not fire here — what a bare "it threw" assertion would not
      // separate is this refusal from the ordinary empty-stack path below it.
      expect((thrown as CdkdError).message).toContain("'orphans'");
      // The DESTROY text, not the generic writer one: a destroy removes the
      // record rather than writing the container back, and it owes the way out.
      expect((thrown as CdkdError).message).toContain('DELETES state');
      expect((thrown as CdkdError).message).toContain('cdkd state orphan');
      // DOMINANCE: nothing deleted, no lock taken, no provider reached.
      expect(
        h.deleteState,
        'the destroy deleted the record before refusing, so its orphan evidence is gone'
      ).not.toHaveBeenCalled();
      expect(h.acquireLock).not.toHaveBeenCalled();
      expect(h.getProviderFor).not.toHaveBeenCalled();
    });
  }

  it('refuses when only the UNDER-LOCK re-read carries the damaged container', async () => {
    // The entry record is clean and EMPTY, so the run reaches the empty-stack
    // path, takes the lock and re-reads — and the re-read is what it acts on.
    const h = makeCtx(stateWith('abc'));
    const thrown = await runDestroyForStack(STACK, stateWith([]), h.ctx).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
    expect(
      (thrown as CdkdError).message,
      'the refusal does not name `orphans`, so this passes on some other guard and the ' +
        're-read is still unguarded'
    ).toContain("'orphans'");
    // The DESTROY text at THIS site too: both messages name the container, so
    // without this the re-read could revert to the writer refusal unnoticed.
    expect((thrown as CdkdError).message).toContain('DELETES state');
    // What this case pins is the NAMING above: for a string `stillEmpty` reads
    // 3, so the run stops elsewhere without the guard and a bare "refused"
    // assertion would not discriminate. The DELETION is pinned by the null
    // case below, the one shape that reaches `deleteState`.
    expect(h.deleteState).not.toHaveBeenCalled();
    // It got far enough to take the lock and re-read — otherwise the case is
    // vacuous and proves only what the entry guard already does.
    expect(h.acquireLock).toHaveBeenCalled();
    expect(h.getState).toHaveBeenCalled();
    expect(h.releaseLock, 'the lock is stranded').toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['an object carrying a zero length', { length: 0 }],
  ])('refuses %s at the re-read, a shape that would reach deleteState', async (_label, orphans) => {
    // These three count 0, so `stillEmpty` is true and `deleteState` runs on a
    // record whose orphan evidence was never read. A number or a plain object
    // yields `undefined` and a string counts its characters, so those stop the
    // run elsewhere — which is why the string case above pins the NAMING and
    // these pin the DELETION.
    const h = makeCtx(stateWith(orphans));
    const thrown = await runDestroyForStack(STACK, stateWith([]), h.ctx).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).message).toContain("'orphans'");
    expect((thrown as CdkdError).message).toContain('DELETES state');
    expect(
      h.deleteState,
      'the destroy deleted the record the re-read exists to protect'
    ).not.toHaveBeenCalled();
    expect(h.acquireLock).toHaveBeenCalled();
  });

  it('marks the refusal non-retryable — a retry cannot change a persisted record', async () => {
    const h = makeCtx();
    const thrown = await runDestroyForStack(STACK, stateWith(5), h.ctx).catch((e: unknown) => e);
    expect(isMarkedNonRetryable(thrown)).toBe(true);
  });

  it('CONTROL: a readable or absent container runs to the delete', async () => {
    // DRIVEN rather than asserted absent: an empty record with a readable
    // container reaches `deleteState`, so an unrelated early failure cannot
    // satisfy this the way a bare `not.toContain` would.
    // The populated row carries a `state` since go-to-k/cdkd#3500: a bare
    // `{ logicalId: 'A' }` is a row the listing cannot read (it prints
    // `entry.state.resourceType`), so the ROW guard now refuses it — correctly,
    // and this control is about the CONTAINER being a list.
    const usableRow = {
      logicalId: 'A',
      orphanedAt: 1,
      state: { physicalId: 'live-a', resourceType: 'AWS::SQS::Queue', properties: {} },
    };
    for (const orphans of [[], [usableRow], undefined]) {
      vi.clearAllMocks();
      const h = makeCtx(stateWith(orphans));
      const thrown = await runDestroyForStack(STACK, stateWith(orphans), h.ctx).catch(
        (e: unknown) => e
      );
      const message = thrown instanceof CdkdError ? thrown.message : '';
      expect(message).not.toContain("'orphans'");
      // EVERY readable shape reaches the delete, populated included: with no
      // resources left the run takes the ordinary path, warns about the orphans,
      // and removes the record. This used to expect the populated case NOT to
      // delete, and it passed for a reason that was the go-to-k/cdkd#3500 defect
      // rather than the rule it claimed: its row was `{ logicalId: 'A' }` with no
      // `state`, so the listing threw a `TypeError` before any delete. With a
      // usable row the run completes, which is what the guard must not prevent.
      expect(
        h.deleteState,
        'the control never reached the delete, so it proves nothing'
      ).toHaveBeenCalled();
    }
  });
});

/**
 * Issue go-to-k/cdkd#3500, destroy half — a READABLE list holding a row the
 * pre-confirmation listing cannot read. That listing is the operator's only
 * notice that resources from an earlier failed deploy stop being tracked, and it
 * prints `entry.logicalId` and `entry.state.*` per row while validating none of
 * them. Unguarded, what an unusable row does there depends on which part is
 * torn — it can abort the run, or print a row the operator is about to approve
 * with a field missing from it.
 */
describe('runDestroyForStack refuses an unusable orphan ROW (go-to-k/cdkd#3500)', () => {
  beforeEach(() => vi.clearAllMocks());

  const healthy = {
    logicalId: 'Keep',
    orphanedAt: 1,
    state: { physicalId: 'live-keep', resourceType: 'AWS::SQS::Queue', properties: {} },
  };

  const UNUSABLE: Array<[string, unknown]> = [
    ['a null row', null],
    ['a number row', 5],
    ['a row with no `state`', { logicalId: 'Gone', orphanedAt: 1 }],
    ['a row whose `logicalId` is not a string', { logicalId: 5, orphanedAt: 1, state: healthy.state }],
    [
      'a row whose `state.properties` is not an object',
      {
        logicalId: 'Gone',
        orphanedAt: 1,
        state: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: 'abcdef' },
      },
    ],
    // Symmetry across the per-command tables (go-to-k/cdkd#3641, items o3 and o7):
    // all five now carry BOTH torn maps and the empty-object row — deploy,
    // destroy, scrub, rollback and import — so a predicate clause cannot be
    // covered at one command and unfenced at another. The first cut claimed that
    // for five tables while extending three, which the maintainer's o7 measured.
    ['an empty-object row', {}],
    // go-to-k/cdkd#3641 item o12: `physicalId: ''` had only a bag-level unit case,
    // so restoring the empty-string acceptance reddened nothing at the COMMAND
    // level. What this row pins is that the REFUSAL fires here — not the blank
    // listing and deletion that acceptance used to produce, which no case drives
    // and which this comment does not credit it with (round-4 proxy pass).
    [
      "a row whose `state.physicalId` is the EMPTY string",
      {
        logicalId: 'Gone',
        orphanedAt: 1,
        state: { physicalId: '', resourceType: 'AWS::SQS::Queue', properties: {} },
      },
    ],
    [
      'a row whose `state.attributes` is not an object',
      {
        logicalId: 'Gone',
        orphanedAt: 1,
        state: {
          physicalId: 'p',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: 'abcdef',
        },
      },
    ],
  ];

  for (const [label, row] of UNUSABLE) {
    it(`refuses ${label} at the entry read, deleting nothing`, async () => {
      // A resource in `resources` too, so the run does NOT take the empty-stack
      // fast path: this case has to reach the listing's own guard rather than
      // exit earlier for an unrelated reason.
      const h = makeCtx();
      const thrown = await runDestroyForStack(
        STACK,
        stateWith([healthy, row], { A: { physicalId: 'a', resourceType: 'AWS::SQS::Queue', properties: {} } }),
        h.ctx
      ).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(CdkdError);
      expect((thrown as CdkdError).code).toBe(STATE_RESOURCES_MALFORMED);
      // The ROW text, and the DESTROY one: it must not claim the field would be
      // written back, which is the writer text's mechanism.
      expect((thrown as CdkdError).message).toContain('rollback-orphan record(s)');
      expect((thrown as CdkdError).message).toContain('DELETES state');
      expect((thrown as CdkdError).message).not.toContain("has no readable 'orphans' list");
      expect(
        h.deleteState,
        'the destroy removed the record it could not fully read'
      ).not.toHaveBeenCalled();
    });
  }

  it('refuses when only the UNDER-LOCK re-read carries the unusable row', async () => {
    // The entry read is clean, so this case can only pass if the re-read is
    // guarded too — and the re-read is the record `deleteState` acts on.
    const h = makeCtx(stateWith([healthy, 5]));
    const thrown = await runDestroyForStack(STACK, stateWith([]), h.ctx).catch((e: unknown) => e);
    expect(thrown, 're-read rows are unguarded').toBeInstanceOf(CdkdError);
    expect((thrown as CdkdError).message).toContain('rollback-orphan record(s)');
    expect(h.deleteState).not.toHaveBeenCalled();
    // It got far enough to take the lock and re-read, or the case proves nothing
    // about the re-read.
    expect(h.acquireLock).toHaveBeenCalled();
    expect(h.getState).toHaveBeenCalled();
    expect(h.releaseLock, 'the lock is stranded').toHaveBeenCalled();
  });

  it('CONTROL: a list whose every row is usable runs to the delete', async () => {
    // An EMPTY record first, then a populated one below. Both reach
    // `deleteState`: with no resources left the run takes the ordinary path
    // either way, which the container control above establishes.
    const h = makeCtx(stateWith([]));
    const outcome = await runDestroyForStack(STACK, stateWith([]), h.ctx).catch(
      (e: unknown) => e as Error
    );
    expect(outcome, `refused a usable list: ${String(outcome)}`).not.toBeInstanceOf(Error);
    expect(h.deleteState, 'the control never deleted, so it proves nothing').toHaveBeenCalled();

    // ...and a POPULATED list of usable rows is not refused either, which is the
    // half the empty case cannot show.
    vi.clearAllMocks();
    const populated = makeCtx(stateWith([healthy]));
    const second = await runDestroyForStack(STACK, stateWith([healthy]), populated.ctx).catch(
      (e: unknown) => e as Error
    );
    expect(second, `refused a usable populated list: ${String(second)}`).not.toBeInstanceOf(Error);
  });

  it('REFUSES a row with no `physicalId` rather than listing a blank field', async () => {
    // The shape that passed every guard before go-to-k/cdkd#3641's review: a
    // healthy `logicalId` and `resourceType`, no physical id. The listing rendered
    // it as `  - A (AWS::SQS::Queue)  ` — a row the operator approves with the one
    // field they would need to find the resource cdkd is about to forget MISSING.
    const noPhysicalId = {
      logicalId: 'A',
      orphanedAt: 1,
      state: { resourceType: 'AWS::SQS::Queue', properties: {} },
    };
    const h = makeCtx();
    const thrown = await runDestroyForStack(
      STACK,
      stateWith([noPhysicalId], { Db: { physicalId: 'p', resourceType: 'AWS::RDS::DBInstance', properties: {} } }),
      h.ctx
    ).catch((e: unknown) => e);
    expect(thrown, 'the row was accepted, so the listing prints a blank field').toBeInstanceOf(
      CdkdError
    );
    expect((thrown as CdkdError).message).toContain('rollback-orphan record(s)');
    // The diagnosis names the field, or the operator cannot tell what to repair.
    expect((thrown as CdkdError).message).toContain("'physicalId'");
    expect(h.deleteState).not.toHaveBeenCalled();
  });

  it('SANITIZES the RESOURCES half of the same banner, where the rows really are deleted', async () => {
    // The orphan listing was sanitized first and this half was not, which left the
    // PR's own claim false where it costs most (go-to-k/cdkd#3641 security
    // review): these resources are deleted once the operator answers y, and
    // `ConsoleLogger` sanitizes extra ARGS, never the message. A `resources` KEY
    // carrying a newline forged rows and a fake orphan tally into the banner.
    const forged =
      'Real\n  - DeleteMe (AWS::S3::Bucket)\n\n5 resource(s) are still in AWS from an earlier failed deploy.';
    const h = makeCtx();
    await runDestroyForStack(
      STACK,
      stateWith([], {
        [forged]: {
          physicalId: 'p',
          resourceType: `AWS::SQS::Queue${String.fromCharCode(0x1b)}[2K`,
          properties: {},
        },
      }),
      h.ctx
    ).catch(() => undefined);
    const rows = (getLogger().info as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.startsWith('  - '));
    expect(rows, 'the resource row was never listed, or listed more than once').toHaveLength(1);
    expect(rows[0], 'the forged newline survived, so the row can still BREAK').not.toContain('\n');
    expect(rows[0], 'the escape run reached the terminal').not.toContain(String.fromCharCode(0x1b));
    // The real key is still readable — sanitizing may not cost the operator the name.
    expect(rows[0]).toContain('Real');
  });

  it('SANITIZES all THREE listing fields, and cuts none of an identifier', async () => {
    // Both halves of the listing rule, which the refusal cases cannot reach —
    // they never get to the listing. The row is USABLE, so it prints.
    //
    // This banner is the operator's only notice of what stops being tracked and
    // the record is gone once they answer y, so the rendering may not DROP part
    // of an identifier. Two legitimate shapes `displayIdent` would drop, both
    // measured: a physical id past its 255-code-point cap (1011 here, a maximal
    // SSM parameter name; a comma-joined SNS topic list passes 2048), and a
    // non-ASCII one a Custom Resource may return, which its allowlist renders as
    // `"customer-"`. Swapping either field back to `displayIdent` reds this case.
    //
    // EVERY field carries a hostile value, and that is the point rather than
    // thoroughness: with the forgery in `resourceType` alone, un-sanitizing
    // either of the other two changed nothing any assertion could see (round-6
    // proxy pass). Each one gets its own injected newline AND its own escape.
    const esc = String.fromCharCode(0x1b);
    // Long AND non-ASCII: a physical id is provider-defined, so `asciiOnly` would
    // strip a legitimate one just as the allowlist does. With an all-ASCII id the
    // `{ asciiOnly: true }` mutant produced identical output (round-10 proxy pass).
    const longId = `/app/\u6771\u4eac/${'p'.repeat(1003)}`;
    expect(longId).toHaveLength(1011);
    const hostile = {
      // Non-ASCII (which `displayIdent` cuts) PLUS its own forgery.
      logicalId: `Keep-\u6771\u4eac\nBOGUS ID ROW${esc}[2K`,
      orphanedAt: 1,
      state: {
        // A newline forged an extra row and a fake tally into the banner the
        // operator's y/N answers; an ESC run redrew the lines above it.
        resourceType: `AWS::SQS::Queue\nBOGUS TYPE ROW${esc}[2K`,
        // Long (which `displayIdent` truncates) PLUS its own forgery, appended so
        // the length that must survive is measured before it.
        physicalId: `${longId}\nBOGUS PID ROW${esc}[2K`,
        properties: {},
      },
    };
    const h = makeCtx(stateWith([hostile]));
    await runDestroyForStack(STACK, stateWith([hostile]), h.ctx);
    const printed = (getLogger().info as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => String(args[0]))
      .join('\n');
    // The non-ASCII logical id survives WHOLE — `displayIdent` would cut it to
    // `"Keep-"`, and the operator would be told a name that is not the one in the
    // record.
    expect(printed, 'the row was never listed, or its id was cut').toContain('Keep-\u6771\u4eac');
    // The full id survives — its length, and its non-ASCII characters.
    expect(printed, 'a legitimate long physicalId was cut out of the only notice').toContain(
      longId
    );
    expect(printed).not.toContain('[cut:');
    // The forged TEXT is still there and that is fine — what the sanitizer takes
    // away is its POWER: the newline becomes a space, so the row cannot BREAK.
    // Asserting the characters' absence would assert the wrong property
    // (measured: they survive, the row does not).
    //
    // Tested on the LOG CALL, not on a line filter over the joined output: a
    // filter for lines starting `  - ` discards the continuation a surviving
    // newline would produce, so it counts ONE row either way and the assertion
    // is satisfied by the defect it exists to catch (round-4 review).
    const rows = (getLogger().info as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.startsWith('  - '));
    // ONE log call for the one row — this counts CALLS, so it cannot see a
    // surviving newline (that stays inside a single call, and the assertion below
    // is what catches it). Its message says so rather than crediting the forged-row
    // property to it (go-to-k/cdkd#3641 test review).
    expect(rows, 'the row was listed more than once, or not at all').toHaveLength(1);
    expect(rows[0], 'the injected newline survived, so the row can still BREAK').not.toContain('\n');
    // Deliberately NOT asserting a quote: `displaySafe` adds no boundary, because
    // the value it renders here is prose in a notice rather than an argument to a
    // command the operator pastes.
    expect(rows[0], 'the sanitized row lost the resource type').toContain('AWS::SQS::Queue');
    // The escape itself never reaches the terminal. Scoped to the ROW, not to the
    // whole log: cdkd's own success line is legitimately coloured, so a
    // whole-output assertion fails on correct code.
    expect(rows[0], 'the escape run reached the terminal').not.toContain(
      String.fromCharCode(0x1b)
    );
  });
});
