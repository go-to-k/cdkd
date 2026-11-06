import { displayIdent } from '../../../utils/display-safe.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceChange, ResourceState } from '../../../types/state.js';
import { acceptedCreateOnlyDropsOf } from '../../../types/state.js';
import {
  findActionableSdkUnwired,
  findHandledUnwrittenCreateOnly,
  unwrittenCreateOnlyReplacement,
} from '../../../provisioning/property-coverage.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import type { NestedStackTypeChange } from '../../../deployment/type-change-guard.js';
import type { CcRouteUnavailableReason } from './types.js';

/**
 * The reason a repaired `properties` map puts on the node's `blocking`
 * (go-to-k/cdkd#3335).
 *
 * `cdkd diff` REPAIRS this container and previews the record; `cdkd deploy`
 * REFUSES it inside `DiffCalculator.calculateDiff`, which both deploy paths
 * reach. So the preview is honest about the rows and wrong about what happens
 * next, and this is the sentence that says so.
 *
 * The ids are NOT re-rendered here: they have already been through
 * `malformedResourcePropertiesWarning`'s sanitizer in the warning printed
 * beside this, and the renderer strips control characters from every blocking
 * reason on the way out. The count is what this line adds — and the line does
 * not send the reader to that warning for the names, because the warning caps
 * at five before `and N more`, and under `--json` this reason ships in the
 * payload, where "above" has no referent.
 */
export function deployRefusesPropertiesReason(logicalIds: readonly string[]): string {
  return (
    `${logicalIds.length} resource record(s) hold a 'properties' map that cannot be read. ` +
    `This preview repaired them to empty; 'cdkd deploy' refuses the record instead, so the ` +
    `deploy this previews will not start.`
  );
}

/**
 * The reason one row of the deploy's nested-stack Type-change refusal
 * (`renderNestedStackTypeChangeRefusal`, go-to-k/cdkd#2668) puts on the node's
 * `blocking` (go-to-k/cdkd#3453). One line per row, since the renderer prints
 * each reason on one `!` line; the deploy's own message carries the longer
 * explanation. The id and both types are template- or state-chosen, so each
 * takes `displayIdent`, as the adoption refusals' fields do.
 */
export function nestedStackTypeChangeReason(tc: NestedStackTypeChange): string {
  return (
    `${displayIdent(tc.logicalId)}: Type changes from ${displayIdent(tc.currentType)} to ` +
    `${displayIdent(tc.desiredType)}. cdkd does not replace a resource into or out of ` +
    `${NESTED_STACK_RESOURCE_TYPE}; give the new resource a different logical ` +
    `id, or remove it in one deploy and add its replacement in the next.`
  );
}

/**
 * One warning per resource the flag-less `cdkd deploy` of this stack refuses
 * pre-flight because its template drives a Cloud Control route the type does
 * not have (`ProviderRegistry.reportSdkUnwiredDecisions`, issue #5600). Walks
 * what that check walks: every template resource but `AWS::CDK::Metadata`,
 * unchanged rows and `AWS::CloudFormation::Stack` included. A deploy skips a
 * nested stack whose row did not change, so the text says "of this stack". A
 * resource this diff kept over a condition it could not settle
 * (`conditionSettled`) may be pruned by the deploy, so its text is conditional.
 * Ids, types and property names are template-chosen, so each takes
 * `displayIdent`. Exported for its unit test.
 */
export function findUnroutableDropRefusals(
  template: CloudFormationTemplate,
  stateResources: Record<string, ResourceState>,
  ccRouteUnavailableReason: CcRouteUnavailableReason,
  conditionSettled: (name: string) => boolean = () => true
): string[] {
  const reasons: string[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (!resource || resource.Type === 'AWS::CDK::Metadata') continue;
    const reason = ccRouteUnavailableReason(resource.Type);
    if (reason === undefined) continue;
    const properties = findActionableSdkUnwired(
      resource.Type,
      resource.Properties,
      EMPTY_ALLOW_SET,
      Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId]?.properties : undefined
    ).map(({ property }) => property);
    if (properties.length === 0) continue;
    const keep = properties.map((p) => displayIdent(`${resource.Type}:${p}`)).join(',');
    const condition = resource.Condition;
    const hedge =
      typeof condition === 'string' && !conditionSettled(condition)
        ? `if condition ${displayIdent(condition)} holds, `
        : '';
    reasons.push(
      `${displayIdent(logicalId)} (${displayIdent(resource.Type)}): ${hedge}a deploy of this ` +
        `stack without --prefer-sdk-route refuses ${properties.map((p) => displayIdent(p)).join(', ')}, ` +
        `because the SDK provider does not handle ${properties.length === 1 ? 'it' : 'them'} ` +
        `and this type cannot fall back to Cloud Control API (${reason}). Remove ` +
        `${properties.length === 1 ? 'the property' : 'the properties'}, or deploy with ` +
        `--prefer-sdk-route ${keep}.`
    );
  }
  return reasons;
}

/**
 * One warning per row `cdkd deploy` refuses with
 * `CREATE_ONLY_DROP_NEEDS_REPLACEMENT` (issue #2790), decided by
 * `unwrittenCreateOnlyReplacement` — the engine's own predicate — with the
 * flag-less allow set this preview stands for. Ids and types are template- or
 * state-chosen, so each takes `displayIdent`; the property names come from the
 * record's evidence field, so they do too. Exported for its unit test.
 */
export function findUnwrittenCreateOnlyRefusals(
  changes: ReadonlyMap<string, ResourceChange>,
  stateResources: Record<string, ResourceState>,
  /** Omitted, every type counts as routable. See {@link CcRouteUnavailableReason}. */
  ccRouteUnavailableReason?: CcRouteUnavailableReason
): string[] {
  const reasons: string[] = [];
  for (const [logicalId, change] of changes) {
    if (change.changeType !== 'UPDATE') continue;
    if (!Object.hasOwn(stateResources, logicalId)) continue;
    const record = stateResources[logicalId];
    if (record === undefined || record.provisionedBy === 'cc-api') continue;
    if (record.resourceType !== change.resourceType) continue;
    // `requiresReplacement` is read before the engine's ceiling lowering, and
    // `desired` is the raw template plus each change's new value, so a row the
    // engine would lower or resolve differently can go unwarned.
    // No `lostWithParent` gate, unlike the engine: no type a recreated
    // parent takes with it has a create-only SDK-unwired property TODAY (fenced in
    // tests/unit/deployment/accepted-create-only-drops.test.ts). Evidence on
    // such a type can still come from an earlier cdkd, written while a since
    // backfilled key was a drop (#5572); for that record this warning can name
    // a refusal the engine skips because the parent re-creates the child. It
    // is a warning, never a blocking reason, so that over-report costs no
    // exit code.
    const propertyChanges = change.propertyChanges ?? [];
    const desired: Record<string, unknown> = { ...(change.desiredProperties ?? {}) };
    for (const pc of propertyChanges) desired[pc.path] = pc.newValue;
    const keys = unwrittenCreateOnlyReplacement(
      change.resourceType,
      record.properties ?? {},
      desired,
      new Set<string>(),
      acceptedCreateOnlyDropsOf(record),
      propertyChanges.filter((pc) => pc.requiresReplacement).map((pc) => pc.path)
    );
    if (keys.length === 0) continue;
    // The keep-dropping list the engine's refusal names: the route is per
    // RESOURCE, so the deploy stays on the SDK provider only with every
    // route-driving key allow-listed, not just the unwritten ones.
    const routeDriving = findActionableSdkUnwired(
      change.resourceType,
      desired,
      new Set<string>(),
      record.properties ?? {}
    ).map(({ property }) => property);
    // Issue #5572: keys the SDK provider now writes, which no flag keeps
    // dropped; the engine's refusal names the same subset.
    const nowWritten = findHandledUnwrittenCreateOnly(
      change.resourceType,
      record.properties ?? {},
      acceptedCreateOnlyDropsOf(record)
    ).filter((property) => keys.includes(property));
    const keepKeys = [...new Set([...keys, ...routeDriving])]
      .filter((property) => !nowWritten.includes(property))
      .sort((a, b) => a.localeCompare(b));
    const keep = keepKeys
      .map((property) => displayIdent(`${change.resourceType}:${property}`))
      .join(',');
    const one = keys.length === 1;
    // Issue #5600: a type with no Cloud Control route has no such opt-in, and
    // the pre-flight refusal, which `findUnroutableDropRefusals` words, comes
    // first and reads neither flag.
    const unroutable = ccRouteUnavailableReason?.(change.resourceType) !== undefined;
    if (nowWritten.length > 0) {
      reasons.push(
        `${displayIdent(logicalId)} (${displayIdent(change.resourceType)}): this previews a ` +
          `replacement that would apply create-only ${keys.map((k) => displayIdent(k)).join(', ')}, ` +
          `which the state record holds although the SDK provider that built the resource did ` +
          `not write ${one ? 'it' : 'them'}, so AWS does not. This cdkd version's SDK provider ` +
          `writes ${nowWritten.map((k) => displayIdent(k)).join(', ')}, so a deploy refuses it ` +
          `(CREATE_ONLY_DROP_NEEDS_REPLACEMENT) unless ` +
          `${
            !unroutable
              ? '--recreate-via-cc-api or --replace opts in, whatever --prefer-sdk-route names'
              : keepKeys.length > 0
                ? `--prefer-sdk-route ${keep} with the --replace flag opts in`
                : '--replace opts in'
          }; a deploy with ` +
          `${nowWritten.map((k) => displayIdent(k)).join(', ')} removed from the template` +
          (keepKeys.length > 0 ? ` and --prefer-sdk-route ${keep}` : '') +
          ` changes nothing.`
      );
      continue;
    }
    reasons.push(
      `${displayIdent(logicalId)} (${displayIdent(change.resourceType)}): this previews a ` +
        `replacement that would apply create-only ${keys.map((k) => displayIdent(k)).join(', ')}, ` +
        `which the state record holds although the SDK provider never wrote ` +
        `${one ? 'it' : 'them'}, so AWS does not. ` +
        (unroutable
          ? `A deploy passing --prefer-sdk-route ${keep} changes nothing.`
          : `A deploy without --prefer-sdk-route refuses it ` +
            `(CREATE_ONLY_DROP_NEEDS_REPLACEMENT) unless --recreate-via-cc-api or ` +
            `--replace opts in; a deploy passing --prefer-sdk-route ${keep} changes nothing.`)
    );
  }
  return reasons;
}

/**
 * The `outputs` twin of {@link deployRefusesPropertiesReason}, a constant
 * because the bag is refused as a whole and there is nothing to count.
 *
 * `refuseMalformedOutputs` in `DeployEngine` is what refuses it. This arm is
 * the one the issue could not drive end to end — a record whose template
 * declares no Outputs produces no delta at all, so before this the node had
 * nothing to report and `--fail` exited 0.
 */
export const DEPLOY_REFUSES_OUTPUTS_REASON =
  `The 'outputs' bag cannot be read. This preview repaired it to empty; 'cdkd deploy' ` +
  `refuses the record instead, so the deploy this previews will not start.`;

/*

 * The reasons for the containers this command DROPS rather than repairs in
 * place (go-to-k/cdkd#3512): the `resources` bag, a `resources` entry, the
 * `orphans` container and an `orphans` row. Each already puts an entry in one
 * of the node's three unreadable fields, which `--fail` counts; `cdkd deploy`
 * refuses the record over every one of them, so each ALSO carries a blocking
 * reason and exit 3 says so. The rule is the one go-to-k/cdkd#3335 set for the
 * two containers above: a container the deploy refuses is a reason, and
 * whatever unreadable entry it had stays — those fields still mean "dropped
 * from the diff", and exit 3 outranks `--fail` where both fire.
 *
 * Count-only, like {@link deployRefusesPropertiesReason}: the rows are named in
 * those fields and in the warning printed beside this.
 */
export const DEPLOY_REFUSES_RESOURCES_BAG_REASON =
  `The 'resources' map cannot be read. This preview read it as empty; 'cdkd deploy' ` +
  `refuses the record instead, so the deploy this previews will not start.`;

export function deployRefusesResourceEntriesReason(logicalIds: readonly string[]): string {
  return (
    `${logicalIds.length} resource record(s) in 'resources' cannot be read as resources. ` +
    `This preview dropped them; 'cdkd deploy' refuses the record instead, so the deploy ` +
    `this previews will not start.`
  );
}

export const DEPLOY_REFUSES_ORPHANS_CONTAINER_REASON =
  `The 'orphans' field is not a list. This preview read it as empty; 'cdkd deploy' ` +
  `refuses the record instead, so the deploy this previews will not start.`;

export function deployRefusesDroppedOrphanRowsReason(
  logicalIds: ReadonlyArray<string | null>
): string {
  return (
    `${logicalIds.length} rollback-orphan record(s) in 'orphans' cannot be read as resources. ` +
    `This preview dropped them; 'cdkd deploy' refuses the record instead, so the deploy ` +
    `this previews will not start.`
  );
}

export const EMPTY_ALLOW_SET: ReadonlySet<string> = new Set();
