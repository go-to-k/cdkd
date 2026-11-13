import { CrossPrefixGuard } from '../../../state/stack-registry.js';
import {
  nameGenerationCarriedFrom,
  nameGenerationHighWaterOf,
} from '../../../state/name-generation.js';
import { isNameGeneration } from '../../../provisioning/resource-name.js';
import { constructPathOf } from '../../../analyzer/destructive-changes.js';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { TemplateParser } from '../../../analyzer/template-parser.js';
import {
  carriesSecretMask,
  maskWholeValue,
  splitGetAttStringForm,
} from '../../../deployment/secret-redaction.js';
import {
  resourcesNamingDeclaredParameter,
  type ParameterNamingVerdict,
} from '../../../analyzer/parameter-dependence.js';
import {
  displayIdent,
  displaySafe,
  displayStackName,
  safeMsg,
} from '../../../utils/display-safe.js';
import { logicalIdShown } from '../../../provisioning/composite-id.js';
import { defineOwnKey, hasOwnKey } from '../../../utils/own-keys.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  exportNamesCarriedFrom,
  hasReasonlessBaselineRefusal,
  hasUnverifiableParameterRefusal,
  orphansCarriedFrom,
  stackInstanceIdCarriedFrom,
  type ResourceState,
  type StackState,
} from '../../../types/state.js';
import { cdkdRemedy } from '../../../utils/pasteable-command.js';
import { stackShown } from './overrides.js';
import type { ImportRow } from './types.js';

/**
 * go-to-k/cdkd#4705: point a top-level stack's registry marker at this prefix
 * after an import wrote its record, through the guard: no marker (or a stale
 * one) is claimed only after the one-time prefix scan answers clear. Another
 * prefix holding the stack is named, not overridden: a later destroy or
 * destructive deploy under either is refused until one record is dropped.
 * Never throws: every outcome but `clear` is a warning.
 */
export async function claimRegistryMarkerAfterImport(
  backend: S3StateBackend,
  stackName: string,
  region: string,
  logger: { warn(message: string): void; debug(message: string): void }
): Promise<void> {
  // The guard's own path (go-to-k/cdkd#4705 review CB-2): with no marker, or
  // a stale one, the prefix scan runs once and only a clear answer claims.
  const answer = await new CrossPrefixGuard(backend).full(stackName, region);
  const regionShown = displaySafe(region, { asciiOnly: true });
  switch (answer.kind) {
    case 'clear':
      return;
    case 'found':
      logger.warn(
        safeMsg`The state bucket also records ${displayStackName(stackName)} (${regionShown}) under another state prefix ` +
          safeMsg`(${answer.prefixes.map((p) => displayIdent(p)).join(', ')}). One stack name per ` +
          safeMsg`account and region is supported: drop one of the records with '${cdkdRemedy('cdkd state orphan')}' ` +
          `before deploying or destroying either.`
      );
      return;
    case 'in-progress':
      logger.warn(
        safeMsg`A deploy of ${displayStackName(stackName)} (${regionShown}) holds a lock under another state prefix ` +
          safeMsg`(${displayIdent(answer.prefix)}). One stack name per account and region is ` +
          `supported: keep one of the two before deploying or destroying either.`
      );
      return;
    default:
      logger.warn(
        safeMsg`Could not record ${displayStackName(stackName)} (${regionShown}) in the state bucket's stack registry` +
          (answer.kind === 'denied' || answer.kind === 'failed'
            ? safeMsg` (${describeAwsFailure(answer.error).summary})`
            : '') +
          `. Its next guarded command records it.`
      );
  }
}

/**
 * go-to-k/cdkd#4523: before the import's state write, mark the resources it
 * adopts (logical id, the physical id this run records, and the type) on the stack's
 * rollback journal, so a later `cdkd rollback` replays none of the journal's
 * ops of those logical ids (the matching ones are adopted, the rest displaced
 * with a warning — `splitImportedOps`). Without it, a kept segment's completed
 * CREATE of an explicitly named resource matches the imported record's
 * physical id and the replay DELETES the resource the user just adopted.
 *
 * Runs BEFORE `saveState`: a failure here refuses the import with nothing
 * written, rather than write a record the journal is still free to delete. A
 * mark that lands followed by a failed save leaves those ops unreverted, which
 * the rollback's plan lists — it never deletes.
 */
export async function recordImportOnRollbackJournal(
  stateBackend: S3StateBackend,
  stackName: string,
  region: string,
  logicalIds: readonly string[],
  resources: StackState['resources'],
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const marks = logicalIds.flatMap((logicalId) => {
    const record = hasOwnKey(resources, logicalId) ? resources[logicalId] : undefined;
    const physicalId = record?.physicalId;
    const resourceType = record?.resourceType;
    return typeof physicalId === 'string' &&
      physicalId !== '' &&
      typeof resourceType === 'string' &&
      resourceType !== ''
      ? [{ logicalId, physicalId, resourceType }]
      : [];
  });
  let marked: string[];
  try {
    marked = await stateBackend.markRollbackJournalImported(stackName, region, marks);
  } catch (error) {
    throw new Error(
      `Could not record this import on the rollback journal of ${stackShown(stackName)}, so ` +
        `state was NOT written: a later cdkd rollback could otherwise delete what was imported. ` +
        `Cause: ${displaySafe(describeAwsFailure(error).detail)}`
    );
  }
  if (marked.length > 0) {
    logger.info(
      safeMsg`  The rollback journal of ${stackShown(stackName)} records ` +
        safeMsg`${marked.map((id) => logicalIdShown(id)).join(', ')} as imported: ` +
        'cdkd rollback leaves those resources as they are.'
    );
  }
}

/**
 * The logical ids whose `ResourceState` a run REBUILT from the template — the
 * discriminator `captureObservedForImportedResources` needs for schema v10's
 * `observedBaselineRefused` (issue
 * [#2944](https://github.com/go-to-k/cdkd/issues/2944)).
 *
 * It is a function, exported and tested, rather than an inline
 * `rows.filter(...)` at each call site, because the predicate is the whole
 * safety property: `buildStackState` overwrites exactly the `'imported'` rows
 * and PRESERVES every other record in a selective merge, so a predicate that
 * drifts wider (`rows.map(...)`, or admitting another outcome) silently
 * re-opens the fifth-writer leak — a preserved record's stale, distrusted
 * `properties` would be treated as this run's resolution, captured against,
 * and its refusal cleared. Two inline copies could also drift apart from each
 * other and from `buildStackState`'s own test.
 *
 * Every non-`'imported'` outcome is EXCLUDED, including the ones that sound
 * harmless: `skipped-out-of-scope` is precisely the selective-merge case, and
 * `failed` / `skipped-not-found` / `skipped-no-impl` leave whatever the record
 * already held.
 */
export function rebuiltLogicalIdsFrom(
  rows: readonly ImportRow[],
  template: CloudFormationTemplate
): ReadonlySet<string> {
  return new Set(
    rows
      .filter(
        (r) =>
          r.outcome === 'imported' &&
          // The SAME three conjuncts `buildStackState` applies before it
          // overwrites a record. Filtering on the outcome alone was the first
          // spelling and a review round caught it: a row that is `'imported'`
          // but carries no physical id, or names a logical id the template
          // does not declare, is SKIPPED there — so the record keeps whatever
          // it already held, and calling it rebuilt would let a preserved
          // refusal be cleared against a previous run's properties.
          // Unreachable today (every `outcome: 'imported'` site sets a
          // physical id), which is exactly why it must be spelled rather than
          // argued.
          r.physicalId !== undefined &&
          template.Resources[r.logicalId] !== undefined
      )
      .map((r) => r.logicalId)
  );
}

/**
 * The attributes bag an imported row records, given what the provider's
 * `import()` returned (`row`) and the stored bag of the SAME physical id
 * (`prior`; `undefined` when there is none or the id changed — attributes
 * describe one AWS resource, so a repointed logical id inherits nothing).
 *
 * Two rules, and the second is PER KEY by necessity (issue
 * [#2927](https://github.com/go-to-k/cdkd/issues/2927)):
 *
 * 1. **An empty `row` keeps `prior`** (issue #1098). Almost every provider
 *    spells "no attributes" as an explicit `attributes: {}`, so the test is
 *    emptiness, not absence — otherwise a provider that reports none would
 *    wipe a map a deploy recorded. A non-empty `row` otherwise replaces
 *    `prior`: a key `row` omits is dropped — except under rule 3.
 * 2. **A masked `row` value never displaces an unmasked `prior` one.**
 *    `CloudControlProvider.import` masks every model key it cannot certify
 *    as an attribute, keeping the KEY, so a bag of masks is non-empty and
 *    rule 1 alone let it overwrite a good deploy-recorded bag — after which
 *    every dependent's `Fn::GetAtt` was refused. A mask is not a value, so
 *    replacing a value with one is never a refresh. The test is per
 *    top-level key because that is the granularity the mask is written at,
 *    and because a whole-bag test (`carriesSecretMask(row)`) would discard
 *    the CERTIFIED siblings of one masked key. `keptRecordedKeys` names
 *    them: the recorded value may be stale, and the caller says so.
 * 3. **A masked `prior` key the `row` omits is carried, not dropped.** A
 *    partial `row` (an SDK provider's degraded `{ Id }`) would otherwise turn
 *    a refused read into a physical-id fallback — the harm the next paragraph
 *    describes. An unmasked omitted key is still dropped (#1098).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: clear a mask `prior` holds when `row`
 * offers nothing better. Dropping the key looks like a repair and is the
 * opposite — `resolveGetAtt` then falls through to the physical-id fallback
 * and ships a wrong value where it used to refuse (measured on the issue).
 * So a mask survives, and `stillMaskedKeys` names every key a `prior` mask
 * survived under, for the caller to report.
 */
export function reimportedAttributes(
  row: Record<string, unknown> | undefined,
  prior: Record<string, unknown> | undefined
): { attributes: Record<string, unknown>; stillMaskedKeys: string[]; keptRecordedKeys: string[] } {
  let attributes: Record<string, unknown>;
  const keptRecordedKeys: string[] = [];
  if (row === undefined || Object.keys(row).length === 0) {
    attributes = prior ?? {};
  } else if (prior === undefined) {
    attributes = row;
  } else {
    // `row`'s own prototype (a Cloud Control bag is null-prototype), and keys
    // DEFINED rather than assigned: such a bag can carry a legal own
    // `__proto__` key, and assigning it writes the prototype instead — a DROP.
    attributes = Object.create(Object.getPrototypeOf(row) as object | null) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(row)) {
      const keepRecorded =
        carriesSecretMask(value) && hasOwnKey(prior, key) && !carriesSecretMask(prior[key]);
      if (keepRecorded) keptRecordedKeys.push(key);
      defineOwnKey(attributes, key, keepRecorded ? prior[key] : value);
    }
    // Rule 3: a masked prior key the row OMITS is carried, not dropped.
    for (const [key, value] of Object.entries(prior)) {
      if (!hasOwnKey(attributes, key) && carriesSecretMask(value)) {
        defineOwnKey(attributes, key, value);
      }
    }
  }
  const stillMaskedKeys =
    prior === undefined
      ? []
      : Object.keys(prior)
          .filter(
            (key) =>
              carriesSecretMask(prior[key]) &&
              hasOwnKey(attributes, key) &&
              carriesSecretMask(attributes[key])
          )
          .sort();
  return { attributes, stillMaskedKeys, keptRecordedKeys: keptRecordedKeys.sort() };
}

/**
 * `attributes` with every name `declared` lists (a prior record's
 * `noEchoAttributeNames`) replaced by its whole-value mask, so a re-import
 * never writes a declared `NoEcho` attribute in the clear (go-to-k/cdkd#4043).
 * Returns the bag itself when nothing changes.
 */
export function withDeclaredNoEchoMasked(
  attributes: Record<string, unknown>,
  declared: unknown
): Record<string, unknown> {
  if (!Array.isArray(declared)) return attributes;
  const names = declared.filter(
    (name): name is string =>
      typeof name === 'string' &&
      hasOwnKey(attributes, name) &&
      !carriesSecretMask(attributes[name]) &&
      attributes[name] !== undefined &&
      attributes[name] !== null
  );
  if (names.length === 0) return attributes;
  const masked = Object.create(Object.getPrototypeOf(attributes) as object | null) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(attributes)) {
    defineOwnKey(masked, key, names.includes(key) ? maskWholeValue(value) : value);
  }
  return masked;
}

/**
 * The `noEchoAttributeNames` field a rebuilt record carries (go-to-k/cdkd#2449):
 * each prior declared name whose attribute in `attributes` still holds the
 * mask. Empty or absent carries nothing, so the field stays omitted.
 */
export function noEchoAttributeNamesCarried(
  prior: unknown,
  attributes: Record<string, unknown> | undefined
): { noEchoAttributeNames?: string[] } {
  if (!Array.isArray(prior) || attributes === undefined) return {};
  const kept = prior.filter(
    (name): name is string =>
      typeof name === 'string' && hasOwnKey(attributes, name) && carriesSecretMask(attributes[name])
  );
  return kept.length > 0 ? { noEchoAttributeNames: kept } : {};
}

/**
 * Per logical id, every attribute the template reads (each dot-prefix of its
 * name) through
 * `Fn::GetAtt` (array or string form) or a `${X.Attr}` in `Fn::Sub`, anywhere
 * in it. An attribute name that is not a literal string reads every key,
 * recorded as {@link READS_EVERY_KEY}. Issue #2925: the re-import's kept-mask warning names only
 * keys a deploy of THIS template would actually refuse to read — since the
 * deploy path masks every non-attribute Cloud Control key too, warning on all
 * of them would fire on every re-import of a deployed resource.
 */
/** {@link templateGetAttReads}' marker for a non-literal attribute name. */
export const READS_EVERY_KEY: unique symbol = Symbol('reads every key');

export function templateGetAttReads(template: unknown): Map<string, Set<string | symbol>> {
  const reads = new Map<string, Set<string | symbol>>();
  const addRead = (logicalId: string, attribute: unknown): void => {
    let attributes = reads.get(logicalId);
    if (!attributes) {
      attributes = new Set();
      reads.set(logicalId, attributes);
    }
    if (typeof attribute === 'string') {
      // Every spelling a record can hold the value under: each dot-prefix of
      // the name, from the top-level container a nested walk descends into to
      // the FLAT dotted key (`Outputs.TableName` on a nested stack,
      // `Endpoint.Address` from the enrichment).
      const segments = attribute.split('.');
      for (let i = 1; i <= segments.length; i++) {
        attributes.add(segments.slice(0, i).join('.'));
      }
    } else {
      attributes.add(READS_EVERY_KEY);
    }
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'Fn::GetAtt') {
        if (Array.isArray(inner) && typeof inner[0] === 'string') {
          addRead(inner[0], inner[1]);
        } else if (typeof inner === 'string') {
          const split = splitGetAttStringForm(inner);
          if (split) addRead(split.logicalId, split.attributeName);
        }
      } else if (key === 'Fn::Sub') {
        const text = Array.isArray(inner) ? inner[0] : inner;
        if (typeof text === 'string') {
          for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
            const ref = match[1] ?? '';
            if (ref.startsWith('!')) continue;
            const split = splitGetAttStringForm(ref);
            if (split) addRead(split.logicalId, split.attributeName);
          }
        }
      }
      walk(inner);
    }
  };
  walk(template);
  return reads;
}

/**
 * Compose a `StackState` from the per-resource import outcomes plus
 * dependency info recovered from the template.
 *
 * `failed` and `skipped-*` rows are dropped — they are not part of state.
 *
 * Resource-map composition depends on the mode:
 *   - `selectiveMode && existingState`: existing resources are the merge
 *     base, every entry survives unless explicitly overwritten by an
 *     `imported` row. Non-destructive for unlisted resources.
 *   - Auto / whole-stack: the resource map is rebuilt from scratch so any
 *     state entry not re-imported is dropped (the user opted into this with
 *     `--force`).
 *
 * Outputs are ALWAYS inherited from `existingState` when present — the
 * import flow never derives outputs (they're computed at deploy time from
 * each resource's attributes), so even an auto-mode rebuild has no reason
 * to wipe them.
 *
 * Exported for unit testing — internal to the command flow otherwise.
 */

export function buildStackState(
  stackName: string,
  region: string,
  rows: ImportRow[],
  templateParser: TemplateParser,
  template: CloudFormationTemplate,
  existingState: StackState | null,
  selectiveMode: boolean
): StackState {
  const resources: Record<string, ResourceState> =
    selectiveMode && existingState ? { ...existingState.resources } : {};
  // Template Parameter names are not provisioning-order edges — filter them
  // from the persisted dependencies (issue #1032), mirroring the deploy
  // engine's extractAllDependencies. Without this, destroy's state-derived
  // graph build warns `depends on <Param>, but <Param> not found in template`.
  const parameterNames = new Set(Object.keys(template.Parameters ?? {}));
  // Issue #3468: computed at most once, and only when a prior record carries a
  // reason-less marker.
  let namesParameter: ParameterNamingVerdict | undefined;
  const getAttReads = templateGetAttReads(template);
  for (const row of rows) {
    if (row.outcome !== 'imported' || !row.physicalId) continue;
    const tmplResource = template.Resources[row.logicalId];
    if (!tmplResource) continue;
    const deps = [...templateParser.extractDependencies(tmplResource)].filter(
      (dep) => !parameterNames.has(dep)
    );
    // Attribute carry-over: a re-imported row REPLACES the whole
    // ResourceState, so a resource that already had a populated attribute
    // map (from a prior `cdkd deploy` or import) would have it wiped when
    // the provider's `import()` returns no attributes. Fall back to the
    // stored map — but ONLY when the physical id is unchanged. Attributes
    // describe a specific AWS resource, so carrying them across a
    // re-import that repoints the logical id at a DIFFERENT physical id
    // (`--resource X=<other>` with `--force`) would resurrect stale facts
    // about the old resource and hand them to `Fn::GetAtt`.
    const prior = existingState?.resources[row.logicalId];
    const priorAttributes =
      prior && prior.physicalId === row.physicalId ? prior.attributes : undefined;
    const reimported = reimportedAttributes(row.attributes, priorAttributes);
    const { stillMaskedKeys, keptRecordedKeys } = reimported;
    // go-to-k/cdkd#4043 (schema v11): an attribute the prior record DECLARED
    // `NoEcho` (same physical id) stays the mask, whatever this re-import read
    // back from AWS: an SSM parameter's `Value` echoes a value deployed from a
    // `NoEcho` parameter that the import cannot classify.
    const attributes = withDeclaredNoEchoMasked(
      reimported.attributes,
      prior && prior.physicalId === row.physicalId ? prior.noEchoAttributeNames : undefined
    );
    if (keptRecordedKeys.length > 0) {
      // Not silent (issue #2927 review): the kept value is the one the last
      // deploy recorded, so an out-of-band change to it is not picked up here.
      getLogger().info(
        safeMsg`${displayIdent(row.logicalId)}: this import recorded ` +
          safeMsg`${keptRecordedKeys.map((key) => displayIdent(key)).join(', ')} only as the ` +
          `redaction mask, so the previously recorded value is kept; a deploy that updates the ` +
          `resource rewrites it.`
      );
    }
    // Only a key this template READS is refused at deploy; the rest are keys
    // no deploy of it resolves (on a Cloud Control record, every non-attribute
    // model key is masked by design, issue #2925), so they go to debug.
    const readAttributes = getAttReads.get(row.logicalId);
    const refusedKeys = stillMaskedKeys.filter(
      (key) => readAttributes?.has(key) === true || readAttributes?.has(READS_EVERY_KEY) === true
    );
    const unreadKeys = stillMaskedKeys.filter((key) => !refusedKeys.includes(key));
    if (unreadKeys.length > 0) {
      getLogger().debug(
        safeMsg`${displayIdent(row.logicalId)}: the redaction mask stays recorded under ` +
          safeMsg`${unreadKeys.map((key) => displayIdent(key)).join(', ')}; this template reads none of them.`
      );
    }
    if (refusedKeys.length > 0) {
      // Issue #2927: the user most likely ran this re-import BECAUSE a deploy
      // refused a masked read and told them to, so a record that still holds
      // the mask must say so here rather than let the next deploy repeat the
      // identical refusal with nothing explaining why. Both the logical id
      // (template-controlled) and the keys (the AWS model's) are rendered
      // display-safe on this default-verbosity line.
      const keys = refusedKeys.map((key) => displayIdent(key)).join(', ');
      const pronoun = refusedKeys.length === 1 ? 'it' : 'them';
      getLogger().warn(
        safeMsg`${displayIdent(row.logicalId)}: this import produced no value to replace the redaction ` +
          safeMsg`mask recorded under ${keys}, so the mask is kept and an Fn::GetAtt reading ${pronoun} ` +
          `in this template is still refused at deploy. It is kept rather than cleared because an attribute missing ` +
          `from state resolves to the physical id instead of failing.`
      );
    }
    resources[row.logicalId] = {
      physicalId: row.physicalId,
      // go-to-k/cdkd#5064 phase 2: the name generation describes the resource
      // a record names, so it is kept only on an UNCHANGED physical id. A
      // resource adopted in place of another records none, only the highest
      // generation the replaced record reached; the next replacement goes past
      // that and any generation whose name the adopted one already carries
      // (`nextNameGeneration`).
      ...importedNameGenerationFields(
        prior,
        row,
        existingState?.retiredNameGenerations?.[row.logicalId]
      ),
      resourceType: row.resourceType,
      properties: tmplResource.Properties ?? {},
      // Issue #1098: persist the provider-returned attribute snapshot so an
      // adopted resource can back `Fn::GetAtt` the same way a deployed one
      // does. How it combines with the same-physical-id stored map is
      // `reimportedAttributes`' contract.
      attributes,
      // go-to-k/cdkd#2449 (schema v11): the attribute names the producer
      // DECLARED `NoEcho`, carried on an UNCHANGED physical id like the
      // attributes themselves, for each name whose carried value still holds
      // the mask. `noEchoLeaves` is NOT carried: `properties` is rebuilt from
      // the template here, so the old coordinates do not describe it.
      ...noEchoAttributeNamesCarried(
        prior && prior.physicalId === row.physicalId ? prior.noEchoAttributeNames : undefined,
        attributes
      ),
      dependencies: deps,
      // Issue #3645: the template's policies, as `DeployEngine` records them.
      // `cdkd destroy` reads `DeletionPolicy` from STATE only, so a record
      // written without it DELETED a `Retain` resource (and skipped a
      // `Snapshot` one's final snapshot) when destroy ran before the first
      // deploy rewrote the record. `template` is the synthesized CDK template,
      // not the Retain-injected copy the CloudFormation retirement uploads.
      deletionPolicy: tmplResource.DeletionPolicy,
      updateReplacePolicy: tmplResource.UpdateReplacePolicy,
      // As `DeployEngine` stamps it on every save, so an imported resource the
      // template later drops is still named by its construct path.
      ...constructPathField(constructPathOf(template, row.logicalId)),
      // v7+ (#614): the layer that imported it, explicit so no reader falls
      // back to the absent-field "sdk legacy default". A type with no SDK
      // provider is `cc-api`, as a deploy records it (go-to-k/cdkd#4706).
      provisionedBy: row.provisionedBy ?? 'sdk',
      // Issue #3462: an unverifiable-parameter refusal is carried across the
      // rebuild, because THIS literal is otherwise the one place it is lost —
      // and the run that rebuilds may have no way to re-judge it. After a
      // `--migrate-from-cloudformation` the CloudFormation stack is gone, so a
      // later re-import has no deployed-parameter source, ARM 4 does not run,
      // and the capture below would position AWS's readback against the same
      // placeholder `Default` the refusal distrusted. Only on an UNCHANGED
      // physical id, for the reason `priorAttributes` has: the refusal is a
      // fact about what that AWS resource holds. Whether it STANDS is decided
      // by `captureObservedForImportedResources`, which knows whether this run
      // had a source.
      //
      // Issue #3468: a marker recorded WITHOUT a reason (an older
      // cdkd, cause unknown) is carried the same way when this resource's
      // template definition names a declared parameter — the fail-closed
      // reading `ResourceState.observedBaselineRefusalReason` documents.
      ...(prior &&
        prior.physicalId === row.physicalId &&
        (hasUnverifiableParameterRefusal(prior) ||
          (hasReasonlessBaselineRefusal(prior) &&
            (namesParameter ??= resourcesNamingDeclaredParameter(template))(row.logicalId))) && {
          observedBaselineRefused: true as const,
          observedBaselineRefusalReason: 'unverifiable-parameter' as const,
        }),
    };
  }
  if (namesParameter?.failedClosed !== undefined) {
    // The cause CLASS only: never a template value or an error's text.
    getLogger().debug(
      `The template's parameter dependence could not be judged (${namesParameter.failedClosed}): every prior observed-baseline refusal recorded without a reason is carried as an unverifiable-parameter refusal.`
    );
  }
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName,
    region,
    resources,
    outputs: existingState?.outputs ?? {},
    // The bag above is carried forward, so its export set travels with it
    // (issue #2193); a record built from nothing exports nothing, and that is
    // a KNOWN `[]`, not an unknown.
    ...(existingState ? exportNamesCarriedFrom(existingState) : { exportNames: [] }),
    // State schema v12: the carried bag's per-output provenance travels with it.
    ...(existingState?.outputReferenceProvenance !== undefined && {
      outputReferenceProvenance: existingState.outputReferenceProvenance,
    }),
    // Carried for the same reason (issue #2934), and it matters MORE here than
    // the export set does: import into an existing state is a realistic
    // recovery route after a failed deploy, and this literal enumerates its
    // fields — so without this line the import would silently delete the only
    // record that a live, billing `Retain` resource is still standing in AWS.
    ...(existingState ? orphansCarriedFrom(existingState) : {}),
    // State schema v13: the stack's lifetime id travels with its record; a
    // record built from nothing gets the one its caller resolves before the
    // save (`stackInstanceIdForFirstWrite`).
    ...(existingState ? stackInstanceIdCarriedFrom(existingState) : {}),
    // ...but the skipped-outputs record (issue #2740) is DROPPED, not carried,
    // even though it describes that same bag. It records what the last DEPLOY
    // could not resolve, and an import refreshes `attributes` for every
    // resource it imports (see `reimportedAttributes` above;
    // selective mode leaves the rest alone), so a key the deploy skipped for
    // want of an attribute may now resolve — with no template resource change
    // to un-bind the record. Carried forward it would make `cdkd diff` preview
    // that key as absent while the next deploy publishes it and its
    // `Export.Name`: the record's silent "nothing to do" over a row that is
    // coming, which is the direction the whole field exists to avoid. Dropping
    // it returns that key to pre-#2740 behaviour until the next deploy
    // recomputes the record: resolved like any other output, so a row when the
    // diff can resolve it and the ordinary whole-section suppression when it
    // cannot. Either way the diff stops asserting that nothing is coming.
    lastModified: Date.now(),
  };
}

/** `{ constructPath }` when the template declares one, else nothing. */
function constructPathField(path: string | undefined): { constructPath?: string } {
  return path === undefined ? {} : { constructPath: path };
}

/**
 * go-to-k/cdkd#5064 phase 2: the name-generation fields of a record `cdkd
 * import` rebuilds over `prior`. Kept verbatim on an unchanged physical id; a
 * resource adopted in place of another records the highest generation the
 * replaced record reached as its high-water mark. A row the import is
 * repairing (unreadable, or holding a malformed generation) contributes
 * nothing: the import is its way out, never a second refusal.
 *
 * @internal Exported for its unit test.
 */
export function importedNameGenerationFields(
  prior: ResourceState | null | undefined,
  row: { logicalId: string; physicalId?: string | undefined },
  /** The logical id's retired generation, when an earlier record of it left the stack. */
  retired?: unknown
): Pick<ResourceState, 'nameGeneration' | 'nameGenerationHigh'> {
  // A copy that left the stack may still hold that generation's name (Retain):
  // the next replacement goes past it.
  const retiredReached = isNameGeneration(retired) ? retired : 0;
  const reachedField = (reached: number): Pick<ResourceState, 'nameGenerationHigh'> =>
    reached === 0 ? {} : { nameGenerationHigh: reached };
  if (prior === null || typeof prior !== 'object') return reachedField(retiredReached);
  try {
    if (prior.physicalId !== row.physicalId) {
      return reachedField(
        Math.max(retiredReached, nameGenerationHighWaterOf(prior, row.logicalId))
      );
    }
    // Read first: a malformed value is dropped, not carried into the repair.
    nameGenerationHighWaterOf(prior, row.logicalId);
    return nameGenerationCarriedFrom(prior);
  } catch {
    return reachedField(retiredReached);
  }
}
