import type { DeployEngine } from '../deploy-engine.js';
import {
  type ParameterNamingVerdict,
  resourcesNamingDeclaredParameter,
} from '../../analyzer/parameter-dependence.js';
import {
  RESOURCE_NOT_FOUND,
  type CloudFormationTemplate,
  type ResourceProvider,
} from '../../types/resource.js';
import {
  type ResourceState,
  type StackState,
  hasReasonlessBaselineRefusal,
} from '../../types/state.js';
import { safeMsg } from '../../utils/display-safe.js';
import {
  isMaskedBaselineRecaptureCandidate,
  persistedTokenResolverContext,
  recaptureMaskedBaseline,
  resolveRecordSecrets,
} from '../masked-baseline-recapture.js';
import { withCurrentResourceSecrets } from '../resource-secrets-scope.js';
import { producerRegionsFromState } from '../rollback-executor.js';
import { markSameGenerationBag, type RecordedSecretValues } from '../secret-redaction.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    kickOffObservedCapture: OmitThisParameter<typeof kickOffObservedCapture>;
    /** @internal */
    drainObservedCaptures: OmitThisParameter<typeof drainObservedCaptures>;
    /** @internal */
    buildObservedCaptureSiblings: OmitThisParameter<typeof buildObservedCaptureSiblings>;
    /** @internal */
    stampReasonlessParameterRefusals: OmitThisParameter<typeof stampReasonlessParameterRefusals>;
    /** @internal */
    kickOffAutoRefreshObservedProperties: OmitThisParameter<
      typeof kickOffAutoRefreshObservedProperties
    >;
    /** @internal */
    kickOffMaskedBaselineRecapture: OmitThisParameter<typeof kickOffMaskedBaselineRecapture>;
  }
}

/**
 * Kick off `provider.readCurrentState` for a freshly-created/updated
 * resource without blocking the deploy critical path. The promise
 * lands in `observedCaptureTasks` keyed by `logicalId`; the deploy's
 * success-path drain (`drainObservedCaptures`) awaits the full set
 * and merges the resolved values into `ResourceState.observedProperties`
 * before the final state save.
 *
 * Errors are swallowed at the Promise level — readCurrentState
 * failing must not fail the deploy. The map entry resolves to
 * `undefined` for failures and for providers without
 * `readCurrentState`; both translate to "no observedProperties" at
 * the merge step, which is fine: drift falls back to comparing
 * against `properties`.
 */
export function kickOffObservedCapture(
  this: DeployEngine,
  provider: ResourceProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  resolvedProps: Record<string, unknown>,
  context?: import('../../types/resource.js').ReadCurrentStateContext,
  secrets?: RecordedSecretValues
): void {
  if (this.options.captureObservedState !== true) return;
  // A capture that cannot run still SUPERSEDES the deploy-start refresh task
  // for this id (issue #3595 review): the record was just rebuilt, and a
  // readback of what it replaced must not be installed over it.
  this.observedCaptureTasks.delete(logicalId);
  if (!provider.readCurrentState) return;

  const readCurrentState = provider.readCurrentState.bind(provider);
  const read = (): Promise<Record<string, unknown> | undefined> =>
    readCurrentState(physicalId, logicalId, resourceType, resolvedProps, context).then(
      // A resource AWS reports gone has no baseline to capture
      // (go-to-k/cdkd#4283): the same "no observedProperties" a failed read
      // leaves, never the sentinel installed as a property bag.
      (observed) => (observed === RESOURCE_NOT_FOUND ? undefined : observed),
      (err: unknown) => {
        this.logger.debug(
          `observedProperties capture for ${logicalId} (${resourceType}) failed: ${err instanceof Error ? err.message : String(err)} — drift will fall back to template properties for this resource until the next successful deploy.`
        );
        return undefined;
      }
    );
  // go-to-k/cdkd#4362: the readback runs AFTER the create / update call
  // returned, so outside the scope that call bound. Bind the SAME bag again,
  // around the whole chain: a promise reaction runs in the scope it was
  // registered in, so the `catch` line above (AWS may echo a submitted,
  // secret-derived name) is sink-masked too, not only the provider's own lines.
  const promise = secrets === undefined ? read() : withCurrentResourceSecrets(secrets, read);
  this.observedCaptureTasks.set(logicalId, promise);
}

/**
 * Wait for every in-flight `readCurrentState` promise from the
 * deploy's success path, then merge each resolved snapshot into the
 * matching `ResourceState.observedProperties`. After this runs the
 * map is drained so a subsequent deploy starts fresh.
 *
 * Called from `doDeploy` immediately before the final `saveState`.
 * The rollback / failure paths intentionally do NOT call this — a
 * failed deploy's partial state is already inconsistent, and waiting
 * on potentially many in-flight reads would slow down the rollback
 * itself.
 *
 * Returns how many baselines it installed, so the no-change path saves only
 * when one landed: a masked-baseline re-capture (issue #3595) that refuses
 * resolves to `undefined` on every deploy for a position that stays
 * uncertifiable, and must not rewrite an unchanged `state.json` each time.
 */
export async function drainObservedCaptures(
  this: DeployEngine,
  stateResources: Record<string, ResourceState>
): Promise<number> {
  if (this.observedCaptureTasks.size === 0) return 0;
  const entries = Array.from(this.observedCaptureTasks.entries());
  this.observedCaptureTasks.clear();
  const resolved = await Promise.all(entries.map(([, p]) => p));
  let installed = 0;
  for (let i = 0; i < entries.length; i++) {
    const logicalId = entries[i]![0];
    const observed = resolved[i];
    const target = stateResources[logicalId];
    const recapturedFrom =
      observed === undefined ? undefined : this.recapturedBaselines.get(observed);
    if (recapturedFrom !== undefined && target?.observedProperties !== recapturedFrom) continue;
    if (target && observed !== undefined) {
      installed++;
      // Issue #2516: the readback is THIS pass's own, taken from the
      // resource it just wrote, so the object is marked same-generation
      // before it is installed — the persist choke point walks this bag
      // separately from `properties`, against today's template, and a mark
      // on `properties` alone would leave the readback of an embedded 1-3
      // character secret in plaintext. The mark is one half of the
      // evidence: the arm also needs a resolved pair for the source token
      // AND the readback's middle to EQUAL what that pair recorded. An
      // UNCHANGED resource's auto-refresh has an empty map and no pair. A
      // resource the diff called UPDATE and the re-check then skipped is
      // refreshed with today's pair in its map — and there the re-check has
      // just proven the stored record already holds the token at that leaf,
      // so a readback carrying today's plaintext converges on the same
      // answer rather than fabricating one.
      //
      // A COPY, like the two never-installed sites -- the journal's
      // `attemptedProperties` above and the no-change re-check below: `observed` is
      // whatever `provider.readCurrentState` returned, and the
      // schema-upgrade auto-refresh hands that method the PREVIOUS
      // generation's `resource.properties` as its 4th argument -- so a
      // provider returning that argument BY IDENTITY would put a permanent
      // same-generation mark on a previous-generation object still
      // installed on the record, which is the fabrication this mark's own
      // contract forbids. No provider under `src/provisioning/` does that
      // today (grepped at PR 2753 review), but the contract is delegated to
      // ~100 implementations with no guard, and the copy costs one spread.
      //
      // Pinned from outside by walking the object the provider handed back
      // through `redactSecretsForState` AFTER the deploy, under the DEFAULT
      // rules: those make no generation claim of their own, so the mark on
      // the object is what decides whether a sub-floor middle becomes the
      // token. Under `STATE_SOURCED_READBACK_RULES` it would not decide --
      // that constant claims the generation itself -- which is why the
      // test does not reuse the persist path's own rules.
      // A masked-baseline re-capture (issue #3595) is installed UNMARKED: it
      // is the previous baseline with some masks replaced by the record's own
      // expressions, not a readback this pass took, so it must not claim the
      // generation. The persist choke point then re-scrubs it with the
      // readback rules, which add no mask to a bag holding no plaintext.
      // NO TEST FENCES THIS, and the reason is structural: marked, the bag
      // would take the fail-closed rules instead, and those only mask a
      // string at a position they cannot pair that is neither a reference
      // nor a literal the record spells. The re-capture's own precondition
      // already refused any such baseline, so the two answers agree on every
      // bag that reaches here.
      target.observedProperties =
        recapturedFrom !== undefined ? observed : markSameGenerationBag({ ...observed });
      // NOTHING CLEARS `observedBaselineRefused` HERE, and that is a finding
      // rather than an omission (issue #2944). An explicit `delete` was
      // written at this line first and is UNREACHABLE: the only two ways a
      // bag reaches it are the deploy-start auto-refresh, which never
      // enqueues a MARKED record (`kickOffAutoRefreshObservedProperties`
      // skips them, and its masked-baseline re-capture takes only a record
      // that HAS a baseline, which a marked one never does), and a
      // post-CREATE / post-UPDATE / post-replacement
      // capture, whose record `provisionResource` has already REBUILT from
      // the template — dropping the field with it. So the clearing mechanism
      // is the rebuild, and the contract a test can hold is "a real CREATE /
      // UPDATE clears the refusal", not "this line does".
      //
      // ONE REFUSAL CLASS IS NOT CLEARED BY THE REBUILD (issue #3462): an
      // unverifiable-parameter refusal survives every IN-PLACE update, and
      // that arm of `provisionResource` kicks off no capture at all, so such
      // a record never reaches this loop either. Only a replacement / CREATE
      // (or a proving re-import) discharges it — the type doc of
      // `ResourceState.observedBaselineRefusalReason` carries the argument.
      //
      // The other arm that deliberately KEEPS a marked record marked is the
      // metadata-only update (`{ ...currentResource, ...templateAttributes }`
      // in `provisionResource`): it issues no provider call and takes no
      // readback, so nothing there earns a baseline the import declined.
    }
  }
  return installed;
}

/**
 * Build a sibling context for the deploy-time `observedProperties`
 * capture of an IAM principal (`AWS::IAM::Role` / `::User` / `::Group`)
 * so that inline policies managed by a SEPARATE `AWS::IAM::Policy`
 * resource are filtered OUT of the captured `Policies` baseline —
 * exactly as the `cdkd drift` read path already does via
 * `buildReadCurrentStateContext`.
 *
 * Without this, the post-CREATE / post-UPDATE capture passes no
 * context, so `collectInlinePolicyNamesManagedBySiblings` no-ops. The
 * capture's `ListRolePolicies` then RACES the sibling
 * `AWS::IAM::Policy`'s `PutRolePolicy`: when the read lands after the
 * write, the sibling-managed `DefaultPolicy*` leaks into
 * `observedProperties.Policies`. A later `cdkd drift` (whose AWS-current
 * side filters it correctly) then reports phantom drift
 * `- Policies:[DefaultPolicy] / + Policies:[]` — a systemic false
 * positive that fires for essentially every Lambda / L2 construct whose
 * grant emits a `Default Policy`.
 *
 * The sibling relationship is fully determined by the TEMPLATE (which
 * `AWS::IAM::Policy` lists this principal in its `Roles`/`Users`/
 * `Groups`), so this is built from the template — deploy-order-
 * independent, immune to the race. Each matched sibling is synthesized
 * into the resolved-property shape
 * `collectInlinePolicyNamesManagedBySiblings` expects
 * (`{ [attachmentField]: [thisPrincipalPhysicalId], PolicyName }`).
 *
 * Returns `undefined` (no context) for non-IAM-principal types and when
 * no sibling policy attaches to the captured principal — both leave the
 * capture behaving exactly as before.
 */
export async function buildObservedCaptureSiblings(
  this: DeployEngine,
  resourceType: string,
  capturedLogicalId: string,
  capturedPhysicalId: string,
  template: CloudFormationTemplate | undefined,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  parameterValues?: Record<string, unknown>,
  conditions?: Record<string, boolean>
): Promise<import('../../types/resource.js').ReadCurrentStateContext | undefined> {
  // Capture disabled (kickOffObservedCapture would ignore the context) —
  // skip the template walk / resolver work entirely.
  if (this.options.captureObservedState !== true) return undefined;
  const attachmentField =
    resourceType === 'AWS::IAM::Role'
      ? 'Roles'
      : resourceType === 'AWS::IAM::User'
        ? 'Users'
        : resourceType === 'AWS::IAM::Group'
          ? 'Groups'
          : undefined;
  if (!attachmentField) return undefined;
  const resources = template?.Resources;
  if (!resources) return undefined;

  // Built lazily — only a non-literal `PolicyName` (rare; e.g. an
  // Fn::Sub) needs the resolver, and the overwhelmingly common case
  // (a literal Default-Policy name) never touches it.
  let resolverContext: import('../intrinsic-function-resolver.js').ResolverContext | undefined;

  const isRefTo = (value: unknown, logicalId: string): boolean =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['Ref'] === logicalId;

  const siblings: NonNullable<
    import('../../types/resource.js').ReadCurrentStateContext['siblings']
  > = {};
  for (const [lid, res] of Object.entries(resources)) {
    if (lid === capturedLogicalId) continue;
    if (res.Type !== 'AWS::IAM::Policy') continue;
    const props = (res.Properties ?? {}) as Record<string, unknown>;
    const attachments = props[attachmentField];
    if (!Array.isArray(attachments)) continue;
    // CDK emits `Roles: [{Ref: <principalLogicalId>}]`; hand-written
    // templates may use the literal physical name. Match either.
    const attachesToCaptured = attachments.some(
      (a) => isRefTo(a, capturedLogicalId) || a === capturedPhysicalId
    );
    if (!attachesToCaptured) continue;
    // PolicyName is almost always a literal string; resolve only when
    // it carries an intrinsic (e.g. Fn::Sub with a pseudo-parameter).
    // Best-effort: an unresolvable name just won't be added to the
    // exclude set (no worse than the pre-fix behavior).
    let policyName: unknown = props['PolicyName'];
    if (policyName !== undefined && typeof policyName !== 'string') {
      resolverContext ??= this.buildResolverContext(
        {
          template: template!,
          resources: stateResources,
          ...(parameterValues && { parameters: parameterValues }),
          ...(conditions && { conditions }),
        },
        stackName
      );
      try {
        policyName = await this.resolver.resolve(policyName, resolverContext);
      } catch {
        continue;
      }
    }
    if (typeof policyName !== 'string') continue;
    siblings[lid] = {
      resourceType: 'AWS::IAM::Policy',
      properties: { [attachmentField]: [capturedPhysicalId], PolicyName: policyName },
    };
  }
  return Object.keys(siblings).length > 0 ? { siblings } : undefined;
}

/**
 * Issue [#3468](https://github.com/go-to-k/cdkd/issues/3468) — the
 * fail-closed reading of a REASON-LESS `observedBaselineRefused` marker.
 *
 * cdkd 0.290.35 wrote unverifiable-parameter refusals with no reason, so an
 * absent reason cannot be read as "an UPDATE may clear it". A reason-less
 * marker on a resource whose TEMPLATE definition names a declared parameter
 * is stamped `'unverifiable-parameter'` here, IN MEMORY, once, before the
 * diff: every later arm (the in-place rebuild, the metadata-only spread, the
 * NO_CHANGE carry, the auto-refresh) then sees the explicit form and needs
 * no rule of its own, and whatever this deploy saves holds it — the record
 * heals into the form later binaries read directly. Nothing is saved FOR the
 * stamp: a deploy that writes no state (`--dry-run`, no changes) re-derives
 * it next time.
 *
 * The template is the RAW one `deploy()` was handed (a nested child engine
 * gets its own), which is what the dependence walk needs. A template that
 * cannot be read, or a walk that throws, stamps every reason-less marker
 * (`resourcesNamingDeclaredParameter` fails closed). A record whose logical
 * id the template no longer defines is being DELETED and is left alone.
 *
 * The RECORD object is replaced, not mutated (a per-record alias taken
 * before this line keeps what was loaded); the container is updated in
 * place, which is what lets every later reader of it see the stamp.
 */
export function stampReasonlessParameterRefusals(
  this: DeployEngine,
  stateResources: Record<string, ResourceState>,
  template: CloudFormationTemplate | undefined
): void {
  let namesParameter: ParameterNamingVerdict | undefined;
  let stamped = 0;
  for (const [logicalId, resource] of Object.entries(stateResources)) {
    if (!hasReasonlessBaselineRefusal(resource)) continue;
    namesParameter ??= resourcesNamingDeclaredParameter(template);
    if (!namesParameter(logicalId)) continue;
    stateResources[logicalId] = {
      ...resource,
      observedBaselineRefusalReason: 'unverifiable-parameter',
    };
    stamped++;
  }
  if (namesParameter?.failedClosed !== undefined) {
    // The cause CLASS only: never a template value or an error's text.
    this.logger.debug(
      `The template's parameter dependence could not be judged (${namesParameter.failedClosed}): every observed-baseline refusal recorded without a reason is treated as an unverifiable-parameter refusal (${stamped} stamped).`
    );
  }
  if (stamped > 0) {
    this.logger.debug(
      `${stamped} resource(s) carry an observed-baseline refusal recorded without a reason by an older cdkd, and their template definition reads a template parameter: treated as an unverifiable-parameter refusal (kept until the resource is replaced or re-imported against a CloudFormation stack that proves the parameter).`
    );
  }
}

/**
 * Kick off `provider.readCurrentState` for every resource in the
 * loaded state that lacks `observedProperties` (e.g. state written
 * by a pre-v3 binary, or a v3 record where a NO_CHANGE-skipped
 * resource's baseline never landed). Calls go through
 * `kickOffObservedCapture`, so they share the same fire-and-forget
 * pipeline, error swallowing, and final-drain wiring that the
 * post-CREATE / post-UPDATE captures use.
 *
 * The deploy critical path does NOT wait on these; the cost is
 * bounded by `max(per-resource readCurrentState latency)` (typically
 * ~200-300ms in practice) once at the end-of-deploy drain. Any
 * resource that subsequently goes through CREATE / UPDATE in the
 * same deploy will overwrite this entry via the `Map.set` keyed by
 * `logicalId` (latest-wins) — so there's no double-write to state,
 * just a wasted SDK call for the (rare) UPDATE / DELETE intersection.
 *
 * Resources whose provider lookup throws (e.g. unsupported type) or
 * lacks `readCurrentState` are silently skipped — same policy as the
 * manual `cdkd state refresh-observed` command.
 */
export function kickOffAutoRefreshObservedProperties(
  this: DeployEngine,
  stateResources: Record<string, ResourceState>,
  crossStackReads: Pick<StackState, 'imports' | 'outputReads'>
): void {
  if (this.options.captureObservedState !== true) return;
  // Dry run does not fire this observed-state read (no AWS side-effect runs
  // under it). The #1852 attribute heal is the one read a dry run CAN issue:
  // it is read-only, fires only on a `Fn::GetAtt` miss, and persists nothing.
  if (this.options.dryRun === true) return;
  let toRefresh = 0;
  let refused = 0;
  const candidates: Array<{
    logicalId: string;
    resource: ResourceState;
  }> = [];
  // Issue #3595: records whose baseline holds a #2852 fail-closed mask. See
  // `masked-baseline-recapture.ts` for what may change and what may not.
  const masked: Array<{ logicalId: string; resource: ResourceState }> = [];
  for (const [logicalId, resource] of Object.entries(stateResources)) {
    if (resource.observedProperties !== undefined) {
      if (isMaskedBaselineRecaptureCandidate(resource)) masked.push({ logicalId, resource });
      continue;
    }
    // Schema v10+ (issue #2944). `observedProperties === undefined` is
    // OVERLOADED: it means "never captured" for a pre-v3 record or a provider
    // with no `readCurrentState` — where refilling is exactly this method's
    // job — and it ALSO means "a `cdkd import` run REFUSED to capture one",
    // where refilling is the leak. The two are indistinguishable from the
    // field alone, which is why the refusal is recorded on the record; see
    // `ResourceState.observedBaselineRefused`'s doc for why nothing else can
    // carry it here.
    //
    // What makes the refill a leak rather than a wasted call: this site
    // positions the readback against `resource.properties` (the 5th argument
    // below), and after a refusal those can hold the WRONG-BRANCH LITERAL the
    // import distrusted. A literal source leaf against a string readback
    // PAIRS as an ordinary drifted literal, so `redactSecretsForState` has
    // nothing to refuse on and the decrypted value is persisted.
    //
    // NOT cleared here. The clearing writer is a real CREATE / UPDATE, which
    // resolved the resource from the template and whose own
    // `kickOffObservedCapture` overwrites the baseline anyway (latest-wins on
    // the `observedCaptureTasks` key) — so a deploy that actually changes the
    // resource heals it, while a deploy that leaves it NO_CHANGE holds no
    // more evidence than this site does.
    if (resource.observedBaselineRefused === true) {
      refused++;
      continue;
    }
    candidates.push({ logicalId, resource });
  }
  if (refused > 0) {
    this.logger.debug(
      `observed-properties auto-refresh SKIPPED for ${refused} resource(s) whose baseline a 'cdkd import' run refused (issue #2944): their recorded properties cannot position the redaction, so capturing an AWS readback against them could persist a resolved secret in plaintext. A deploy that actually CHANGES one of them restores its baseline, unless the refusal is an unverifiable-parameter one (only a replacement or a proving re-import discharges that); a NO_CHANGE deploy never does.`
    );
  }
  if (candidates.length === 0 && masked.length === 0) return;

  // Issue #323: at the v2→v3 schema-upgrade refresh path, state is
  // fully loaded from the previous deploy — sibling AWS::IAM::Policy
  // resources are all present. Pass a cross-resource context so IAM
  // providers can filter inline policies managed via sibling
  // resources, otherwise observed.Policies would record the
  // sibling-managed entries and the next `cdkd drift` would fire
  // false drift (filtered AWS-current = []) until `cdkd drift
  // --accept` runs. Build the siblings map once and clone-minus-self
  // per resource to avoid an O(N²) walk.
  const allSiblings: Record<string, { resourceType: string; properties: Record<string, unknown> }> =
    {};
  for (const [lid, res] of Object.entries(stateResources)) {
    allSiblings[lid] = {
      resourceType: res.resourceType,
      properties: res.properties ?? {},
    };
  }

  for (const { logicalId, resource } of candidates) {
    // Skip-list / unsupported types: the routing lookup throws — silently
    // skip (mirrors `cdkd state refresh-observed`'s policy: best-effort,
    // no failure on a state record we cannot resolve).
    //
    // Routed on the RECORD's `provisionedBy`, not by type alone (issue
    // #2608's sibling site, found by that fix's sweep). Unlike the UPDATE
    // capture, this site has no routing DECISION to bind to — the record is
    // all there is — so it re-derives, and that is not an identity for a
    // `STICKY_CC_MIGRATION_EXEMPT` type: one stamped `cc-api` can
    // deliberately land on its SDK provider. Accepted here rather than
    // papered over, and the reason is now per MODE (issue #2719):
    //   - `'cc-broken'` (`AWS::Scheduler::Schedule`): the SDK provider IS the
    //     correct reader — the exemption exists because CC cannot address the
    //     resource — and both layers store the same physicalId.
    //   - `'sdk-coverage'` (`AWS::SNS::Topic`): this site passes NO property
    //     bags, so the flip predicate's no-properties gate refuses, and the
    //     re-derivation stays on Cloud Control. That is load-bearing rather
    //     than incidental: the capture must read through the layer that
    //     WROTE the resource, and this deploy has not flipped it yet.
    // Either way the re-derivation lands on the right provider.
    //
    // One more consequence, audited rather than accidental: the sticky arm
    // returns BEFORE `isSupportedResourceType`, so a `cc-api`-stamped record
    // of a type Cloud Control no longer supports now resolves to the CC
    // provider instead of falling into the `catch { continue }` below. It
    // gets a fire-and-forget read that fails and is swallowed, which is the
    // same no-baseline outcome skipping produced -- one wasted call on a
    // record that has no observed bag either way. The legacy
    // `getProvider` entry point passes no recorded layer, so a record
    // stamped `provisionedBy: 'cc-api'` — because a silent-drop property
    // auto-routed it (issue #614) — had its baseline read back through the
    // SDK provider instead. The bag then describes a layer state does not
    // name, and this bag IS the drift baseline, so the very next
    // `cdkd drift` reports the shape difference as drift (the phantom-drift
    // class of issue #1591). Absent on a pre-v7 record, which reads as
    // "no recorded layer" and lands on the same type-only decision as
    // before.
    let provider: ResourceProvider;
    try {
      provider = this.providerRegistry.getProviderFor({
        resourceType: resource.resourceType,
        provisionedBy: resource.provisionedBy,
      }).provider;
    } catch {
      continue;
    }
    if (!provider.readCurrentState) continue;
    const siblings = { ...allSiblings };
    delete siblings[logicalId];
    this.kickOffObservedCapture(
      provider,
      logicalId,
      resource.physicalId,
      resource.resourceType,
      resource.properties ?? {},
      { siblings }
    );
    toRefresh++;
  }

  if (toRefresh > 0) {
    this.logger.warn(
      `cdkd state schema upgrade detected — refreshing observed-properties baseline for ${toRefresh} resource(s) (one-time, runs in parallel with deploy)`
    );
  }

  // The CONSUMER's cross-region evidence for the re-capture's resolution. Read
  // only when a masked record needs it, and a record list that cannot be read
  // (a hand-edited `imports` element) skips the re-capture rather than
  // resolving without the evidence: an absent list would verdict every
  // region-less reference `local`.
  let producerRegions: readonly string[] = [];
  if (masked.length > 0) {
    try {
      producerRegions = producerRegionsFromState(crossStackReads);
    } catch {
      this.logger.debug(
        safeMsg`Masked observed baseline re-capture skipped for ${masked.length} resource(s): the record's cross-stack reads could not be read (issue #3595).`
      );
      masked.length = 0;
    }
  }
  for (const { logicalId, resource } of masked) {
    let provider: ResourceProvider;
    try {
      // Routed on the record's `provisionedBy`, as the loop above is.
      provider = this.providerRegistry.getProviderFor({
        resourceType: resource.resourceType,
        provisionedBy: resource.provisionedBy,
      }).provider;
    } catch {
      continue;
    }
    if (!provider.readCurrentState) continue;
    const siblings = { ...allSiblings };
    delete siblings[logicalId];
    this.kickOffMaskedBaselineRecapture(provider, logicalId, resource, producerRegions, {
      siblings,
    });
  }
}

/**
 * Re-capture ONE record's fail-closed-masked baseline (issue #3595).
 *
 * Resolves the record's own `properties` references into a map of its own —
 * never into `perResourceSecrets`: a populated entry there would move the
 * persist choke point's observed walk off the fail-closed rules for this
 * record. Then reads the resource back and hands both to
 * `recaptureMaskedBaseline`, which changes masked positions only. Every
 * refusal (a reference that does not resolve, a readback that fails, a
 * baseline the fresh readback does not reproduce) resolves the task to
 * `undefined`, which leaves the old baseline in place.
 *
 * Fire-and-forget like every other capture: drained before the final save,
 * latest-wins against a later CREATE / UPDATE capture of the same id.
 */
export function kickOffMaskedBaselineRecapture(
  this: DeployEngine,
  provider: ResourceProvider,
  logicalId: string,
  resource: ResourceState,
  producerRegions: readonly string[],
  context: import('../../types/resource.js').ReadCurrentStateContext
): void {
  const previous = resource.observedProperties;
  const readCurrentState = provider.readCurrentState?.bind(provider);
  if (previous === undefined || readCurrentState === undefined) return;
  const properties = resource.properties ?? {};
  const task = (async (): Promise<Record<string, unknown> | undefined> => {
    const secrets = await resolveRecordSecrets(properties, (token, own) =>
      this.resolver.resolveDynamicReferences(
        token,
        // The CONSUMER's cross-region evidence rides it, so a region-less
        // reference this stack may have read from another region refuses
        // (`ambiguous`) instead of resolving against a same-named secret here.
        persistedTokenResolverContext(own, producerRegions)
      )
    );
    if (secrets === undefined || secrets.size === 0) {
      // The CLASS only: never a reference, a value or an error's text.
      this.logger.debug(
        safeMsg`Masked observed baseline of ${logicalId} kept: its recorded references did not all resolve to distinct values (issue #3595).`
      );
      return undefined;
    }
    // The readback can carry the plaintext just resolved, so it runs inside
    // that bag's sink scope, like the post-write capture (#4362).
    const readback = await withCurrentResourceSecrets(secrets, () =>
      readCurrentState(resource.physicalId, logicalId, resource.resourceType, properties, context)
    );
    // A resource AWS reports gone keeps its masked baseline (go-to-k/cdkd#4283).
    if (readback === undefined || readback === RESOURCE_NOT_FOUND) return undefined;
    const recaptured = recaptureMaskedBaseline({ previous, readback, properties, secrets });
    if (recaptured === undefined) {
      this.logger.debug(
        safeMsg`Masked observed baseline of ${logicalId} kept: no masked position could be certified, or the resource no longer reads back as its baseline records (issue #3595).`
      );
      return undefined;
    }
    this.recapturedBaselines.set(recaptured, previous);
    this.logger.debug(
      safeMsg`Re-captured the masked observed baseline of ${logicalId} (issue #3595).`
    );
    return recaptured;
  })().catch(() => {
    this.logger.debug(
      safeMsg`Masked observed baseline of ${logicalId} kept: the re-capture failed (issue #3595).`
    );
    return undefined;
  });
  this.observedCaptureTasks.set(logicalId, task);
}
