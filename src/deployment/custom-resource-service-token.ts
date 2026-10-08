/**
 * A custom resource's `ServiceToken` never changes in place
 * (go-to-k/cdkd#4749), matching CloudFormation, which refuses the update with
 * `Modifying service token is not allowed`.
 *
 * Sent as an `Update`, the change reaches the NEW handler only: the old one
 * never gets a `Delete`, so whatever it created is orphaned without a word.
 * The remedy CloudFormation documents is a new custom resource (in CDK, a new
 * logical id): the deploy then creates it through the new handler and deletes
 * the old one through its OLD handler, from the record's own `ServiceToken`.
 *
 * ## Two checks, one rule
 *
 * - PLAN time ({@link findServiceTokenRefusals}), before anything is
 *   provisioned, in the deploy engine and in `cdkd diff`'s `blocking`. It
 *   refuses a row whose recorded token and diffed desired token are two
 *   different plain strings.
 * - PROVISIONING time ({@link serviceTokenUpdateRefusal}), right before the
 *   in-place update is dispatched, with the desired token fully resolved. It
 *   catches what the plan cannot see: a token that reads a resource this
 *   deploy replaces or creates (a renamed backing Lambda), whose new ARN
 *   exists only once that resource is provisioned. No handler has been invoked
 *   for this resource at either point; the provisioning-time refusal fails the
 *   deploy like any resource failure, and its rollback reverts what earlier
 *   rows did, as CloudFormation's own rollback does after the same refusal.
 *
 * ## When equality cannot be judged
 *
 * A token is COMPARABLE only as a non-empty string that holds neither the
 * redaction mask nor a `{{resolve:...}}` reference. When the RECORDED token
 * is not comparable (absent, the mask, a reference, not a string) and the
 * diff saw the token move (any `ServiceToken` property change, synthetic ones
 * included), the update is refused: neither check can say the handler is the
 * same, and a wrong guess orphans the old handler's resources. A record the
 * diff calls unchanged there is left alone, since the mask-aware diff already
 * judged it equal and refusing would block every update of such a resource.
 *
 * A DESIRED token the plan cannot judge (an intrinsic it could not resolve, a
 * dynamic reference `cdkd diff` leaves unresolved, a masked `NoEcho` value)
 * defers to the provisioning check, which reads the resolved value.
 *
 * ## Not refused
 *
 * - A `--recreate-via-*` target of this stack: that flag already deletes the
 *   old resource through the record's provider and token and creates the new
 *   one through the template's, which is the delete-old + create-new this
 *   refusal asks for. Its replacement path never reaches the in-place check.
 * - A Type change: it is replaced, each half through its own type.
 */

import type { PropertyChange, ResourceChange, ResourceState } from '../types/state.js';
import { isCustomResourceType as isCustomResource } from '../provisioning/custom-resource-secure-references.js';
import { dynamicReferenceTokens, SECRET_MASK } from './secret-redaction.js';
import { displayIdent } from '../utils/display-safe.js';

/** The error code both refusals raise. */
export const SERVICE_TOKEN_CHANGE_REFUSED = 'CUSTOM_RESOURCE_SERVICE_TOKEN_CHANGED';

/** Why a recorded token cannot be compared. */
export type UncomparableToken = 'absent' | 'masked' | 'reference' | 'not-a-string';

/** One refused row. `changed` carries both tokens; `unjudgeable` says why. */
export type ServiceTokenRefusal =
  | { logicalId: string; resourceType: string; kind: 'changed'; recorded: string; desired: string }
  | { logicalId: string; resourceType: string; kind: 'unjudgeable'; recorded: UncomparableToken };

/** A row whose token the plan cannot judge, which the deploy decides once it resolves it. */
export interface DeferredServiceToken {
  logicalId: string;
  resourceType: string;
}

/** `undefined` for a comparable token, else why it is not one. */
export function uncomparableToken(value: unknown): UncomparableToken | undefined {
  if (value === undefined || value === null || value === '') return 'absent';
  if (typeof value !== 'string') return 'not-a-string';
  // Containment, not equality: no Lambda or SNS ARN can hold a `*`.
  if (value.includes(SECRET_MASK)) return 'masked';
  if (dynamicReferenceTokens(value).length > 0) return 'reference';
  return undefined;
}

const SERVICE_TOKEN = 'ServiceToken';

function serviceTokenChange(change: ResourceChange): PropertyChange | undefined {
  return change.propertyChanges?.find((pc) => pc.path === SERVICE_TOKEN);
}

/** A change the diff synthesized, whose value the deploy resolves later. */
function isSynthetic(pc: PropertyChange): boolean {
  return (
    pc.replacementPropagated === true || pc.inPlacePropagated === true || pc.noEchoPromoted === true
  );
}

/**
 * The plan-time verdicts over the diff's rows. `refused` is what the deploy
 * refuses before provisioning anything; `deferred` names rows the preview
 * cannot judge (the token reads a resource this deploy replaces, or a value
 * the preview could not resolve), which `cdkd diff` warns about.
 *
 * Reads the RECORD's token, not the change's `oldValue`: the diff may have
 * narrowed or masked its compared sides, and the record is what the delete
 * path reads to address the old handler.
 */
export function findServiceTokenRefusals(input: {
  changes: ReadonlyMap<string, ResourceChange>;
  stateResources: Record<string, ResourceState>;
  /** This stack's `--recreate-via-*` targets, which are not refused. */
  recreateTargetIds?: ReadonlySet<string> | undefined;
}): { refused: ServiceTokenRefusal[]; deferred: DeferredServiceToken[] } {
  const refused: ServiceTokenRefusal[] = [];
  const deferred: DeferredServiceToken[] = [];
  for (const [logicalId, change] of input.changes) {
    if (change.changeType !== 'UPDATE' || !isCustomResource(change.resourceType)) continue;
    // `Object.hasOwn`: a logical id spelling an `Object.prototype` member
    // must not read a record off the prototype chain.
    if (!Object.hasOwn(input.stateResources, logicalId)) continue;
    const record = input.stateResources[logicalId];
    if (record === undefined || record.resourceType !== change.resourceType) continue;
    if (input.recreateTargetIds?.has(logicalId) === true) continue;
    const pc = serviceTokenChange(change);
    if (pc === undefined) continue;
    const recordedToken = record.properties?.[SERVICE_TOKEN];
    const recordedProblem = uncomparableToken(recordedToken);
    if (recordedProblem !== undefined) {
      refused.push({
        logicalId,
        resourceType: change.resourceType,
        kind: 'unjudgeable',
        recorded: recordedProblem,
      });
      continue;
    }
    const desired = pc.newValue;
    if (!isSynthetic(pc) && uncomparableToken(desired) === undefined) {
      if (desired !== recordedToken) {
        refused.push({
          logicalId,
          resourceType: change.resourceType,
          kind: 'changed',
          recorded: recordedToken as string,
          desired: desired as string,
        });
      }
      continue;
    }
    // Only what can MOVE the token is reported: a replaced referent, or a
    // value the preview could not resolve. An in-place-updated referent
    // (a backing Lambda's code change) keeps its ARN, and warning on every
    // such deploy would bury the one that matters.
    if (
      pc.replacementPropagated === true ||
      (desired !== null && typeof desired === 'object' && !isSynthetic(pc))
    ) {
      deferred.push({ logicalId, resourceType: change.resourceType });
    }
  }
  return { refused, deferred };
}

/**
 * The provisioning-time verdict for one in-place update of a custom resource,
 * or `undefined` to proceed. `recorded` is the state record's token,
 * `desired` the fully resolved one, and `diffSawTokenChange` whether the
 * plan's row carried a `ServiceToken` change.
 */
export function serviceTokenUpdateRefusal(input: {
  logicalId: string;
  resourceType: string;
  recordedType: string;
  recorded: unknown;
  desired: unknown;
  diffSawTokenChange: boolean;
}): ServiceTokenRefusal | undefined {
  if (!isCustomResource(input.resourceType) || input.recordedType !== input.resourceType) {
    return undefined;
  }
  const recordedProblem = uncomparableToken(input.recorded);
  if (recordedProblem !== undefined) {
    return input.diffSawTokenChange
      ? {
          logicalId: input.logicalId,
          resourceType: input.resourceType,
          kind: 'unjudgeable',
          recorded: recordedProblem,
        }
      : undefined;
  }
  // A desired side that is still not a plain string fails in the provider
  // with its own message; only two comparable tokens are judged here.
  if (uncomparableToken(input.desired) !== undefined) return undefined;
  if (input.desired === input.recorded) return undefined;
  return {
    logicalId: input.logicalId,
    resourceType: input.resourceType,
    kind: 'changed',
    recorded: input.recorded as string,
    desired: input.desired as string,
  };
}

const UNCOMPARABLE_TEXT: Record<UncomparableToken, string> = {
  absent: 'missing',
  masked: `the redaction mask '${SECRET_MASK}'`,
  reference: "a '{{resolve:...}}' dynamic reference",
  'not-a-string': 'not a string',
};

/** The masker the caller prints through; identity when it has none. */
type Mask = (text: string) => string;

function rowText(refusal: ServiceTokenRefusal, mask: Mask): string {
  const id = displayIdent(refusal.logicalId);
  if (refusal.kind === 'changed') {
    return (
      `${id}: ServiceToken changes from ${displayIdent(mask(refusal.recorded))} to ` +
      `${displayIdent(mask(refusal.desired))}.`
    );
  }
  return (
    `${id}: its recorded ServiceToken is ${UNCOMPARABLE_TEXT[refusal.recorded]}, so cdkd ` +
    `cannot tell whether this deploy changes it.`
  );
}

const REMEDY =
  `To move a custom resource to a different handler, give it a new logical id (in CDK, a new ` +
  `construct id, or overrideLogicalId on its CfnResource): the deploy then creates the new ` +
  `resource through the new handler and deletes the old one through its old handler. To keep ` +
  `the existing resource, deploy its previous ServiceToken.`;

const UNJUDGEABLE_REMEDY =
  `Where the recorded ServiceToken is unreadable and the handler did not change, put the ` +
  `handler's Lambda function or SNS topic ARN back as ServiceToken in state.json (a ServiceToken ` +
  `fed by a NoEcho parameter is recorded only as '${SECRET_MASK}': feed it from a plain value) ` +
  `and re-deploy.`;

/**
 * The deploy's refusal: names each row, the remedy, and that nothing reached
 * either handler. `mask` covers the printed tokens.
 */
export function renderServiceTokenRefusal(
  refusals: readonly ServiceTokenRefusal[],
  stackName: string,
  mask: Mask = (text) => text
): string {
  const rows = refusals.map((refusal) => `  - ${rowText(refusal, mask)}`);
  return (
    `Refusing to deploy ${stackName}: ` +
    (refusals.length === 1
      ? `a custom resource's ServiceToken changes`
      : `${refusals.length} custom resources' ServiceTokens change`) +
    `, which CloudFormation does not allow ("Modifying service token is not allowed") ` +
    `(issue #4749). Nothing was sent to either handler.\n` +
    `${rows.join('\n')}\n` +
    `  ${REMEDY}` +
    (refusals.some((refusal) => refusal.kind === 'unjudgeable') ? `\n  ${UNJUDGEABLE_REMEDY}` : '')
  );
}

/** One `cdkd diff` `blocking` line per refused row. */
export function serviceTokenBlockingReason(refusal: ServiceTokenRefusal, mask: Mask): string {
  return (
    `${rowText(refusal, mask)} cdkd deploy refuses a changed custom-resource ServiceToken, as ` +
    `CloudFormation does (issue #4749); give the custom resource a new logical id to move it ` +
    `to another handler.`
  );
}

/** One `cdkd diff` warning per deferred row. */
export function deferredServiceTokenWarning(row: DeferredServiceToken): string {
  return (
    `${displayIdent(row.logicalId)}: its ServiceToken reads a resource this deploy replaces or ` +
    `creates, or a value this preview cannot resolve. If it resolves to a different ARN than ` +
    `the one recorded, cdkd deploy refuses the update before invoking any handler and rolls ` +
    `back, as CloudFormation does (issue #4749).`
  );
}
