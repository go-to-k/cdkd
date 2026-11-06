import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { parseFailureDebugDetail } from '../../../utils/json-parse-failure.js';
import { refusedBaselineRemedy } from '../refused-baseline-remedy.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import { displayIdent, displayStackName, safeMsg } from '../../../utils/display-safe.js';
import {
  buildLockContentionMessage,
  type LockRecoveryContext,
} from '../../../state/lock-contention-message.js';
import {
  refuseMalformedResourceEntries,
  refuseMalformedState,
} from '../../../state/malformed-resources-bag.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import { withStackScope } from '../../../provisioning/resource-name.js';
import { nameScopeOf } from '../../../state/name-generation.js';
import {
  redactForState,
  maskReadbackAtCoordinates,
  noEchoLeavesOf,
  maskedLeafCoordinatesOf,
} from '../../../deployment/secret-redaction.js';
import { PublicSsmProver } from '../../../deployment/public-ssm-proof.js';
import { secretNamePrintingBags } from '../../../deployment/secret-name-needles.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import { buildReadCurrentStateContext, driftProducerRegionEvidence } from '../drift.js';
import {
  acceptRefusedAssertion,
  confirmAcceptRefused,
  judgeAcceptRefused,
} from '../state-refresh-observed.js';
import { stackInstanceIdOf } from '../../../state/stack-instance-id.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { formatStackRefSafe } from './refs.js';

/** A `--accept-refused` run's target (issue #3466). */
export interface AcceptRefusedRequest {
  logicalId: string;
  /** The parsed `--template` file the gate judges against. */
  template: Record<string, unknown>;
  /** `-y` / `--yes`: the assertion is logged instead of asked. */
  yes: boolean;
}

/** Per-stack tallies of `cdkd state refresh-observed`. */
interface RefreshObservedCounts {
  refreshed: number;
  unsupported: number;
  failed: number;
  /** AWS reports the resource gone — deleted outside cdkd (go-to-k/cdkd#4283). */
  notFound: number;
  /** Declined over an `observedBaselineRefused` marker (issue #2944). */
  refusedBaseline: number;
  /**
   * The subset of `refusedBaseline` an in-place deploy may NOT clear
   * (`refusedBaselineRemedy` names one), issue #3465.
   */
  refusedSticky: number;
}

/**
 * Refresh the `observedProperties` of every resource in one stack
 * record. Returns counts so the caller can aggregate across `--all`.
 *
 * `dryRun: true` skips the lock + saveState + provider call entirely
 * and just reports how many resources would be refreshed; this is a
 * cheap "preview the scope" mode that doesn't need AWS credentials
 * for the underlying SDK reads.
 */
export async function refreshObservedForStack(
  stackName: string,
  region: string,
  stateBackend: S3StateBackend,
  lockManager: LockManager,
  providerRegistry: ProviderRegistry,
  opts: {
    dryRun: boolean;
    logger: ReturnType<typeof getLogger>;
    // Threaded so the contention message can name the SAME lock object this
    // call was working on, rather than whatever `force-unlock` would re-resolve
    // from the ambient profile (issue #2170).
    lockRecovery?: LockRecoveryContext;
    /** Issue #3466: refresh ONLY this refused resource, clearing its refusal. */
    accept?: AcceptRefusedRequest;
  }
): Promise<RefreshObservedCounts> {
  const { logger, lockRecovery, accept } = opts;
  // `stackName` is an S3 key segment under `--all` and `region` always is, so
  // every line naming this record takes `formatStackRefSafe`'s boundary rather
  // than cdkd's own ` (region)` beside a raw value (go-to-k/cdkd#3179).
  const ref = formatStackRefSafe({ stackName, region });

  const result = await stateBackend.getState(stackName, region);
  if (!result) {
    throw new Error(
      safeMsg`No state found for stack ${ref}. ` + `Run 'cdkd state list' to see available stacks.`
    );
  }
  const { state, etag, migrationPending } = result;

  // go-to-k/cdkd#3018. This is the one WRITER in this file, and the two
  // malformed shapes below fail it in OPPOSITE directions — which is why one
  // guard would not have covered both.
  //
  // The BAG first: `?? {}` covered nullish and nothing else, so a hand-edited
  // `"resources": "abcdef"` yielded six phantom `[index, character]` entries
  // that cleared the `entries.length === 0` return, took the lock, and reached
  // the save. The shape that reaches real damage is a bag edited into a LIST of
  // resource OBJECTS — those entries refresh, so `refreshed > 0` drops
  // `skippedOutputs` and `observedProperties` are written back into the list;
  // the string shape looks benign because nothing can refresh under it, which is
  // why it is not the case to build a fence from.
  //
  // Then the ENTRIES, whose failure is the opposite one: `hasReadableResources`
  // tests the BAG, so a readable map holding `{"R": null}` passes it and the
  // `null` ABORTED one dereference later, at `resource.observedBaselineRefused`
  // in BOTH loops below — a bare `TypeError` rather than a bad write. Refusing
  // it here is about naming the row, not about protecting the save.
  //
  // REFUSE, not repair and not skip, for the reason
  // `src/state/malformed-resources-bag.ts` gives at each helper: a repair would
  // save a well-formed bag over the only evidence the record is broken, and a
  // skip would report a clean refresh over entries nothing can read. Both checks
  // sit ABOVE the `--dry-run` branch on purpose — the dry run must reach the
  // same answer in the same order as the real run (the reason it has its own
  // loop at all), and a refusal below the branch would have let `--dry-run`
  // report a plan for a record the real run refuses.
  // `lockRecovery` qualifies the refusals' pasteable commands with this run's
  // account flags (go-to-k/cdkd#3909), as it does the contention hint below.
  refuseMalformedState(state, stackName, region, lockRecovery);
  refuseMalformedResourceEntries(state, stackName, region, lockRecovery);

  // No `?? {}`: the two refusals above have already thrown for every shape it
  // covered, so a fallback here could no longer fire and would only make a later
  // reader think the guard is at the loop rather than at the load. Same rule the
  // read-only sites in this file apply.
  let entries = Object.entries(state.resources);

  // Issue #3466. The gate runs on the record as loaded, ahead of the dry-run
  // branch so a plan and a run refuse alike, and the run then touches only
  // this one resource.
  const acceptId = accept?.logicalId;
  if (accept !== undefined) {
    const record = Object.hasOwn(state.resources, accept.logicalId)
      ? state.resources[accept.logicalId]
      : undefined;
    const verdict = judgeAcceptRefused(record, accept.logicalId, accept.template, {
      stackName,
      region,
      resources: state.resources,
    });
    if (!verdict.ok) {
      throw new Error(safeMsg`${ref}: ${verdict.reason}`);
    }
    entries = [[accept.logicalId, record!]];
    if (!opts.dryRun) {
      const assertion = acceptRefusedAssertion(
        accept.logicalId,
        record!.resourceType,
        ref,
        verdict.legacy
      );
      if (accept.yes) {
        logger.warn(safeMsg`${assertion} (asserted with --yes)`);
      } else if (!(await confirmAcceptRefused(assertion))) {
        logger.info('Aborted.');
        return {
          refreshed: 0,
          unsupported: 0,
          failed: 0,
          notFound: 0,
          refusedBaseline: 0,
          refusedSticky: 0,
        };
      }
    }
  }

  if (entries.length === 0) {
    logger.info(safeMsg`✓ ${ref}: no resources in state, skipping`);
    return {
      refreshed: 0,
      unsupported: 0,
      failed: 0,
      notFound: 0,
      refusedBaseline: 0,
      refusedSticky: 0,
    };
  }

  if (opts.dryRun) {
    let wouldRefresh = 0;
    let wouldUnsupported = 0;
    let wouldRefuse = 0;
    let wouldRefuseSticky = 0;
    for (const [logicalId, resource] of entries) {
      // Issue #2944, and this arm is the reason the dry run has its own loop
      // rather than sharing the real one: it must apply the SAME gate in the
      // SAME order, or the plan promises a refresh the run then declines. It is
      // first here for the same reason it is first there — a refused resource
      // is supported and would otherwise be counted as one that WOULD refresh.
      // The one `--accept-refused` names passed its own gate (issue #3466).
      if (resource.observedBaselineRefused === true && logicalId !== acceptId) {
        wouldRefuse++;
        if (refusedBaselineRemedy(resource) !== undefined) wouldRefuseSticky++;
        continue;
      }
      let provider;
      try {
        provider = providerRegistry.getProviderFor({
          resourceType: resource.resourceType,
          provisionedBy: resource.provisionedBy,
        }).provider;
      } catch {
        wouldUnsupported++;
        continue;
      }
      if (provider.readCurrentState) wouldRefresh++;
      else wouldUnsupported++;
    }
    if (accept !== undefined && wouldRefresh === 0) {
      // The plan refuses as the run does (issue #3466).
      throw new Error(
        safeMsg`${ref}: cdkd cannot read ${displayIdent(accept.logicalId)} back from AWS, so no ` +
          `baseline can be captured and its refusal stands.`
      );
    }
    logger.info(
      safeMsg`Plan ${ref}: ${wouldRefresh} resource(s) would be refreshed, ${wouldUnsupported} unsupported` +
        (wouldRefuse > 0 ? safeMsg`, ${wouldRefuse} refused (import baseline refusal)` : '')
    );
    return {
      refreshed: wouldRefresh,
      unsupported: wouldUnsupported,
      failed: 0,
      notFound: 0,
      refusedBaseline: wouldRefuse,
      refusedSticky: wouldRefuseSticky,
    };
  }

  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
  // Check the boolean (issue #2161): a bare `acquireLock` returns `false` for a
  // live foreign lock without throwing, so the discarded return let `state
  // refresh-observed` rewrite state under a concurrent deploy and then release
  // that deploy's lock. Throwing on `!acquired` aborts before any state write.
  const acquired = await lockManager.acquireLock(
    stackName,
    region,
    owner,
    'state-refresh-observed'
  );
  if (!acquired) {
    throw new Error(
      await buildLockContentionMessage({
        lockManager,
        stackName,
        region,
        recovery: lockRecovery,
      })
    );
  }
  try {
    let refreshed = 0;
    let unsupported = 0;
    let failed = 0;
    let notFound = 0;
    let refusedBaseline = 0;
    let refusedSticky = 0;

    // Issue #2036: one prover per stack, so each `ssm` reference is asked
    // about once however many records embed it. Its region and producer-region
    // evidence are the ones `cdkd drift` routes by: the stack's own reads plus,
    // for a nested child, every ancestor's (go-to-k/cdkd#4213). The evidence is
    // derived LAZILY — only when a region-less reference is about to be looked
    // up — so a stack with none reads no ancestor record under its lock. If it
    // cannot be established it is INCOMPLETE and no region-less reference is
    // proven; it never fails the refresh.
    const publicSsmProver = new PublicSsmProver(
      region,
      () => driftProducerRegionEvidence(state, stackName, region, stateBackend),
      logger
    );

    // Refresh in parallel under the stack's naming scope so any
    // provider-internal resource-name resolution sees the right stack and
    // lifetime (go-to-k/cdkd#5064; mirrors the deploy engine's scope).
    const stackInstanceId = stackInstanceIdOf(state, displayStackName(stackName));
    await withStackScope(nameScopeOf(stackName, stackInstanceId, state), async () => {
      // go-to-k/cdkd#3869: each read runs under the record's printing bag, as
      // `cdkd drift` does: a provider's debug line, and a failed read's AWS
      // error, name the physical id, which for a resource named from a secret
      // (or a reader of one) no recorded plaintext spells. Log-only needles, so
      // the redaction below never reads them.
      const printingBagOf = secretNamePrintingBags(state.resources, undefined);
      const tasks = entries.map(([logicalId, resource]) =>
        withPrintingSecrets(printingBagOf(logicalId), async () => {
          // Schema v10+ (issue #2944). A `cdkd import` run REFUSED to capture a
          // baseline for this resource because its recorded `properties` can no
          // longer position the redaction — and this command positions its
          // readback against exactly those `properties` (the 4th argument to
          // `readCurrentState`, and the source bag handed to
          // `redactSecretsForState` below). After a refusal they can hold the
          // WRONG-BRANCH LITERAL the import distrusted, and a literal source leaf
          // against a string readback PAIRS as an ordinary drifted literal, so
          // the walk refuses nothing and the decrypted value is persisted.
          //
          // This command has NO template in hand — by construction, it is the
          // synth-free half of the CLI — so the discard evidence the refusal was
          // based on is structurally unavailable to it. Reading the marker is the
          // only thing it can do, which is why the refusal is persisted at all;
          // see `ResourceState.observedBaselineRefused`'s doc.
          //
          // Counted apart from `unsupported`: a refused resource IS supported and
          // WOULD have been refreshed, so folding it into that tally would report
          // a security refusal as missing provider coverage.
          // The one `--accept-refused` names passed its gate (issue #3466).
          if (resource.observedBaselineRefused === true && logicalId !== acceptId) {
            refusedBaseline++;
            if (refusedBaselineRemedy(resource) !== undefined) refusedSticky++;
            return;
          }
          if (providerRegistry.shouldSkipResource(resource.resourceType)) {
            unsupported++;
            return;
          }
          let provider;
          try {
            provider = providerRegistry.getProviderFor({
              resourceType: resource.resourceType,
              provisionedBy: resource.provisionedBy,
            }).provider;
          } catch {
            unsupported++;
            return;
          }
          if (!provider.readCurrentState) {
            unsupported++;
            return;
          }
          try {
            const observed = await provider.readCurrentState(
              resource.physicalId,
              logicalId,
              resource.resourceType,
              resource.properties ?? {},
              // Issue #323: pass cross-resource context so IAM providers
              // can filter out inline policies managed by sibling
              // AWS::IAM::Policy resources. The refreshed observed must
              // match what `cdkd drift` would see (also passes context),
              // otherwise post-refresh drift would fire on the offset.
              buildReadCurrentStateContext(state, logicalId)
            );
            if (observed === undefined) {
              // Provider is registered with readCurrentState but has no read
              // path for this type. Leave observed unchanged.
              unsupported++;
              return;
            }
            if (observed === RESOURCE_NOT_FOUND) {
              // AWS reports the resource gone (go-to-k/cdkd#4283). Not a type
              // without a read path, so not `unsupported`: there is nothing to
              // refresh, and saying so is what tells the user. Counted on its own
              // (the run exits 2, with its own advice), and the record keeps
              // whatever baseline it had rather than being nulled out under what
              // may be an eventual-consistency window.
              notFound++;
              logger.warn(
                safeMsg`  ✗ ${displayStackName(stackName)}/${displayIdent(logicalId)} ` +
                  safeMsg`(${displayIdent(resource.resourceType)}): ` +
                  `not found in AWS — it was deleted outside cdkd; 'cdkd drift' reports it as deleted.`
              );
              return;
            }
            // GHSA-p5qg-v9gv-hc7w (issue #1926). The readback is what AWS
            // actually holds, so for a resource deployed from a
            // `{{resolve:secretsmanager:...}}` reference — or a
            // `{{resolve:ssm:...}}` naming a `SecureString` — it is the DECRYPTED
            // value, and persisting it verbatim re-introduces the advisory's
            // disclosure inside `state.json`. This writer reached the redaction
            // module through NO path at all before this line, which is why the
            // #1910 sweep (framed as "every writer passes a POSITION source")
            // never surfaced it.
            //
            // The map is EMPTY by construction (issue #1926): this command neither
            // synthesizes nor resolves, so no plaintext is ever recorded and a
            // VALUE scan has no needles — POSITION is the whole mechanism: the
            // record's own `properties` hold the unresolved expression, and
            // walking the observed bag against them rewrites the plaintext AWS
            // echoes back onto that expression with no secret fetch and no value
            // matching.
            //
            // The MIXED-leaf and unpairable-array refusals live in
            // `secret-redaction.ts`, NOT here (issue #1926 review). This command
            // is not the only writer with an empty map and a state-bag source — a
            // plain `cdkd deploy` reaches the same configuration through
            // `drainObservedCaptures` and the persist choke point — so a remedy
            // spelled at this call site would have left the DEFAULT path leaking.
            // That module's `refuseUncertifiedReadbackPositions` carries the
            // measured per-shape table, and since issue #2012 landed the rows it
            // names are fewer — by TWO SEPARATE mechanisms, which the table keeps
            // apart and so must this note. `unkeyedArrayPairsByAnchors` closes
            // two rows CONDITIONALLY: an unkeyed array is walked positionally
            // when its own positions corroborate the alignment. The OTHER two
            // rows (an unpaired element beside a paired one; an observed KEY the
            // source does not carry) are closed instead by DERIVED NEEDLES, and
            // this write site is exactly where they apply — `deriveReadbackNeedles`
            // returns nothing unless the secrets map is EMPTY, which it is here
            // by construction (see above). Read that
            // function's own table for which shapes still fall through.
            //
            // A THIRD mechanism since issue
            // [#2852](https://github.com/go-to-k/cdkd/issues/2852), and it is the
            // one that decides what happens where the first two say nothing: the
            // walk FAILS CLOSED. A position whose source subtree spells a
            // reference and whose two sides cannot be paired is persisted as
            // `SECRET_MASK` rather than as the readback — which is what closes
            // this command's own raw-shape hazard, issue
            // [#2846](https://github.com/go-to-k/cdkd/issues/2846): `cdkd import`
            // legitimately writes a RAW `Fn::Join` / `Fn::Sub` OBJECT into
            // `properties` (its warn path says so), and walking a STRING readback
            // against it used to persist the decrypted value here. The remedy is
            // in the MODULE for the same reason the two above are, and the
            // remaining open row is named on that function.
            //
            // `STATE_SOURCED_BASELINE_RULES` is the row this write site occupies
            // in `secret-redaction/rules.ts`'s generation table ("observed walk,
            // own-record source"): the source is THIS record's own persisted bag,
            // so it is the same GENERATION as the bag beside it and holds no
            // PUBLIC ssm expression — a `String` parameter is stored resolved
            // (issue #1901) — which is what lets a stored expression win over the
            // plaintext AWS echoes back. BLIND positional array descent stays off
            // because AWS may reorder a list, and the two relaxations that reach
            // an element anyway both live inside that pass and are inherited here
            // rather than re-solved: the order-independent KEYED descent added by
            // issue #1915, so a secret nested in a `Tags[]` / `Environment[]`
            // element is reached; and, for a list with no identity key, the
            // corroborated positional walk `unkeyedArrayPairsByAnchors` licenses
            // (issue #2012). "Descent stays off" is about pairing by INDEX ALONE,
            // not a claim that no array is ever walked by index here — and the
            // flag is not a knob to reach for either way. Turning it ON does two
            // things, not one: it enables BLIND positional descent inside the
            // path pass (`redactByPath`'s equal-length array arm, plus the
            // `positionalIsExact` fallback for an unpaired keyed element), AND —
            // because `!descendArrays` is one of the three conjuncts in
            // `isReadbackProjectedFromState` — it switches the CORROBORATED pass
            // off entirely. It is a trade, and the half it gives up is the half
            // with evidence behind it.
            //
            // Inherited residual, not introduced here: `cdkd import`'s warn path
            // can leave a PUBLIC expression in `properties`, and
            // `trustAnyExpression` would then copy it over the observed value —
            // the same trade every other caller of this rules constant makes.
            //
            // A PRE-GHSA record is not repaired by either pass and cannot be:
            // its `properties` hold the plaintext too, so the position source
            // carries no expression to take. `cdkd scrub` is what repairs that,
            // and the command's own description says to run it first.
            //
            // EMPTY, but not a shared constant (issue #2036): the map carries,
            // by identity, a PROOF for each plain `ssm` reference in a MIXED
            // leaf of `properties` whose parameter a no-decryption
            // `GetParameter` in this stack's region answered as public. Such a
            // leaf keeps the value AWS holds instead of the expression; with no
            // proof (a `SecureString`, a missing `ssm:GetParameter` grant, any
            // error) it is refused exactly as before. See `PublicSsmProver`.
            // go-to-k/cdkd#4043: a coordinate the record marks in `noEchoLeaves`
            // holds `***` in `properties`, which positions nothing for the walk
            // below, so the readback's live value there is masked FIRST (through
            // each list's identity field, the whole list where none pairs them).
            resource.observedProperties = redactForState(
              maskReadbackAtCoordinates(observed, resource.properties ?? {}, [
                // A record naming no coordinate (pre-v11, imported, scrubbed)
                // still holds `***` where the value stood: mask there too, as
                // the deploy-start refresh does.
                ...maskedLeafCoordinatesOf(resource.properties ?? {}),
                ...(noEchoLeavesOf(resource) ?? []),
              ]),
              {
                provenance: 'state-baseline',
                secrets: await publicSsmProver.proofBagFor(resource.properties ?? {}),
                source: resource.properties ?? {},
              }
            );
            // Issue #3466: BOTH fields, and only once a baseline was captured —
            // a marker left without its reason is re-stamped by the next deploy,
            // and a failed read keeps the refusal.
            if (logicalId === acceptId) {
              delete resource.observedBaselineRefused;
              delete resource.observedBaselineRefusalReason;
            }
            refreshed++;
          } catch (err) {
            failed++;
            // A `SyntaxError` here is almost always a parse failure of a body a
            // provider read back, and V8's own one quotes a window of that body,
            // which can hold a plaintext value (issue #5254).
            // `CloudControlProvider.readCurrentState` throws a snippet-free
            // `SyntaxError` for its resource model, but a provider's raw one
            // would not be, so only the class is printed, for any
            // `SyntaxError`, failing safe; its text goes to `debug`.
            if (err instanceof SyntaxError) {
              logger.debug(
                safeMsg`readCurrentState parse failure for ${displayIdent(logicalId)}: ${parseFailureDebugDetail(err)}`
              );
            }
            const detail =
              err instanceof SyntaxError
                ? 'SyntaxError (its text is withheld: a parse error quotes the body it read)'
                : describeAwsFailure(err).detail;
            logger.warn(
              safeMsg`  ✗ ${displayStackName(stackName)}/${displayIdent(logicalId)} ` +
                safeMsg`(${displayIdent(resource.resourceType)}): ` +
                safeMsg`readCurrentState failed — ${detail}`
            );
          }
        })
      );
      await Promise.all(tasks);
    });

    if (accept !== undefined && refreshed === 0) {
      // Nothing was captured, so the refusal stands and nothing is written. A
      // failed or not-found read is reported by the caller (exit 2); a type
      // with no read path has no other report.
      if (unsupported > 0) {
        throw new Error(
          safeMsg`${ref}: cdkd cannot read ${displayIdent(accept.logicalId)} back from AWS, so no ` +
            `baseline was captured and its refusal stands.`
        );
      }
      return { refreshed, unsupported, failed, notFound, refusedBaseline, refusedSticky };
    }
    state.lastModified = Date.now();
    // `skippedOutputs` (issue #2740) is dropped, as every writer that rebuilds
    // state outside a deploy drops it. This one only rewrites
    // `observedProperties`, which no attribute is built from — but that is a
    // per-writer argument of exactly the kind that was wrong three times for
    // this field, so the rule is applied rather than re-argued. What IS
    // narrowed is WHEN: this command saves unconditionally, even when every
    // resource was unsupported or failed, and `--all` is a diagnostic — so the
    // drop is gated on having refreshed at least one resource, which keeps the
    // rule flat while a no-op run stays free of the pre-#2740 phantom.
    if (refreshed > 0) delete state.skippedOutputs;
    const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {
      expectedEtag: etag,
    };
    if (migrationPending) saveOptions.migrateLegacy = true;
    await stateBackend.saveState(stackName, region, state, saveOptions);

    logger.info(
      safeMsg`✓ ${ref}: ` +
        safeMsg`${refreshed} refreshed, ${unsupported} unsupported, ${failed} failed` +
        (notFound > 0 ? safeMsg`, ${notFound} not found in AWS` : '') +
        // Issue #2944: appended rather than always printed, so a stack with no
        // refused record renders byte-identically to the pre-v10 line.
        (refusedBaseline > 0 ? safeMsg`, ${refusedBaseline} refused (import baseline refusal)` : '')
    );
    if (accept !== undefined) {
      logger.info(
        safeMsg`Accepted: the observed-baseline refusal on ${displayIdent(accept.logicalId)} was cleared ` +
          `and a baseline was captured.`
      );
    }

    return { refreshed, unsupported, failed, notFound, refusedBaseline, refusedSticky };
  } finally {
    await lockManager.releaseLock(stackName, region).catch((err) => {
      logger.warn(safeMsg`Failed to release lock for ${ref}: ${describeAwsFailure(err).detail}`);
    });
  }
}
