import type { ResourceChange } from '../../types/state.js';
import type { ReplacementSiblings } from '../replacement-rules.js';
import { isIntrinsicShaped } from '../../provisioning/create-only-properties.js';
import { SECRET_MASK } from '../../deployment/secret-redaction.js';
import { maskDeep, type MaskerFn } from '../../provisioning/masked-retry-logger.js';

/**
 * A type's CFn-schema create-only keys as the promotion passes read them
 * (go-to-k/cdkd#3803): every WHOLE-property key, and those that raise no
 * ceiling from a value that may be a fresh `NoEcho` one — the write-only keys,
 * or `'all'` when the write-only list is unknown.
 */
export interface SyntheticCreateOnly {
  readonly whole: ReadonlySet<string>;
  readonly unconfirmable: ReadonlySet<string> | 'all';
}

/**
 * Best-effort resolver for intrinsic functions during diff calculation.
 * Should return the resolved value on success, or the original value if resolution fails.
 * Kept as a callback to avoid circular dependency between analyzer and deployment layers.
 */
export type IntrinsicResolveFn = (value: unknown) => Promise<unknown>;

/**
 * The CloudFormation intrinsic function keys, as a single shared set.
 *
 * Exported so `outputs-diff.ts` detects a surviving intrinsic with exactly the
 * same key list this calculator uses — a second hand-maintained copy is how the
 * two drift into disagreeing about what "unresolved" means.
 */
export const INTRINSIC_KEYS: ReadonlySet<string> = new Set([
  'Ref',
  'Fn::Sub',
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::ImportValue',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
]);

/**
 * Per-type normalization applied to BOTH comparison sides (issue #1591).
 *
 * A provider that deliberately sends LESS than the template declares records
 * the narrowed bag in state (`effectiveProperties`). Without the identical
 * narrowing here the template's extra keys read as a user-made change on every
 * later deploy — and for a create-only property that is a REPLACEMENT, so a
 * previously-green no-op deploy starts destroying and re-creating the resource,
 * or failing outright where the provider refuses the shape on the create path.
 *
 * BOTH sides, not just the desired one: a record written BEFORE the provider
 * started narrowing still carries every key, so a desired-only normalization
 * flips the same difference to a REMOVAL and breaks exactly the population the
 * narrowing exists for. State can only carry the wider bag when it is junk, so
 * normalizing it is safe and the next write self-heals the record.
 * `drift-normalize.ts` records the same both-sides rule for ordering.
 *
 * MUST be pure and synchronous — it runs inside the diff, before any AWS call.
 */
export type CanonicalizePropertiesFn = (
  resourceType: string,
  properties: Record<string, unknown>
) => Record<string, unknown>;

/**
 * Per-type set of computed/derived read-only attributes whose value can change
 * as a side effect of an IN-PLACE update, even though the attribute NAME never
 * appears among the type's template properties (issue #985).
 *
 * The default in-place propagation arm matches a dependent only when the GetAtt
 * attribute NAME equals a template property that CHANGED on the upstream (e.g.
 * an SSM Parameter `Value`). That arm cannot see version-style attributes: an
 * `AWS::EC2::LaunchTemplate` edit changes `LaunchTemplateData`, which bumps the
 * read-only `LatestVersionNumber` from N to N+1 — but `LatestVersionNumber` is
 * NOT a template property, so a dependent reading `Fn::GetAtt[Lt,
 * LatestVersionNumber]` (the canonical `autoscaling.AutoScalingGroup`
 * `LaunchTemplate.Version` shape) is left NO_CHANGE and stays pinned one deploy
 * behind. These attributes resolve LIVE from AWS at deploy time (see the
 * `DescribeLaunchTemplates` special case in intrinsic-resolver/getatt.ts), so
 * a speculative promotion is safe: the deploy engine re-resolves the dependent
 * against the fresh live value and skips the provider call if it did not move.
 *
 * Keyed by upstream resource type -> the derived attribute names that any
 * in-place UPDATE of that type may move. Kept intentionally narrow (an allow
 * list, not "every read-only attr") so unrelated computed attributes that do
 * NOT track in-place edits (e.g. a Lambda `Arn`) never trigger spurious
 * dependent promotion.
 */
export const IN_PLACE_UPDATE_DERIVED_ATTRS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    'AWS::EC2::LaunchTemplate': new Set(['LatestVersionNumber', 'DefaultVersionNumber']),
    // Issue #5446: an InstanceType / UserData update stops and starts the
    // instance, which gives an instance without an Elastic IP a new public
    // address and DNS name (its private address and DNS name stay). The update
    // records the new pair, so a reader re-resolves against it.
    // go-to-k/cdkd#5630: a PrivateDnsNameOptions.HostnameType change moves the
    // private DNS name in place (`ip-10-0-0-1...` <-> `i-0123...`, measured).
    'AWS::EC2::Instance': new Set(['PublicIp', 'PublicDnsName', 'PrivateDnsName']),
    // go-to-k/cdkd#6962: every UpdateAgentRuntime mints a new runtime version,
    // and cdkd's update sends it for every change, a tag-only one included (a
    // full replace, Tags synced after it). A reader of `AgentRuntimeVersion`
    // (CDK `addEndpoint()`) moves to it, as CloudFormation moves the endpoint;
    // if a tag-only update minted none, the re-resolve-and-skip drops the
    // promotion. The update records the version UpdateAgentRuntime answers.
    'AWS::BedrockAgentCore::Runtime': new Set(['AgentRuntimeVersion']),
  });

/**
 * go-to-k/cdkd#6913: derived attributes an in-place UPDATE moves only when one
 * of the NAMED properties changes. Kept out of
 * {@link IN_PLACE_UPDATE_DERIVED_ATTRS}, which promotes on ANY in-place edit:
 * `export-change-guard.ts` reads both, so a CDK cross-stack `db.secret` export
 * would be refused on every unrelated cluster update while a consumer imports
 * it. Keyed by upstream type -> attribute -> the top-level property names.
 */
export const IN_PLACE_UPDATE_ATTRS_MOVED_BY: Readonly<
  Record<string, Readonly<Record<string, ReadonlySet<string>>>>
> = Object.freeze({
  // Turning the managed password off and on again mints a new master secret;
  // a storage change moves a Multi-AZ cluster's throughput. The update
  // records the described values.
  'AWS::RDS::DBCluster': Object.freeze({
    'MasterUserSecret.SecretArn': new Set(['ManageMasterUserPassword']),
    StorageThroughput: new Set(['StorageType', 'Iops', 'AllocatedStorage']),
  }),
  'AWS::RDS::DBInstance': Object.freeze({
    'MasterUserSecret.SecretArn': new Set(['ManageMasterUserPassword']),
  }),
  // go-to-k/cdkd#6939: a subnet added or removed gains or loses an interface
  // and its zonal DNS name; private DNS, DNS options and the IP address type
  // add or drop DNS names. The update records the described values, or, after
  // a --no-wait modify, none, so a reader reads the endpoint live.
  'AWS::EC2::VPCEndpoint': Object.freeze({
    NetworkInterfaceIds: new Set(['SubnetIds']),
    DnsEntries: new Set(['SubnetIds', 'PrivateDnsEnabled', 'DnsOptions', 'IpAddressType']),
  }),
  // go-to-k/cdkd#6999: a stream view type change (or a stream turned off and
  // on) disables the old stream and mints a new ARN, so an event source mapping
  // reading `StreamArn` must follow it; its `EventSourceArn` is create-only, so
  // the mapping is replaced, as CloudFormation does.
  'AWS::DynamoDB::Table': Object.freeze({
    StreamArn: new Set(['StreamSpecification']),
  }),
  'AWS::DynamoDB::GlobalTable': Object.freeze({
    StreamArn: new Set(['StreamSpecification']),
  }),
});

/**
 * Whether `attr` of an in-place-updated `type` moves with one of `changed`
 * (top-level property names), per {@link IN_PLACE_UPDATE_ATTRS_MOVED_BY}.
 * `Object.hasOwn` on both levels: type and attribute are template text.
 */
export function attributeMovedByChangedProperty(
  type: string,
  attr: string,
  changed: ReadonlySet<string>
): boolean {
  if (!Object.hasOwn(IN_PLACE_UPDATE_ATTRS_MOVED_BY, type)) return false;
  const byAttr = IN_PLACE_UPDATE_ATTRS_MOVED_BY[type]!;
  if (!Object.hasOwn(byAttr, attr)) return false;
  return [...byAttr[attr]!].some((prop) => changed.has(prop));
}

/**
 * The PREFIX twin of {@link IN_PLACE_UPDATE_DERIVED_ATTRS}, for a type whose
 * derived attributes are an open family rather than a fixed list (issue
 * [#3631](https://github.com/go-to-k/cdkd/issues/3631)).
 *
 * A nested stack's `Outputs.<Key>` attributes are the child's outputs, and a
 * child-only change moves them while the parent's `AWS::CloudFormation::Stack`
 * row changes only `TemplateURL` / `Parameters`. The parent's diff runs BEFORE
 * the child deploys, so a reader of `Fn::GetAtt [Child, 'Outputs.<Key>']`
 * resolves against the PREVIOUS value and diffs NO_CHANGE. Which outputs move
 * is decided by the child's own deploy, so it is not knowable here: every
 * reader is promoted, and the deploy engine's re-resolve-and-skip drops the
 * ones whose output did not move.
 */
export const IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    'AWS::CloudFormation::Stack': Object.freeze(['Outputs.']),
  });

/**
 * The attribute name `DiffCalculator.extractGetAttRefs` records for a
 * `Ref` read (go-to-k/cdkd#3717 / #3722). Not a name any attribute can have, so
 * the property-name, derived-attribute and prefix arms of the in-place pass
 * never match it; only the custom-resource arm (whose physical id the handler
 * may change) and the fresh-parameter arm (a parameter carrying a `NoEcho`
 * value supplied in this deploy) read it.
 */
export const REF_READ = '<Ref>';

/**
 * Does `value` hold an intrinsic (`Ref` / `Fn::*`, a single-key object) at any
 * depth? The shape `create-only-properties.ts` treats as unresolved.
 */
export function containsIntrinsic(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && isIntrinsicShaped(value)) return true;
  return Object.values(value).some((child) => containsIntrinsic(child, seen));
}

/**
 * One side of the replacement debug line, masked BEFORE it is stringified
 * (go-to-k/cdkd#4049): `JSON.stringify` escapes `"`, `\` and newlines, so a
 * needle carrying one no longer occurs in the finished line. `maskDeep` masks
 * every string leaf and key; the replacer masks a number or boolean leaf
 * whose printed form is a needle, the spelling `recordNoEchoParameterValue`
 * records for a `Number` parameter.
 */
function maskedJsonForLog(value: unknown, mask: MaskerFn): string {
  // `?? 'undefined'`: `JSON.stringify(undefined)` is `undefined`, which
  // `safeMsg` renders as nothing, so an added or removed property would print
  // an empty side.
  return (
    JSON.stringify(maskDeep(value, mask), (_key, leaf: unknown) =>
      (typeof leaf === 'number' || typeof leaf === 'boolean') && mask(String(leaf)) !== String(leaf)
        ? SECRET_MASK
        : leaf
    ) ?? 'undefined'
  );
}

/**
 * Both sides of the replacement debug line (go-to-k/cdkd#4049).
 *
 * The OLD side is read from state, which persists a `NoEcho` value in the
 * clear, and only the CURRENT value is a needle (the deploy's masker holds
 * every `NoEcho` parameter's current value from the start, so this does not
 * depend on which resource the diff reaches first): a rotated value's
 * previous plaintext masks nothing. So when the new side carries a needle, the old side
 * is withheld whole — the old value of the property now served by a secret is
 * taken to have been served by it too. Over-masking a debug line is the safe
 * direction; a property that stops being served by one still prints its old
 * value.
 */
export function replacementSidesForLog(
  oldValue: unknown,
  newValue: unknown,
  mask: MaskerFn
): [string, string] {
  const newText = maskedJsonForLog(newValue, mask);
  // Against the SAME walk unmasked, so a shape the walk itself reshapes is
  // never read as a needle.
  if (newText !== maskedJsonForLog(newValue, (text) => text)) return [SECRET_MASK, newText];
  return [maskedJsonForLog(oldValue, mask), newText];
}

/**
 * The `NoEcho` half of the comparison (go-to-k/cdkd#4043), injected so the
 * analyzer layer holds no redaction rule of its own: given a resource's
 * template bag, its resolved desired bag and its recorded bag (both after the
 * calculator's own narrowing), return the two bags the property comparison
 * reads. The deploy and `cdkd diff` mask the desired side where a `NoEcho`
 * source served a leaf, exactly as the persist side writes it, and read a
 * pre-v11 record's plaintext there as the migration witness.
 */
export type NoEchoCompareFn = (input: {
  logicalId: string;
  resourceType: string;
  templateProperties: Record<string, unknown>;
  desired: Record<string, unknown>;
  current: Record<string, unknown>;
}) => { desired: Record<string, unknown>; current: Record<string, unknown> } | undefined;

/**
 * The sibling bags a synthetic (propagated) change hands a conditional
 * replacement predicate (issue #5446: an instance's `SecurityGroupIds`
 * replaces only without a `SubnetId`).
 */
export function siblingsOf(change: {
  currentProperties?: Record<string, unknown> | undefined;
  desiredProperties?: Record<string, unknown> | undefined;
}): ReplacementSiblings | undefined {
  // Without the bags a predicate answers its non-destructive default.
  if (change.currentProperties === undefined || change.desiredProperties === undefined) {
    return undefined;
  }
  return { oldProperties: change.currentProperties, newProperties: change.desiredProperties };
}

/**
 * Marks the row the diff computed ON ITS OWN for `path` as resolved against a
 * resource this deploy replaces or updates (go-to-k/cdkd#6078), and records
 * the template value the renderers print instead of its stale `newValue`.
 * Display-only: nothing on the deploy path reads either field. A row a
 * promotion pass created (propagated, `NoEcho`-promoted, read-provenance) or
 * one shown as `***` on both sides already says the value is not final, so
 * it is left as it is.
 */
export function markNewValueKnownAfterDeploy(change: ResourceChange, path: string): void {
  for (const pc of change.propertyChanges ?? []) {
    if (
      pc.path !== path ||
      pc.replacementPropagated === true ||
      pc.inPlacePropagated === true ||
      pc.noEchoPromoted === true ||
      pc.readProvenancePromoted === true ||
      pc.maskedExpressionChanged === true
    ) {
      continue;
    }
    pc.newValueKnownAfterDeploy = true;
    pc.newValueTemplate = change.desiredProperties?.[path];
  }
}
