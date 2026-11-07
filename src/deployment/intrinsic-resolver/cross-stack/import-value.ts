import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import { displayLeaf, displayMasked } from '../masking-display.js';
import { markNonRetryable } from '../../retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { ExportIndexStore } from '../../../state/export-index-store.js';
import { importableOutputKeys, type StackState } from '../../../types/state.js';
import { sameRegion } from '../../../utils/aws-partition.js';
import { type ResolverContext, carriesDynamicReference, quotedRender } from '../support.js';
import { crossStackSourceKey } from '../../secret-redaction.js';
import { reresolveCrossStackValue } from './reresolve.js';

/**
 * The export `exportName` from `entry.producerStack`'s record in the
 * CONSUMER's region, when that record exports it: the index entry came from a
 * same-named stack in another region (two Stages sharing a stackName, #5176),
 * and the producer in the consumer's own region is the one CloudFormation
 * would bind. `undefined` when there is no such record or export, or the read
 * fails; the caller then keeps the cross-region entry.
 */
async function sameRegionExportEntry(
  resolver: IntrinsicFunctionResolver,
  context: ResolverContext,
  exportName: string,
  entry: NonNullable<Awaited<ReturnType<ExportIndexStore['lookup']>>>
): Promise<typeof entry | undefined> {
  try {
    const local = await context.stateBackend!.getState(
      entry.producerStack,
      resolver.resolverRegion
    );
    if (!local || !importableOutputKeys(local.state).includes(exportName)) return undefined;
    return {
      // allow-template-keyed-bag-read: membership was just established by
      // `importableOutputKeys(local.state).includes(exportName)` above.
      value: local.state.outputs[exportName],
      producerStack: entry.producerStack,
      producerRegion: resolver.resolverRegion,
    };
  } catch (err) {
    resolver.logger.debug(
      safeMsg`Same-region read for an exports index entry failed: ${displayMasked(resolver, describeAwsFailure(err).detail, context)}`
    );
    return undefined;
  }
}

/**
 * Resolve Fn::ImportValue (cross-stack references)
 *
 * Searches all other stacks for an exported output with the given name.
 */
export async function resolveImportValue(
  resolver: IntrinsicFunctionResolver,
  importValueArg: unknown,
  context: ResolverContext
): Promise<unknown> {
  // The canonical key for the issue #2059 association, computed from the RAW
  // argument rather than from the resolved `exportName` below. The persist
  // path holds the UNRESOLVED template leaf and nothing else, so the two keys
  // are byte-identical only when both are built from the same spelling by the
  // same function — and an export name that is itself an `Fn::Sub` / `Ref`
  // has no key at all, which is the refusal the redaction path falls back
  // from.
  const sourceKey = crossStackSourceKey({ 'Fn::ImportValue': importValueArg });

  // First, resolve the export name (it might contain intrinsic functions)
  const exportName = await resolver.resolveValue(importValueArg, context);

  if (typeof exportName !== 'string') {
    throw markNonRetryable(
      new Error(`Fn::ImportValue: export name must resolve to a string, got ${typeof exportName}`)
    );
  }

  // Check if we have a state backend
  if (!context.stateBackend) {
    throw markNonRetryable(
      new Error('Fn::ImportValue: state backend is required for cross-stack references')
    );
  }

  // MASKED, and the export NAME rather than only the value (issue #2133
  // review): `exportName` is the RESOLVED argument — `resolveValue` above
  // runs `Fn::Sub` / `Fn::Join` / a `{{resolve:...}}` string through — so an
  // export name assembled from a secret is a resolved secret in every line
  // that names it. Same treatment as `Fn::Join` / `Fn::Sub` already give
  // their results.
  const loggedExportName = displayMasked(resolver, exportName, context);
  resolver.logger.debug(`Resolving Fn::ImportValue: ${loggedExportName}`);

  // Hot path: consult the persistent exports index for O(1) lookup.
  // Skip self-references (a stack importing its own export) so the
  // fallback scan below can apply the same exclusion.
  if (context.exportIndex) {
    // The LOOKUP is what this catch degrades from — deliberately narrowed to
    // it (issue #1934). The re-resolution below can fail for real reasons
    // (an `AccessDenied` on `GetSecretValue`, a producer region that is not
    // client-safe), and inside this try those would have been swallowed as
    // "index lookup failed", re-scanned, found again, and finally reported
    // as `export not found in any stack` — an error naming neither the
    // cause nor the export that WAS found.
    let entry: Awaited<ReturnType<ExportIndexStore['lookup']>>;
    try {
      entry = await context.exportIndex.lookup(exportName);
    } catch (err) {
      resolver.logger.warn(
        // The CAUGHT MESSAGE is masked too since issue
        // [#2827](https://github.com/go-to-k/cdkd/issues/2827), and that half
        // is DEFENCE IN DEPTH rather than a closed leak — corrected in review
        // round 2, where an earlier revision of this comment claimed the
        // opposite. `ExportIndexStore.lookup` throws exactly twice, and both
        // messages name `indexKey()` (`<prefix>/_index/<region>/exports.json`)
        // or the index VERSION — never the export name, which is not a key
        // segment. So no reachable message here carries a plaintext today.
        // Kept for the same reason the `ListExports` twin below is: one
        // idempotent call, against re-deciding per future AWS error text.
        // What IS a closed leak is `loggedExportName` beside it (issue
        // #2133), and that is what the test for this site pins.
        `Exports index lookup failed for ${quotedRender(loggedExportName, "'", 'an export whose name is not a plain identifier')}: ` +
          `${displayMasked(resolver, describeAwsFailure(err).detail, context)}` +
          `; falling back to state.json scan`
      );
      entry = undefined;
    }
    // A producer in THIS stack's region wins over one in another (#5176).
    // The run's one index holds every region's entries keyed by export name,
    // and two Stages sharing a stackName in two regions publish the SAME
    // export names, so the later deploy's entry replaces the earlier one's.
    // A cross-region entry is therefore checked against the same-named
    // producer's record in this region (one read, only for a cross-region
    // entry); without one, the cross-region import resolves as before.
    // Performance gave way to correctness here: a deliberate cross-region
    // import pays that one GET per resolve, which binding the other region's
    // value would not; a same-region hit, every single-region app's case,
    // pays nothing. Per-region index entries would avoid the read but need an
    // index schema change.
    if (
      entry &&
      !sameRegion(entry.producerRegion, resolver.resolverRegion) &&
      entry.producerStack !== context.stackName
    ) {
      entry = (await sameRegionExportEntry(resolver, context, exportName, entry)) ?? entry;
    }
    if (entry && (!context.stackName || entry.producerStack !== context.stackName)) {
      recordImport(resolver, context, exportName, entry.producerStack, entry.producerRegion);
      // NAMES the reference, never the VALUE (issue
      // [#2133](https://github.com/go-to-k/cdkd/issues/2133)). This line used
      // to interpolate `entry.value`, justified by "what the index holds for
      // a secret-bearing export is the `{{resolve:...}}` EXPRESSION". That
      // premise is true only of state a POST-#1934 binary wrote, and it is
      // false by construction for the population `cdkd scrub` exists for:
      // state an OLDER binary wrote, which holds the PLAINTEXT. Since scrub
      // gained a `stateBackend` (#2133) it reaches this line, `--dry-run`
      // included, and prints at DEFAULT verbosity. Masking could not rescue
      // it either — the needle for THIS value is recorded by the
      // re-resolution below, so at this point there is nothing to mask
      // against. The shape note keeps the one fact that made the value worth
      // logging (redacted vs literal) and discloses nothing.
      resolver.logger.info(
        `Resolved Fn::ImportValue: ${loggedExportName} (from index: ` +
          `${displayMasked(resolver, entry.producerStack, context)} / ${displayMasked(resolver, entry.producerRegion, context)}; ` +
          `${carriesDynamicReference(entry.value) ? 'redacted dynamic reference' : 'literal value'})`
      );
      return await reresolveCrossStackValue(
        resolver,
        entry.value,
        entry.producerRegion,
        context,
        `Fn::ImportValue ${quotedRender(displayLeaf(resolver, exportName, context), "'")} (producer ${displayLeaf(resolver, entry.producerStack, context)} / ${displayLeaf(resolver, entry.producerRegion, context)})`,
        sourceKey,
        // Issue #2274: the coordinate the value was READ from, so an in-run
        // producer's masked output can be recovered rather than refused. The
        // exports index is keyed by export name and `state.outputs` aliases
        // an exported output under that same name, so the export name IS the
        // output key here.
        {
          stackName: entry.producerStack,
          region: entry.producerRegion,
          outputKey: exportName,
        }
      );
    }
  }

  // Fallback path (index miss, drift, or no index supplied): scan every
  // stack's state.json. Same as the pre-index behavior.
  const allStacks = await context.stateBackend.listStacks();
  resolver.logger.debug(
    `Found ${allStacks.length} state record(s) to search for export: ${loggedExportName}`
  );

  // Hoisted out of the loop so the re-resolution happens OUTSIDE the
  // per-stack catch (issue #1934). Inside it, a failing `GetSecretValue`
  // would have been logged as `Failed to read state for stack X`, the scan
  // would have continued past the record it had just matched, and the caller
  // would have been told the export exists nowhere.
  let found:
    | { value: unknown; refStack: string; lookupRegion: string; state: StackState }
    | undefined;

  // This stack's region first (a region-less legacy record is read in it),
  // so a producer here wins over a same-named export in another region
  // (#5176). The same records are read; only the order changes.
  const inThisRegion = (r: { region?: string | undefined }): boolean =>
    r.region === undefined || sameRegion(r.region, resolver.resolverRegion);
  const scanOrder = [
    ...allStacks.filter(inThisRegion),
    ...allStacks.filter((r) => !inThisRegion(r)),
  ];
  for (const ref of scanOrder) {
    const { stackName: refStack, region: refRegion } = ref;
    if (context.stackName && refStack === context.stackName) {
      resolver.logger.debug(
        `Skipping current stack: ${displayMasked(resolver, refStack, context)}`
      );
      continue;
    }

    try {
      const lookupRegion = refRegion ?? resolver.resolverRegion ?? '';
      if (!lookupRegion) {
        resolver.logger.debug(
          `No region available for stack ${quotedRender(displayMasked(resolver, refStack, context), "'")} — skipping (cdkd cannot read state without a region)`
        );
        continue;
      }
      const stateData = await context.stateBackend.getState(refStack, lookupRegion);
      if (!stateData) {
        resolver.logger.debug(
          `No state found for stack: ${displayMasked(resolver, refStack, context)} (${displayMasked(resolver, lookupRegion, context)})`
        );
        continue;
      }

      const { state } = stateData;

      // Through the shared predicate (issue #2193), not `in state.outputs`:
      // the bag also holds every plain Output name, and matching on those
      // bound an import to a stack that exports nothing of that name.
      if (importableOutputKeys(state).includes(exportName)) {
        // allow-template-keyed-bag-read: membership was just established by
        // `importableOutputKeys(state).includes(exportName)` above.
        const value = state.outputs[exportName];
        // No VALUE, for the reason the index arm above states (issue #2133).
        // This is the arm `cdkd scrub` actually takes, since scrub
        // deliberately supplies no `exportIndex`.
        resolver.logger.info(
          // `refStack` masked too (issue
          // [#2827](https://github.com/go-to-k/cdkd/issues/2827)'s sweep):
          // the export name has been masked here since #2133, and the stack
          // name beside it comes from a state scan, so it is a needle
          // whenever a producer stack is NAMED after a value this pass
          // resolved. Masking a non-needle is a no-op, so this costs
          // nothing on an ordinary stack.
          `Resolved Fn::ImportValue: ${loggedExportName} (from stack: ${displayMasked(resolver, refStack, context)} / ${displayMasked(resolver, lookupRegion, context)}; ` +
            `${carriesDynamicReference(value) ? 'redacted dynamic reference' : 'literal value'})`
        );
        // Patch the index with the just-discovered entry so subsequent
        // resolves hit the O(1) path. Best-effort — index write failures
        // are logged and don't fail the resolve.
        if (context.exportIndex) {
          context.exportIndex
            .patchEntry(exportName, {
              value,
              producerStack: refStack,
              producerRegion: lookupRegion,
            })
            .catch((err) => {
              resolver.logger.debug(
                // The FIFTH site of the class issue
                // [#2827](https://github.com/go-to-k/cdkd/issues/2827)
                // enumerates as four, found by sweeping the file rather than
                // the issue's list: same shape as the four warns, one level
                // quieter. An index write failure quotes the KEY it could
                // not write, which is built from the export name.
                `Failed to patch exports index for ` +
                  `${quotedRender(displayMasked(resolver, exportName, context), "'", 'an export whose name is not a plain identifier')}: ` +
                  `${displayMasked(resolver, describeAwsFailure(err).detail, context)}`
              );
            });
        }
        recordImport(resolver, context, exportName, refStack, lookupRegion);
        found = { value, refStack, lookupRegion, state };
        break;
      }
    } catch (error) {
      resolver.logger.warn(
        // Both halves masked (issue
        // [#2827](https://github.com/go-to-k/cdkd/issues/2827)): the sibling
        // of the index line above, and the one warn of the four that masked
        // NEITHER operand. `refStack` is a state-derived stack name and the
        // caught message quotes the state key it failed on.
        `Failed to read state for stack ${displayMasked(resolver, refStack, context)}: ` +
          `${displayMasked(resolver, describeAwsFailure(error).detail, context)}`
      );
      continue;
    }
  }

  if (found) {
    // Same as the index arm above: the patched index entry carries the
    // STORED value; only what is handed to the consumer is re-resolved
    // (issue #1934). The log line above no longer carries any value at all
    // (issue #2133).
    return await reresolveCrossStackValue(
      resolver,
      found.value,
      found.lookupRegion,
      context,
      `Fn::ImportValue ${quotedRender(displayLeaf(resolver, exportName, context), "'")} (producer ${displayLeaf(resolver, found.refStack, context)} / ${displayLeaf(resolver, found.lookupRegion, context)})`,
      sourceKey,
      // Issue #2274 — see the index arm above. Same bag, reached by scanning
      // state instead of the index, so the same coordinate applies.
      {
        stackName: found.refStack,
        region: found.lookupRegion,
        outputKey: exportName,
        state: found.state,
      }
    );
  }

  // CloudFormation fallback (issue #1697): the export is in no cdkd state
  // record — the producer may be a CloudFormation-managed stack (deployed
  // via `cdk deploy` / raw CFn). CloudFormation's own semantic for
  // Fn::ImportValue IS ListExports, so consult it before giving up.
  // cdkd-first precedence is inherent: this path only runs on a cdkd miss.
  // The resolution is deliberately NOT recorded into `recordedImports` —
  // `state.imports` drives destroy-time strong-ref protection, which cdkd
  // cannot honor for a producer it does not manage (and CFn's own
  // export-in-use protection cannot see cdkd consumers), so a CFn-sourced
  // import is a WEAK reference by design.
  if (resolver.cfnFallback) {
    const cfnExport = await resolver.cfnFallbackCache.lookupCfnExport(exportName, context);
    if (cfnExport) {
      // No VALUE (issue #2133). A CloudFormation export never passed through
      // cdkd's redaction, so what it holds is whatever the producer
      // published — a plaintext whenever the producer resolved one, which is
      // the same disclosure as the two arms above.
      // exporting STACK ID from the CloudFormation ListExports response, an
      // AWS-assigned ARN.
      // not-in-class(cfnExport.exportingStackId ? `; exporting stack: ${cfnExport.exportingStackId}` : ''): the exporting STACK ID from the CloudFormation ListExports response, an AWS-assigned ARN.
      resolver.logger.info(
        `Resolved Fn::ImportValue: ${loggedExportName} ` +
          `(from CloudFormation exports${
            cfnExport.exportingStackId ? `; exporting stack: ${cfnExport.exportingStackId}` : ''
          }; weak reference — producer is not cdkd-managed)`
      );
      // Deliberately NOT re-resolved (issue #1934). The re-resolution exists
      // to undo cdkd's OWN redaction, and this value never passed through it:
      // it is whatever CloudFormation holds for the export. CFn does not
      // resolve dynamic references in an export value either, so a
      // `{{resolve:...}}` here is a LITERAL the producer chose to publish, and
      // resolving it would diverge from what a CloudFormation consumer of the
      // same export receives.
      return cfnExport.value;
    }
  }

  // MASKED, for the reason `loggedExportName` above exists (issue #2133) and
  // now at the THROW too (issue
  // [#2827](https://github.com/go-to-k/cdkd/issues/2827)): the export name is
  // the RESOLVED argument, so an `Fn::Sub`-assembled name IS a decrypted
  // secret — and the throw is the copy that travels to every caller.
  // Deliberately NOT `markNonRetryable` (go-to-k/cdkd#1889): the miss can
  // follow a SWALLOWED transient failure -- the per-stack read above warns and
  // continues on a throttle / 5xx, and `lookupCfnExport` answers undefined on a
  // throttled ListExports -- so it is not proof the export is absent.
  throw new Error(
    `Fn::ImportValue: export ${quotedRender(loggedExportName, "'")} not found in any stack. ` +
      `Searched ${allStacks.length} cdkd state record(s)` +
      `${resolver.cfnFallback ? ' and CloudFormation exports' : ''}. ` +
      `Make sure the exporting stack has been deployed and the Output has an Export.Name property.`
  );
}

/**
 * Push a resolved `Fn::ImportValue` into the consumer's recorded-imports
 * bag (when supplied by the caller). Skips duplicates within the
 * SAME bag — multiple references to the same `(exportName,
 * sourceStack, sourceRegion)` triple emit one entry. The region half compares
 * through `sameRegion` (issue #2209): `producerRegion` is a state-key region
 * on one arm and falls back to the RAW `resolverRegion` on another, so one
 * producer can arrive in two spellings.
 *
 * Concurrency: the check + push pair is purely synchronous (no
 * `await` between `some()` and `push()`), so the JS event loop
 * cannot interleave a competing `recordImport` call between the
 * dedup check and the append. The bag's lifetime is per-deploy
 * (DeployEngine resets `this.recordedImports = []` at the top of
 * each `deploy()` call), so the bag identity already serves as
 * the dedup scope.
 *
 * Cross-context dedup: when callers share the same bag instance
 * across multiple ResolverContext objects (the typical pattern —
 * DeployEngine passes `this.recordedImports` into every resolver
 * context it constructs), the dedup naturally extends across
 * contexts because the `some()` reads the shared bag. Stashing
 * the dedup Set on `context.recordedImports` directly via a
 * property would break under `verbatimModuleSyntax`-style strict
 * typing; the array scan stays O(N) where N is the per-deploy
 * import count (typically < 20), which is fine.
 */
export function recordImport(
  _resolver: IntrinsicFunctionResolver,
  context: ResolverContext,
  exportName: string,
  producerStack: string,
  producerRegion: string
): void {
  if (!context.recordedImports) return;
  const dup = context.recordedImports.some(
    (e) =>
      e.exportName === exportName &&
      e.sourceStack === producerStack &&
      sameRegion(e.sourceRegion, producerRegion)
  );
  if (dup) return;
  context.recordedImports.push({
    exportName,
    sourceStack: producerStack,
    sourceRegion: producerRegion,
  });
}
