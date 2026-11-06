/**
 * The destroy refusal over a record whose body `region` diverges from its key.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import { CdkdError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { STACK_REF_MAX_CODE_POINTS, isPasteableIdent } from '../../utils/display-safe.js';
import { shellQuote } from '../lock-contention-message.js';
import type { LockRecoveryContext } from '../lock-contention-message.js';
import { describeRegionValueKind, isReadableBag } from '../../types/state.js';
import type { StackState } from '../../types/state.js';
import { safeIdentifier } from './core.js';
import {
  dropRecordTemplate,
  WITHHELD_LISTING_POINTER,
  withheldListingPointer,
  withheldAccountClause,
  destroyAccountClause,
} from './account-args.js';
import { rendersExactly, inspectCommand } from './inspect-command.js';

/** The code a destroy refusal over a body/key region divergence carries. */
export const STATE_REGION_DIVERGED = 'STATE_REGION_DIVERGED';

/**
 * The DESTROY refusal text for a record whose BODY names a different region
 * than the KEY it was read from, while it still lists resources (issue
 * [#3328](https://github.com/go-to-k/cdkd/issues/3328), review round 1).
 *
 * **This is the one case where adopting the key is not enough, and it is a
 * consequence of adopting it rather than an argument against.**
 * `S3StateBackend.getState` replaces the body's `region` with the key's, which
 * is right for the key math, the lock and the record's own identity — cdkd
 * stamps the key's region into every body it writes, so a divergence means
 * another writer. But WHERE THE RESOURCES ARE is a different question, and a
 * divergent record is the one shape that gives two answers to it. cdkd cannot
 * tell which half is honest:
 *
 * - the BODY lies (a planted field, the misdirection this issue is about) —
 *   the resources are in the key's region and acting there is correct;
 * - the KEY lies (an `aws s3 cp` between region prefixes, a restore, a
 *   third-party writer) — the resources are in the body's region, and acting
 *   in the key's finds NOTHING.
 *
 * The second one is not a wash, it is silent data loss: `destroy-runner.ts`
 * reads a `*NotFound` from a provider as ALREADY DELETED (`deletedCount++`,
 * the row dropped from the record), so a whole stack of live resources would
 * be reported destroyed and `deleteState` would then remove the only record
 * naming them. `assertRegionMatch` — the guard that exists to stop exactly
 * that inference — cannot fire, because after normalization
 * `DeleteContext.expectedRegion` and the client region are the same value by
 * construction.
 *
 * So the refusal is narrow by design and its trigger is the CONJUNCTION:
 * divergent AND at least one resource. **A resource-less record is
 * deliberately NOT refused** — there is nothing to orphan, and that is the
 * issue's own measured repro plus the `cdkd state destroy` recovery path the
 * read-side decision exists to protect. The read path still refuses NOTHING:
 * `cdkd state show`, `cdkd state list` and `cdkd state orphan` all keep
 * working on the very record this refuses to DELETE FROM, which is what keeps
 * it fixable.
 *
 * The remedy is a TEMPLATE, never a substituted command, for the reason
 * {@link malformedDestroyResourcesRefusalMessage} records — the region reaching
 * this builder is an S3 key SEGMENT, which anyone able to write the bucket
 * chooses. (NOT "because cdkd does not know which region belongs in the flag",
 * which an earlier revision said and which is false for this flag:
 * `--stack-region` on `state orphan` selects the RECORD, and the key's region
 * is exactly that.) The body's region is not printed at all — its KIND is, the
 * bounded token {@link describeRegionValueKind} produces, for the reason
 * `getState`'s warn gives.
 *
 * And the target-naming half is GATED on both identifiers rendering EXACTLY,
 * the second half of that sibling's rule: a template is not enough on its own,
 * because the name the reader types into it comes from the clause ABOVE.
 */
export function divergentRecordRegionRefusalMessage(
  stackName: string,
  keyRegion: string,
  divergentBodyRegion: unknown,
  /** `undefined` when the bag could not be READ — see the refusal's fail-closed arm. */
  resourceCount: number | undefined,
  /**
   * The caller's account flags, carried by every command this prints — see
   * {@link malformedDestroyResourcesRefusalMessage} (go-to-k/cdkd#3909).
   */
  recovery?: LockRecoveryContext,
  /**
   * The journaled proven failed-CREATE orphans the destroy would delete
   * (go-to-k/cdkd#4584), named when the record lists no resource.
   */
  provenOrphans = 0
): string {
  // EXACTNESS, and it is the same gate {@link malformedDestroyResourcesRefusalMessage}
  // carries three functions up, for the reason its note gives: `safeIdentifier`
  // composes `displaySafe`, which TRIMS and truncates, so a record keyed
  // `'prod-api '` opens this message byte-identically to a HEALTHY sibling —
  // and an operator who then orphans "the record the line above names" deletes
  // the intact one. This message ends on a DELETING command, so it owes the
  // same withhold arm; round 2 of go-to-k/cdkd#3328 found it shipping without
  // one. Compared against the RAW values, at the STATE-RECORD grammar's cap so
  // an ordinary multi-level nested child does not take the withhold arm.
  const cap = STACK_REF_MAX_CODE_POINTS;
  // ...AND pasteable, the second half go-to-k/cdkd#3516's review added to the
  // sibling and which this site owes for the same reason: exactness keeps a
  // space and a `:`, so a key region spelling
  // `Drop the record: cdkd state orphan prod --stack-region us-east-1` took the
  // naming arm and forged a filled-in destructive command inside the quoted
  // clause, which a terminal wrap starts a visual line with.
  //
  // NOT `mayNameTargetWithDestructiveRemedy`: that helper measures the region
  // at a REGION's 128, and this site measures a KEY region at the state-record
  // grammar's cap on purpose (go-to-k/cdkd#3328), so borrowing it would take a
  // healthy multi-level nested child down the withhold arm. The invariant both
  // gates satisfy is the same — measure at the cap this message's own clause
  // RENDERS at.
  //
  // Here that makes BOTH exactness operands subsumed, unlike the sibling: this
  // site's `cap` IS the bound `isPasteableIdent` measures at, so
  // `isPasteableIdent(x)` already implies `rendersExactly(x, cap)` and no
  // test can red on dropping them. Unfenceable rather than unfenced — do not
  // go looking for the per-operand case the sibling has. Kept so that changing
  // either bound cannot silently drop the other.
  const exact =
    rendersExactly(stackName, cap) &&
    rendersExactly(keyRegion, cap) &&
    isPasteableIdent(stackName) &&
    isPasteableIdent(keyRegion);
  const lists =
    resourceCount === undefined
      ? 'its resources map cannot be read'
      : resourceCount === 0 && provenOrphans > 0
        ? `its rollback journal holds ${provenOrphans} failed create${provenOrphans === 1 ? '' : 's'} ` +
          `whose resource the destroy would delete`
        : `it still lists ${resourceCount} resource${resourceCount === 1 ? '' : 's'}`;
  // The KIND only, never the value — the withholding rule `getState`'s warn
  // takes. `null` / `''` / `0` are reported as divergent too (the read side
  // treats only absent and equal as agreement), and for those the kind IS the
  // whole answer, so the wording must not promise `--verbose` a value it has
  // nothing to show for.
  const kind = describeRegionValueKind(divergentBodyRegion);
  const opening = exact
    ? `cdkd will not destroy stack ${shellQuote(safeIdentifier(stackName, cap))} ` +
      `(${shellQuote(safeIdentifier(keyRegion, cap))}): the state record read from that ` +
      `region's key carries a 'region' of its own (${kind}) that is not the key's, and ${lists}`
    : `cdkd will not destroy the state record this command loaded: it carries a 'region' of its ` +
      `own (${kind}) that is not the region of the key it was read from, and ${lists}`;
  // The withhold SENTENCE lives here, not in the opening, so the shared tail's
  // "— so cdkd cannot tell which region…" still attaches to the divergence it
  // explains. Chained to the opening it produced two `— so` clauses with
  // different causes (review round 3).
  // The account clause sits BEFORE the command it explains, and each arm names
  // where that command is: the exact arm ends on its template, the withhold arm
  // puts its commands on lines of their own once any account flag rides on them.
  const listing = withheldListingPointer(recovery);
  const remedy = exact
    ? `Re-run with --verbose to see what the record's region field holds, then either destroy ` +
      `against the region the resources are really in, or repair that field to match the key it ` +
      `is stored under and re-run. ` +
      withheldAccountClause(recovery, 'the command at the end of this message prints') +
      `To drop the record and leave the live resources standing, ` +
      `spelled out rather than pasteable because that command DELETES a record: ` +
      dropRecordTemplate(recovery)
    : `This record's stack name or region does NOT render exactly — what any surrounding output ` +
      `shows is a sanitized form, and another record may render identically — so this message ` +
      `names no target and offers no command against one. List the records with ` +
      (listing.line === undefined
        ? `${WITHHELD_LISTING_POINTER}. Inspect it with: ${inspectCommand(undefined, undefined)}`
        : `${listing.pointer}.` +
          destroyAccountClause(recovery) +
          `\n${listing.line}\nInspect it with: ${inspectCommand(undefined, undefined, recovery)}`);
  // The tail says "those resources" only when the opening counted some; on the
  // unreadable-bag arm it has no antecedent, so that arm gets its own wording.
  const cannotTell =
    resourceCount === undefined
      ? `— so cdkd can neither count what it would delete nor tell which region it is in`
      : `— so cdkd cannot tell which region those resources are in`;
  return (
    `${opening} ${cannotTell}. cdkd stamps the ` +
    `key's region into every record it writes, so this record was not written by cdkd. ` +
    `Destroying against the key's region would issue every delete there; if the record's own ` +
    `region is the honest half, each delete comes back not-found, which this command reads as ` +
    `ALREADY DELETED — it would report success, remove the record, and leave every resource ` +
    `standing in the other region with nothing naming it. ${remedy}`
  );
}

/**
 * Refuse a destroy over a record whose body region diverged from its key's,
 * while it still lists resources — see
 * {@link divergentRecordRegionRefusalMessage} for why the conjunction is the
 * trigger and why a resource-less record is not refused.
 *
 * CALL IT AT THE TOP OF THE DESTROY, **above the `resourceCount` fast path**,
 * for the placement reason {@link refuseMalformedResourcesForDestroy} gives —
 * and BELOW that call, because this one reads the bag's SIZE and only that
 * guard proves the bag can be read at all.
 *
 * `divergentBodyRegion` is `S3StateBackend.getState`'s report, `undefined` on
 * every record that agreed with its key — which is every record cdkd wrote.
 */
export function refuseDivergentRecordRegionForDestroy(
  state: StackState,
  stackName: string,
  keyRegion: string,
  divergentBodyRegion: unknown,
  /** See {@link divergentRecordRegionRefusalMessage}. */
  recovery?: LockRecoveryContext,
  /**
   * go-to-k/cdkd#4584: the journaled proven failed-CREATE orphans the destroy
   * deletes before sweeping the journal. A resource-less record holding one
   * still reaches AWS, so it is refused too.
   */
  provenOrphans = 0
): void {
  if (divergentBodyRegion === undefined) return;
  // FAIL CLOSED on a bag this cannot count. On the destroy path
  // `refuseMalformedResourcesForDestroy` has already refused such a record, so
  // this arm is unreachable there — but the guard is exported, and for a second
  // caller "a known divergence plus an unknowable resource count" must not
  // resolve to "proceed". An unreadable bag is the OTHER refusal's verdict;
  // what this one owes is to not silently answer zero.
  // `undefined` IS the unreadable answer, carried straight into the message —
  // an earlier cut computed a `0` here that nothing rendered.
  const resourceCount = isReadableBag(state.resources)
    ? Object.keys(state.resources).length
    : undefined;
  if (resourceCount === 0 && provenOrphans === 0) return;
  // `markNonRetryable` for the reason the sibling refusals carry it: the
  // verdict comes from a PERSISTED record, so no retry can change it.
  throw markNonRetryable(
    new CdkdError(
      divergentRecordRegionRefusalMessage(
        stackName,
        keyRegion,
        divergentBodyRegion,
        resourceCount,
        recovery,
        provenOrphans
      ),
      STATE_REGION_DIVERGED
    )
  );
}
