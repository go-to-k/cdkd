/**
 * `cdkd drift`: one stack's drift detection.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { getLogger } from '../../../utils/logger.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import {
  refuseMalformedState,
  refuseMalformedResourceEntries,
  refuseMalformedResourcePropertiesForDrift,
  repairMalformedResourcesForReadOnly,
  malformedResourcesWarning,
  UNREADABLE_RESOURCES_MAP_ROW,
  repairMalformedResourceEntriesForReadOnly,
  malformedResourceEntriesWarning,
  repairMalformedResourcePropertiesForReadOnly,
  malformedDriftResourcePropertiesWarning,
} from '../../../state/malformed-resources-bag.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import type { PrincipalUniqueIdResolver } from '../../../analyzer/drift-principal-normalize.js';
import { CC_API_FALLBACK_DENY_LIST } from '../../../analyzer/drift-cc-api-deny-list.js';
import { stripCcApiAwsManagedFields } from '../../../analyzer/cc-api-strip.js';
import { CloudControlProvider } from '../../../provisioning/cloud-control-provider.js';
import { withStackScope } from '../../../provisioning/resource-name.js';
import { displayStackName, safeMsg } from '../../../utils/display-safe.js';
import { stackInstanceIdOf } from '../../../state/stack-instance-id.js';
import {
  type RecordedSecretValues,
  maskSecretsInText,
  maskSecretsInError,
} from '../../../deployment/secret-redaction.js';
import { type ResourceNotFound, RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import type { StackState } from '../../../types/state.js';
import { nameScopeOf } from '../../../state/name-generation.js';
import {
  secretNamePrintingBags,
  secretNamedRecordNeedles,
} from '../../../deployment/secret-name-needles.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import type { StackDriftReport, DriftOutcome } from './outcome.js';
import { type NestedChildRecord, nestedChildStackName } from './command.js';
import { DriftSecretResolvers, driftProducerRegionEvidence } from './secret-resolution.js';
import {
  type DriftReadPath,
  isNoReadHandlerError,
  DRIFT_READ_FAILURE_BREAKER_THRESHOLD,
  DRIFT_READ_PATH_LABELS,
} from './read-failure.js';
import {
  buildReadCurrentStateContext,
  compareDriftReadback,
  warnIfPreV10BaselineGap,
} from './compare.js';

/**
 * Run drift detection for one stack and shape the per-resource outcomes
 * into a {@link StackDriftReport}. The state object + etag are stored on
 * the report so `--accept` can write back without a re-read, and
 * `--revert` can pass the captured AWS-current snapshot to
 * `provider.update` as the `previousProperties` argument.
 */
export async function runDriftForStack(
  stackName: string,
  region: string,
  stateBackend: S3StateBackend,
  providerRegistry: ProviderRegistry,
  ccApiFallback: CloudControlProvider,
  resolvePrincipalUniqueId: PrincipalUniqueIdResolver,
  // go-to-k/cdkd#3018. `cdkd drift` is read-only by DEFAULT and write-capable
  // under `--accept` / `--revert`, so the malformed-record remedy this command
  // takes is decided per MODE rather than per command. `cdkd scrub` splits the
  // same way on `--dry-run`, so this is the second such flow rather than the
  // only one — what differs is that scrub's split is decidable from its own
  // write gate at the site, while this one is a FLAG pair the loader cannot
  // see. Hence a parameter: the decision is made once, beside the flags.
  malformedRecordMode: 'repair' | 'refuse',
  // go-to-k/cdkd#4533: what this stack's nested rows' own records are in the
  // run — decided by the driver, the one place that holds the selection.
  nestedChildRecord: (childStackName: string, region: string) => NestedChildRecord,
  // go-to-k/cdkd#4159: the run's account flags, carried on the pasteable
  // commands both modes' malformed-record messages print.
  refusalRecovery: LockRecoveryContext
): Promise<StackDriftReport> {
  const result = await stateBackend.getState(stackName, region);
  if (!result) {
    throw new Error(
      `No state found for stack '${stackName}' (${region}). Run 'cdkd state list' to see available stacks.`
    );
  }

  // go-to-k/cdkd#5064: detection derives names in the stack's lifetime.
  // `runRevert` runs after this scope closes; every `update()` it reaches
  // keeps the recorded name of a resource the template does not name.
  const namingScope = nameScopeOf(
    stackName,
    stackInstanceIdOf(result.state, displayStackName(stackName)),
    result.state
  );
  return await withStackScope(namingScope, async () => {
    const outcomes: DriftOutcome[] = [];
    const state: StackState = result.state;
    const logger = getLogger();

    // go-to-k/cdkd#3018, at the LOAD and not at each of this file's walks —
    // the rule `malformed-resources-bag.ts`'s header records, and the reason is
    // the same here: the walks below dereference the bag and each entry, so a
    // guard at any one of them leaves the others aborting a line away.
    //
    // REFUSING under `--accept` / `--revert` is not symmetry for its own sake.
    // Both modes rebuild the record as `{ ...report.state.resources }` and then
    // `saveState` it, and for ONE shape that spread is a LAUNDERING step rather
    // than a crash: a bag hand-edited into a LIST OF RESOURCE OBJECTS walks
    // fine here (each element has a `resourceType`), reaches the writer, and
    // `{ ...[objA, objB] }` is `{'0': objA, '1': objB}` — persisted back as a
    // well-formed-looking map of phantom rows, with the only evidence the
    // record was broken gone. Every other non-object shape fails differently,
    // and neither way is this one: a NON-EMPTY string, or a list holding an
    // unreadable element, throws in the walk above, while `null`, an absent
    // bag, a number, a boolean, an empty string and an empty list all walk to
    // zero entries and yield a silent empty report. Only the list of records
    // both survives the walk AND reaches the spread.
    //
    // Plain `cdkd drift` cannot write, so it REPAIRS and says so. Both shapes
    // ABORT this command rather than fabricating — the walk below reaches
    // `resource.resourceType.startsWith(...)`, which throws on a string bag's
    // per-character entries exactly as it does on a `null` one — and a bare
    // `TypeError` from a read-only report is worse than a short report the
    // warning explains. (The FABRICATING failure is `cdkd state resources`'s,
    // one command over, and is what go-to-k/cdkd#3172 fixed; the difference is
    // that this walk dereferences each entry while that one rendered it.)
    // go-to-k/cdkd#3315: the ids whose `properties` map was repaired to `{}`.
    // Each is reported `notCompared` in the walk below rather than compared,
    // because a `{}` baseline walks no keys and would read as CLEAN.
    let unreadablePropertyBags: ReadonlySet<string> = new Set();
    if (malformedRecordMode === 'refuse') {
      refuseMalformedState(state, stackName, region, refusalRecovery);
      refuseMalformedResourceEntries(state, stackName, region, refusalRecovery);
      // After the entry refusal: a typeless object with a torn map is named by
      // both, and the entry text is the more precise diagnosis.
      refuseMalformedResourcePropertiesForDrift(state, stackName, region, refusalRecovery);
    } else {
      if (repairMalformedResourcesForReadOnly(state)) {
        logger.warn(malformedResourcesWarning(stackName, region, refusalRecovery));
        // ONE outcome for the whole record, for the reason the entry arm below
        // gives per row: the warning goes to stderr, so without an outcome an
        // unreadable BAG produced no `notCompared` row, an empty `--json`
        // payload and exit 0 — a clean verdict about a stack cdkd could not
        // read at all, where before the repair existed the same record crashed
        // non-zero. There is no logical id to name, so the row names the
        // container instead; `outcomeExitSignal` routes the cause to exit 2.
        // The CAUSE says it is the map, not the name (go-to-k/cdkd#3339): a
        // dropped entry below can be keyed with the same text.
        outcomes.push({
          kind: 'notCompared',
          logicalId: UNREADABLE_RESOURCES_MAP_ROW,
          resourceType: 'unreadable record',
          notComparedCause: 'unreadableMap',
        });
      }
      const dropped = repairMalformedResourceEntriesForReadOnly(state);
      if (dropped.length > 0) {
        logger.warn(malformedResourceEntriesWarning(stackName, region, dropped, refusalRecovery));
        // One OUTCOME per dropped row, not just the warning. The warning goes to
        // stderr, which a `cdkd drift --json > report.json` gate discards; the
        // outcome joins the roll-up, the `--json` payload and `outcomeExitSignal`,
        // which routes every cause but `unresolvedToken` to exit 2. Without it a
        // record with one unreadable row exits 0 and reports only its healthy
        // rows — a clean verdict about a stack cdkd could not fully read.
        for (const logicalId of dropped) {
          outcomes.push({
            kind: 'notCompared',
            logicalId,
            // No type is knowable — that is what "unreadable" means here. The
            // placeholder is deliberately not a real CloudFormation type, so no
            // reader can mistake it for one.
            resourceType: 'unreadable record',
            notComparedCause: 'unreadableRecord',
          });
        }
      }
      // AFTER the entry drop, so a typeless object with a torn map is reported
      // once, as an unreadable entry. The repair keeps the row (its type and
      // physical id are real) and gives sibling readers a readable map; the
      // walk below reports it instead of comparing it.
      const repaired = repairMalformedResourcePropertiesForReadOnly(state);
      if (repaired.length > 0) {
        logger.warn(
          malformedDriftResourcePropertiesWarning(stackName, region, repaired, refusalRecovery)
        );
        unreadablePropertyBags = new Set(repaired);
      }
    }
    // Issue #1914: the resolver used to re-resolve the secret expressions this
    // stack's records store. Only ever CALLED for a bag that actually holds a
    // `{{resolve:...}}` string, so a stack with no dynamic reference makes no
    // AWS call here.
    //
    // One instance per stack, and since issue
    // [#1933](https://github.com/go-to-k/cdkd/issues/1933) that instance IS the
    // dedup scope: `cachedDynamicReferences` moved off module scope onto the
    // resolver, so an expression is fetched once per STACK (it used to be once
    // per process) and one stack's resolved value can no longer be handed to
    // another stack's — or another region's — records.
    //
    // The other half — the LOOKUP reaching for the ambient `getAwsClients()`
    // singleton rather than the `region` handed to this constructor — was the
    // surviving hazard for a cross-region `--all` run, because this command
    // installs its clients ONCE (see the `setAwsClients` call at the top of
    // `runDrift`) while looping over stacks in several regions. Issue
    // [#1957](https://github.com/go-to-k/cdkd/issues/1957) CLOSED it, and
    // deliberately not here: the resolver now derives region-scoped lookup
    // clients from the region it is CONSTRUCTED with, carrying the ambient
    // profile / assume-role credentials while overriding only the region.
    // (Constructed-with, not `resolverRegion` — the two differ only when no
    // region was passed, where the seam declines to override; this command
    // always passes one.) That is a credentials decision, so it belongs where
    // every caller inherits it rather than in one command's private
    // workaround — which is why the `region` passed just below is now
    // load-bearing for VALUE correctness and not only for cache scoping. Do
    // not reintroduce a `setAwsClients` dance here to compensate for the
    // LOOKUP.
    //
    // Scope note: #1957 fixed what this resolver READS. What `--revert`
    // WRITES is the provider registry's job: since go-to-k/cdkd#4283 each
    // stack's reads AND writes run inside that stack's region scope
    // (`stackRegionScope` in `driftCommand`, `runRevert`), and the state key's
    // region also rides `UpdateContext.expectedRegion` (#2301), on which a
    // Cloud-Control-routed write refuses a region mismatch.
    //
    // Issue [#2108](https://github.com/go-to-k/cdkd/issues/2108) is the third
    // scope note, and it is the one that made this a BAG of resolvers rather
    // than a single one. #1957 fixed which region this resolver READS FOR — the
    // stack's, rather than the ambient CLI one. It did NOT ask whether the
    // stack's own region is the right region for a given EXPRESSION, and for a
    // value that arrived through a cross-region cross-stack import it is not:
    // since #1934 the consumer records the PRODUCER's region-less spelling, so
    // re-resolving it here answered from a same-named secret in the wrong
    // region. `DriftSecretResolvers` routes each reference to the region
    // `classifyReplaySecretRegion` says must answer for it.
    const secretResolvers = new DriftSecretResolvers(region);
    // The FOREIGN-region evidence: `state.imports[].sourceRegion` /
    // `state.outputReads[].sourceRegion` of this record and, for a nested
    // child, of every ancestor, which `driftProducerRegionEvidence` reads from
    // state (go-to-k/cdkd#4213); an ancestor it cannot read leaves the evidence
    // incomplete.
    const producerRegions = await driftProducerRegionEvidence(
      state,
      stackName,
      region,
      stateBackend
    );
    const entries = Object.entries(state.resources ?? {}).sort(([a], [b]) => a.localeCompare(b));
    // go-to-k/cdkd#3869: each record's needles judged once for the stack.
    const printingBagOf = secretNamePrintingBags(state.resources ?? {}, undefined);
    // go-to-k/cdkd#3869: a drifted row's AWS side can name a secret-named record
    // the reader's stored leaves never held (a `Roles` list drifted onto one),
    // so the report masks with every such record's spellings too.
    const stackSecretNames = secretNamedRecordNeedles(state.resources ?? {}, undefined);
    // go-to-k/cdkd#2207: resources in a row whose READ threw. See
    // `DRIFT_READ_FAILURE_BREAKER_THRESHOLD` for what resets it.
    const consecutiveReadFailures: Record<DriftReadPath, number> = { provider: 0, ccApi: 0 };
    const trippedReadPaths = new Set<DriftReadPath>();
    const noteReadReturned = (): void => {
      consecutiveReadFailures.provider = 0;
      consecutiveReadFailures.ccApi = 0;
    };

    for (const [logicalId, resource] of entries) {
      // go-to-k/cdkd#3315. FIRST, above the skip rules: the warning names every
      // repaired id as not compared, so every one of them gets the outcome —
      // a type drift never compares included. That exit 2 is intended: the
      // record is damaged whatever its type, and a CI gate must see it.
      if (unreadablePropertyBags.has(logicalId)) {
        outcomes.push({
          kind: 'notCompared',
          logicalId,
          resourceType: resource.resourceType,
          notComparedCause: 'unreadableRecord',
        });
        continue;
      }
      if (providerRegistry.shouldSkipResource(resource.resourceType)) {
        continue;
      }

      // Issue #323: route Custom Resources to 'skipped' (silent) BEFORE
      // looking up the provider, since the lookup falls through to the
      // CC API path which would short-circuit them to 'unsupported'
      // (= "drift unknown" noise in the human report). Custom Resource
      // drift would require re-invoking the handler Lambda, which is
      // out of scope for `cdkd drift`. Both Lambda-backed CR types are
      // covered: `Custom::*` (the user-named form) AND
      // `AWS::CloudFormation::CustomResource` (what CDK emits for
      // `new cdk.CustomResource(...)` without an explicit `resourceType`).
      if (
        resource.resourceType.startsWith('Custom::') ||
        resource.resourceType === 'AWS::CloudFormation::CustomResource'
      ) {
        outcomes.push({
          kind: 'skipped',
          logicalId,
          resourceType: resource.resourceType,
        });
        continue;
      }

      // go-to-k/cdkd#4533: a nested stack's row has nothing in AWS to read
      // (cdkd deploys its resources itself), and its resources are compared as
      // their own `<parent>~<child>` stack in this same run. So the row is
      // `skipped` when that record is selected — its block covers it — and
      // `deleted` when the record is gone: a deploy writes it before the row
      // exists, so it was removed later (out of band, or by `cdkd state
      // orphan`) or never written by an interrupted `cdkd import
      // --migrate-from-cloudformation`, which records the parent first. The
      // report says neither "outside cdkd" nor which. A record present but not selected cannot
      // arise from this command's selection; it keeps the `unsupported` path.
      if (resource.resourceType === NESTED_STACK_RESOURCE_TYPE) {
        const child = nestedChildRecord(nestedChildStackName(stackName, logicalId), region);
        if (child === 'selected') {
          outcomes.push({ kind: 'skipped', logicalId, resourceType: resource.resourceType });
          continue;
        }
        if (child === 'missing') {
          outcomes.push({
            kind: 'deleted',
            logicalId,
            resourceType: resource.resourceType,
            nestedStackRecordMissing: true,
          });
          continue;
        }
      }

      let provider;
      // go-to-k/cdkd#2207: which read path the breaker counts this resource on.
      let routedToCloudControl = false;
      // Issue #1914: the baseline comes out of STATE, where a secret dynamic
      // reference is stored as its unresolved `{{resolve:...}}` expression
      // (GHSA-p5qg-v9gv-hc7w), while `aws` is a live readback holding the
      // resolved plaintext. An expression never equals a plaintext, so without
      // this the two sides could not agree and every dynamic-ref stack reported
      // permanent phantom drift — with the plaintext printed as the AWS-current
      // side of the diff.
      //
      // Resolved for COMPARISON ONLY: `resource.observedProperties` /
      // `resource.properties` are untouched, so nothing here can widen what
      // state holds. What the resolution DOES leak forward is the plaintext now
      // sitting in `changes[].stateValue`, which `redactDriftChanges` puts back
      // on its expression before the outcome is built.
      //
      // Hoisted ABOVE the guard so the catch below can mask with it. It is
      // populated inside the try (by `resolveStateSecretExpressions`), and that
      // is exactly why the catch needs it: a throw AFTER a successful resolution
      // is the case where a resolved plaintext exists and could be echoed in an
      // error message. Declared here rather than passed out because `const` in
      // the try body would be out of scope in the catch, and a `let` reassigned
      // there is the same thing with a mutable binding nothing needs.
      const secrets: RecordedSecretValues = new Map();
      try {
        // Schema v7+ (#614): route reads via state-recorded
        // `provisionedBy` so a CC-managed resource is read through Cloud
        // Control's `readCurrentState`. Pre-v7 state has
        // `provisionedBy: undefined` which preserves legacy SDK routing.
        const routing = providerRegistry.getProviderFor({
          resourceType: resource.resourceType,
          provisionedBy: resource.provisionedBy,
        });
        provider = routing.provider;
        routedToCloudControl = routing.provisionedBy === 'cc-api';
      } catch {
        outcomes.push({
          kind: 'unsupported',
          logicalId,
          resourceType: resource.resourceType,
        });
        continue;
      }

      // Schema v10+ (issue #2952). A `cdkd import` run REFUSED to capture this
      // record's observed baseline, so the only baseline available is its
      // `properties` — which that refusal already found untrustworthy, and which
      // after a downgraded `Fn::If` can hold the WRONG-BRANCH LITERAL while AWS
      // holds the secret the deployed branch resolved.
      //
      // COMPARING THAT IS A DISCLOSURE, not merely a false positive. The record
      // spells no `{{resolve:` anywhere, so `secretPaths` (filled by resolution)
      // and its offline fallback (which scans for where the tokens simply ARE)
      // are BOTH empty; nothing marks the path secret-bearing, `redactDriftChanges`
      // has no needle and no position to mask, and the live decrypted value is
      // rendered as the AWS side of an ordinary-looking drift row — in the human
      // report, in `--json`, and in the plans. The write paths already refuse
      // such a resource (issue #2944), so the row was also unactionable.
      //
      // Reported as `notCompared` rather than `clean`: it genuinely was not
      // compared, and a silent `clean` is the "report a resource cdkd never
      // compared as a pass" failure the cause enumeration exists to prevent. The
      // cause is CLEARABLE — deploying a change to the resource rebuilds its
      // record from the template and captures a real baseline, or for an
      // unverifiable-parameter refusal (or a reason-less one on a resource
      // that reads a template parameter) a replacement or proving re-import
      // does (issue #3465) — so it inherits
      // `outcomeExitSignal`'s non-zero side, which that switch already defaults
      // a new cause to.
      //
      // Placed after the provider LOOKUP but before any readback. Before the
      // readback because there is nothing to learn from AWS about a resource we
      // have already decided not to compare, and fetching it would pull the
      // plaintext into this process for no reason — the lookup itself is local
      // and issues no AWS call. After the lookup because a type whose provider
      // cannot be resolved is `unsupported`, which exits 0; classifying it
      // `baselineRefused` instead would make such a stack permanently non-zero
      // for a reason that has nothing to do with the refusal.
      if (resource.observedBaselineRefused === true) {
        outcomes.push({
          kind: 'notCompared',
          logicalId,
          resourceType: resource.resourceType,
          notComparedCause: 'baselineRefused',
        });
        continue;
      }

      // First try the SDK provider's first-class readCurrentState (PR G's
      // 4-arg signature). When the SDK Provider hasn't shipped its own
      // readCurrentState yet, fall back to the Cloud Control API provider
      // (PR F). The fallback is gated by two false-drift guards (PR J):
      //
      //   1. Deny-list (`CC_API_FALLBACK_DENY_LIST`) — types with verified
      //      structural divergence between CC API response shape and the
      //      CFn-template shape cdkd state stores (e.g.
      //      `AWS::IAM::ManagedPolicy`'s URL-encoded `PolicyDocument`)
      //      short-circuit to "drift unknown" so they don't fire false
      //      positives every run.
      //   2. Strip (`stripCcApiAwsManagedFields`) — generic AWS-managed
      //      fields (timestamps, generated identifiers, runtime status)
      //      are removed from CC API responses before the comparator sees
      //      them.
      // Issues [#2151](https://github.com/go-to-k/cdkd/issues/2151) and
      // [#1945](https://github.com/go-to-k/cdkd/issues/1945): ONE guard over the
      // whole per-resource body, not a catch per risky call.
      //
      // The defect is a CLASS, not two instances. Everything from here to the
      // outcome push runs provider-authored or AWS-facing code, and a throw from
      // ANY of it propagated out of this loop and out of the command: no summary
      // line, no per-resource report, and every OTHER resource in the stack --
      // and under `--all` every remaining STACK -- left unchecked, over one bad
      // resource. The reachable sites are `provider.readCurrentState`,
      // `ccApiFallback.readCurrentState`, `getDriftUnknownPaths` /
      // `getDriftUnorderedPaths`, `canonicalizePrincipalUniqueIds` (which makes
      // its own `iam:GetRole` call), `canonicalizeIpProtocols`,
      // `provider.canonicalizeDriftProperties`, `calculateResourceDrift` and
      // `redactDriftChanges`. #2151 reported the second, #1945 the seventh; a
      // guard on either alone would have left the other five, and would have
      // left every site a future provider hook adds.
      //
      // This RESTORES the symmetry the surrounding code already chose. The
      // provider lookup above, the deny-list short-circuit, and (since #1914)
      // the dynamic-reference resolution all degrade to a per-resource outcome
      // and continue. This path was the one that disagreed.
      //
      // The secret-resolution catch INSIDE this region still runs first and
      // still degrades to `refused` / `unresolvedToken` -- an inner catch that
      // handles its error never reaches this one, so the causes cannot collide.
      //
      // go-to-k/cdkd#2207: once this resource's read path has tripped, a
      // resource that WOULD be read below is reported unread instead. The
      // condition is the one the try body reads AWS under (a provider read, or
      // a Cloud Control fallback the deny-list does not short-circuit to
      // `unsupported`), so a resource that never reaches AWS keeps the outcome
      // it gets without the breaker.
      //
      // A Cloud Control READ is the `ccApi` path whichever way it is reached:
      // the registry routes every Cloud-Control-managed type to the Cloud
      // Control provider (tagged `provisionedBy: 'cc-api'`), whose own
      // `readCurrentState` is a Cloud Control call, and an SDK provider with no
      // `readCurrentState` falls back to Cloud Control below. Keyed on the
      // provider's `readCurrentState` alone, the first population counted as
      // `provider` and a role missing only `cloudcontrol:GetResource` aborted
      // the SDK reads that work.
      const readPath: DriftReadPath =
        routedToCloudControl || !provider.readCurrentState ? 'ccApi' : 'provider';
      if (
        trippedReadPaths.has(readPath) &&
        // The deny-list short-circuits only the FALLBACK branch (no
        // `readCurrentState`); a Cloud-Control-routed provider reads anyway.
        (provider.readCurrentState !== undefined ||
          !CC_API_FALLBACK_DENY_LIST[resource.resourceType])
      ) {
        outcomes.push({
          kind: 'notCompared',
          logicalId,
          resourceType: resource.resourceType,
          notComparedCause: 'readAborted',
        });
        continue;
      }
      // Set once a read RETURNS, so the catch below can tell a read that threw
      // (counted) from a comparison that threw after a good read (resets).
      let readReturned = false;
      // go-to-k/cdkd#3869: the read and the comparison run under this
      // resource's printing bag, as `--revert` and `cdkd destroy` do: a
      // provider's debug line, and a failed read's AWS error, name the physical
      // id, which for a resource named from a secret (or a reader of one, an
      // access key's `UserName`) no recorded plaintext spells. Log-only needles,
      // so nothing compared, redacted or persisted reads them.
      const printing = printingBagOf(logicalId);
      await withPrintingSecrets(printing, async () => {
        try {
          let aws: Record<string, unknown> | ResourceNotFound | undefined;
          if (provider.readCurrentState) {
            aws = await provider.readCurrentState(
              resource.physicalId,
              logicalId,
              resource.resourceType,
              resource.properties ?? {},
              buildReadCurrentStateContext(state, logicalId)
            );
            readReturned = true;
            noteReadReturned();
          } else {
            if (CC_API_FALLBACK_DENY_LIST[resource.resourceType]) {
              outcomes.push({
                kind: 'unsupported',
                logicalId,
                resourceType: resource.resourceType,
              });
              return;
            }
            const ccApiAws = await ccApiFallback.readCurrentState(
              resource.physicalId,
              logicalId,
              resource.resourceType,
              resource.properties ?? {}
            );
            readReturned = true;
            noteReadReturned();
            if (ccApiAws === undefined) {
              outcomes.push({
                kind: 'unsupported',
                logicalId,
                resourceType: resource.resourceType,
              });
              return;
            }
            aws =
              ccApiAws === RESOURCE_NOT_FOUND
                ? ccApiAws
                : stripCcApiAwsManagedFields(resource.resourceType, ccApiAws);
          }

          // go-to-k/cdkd#4283: AWS reports the resource is not there. Checked
          // BEFORE the `undefined` arm, which means "no read path for the type"
          // and is reported as an uncovered type that does not affect the exit
          // code; a resource deleted out of band is drift, and exits 1.
          if (aws === RESOURCE_NOT_FOUND) {
            outcomes.push({
              kind: 'deleted',
              logicalId,
              resourceType: resource.resourceType,
            });
            return;
          }

          if (aws === undefined) {
            outcomes.push({
              kind: 'unsupported',
              logicalId,
              resourceType: resource.resourceType,
            });
            return;
          }

          await compareDriftReadback({
            region,
            resolvePrincipalUniqueId,
            outcomes,
            logger,
            secretResolvers,
            producerRegions,
            stackSecretNames,
            resource,
            logicalId,
            provider,
            secrets,
            printing,
            aws,
          });
        } catch (err) {
          // A type with NO read path is not a failure. When the Cloud Control
          // registry has no READ handler the fallback can signal it EITHER by
          // returning `undefined` (handled above, reports `unsupported`) or by
          // throwing `UnsupportedActionException`, and the same condition must not
          // report two different things depending on which spelling AWS picked.
          // Routing it to `unsupported` also keeps the exit code at 0 for it:
          // the condition is permanent by construction -- the type will not grow a
          // handler because this run failed -- which is the same "unclearable in
          // CI forever" argument `unresolvedToken` is excluded on. This is the
          // taxonomy question #2151 raised (read-failure vs no-read-path), settled
          // by which of the two a re-run can clear.
          if (isNoReadHandlerError(err)) {
            // Logged, because this arm is the one place the guard is QUIETER than
            // main: main aborted loudly on this throw, and the report line it now
            // produces (`? <id>`) is the same one a provider that simply has no
            // `readCurrentState` yields, so the fact that something THREW is
            // otherwise invisible. Debug rather than warn -- for the population
            // this arm is for, the condition is permanent and there is nothing to
            // act on, so warning on every run would be noise. It matters when the
            // classification is WRONG, which is exactly when someone runs with
            // `--verbose`.
            logger.debug(
              `${logicalId} (${resource.resourceType}): read threw with a no-READ-handler ` +
                `signature, reported as drift unknown — ` +
                `${maskSecretsInText(describeAwsFailure(err).detail, secrets)}`
            );
            // go-to-k/cdkd#2207: a throw about the TYPE, not the account.
            noteReadReturned();
            outcomes.push({
              kind: 'unsupported',
              logicalId,
              resourceType: resource.resourceType,
            });
            return;
          }
          // Everything else: the resource was NOT compared, and the reason is
          // actionable. `notCompared` rather than `unsupported` because the two
          // answer different questions -- `unsupported` says cdkd cannot read this
          // TYPE, which would be a false statement about a type it reads fine on
          // every other run, and it would report 0 where #2135 requires a cause.
          //
          // NOT `drifted`: nothing was compared, so there are no changes to show,
          // and inventing one would be the fabricated-baseline hazard `--revert`
          // then pushes to a live resource. `--accept` / `--revert` both iterate
          // the drifted outcomes only, so a resource landing here is excluded from
          // both remediation paths automatically -- which is the answer to #1945's
          // second open question, and it falls out of the outcome kind rather than
          // needing a filter of its own.
          //
          // MASKING, and the limit stated exactly rather than reassuringly. The
          // map holds needles exactly when this resource's references RESOLVED.
          // When it is EMPTY, what follows is narrower than "no plaintext is in
          // play":
          //
          //   - The COMPARISON BAGS are clean. `resolveStateSecretExpressions` is
          //     a non-mutating walk, and its catch sets
          //     `comparisonBaseline = baseline` (the unresolved bag) in the same
          //     block as `secrets.clear()`. Every later call here reads only
          //     `comparisonBaseline` and `aws`, so no resolved plaintext reaches
          //     them.
          //   - A plaintext cdkd resolved may nonetheless EXIST. The #2108 refusal
          //     is per LEAF (see the note at the inner catch): an earlier ARN-form
          //     leaf can resolve and record its needle, a later name-form leaf can
          //     then refuse, and the clear discards the correct needle from the
          //     MAP. It is kept as a LOG-ONLY needle of the same bag (issue
          //     #2102), so the text below still masks it.
          //
          // The message names the resource and the error but never a property
          // VALUE. Before this guard the same message reached the top-level
          // handler, which renders the whole error OBJECT and its cause chain
          // through `util.inspect`, entirely unmasked, and then aborted.
          outcomes.push({
            kind: 'notCompared',
            logicalId,
            resourceType: resource.resourceType,
            notComparedCause: 'readFailed',
          });
          // go-to-k/cdkd#2207: only a READ that threw counts toward the breaker;
          // a comparison that threw after a good read was reset above.
          let breakerTripped = false;
          if (!readReturned) {
            consecutiveReadFailures[readPath]++;
            if (consecutiveReadFailures[readPath] === DRIFT_READ_FAILURE_BREAKER_THRESHOLD) {
              trippedReadPaths.add(readPath);
              breakerTripped = true;
            }
          }
          logger.warn(
            `${logicalId} (${resource.resourceType}): could not be compared — the read or ` +
              `comparison failed, so NONE of its properties were checked. ` +
              // go-to-k/cdkd#2207: the old "every other resource in this stack was
              // still compared" became false once a later failure can trip the
              // breaker, so the clause speaks only for what happens next.
              // Said only while NO path has tripped: after one has, part of the
              // rest of the stack is not read, whichever path this failure took.
              (trippedReadPaths.size > 0 ? '' : `cdkd goes on with the rest of this stack. `) +
              `${maskSecretsInText(describeAwsFailure(err).detail, secrets)}`
          );
          if (breakerTripped) {
            logger.warn(
              safeMsg`${DRIFT_READ_FAILURE_BREAKER_THRESHOLD} reads in a row in this stack failed ` +
                safeMsg`${DRIFT_READ_PATH_LABELS[readPath]} — expired credentials, a revoked ` +
                `role, a permission all of them need, or a burst of throttling — so cdkd stops ` +
                `reading this stack's resources that way, and reports each one left as not ` +
                `compared. Fix the cause, or re-run if it was throttling.`
            );
          }
          // The message alone is enough for the population this arm is FOR (an
          // IAM denial, a throttle), and useless for the one nobody expects: a
          // cdkd bug in a normalizer or in `calculateResourceDrift` would surface
          // stackless at exit 2 where main printed a full trace. The STACK goes to
          // debug so the ordinary run stays one line, masked through
          // `maskSecretsInError`, which walks the cause chain -- a stack frame can
          // carry an argument value, so `maskSecretsInText` over `err.message`
          // alone is not the right tool.
          //
          // `.stack`, a STRING, and never the Error object. Passing the object was
          // written first and is wrong twice over. `ConsoleLogger.formatMessage`
          // renders extra args with `JSON.stringify`, and an Error's `message` /
          // `stack` are non-enumerable -- `maskSecretsInError` re-defines them
          // that way itself -- so `JSON.stringify(new Error('x'))` is `'{}'` and
          // the line printed nothing for exactly the population it exists for.
          // Worse, `JSON.stringify` THROWS on a circular own-enumerable structure,
          // and `err.cause = err` set by ordinary assignment is enumerable: at
          // `--verbose` that throw escapes this catch, the loop and the command --
          // reintroducing issue #2151 one arm away from the try/catch in
          // `isNoReadHandlerError` added to prevent precisely that. A string
          // cannot do either, which is why `scrub.ts`'s equivalent site passes one
          // too.
          if (err instanceof Error && err.stack) {
            logger.debug(
              `${logicalId} (${resource.resourceType}): comparison failure detail`,
              maskSecretsInError(err, secrets).stack
            );
          }
          return;
        }
      });
    }

    // Issue #3011. The `baselineRefused` gate above can only fire for a record
    // a v10-or-later binary refused, because only such a binary knew how to
    // record the refusal. A stack imported by an EARLIER release carries the
    // same untrustworthy `properties` with nothing marking them, so drift
    // compares it and — since a refused record spells no `{{resolve:` for the
    // redaction to key on — can print the live decrypted value.
    //
    // The marker cannot reach that population by construction, and the obvious
    // widening (gate on bare `observedProperties === undefined`) would sweep in
    // every pre-observed-capture record and every provider without
    // `readCurrentState`, stopping drift comparing a large and entirely
    // legitimate set.
    //
    // So this warns instead, and the condition is EXACT rather than a guess
    // about which stacks were imported: `version < 10` is precisely "cdkd could
    // not have recorded a refusal on this record, whatever it did". It fires
    // ONCE per stack, changes no behaviour and no exit code, and self-clears on
    // the stack's first v10 write. The cost is one line on a stack that was
    // never imported — a warning, not a refusal, and the direction to err in
    // when the alternative is printing a decrypted secret.
    const warnings = warnIfPreV10BaselineGap(state, outcomes, logger);

    return {
      stackName,
      region,
      outcomes,
      state,
      etag: result.etag,
      migrationPending: result.migrationPending ?? false,
      warnings,
      producerRegions,
    };
  });
}
