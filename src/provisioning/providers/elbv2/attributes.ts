import type { ELBv2Provider } from '../elbv2-provider.js';
import {
  DescribeTargetHealthCommand,
  AddTagsCommand,
  RemoveTagsCommand,
  type Tag,
  type Action,
  type Certificate,
  type TargetDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { SecretMasker } from '../../../types/resource.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import {
  readTargets,
  removableRecordedTargets,
  toTargetDescriptions,
  targetsSecretCause,
  TARGETS_WHAT,
} from './shared.js';

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Normalize a CFn `ListenerAttributes` value (an array of `{ Key, Value }`
 * objects) into the SDK's `Attributes` shape. CFn emits the `Value` as a
 * string (e.g. `"3600"`, `"false"`) — pass it through verbatim; the
 * `ModifyListenerAttributes` API takes string Key/Value pairs. Entries
 * missing a `Key` are dropped (an empty `Value` is a valid "clear the
 * override" signal, so only `Key` is required). Returns `[]` for an
 * absent / non-array value so callers can branch on `.length`.
 *
 * Values are coerced only from `string` / `number` / `boolean` — never
 * `String()`-coerced from an arbitrary object (which would yield
 * `[object Object]`); CFn emits these as strings already, so a non-scalar
 * value is malformed input and is dropped rather than silently stringified.
 */
export function normalizeAttributes(
  this: ELBv2Provider,
  raw: unknown
): Array<{ Key: string; Value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ Key: string; Value: string }> = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { Key?: unknown; Value?: unknown };
    if (typeof e.Key !== 'string') continue;
    let value: string;
    if (e.Value === undefined || e.Value === null) {
      value = '';
    } else if (
      typeof e.Value === 'string' ||
      typeof e.Value === 'number' ||
      typeof e.Value === 'boolean'
    ) {
      value = String(e.Value);
    } else {
      // Non-scalar value — malformed; skip rather than emit [object Object].
      continue;
    }
    out.push({ Key: e.Key, Value: value });
  }
  return out;
}

/**
 * Key-diff two normalized `{Key, Value}` attribute lists into the payload
 * for a Modify*Attributes call: changed values from `newAttrs` win, and
 * keys present only in `oldAttrs` are pushed back through `removalValue`.
 * A resolver returning `undefined` SKIPS the entry (the resolver owns any
 * warn). An empty return means nothing changed and the call should be
 * skipped. Shared by the LoadBalancer / TargetGroup / Listener update
 * paths; none sends a removal ({@link RETAIN_REMOVED_ATTRIBUTE}), and the
 * LoadBalancer's resolver also collects the log-delivery keys it warns about.
 * `removalValue` is REQUIRED rather than defaulted, so a new caller has to
 * decide.
 */
export function diffAttributes(
  this: ELBv2Provider,
  newAttrs: Array<{ Key: string; Value: string }>,
  oldAttrs: Array<{ Key: string; Value: string }>,
  removalValue: (key: string, currentValue: string) => string | undefined
): Array<{ Key: string; Value: string }> {
  const newAttrMap = new Map(newAttrs.map((a) => [a.Key, a.Value]));
  const oldAttrMap = new Map(oldAttrs.map((a) => [a.Key, a.Value]));
  const submitted: Array<{ Key: string; Value: string }> = [];
  for (const [k, v] of newAttrMap) {
    if (oldAttrMap.get(k) !== v) submitted.push({ Key: k, Value: v });
  }
  for (const [k, currentValue] of oldAttrMap) {
    if (!newAttrMap.has(k)) {
      const value = removalValue(k, currentValue);
      if (value !== undefined) submitted.push({ Key: k, Value: value });
    }
  }
  return submitted;
}

/**
 * {@link diffAttributes} over one of the three attribute bags of an
 * `update()`, except on `cdkd drift --revert` (`fromReadback`), where a key
 * the desired side lacks is never sent as a removal (go-to-k/cdkd#4147).
 *
 * There the desired side is the recorded baseline and the previous side the
 * live readback, so such a key is one AWS reports and the baseline does not
 * hold. With an observed baseline that means AWS was not returning the key at
 * capture (an attribute rolled out later, or `ddos_protection.syn_cookie.mode`,
 * which AWS returns intermittently), so cdkd has no recorded value to restore.
 * No Elastic Load Balancing call removes an attribute key. (Without an
 * observed baseline, `runRevert` merges the untemplated keys into the desired
 * side, so none arrives here.)
 *
 * The key keeps its live value, and a warning names it and the remedy, since
 * `cdkd drift` keeps reporting a key only the readback holds: it cannot tell
 * a service-side addition from a value an operator set.
 */
export function diffAttributeBag(
  this: ELBv2Provider,
  bag: 'LoadBalancerAttributes' | 'TargetGroupAttributes' | 'ListenerAttributes',
  logicalId: string,
  desired: unknown,
  previous: unknown,
  removalValue: (key: string, currentValue: string) => string | undefined,
  fromReadback: boolean,
  maskSecrets: SecretMasker | undefined
): Array<{ Key: string; Value: string }> {
  const leftInPlace: string[] = [];
  const submitted = this.diffAttributes(
    this.normalizeAttributes(desired),
    this.normalizeAttributes(previous),
    fromReadback
      ? (key) => {
          leftInPlace.push(key);
          return undefined;
        }
      : removalValue
  );
  if (leftInPlace.length > 0) {
    // A KEY comes out of the resolved bag, so it is masked as the raw value
    // (not the finished sentence, so it reaches `maskSecretsInText`'s
    // whole-value arm at any length), then made display-safe.
    const mask = maskerOrIdentity(maskSecrets);
    const keys = leftInPlace.map((key) => mask(key)).join(', ');
    const one = leftInPlace.length === 1;
    const noun = one ? 'key' : 'keys';
    const values = one ? 'its live value' : 'their live values';
    const them = one ? 'it' : 'them';
    const be = one ? 'is' : 'are';
    const theValue = one ? 'the value' : 'the values';
    this.logger.warn(
      safeMsg`${logicalId}: AWS reports ${bag} ${noun} ${keys}, which the recorded baseline holds no value for. No Elastic Load Balancing call removes an attribute key, so the revert leaves ${values} in place, and 'cdkd drift' keeps reporting ${them}. If ${values} ${be} what you intend, run 'cdkd drift --accept' to record ${them}; otherwise declare ${theValue} in the template and deploy.`
    );
  }
  return submitted;
}

/**
 * Read both sides of a TargetGroup update's `Targets` (go-to-k/cdkd#3989),
 * mapped to the SDK shape against the SAME group port.
 *
 * A malformed DESIRED side is refused before any call, on every path (a
 * rollback replay and `drift --revert` included): read as empty it would
 * deregister every target the record holds.
 *
 * A malformed RECORDED side is read from the live group instead
 * (`DescribeTargetHealth`), ADD-only: the old side becomes the desired
 * targets the group already holds, so nothing is deregistered on the strength
 * of a record cdkd could not read, and a registered target the desired side
 * omits stays registered, with a warning. `cdkd import` can record an
 * unresolved intrinsic there, which a refusal would wedge forever. A
 * draining target counts as not held, so a desired one is registered again.
 */
export async function readUpdateTargets(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  desiredRaw: unknown,
  recordedRaw: unknown,
  groupPort: unknown
): Promise<{ newTargets: TargetDescription[]; oldTargets: TargetDescription[] }> {
  const desired = readTargets(desiredRaw, 'desired');
  if (desired.kind === 'malformed') {
    throw markNonRetryable(
      new ProvisioningError(
        `desired Targets of TargetGroup ${logicalId} is not a list of ${TARGETS_WHAT}` +
          `${targetsSecretCause(desired)} — the target group was not updated`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  const newTargets = toTargetDescriptions(desired.items, groupPort);

  const recorded = readTargets(recordedRaw, 'recorded');
  if (recorded.kind === 'list') {
    return {
      newTargets,
      oldTargets: toTargetDescriptions(removableRecordedTargets(recorded.items), groupPort),
    };
  }

  let live: TargetDescription[];
  try {
    const resp = await this.getClient().send(
      new DescribeTargetHealthCommand({ TargetGroupArn: physicalId })
    );
    live = (resp.TargetHealthDescriptions ?? [])
      .filter((d) => d.TargetHealth?.State !== 'draining')
      .map((d) => d.Target)
      .filter((t): t is TargetDescription => typeof t?.Id === 'string' && t.Id.length > 0);
  } catch (error) {
    // Not marked non-retryable: a throttled read is worth the retry, which
    // classifies through `cause`.
    throw new ProvisioningError(
      `the recorded Targets of TargetGroup ${logicalId} is not a list cdkd can read, and the ` +
        `registered targets could not be read from Elastic Load Balancing instead — the ` +
        `target group was not updated`,
      resourceType,
      logicalId,
      physicalId,
      error instanceof Error ? error : undefined
    );
  }
  // A desired entry naming no AvailabilityZone matches a live one in any zone.
  const holds = (want: TargetDescription, have: TargetDescription): boolean =>
    want.Id === have.Id &&
    (want.Port ?? null) === (have.Port ?? null) &&
    (want.AvailabilityZone === undefined || want.AvailabilityZone === have.AvailabilityZone) &&
    (want.QuicServerId === undefined || want.QuicServerId === have.QuicServerId);
  // A desired entry that names ANOTHER server id for a live Id / Port replaces it.
  const replaces = (want: TargetDescription, have: TargetDescription): boolean =>
    want.QuicServerId !== undefined &&
    have.QuicServerId !== undefined &&
    want.Id === have.Id &&
    (want.Port ?? null) === (have.Port ?? null) &&
    (want.AvailabilityZone === undefined || want.AvailabilityZone === have.AvailabilityZone);
  const retained = live.filter(
    (have) => !newTargets.some((want) => holds(want, have) || replaces(want, have))
  );
  if (retained.length > 0) {
    this.logger.warn(
      safeMsg`The recorded Targets of TargetGroup ${logicalId} is not a list cdkd can read, so cdkd read the registered targets from Elastic Load Balancing; the target group holds ${retained.length} target(s) the desired Targets does not name, and cdkd left them registered. Deregister them yourself if they are no longer wanted.`
    );
  }
  // A live target with the desired Id / Port but ANOTHER server id is what the
  // desired entry changes: carry the live tuple as the old side so the diff
  // deregisters it before registering the new one (AWS refuses the register
  // while the old server id is held).
  const oldTargets: TargetDescription[] = [];
  for (const want of newTargets) {
    if (live.some((have) => holds(want, have))) {
      oldTargets.push(want);
      continue;
    }
    const changed = live.find((have) => replaces(want, have));
    if (changed !== undefined) {
      oldTargets.push({
        Id: changed.Id,
        ...(changed.Port !== undefined && { Port: changed.Port }),
        ...(want.AvailabilityZone !== undefined && { AvailabilityZone: want.AvailabilityZone }),
        QuicServerId: changed.QuicServerId,
      });
    }
  }
  return { newTargets, oldTargets };
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via ELBv2's
 * `AddTags` / `RemoveTags` APIs. Both accept `ResourceArns: [arn]`
 * (single ARN), `Tags: [{Key, Value}]` for AddTags, and
 * `TagKeys: [...]` for RemoveTags. Both sides are read through
 * `planTagDiff` (go-to-k/cdkd#3994): an unreadable record untags nothing.
 */
export async function applyTagDiff(
  this: ELBv2Provider,
  arn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  // A load balancer ARN carries its `Name`, which can be secret-derived
  // (go-to-k/cdkd#4275); absent means unmasked.
  maskSecrets?: SecretMasker
): Promise<void> {
  const mask = maskerOrIdentity(maskSecrets);
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const tagsToAdd: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  const tagsToRemove = plan.remove;

  if (tagsToRemove.length > 0) {
    await this.getClient().send(
      new RemoveTagsCommand({ ResourceArns: [arn], TagKeys: tagsToRemove })
    );
    this.logger.debug(mask(`Removed ${tagsToRemove.length} tag(s) from ELBv2 resource ${arn}`));
  }
  if (tagsToAdd.length > 0) {
    await this.getClient().send(new AddTagsCommand({ ResourceArns: [arn], Tags: tagsToAdd }));
    this.logger.debug(mask(`Added/updated ${tagsToAdd.length} tag(s) on ELBv2 resource ${arn}`));
  }
}

/**
 * Convert CDK DefaultActions to ELBv2 API Action format
 * CDK uses PascalCase property names matching the ELBv2 API, so pass through.
 */
export function convertActions(
  this: ELBv2Provider,
  actions: Array<Record<string, unknown>> | undefined
): Action[] | undefined {
  if (!actions || actions.length === 0) return undefined;
  return actions as unknown as Action[];
}

/**
 * Convert CDK Certificates to ELBv2 API Certificate format
 */
export function convertCertificates(
  this: ELBv2Provider,
  certificates: Array<Record<string, unknown>> | undefined
): Certificate[] | undefined {
  if (!certificates || certificates.length === 0) return undefined;
  return certificates as unknown as Certificate[];
}
