import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import { displayAwsMessage } from '../../../utils/display-safe.js';
import { getLogger } from '../../../utils/logger.js';
import { canonicalizeIpv4Cidr } from '../../../utils/ipv4-cidr.js';
import { recordValueOrNotShown, showRecordValue } from './render.js';
import { type CompositeIdSplitter } from './composite-id-splitters.js';

/**
 * The prefix every EC2 Elastic IP allocation id carries. Used to discriminate
 * the two segments of an `AWS::EC2::EIP` physicalId by SHAPE rather than by
 * position — see the splitter for why the order is not relied on.
 */
export const EIP_ALLOCATION_ID_PREFIX = 'eipalloc-';

/**
 * The other half of the same discriminator: an Elastic IP's public address is
 * always a dotted quad (EIPs are IPv4-only). Shape-only — the octet RANGES are
 * not checked, because this exists to tell the two segments apart, not to
 * validate an address AWS itself minted.
 */
export const EIP_PUBLIC_IP_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * The prefix every `AWS::EC2::VPCCidrBlock` association id carries. The same
 * kind of shape discriminator as {@link EIP_ALLOCATION_ID_PREFIX}: a VPC id and
 * an association id BOTH start with `vpc-`, so the longer prefix is what tells
 * the two segments apart.
 */
export const VPC_CIDR_ASSOCIATION_ID_PREFIX = 'vpc-cidr-assoc-';

/**
 * The other half of that discriminator. ANCHORED, so an association id
 * (`vpc-cidr-assoc-…`, which also begins `vpc-`) does NOT match — a reversed
 * pair is exactly what this exists to catch.
 *
 * The character class is `[0-9a-z]` rather than hex, and the LENGTH is not
 * pinned. EC2 ids are hex today, but `cdkd export` is all-or-nothing, so a
 * false REFUSAL here blocks an entire export — and the discrimination does not
 * depend on the alphabet at all: it is the `-` in `cidr-assoc`, which no
 * character class here admits. Widening the class therefore costs nothing and
 * removes a false-refusal vector.
 */
export const VPC_ID_PATTERN = /^vpc-[0-9a-z]+$/;

const GATEWAY_ATTACHMENT_TYPE_IGW = 'IGW';
const GATEWAY_ATTACHMENT_TYPE_VGW = 'VGW';

/**
 * The values AWS actually uses for `AWS::EC2::VPCGatewayAttachment`'s
 * `AttachmentType`, plus the two spellings issue #1691 guessed.
 *
 * `IGW` / `VGW` are what every real writer produces: Cloud Control stores the
 * primaryIdentifier verbatim, so a CC-written cdkd state record carries one of
 * them as segment 0. `InternetGateway` / `VPN` were never written by anything —
 * they were produced by THIS table on the way OUT, and CloudFormation rejects
 * them (`Invalid request provided: Invalid Attachment Type 'InternetGateway'`;
 * the IMPORT changeset never reaches CREATE_COMPLETE). They are kept purely as
 * input compatibility, so a physicalId hand-written from the old comment, or
 * supplied via `cdkd import --resource`, normalizes instead of falling through
 * to the property-derivation arms. Nothing in cdkd can put them in state.
 *
 * `Object.hasOwn` at the lookup site, not a bare index: a bare index on an
 * object literal answers for inherited members too, so a first segment of
 * `constructor` would resolve to a function rather than missing.
 */
const GATEWAY_ATTACHMENT_TYPE_ALIASES: Record<string, string> = {
  [GATEWAY_ATTACHMENT_TYPE_IGW]: GATEWAY_ATTACHMENT_TYPE_IGW,
  [GATEWAY_ATTACHMENT_TYPE_VGW]: GATEWAY_ATTACHMENT_TYPE_VGW,
  InternetGateway: GATEWAY_ATTACHMENT_TYPE_IGW,
  VPN: GATEWAY_ATTACHMENT_TYPE_VGW,
};

/**
 * Resolve `AttachmentType` for an `AWS::EC2::VPCGatewayAttachment` from the
 * first segment of cdkd's composite physicalId plus the recorded properties.
 *
 * The Cloud-Control-written shape already carries the attachment type verbatim
 * (it is the CFn primaryIdentifier's first field). The SDK-written shape
 * carries the gateway id instead, so the type is derived from WHICH gateway
 * property cdkd recorded — never hardcoded to the internet-gateway value, which
 * would ship a wrong identifier for a VPN attachment and make CFn's
 * identifier-match reject the import.
 *
 * The VALUES are `IGW` / `VGW`, measured live (Cloud Control `ListResources`,
 * us-east-1, 2026-08-13) against a VPC carrying both an internet-gateway and a
 * virtual-private-gateway attachment:
 *
 *   `IGW|vpc-…` -> {"AttachmentType":"IGW","VpcId":"vpc-…"}
 *   `VGW|vpc-…` -> {"AttachmentType":"VGW","VpcId":"vpc-…"}
 *
 * The registry schema does not enumerate them (`AttachmentType` is a bare
 * `{"type": "string"}` whose description only says it distinguishes the two
 * kinds), which is how the spelled-out `InternetGateway` / `VPN` guesses this
 * function shipped with in issue #1691 went unnoticed: they are plausible, they
 * satisfy every unit test written against them, and CFn only rejects them at
 * changeset-create time — measured 2026-08-13 as `Invalid request provided:
 * Invalid Attachment Type 'InternetGateway'` (issue #1771).
 */
export function resolveGatewayAttachmentType(
  firstSegment: string,
  properties: Record<string, unknown>
): string {
  if (Object.hasOwn(GATEWAY_ATTACHMENT_TYPE_ALIASES, firstSegment)) {
    return GATEWAY_ATTACHMENT_TYPE_ALIASES[firstSegment]!;
  }
  if (typeof properties['InternetGatewayId'] === 'string' && properties['InternetGatewayId']) {
    return GATEWAY_ATTACHMENT_TYPE_IGW;
  }
  if (typeof properties['VpnGatewayId'] === 'string' && properties['VpnGatewayId']) {
    return GATEWAY_ATTACHMENT_TYPE_VGW;
  }
  // Last resort: the gateway id itself names the kind (`igw-…` / `vgw-…`).
  if (firstSegment.startsWith('igw-')) {
    return GATEWAY_ATTACHMENT_TYPE_IGW;
  }
  if (firstSegment.startsWith('vgw-')) {
    return GATEWAY_ATTACHMENT_TYPE_VGW;
  }
  throw new Error(
    `cannot determine AttachmentType for AWS::EC2::VPCGatewayAttachment: cdkd state's ` +
      `properties carry neither 'InternetGatewayId' nor 'VpnGatewayId', and the physical id ` +
      `segment ${showRecordValue(firstSegment)} is not a recognized gateway id. State entry may be corrupt ` +
      `or written by an older cdkd binary; re-deploy the resource to refresh state.`
  );
}

/**
 * The `AWS::EC2::Route` destination keys, in CloudFormation's own precedence
 * order — the same order (and the same list) `narrowRouteDestinations` in
 * `src/provisioning/providers/ec2-provider.ts` resolves them in when it decides
 * which one `createRoute` actually sends, i.e. which one ends up in the
 * physicalId's destination segment. Restated here rather than imported so this
 * command does not pull the EC2 provider (and its SDK client) into the export
 * module graph.
 */
const ROUTE_DESTINATION_KEYS = [
  'DestinationCidrBlock',
  'DestinationIpv6CidrBlock',
  'DestinationPrefixListId',
] as const;

/**
 * Resolve the value CFn's read-only `AWS::EC2::Route.CidrBlock` identifier
 * field holds, from cdkd's physicalId destination segment plus the recorded
 * properties.
 *
 * The segment is the starting point — it is the destination cdkd sent to
 * `CreateRoute` (SDK path) or the `CidrBlock` AWS itself reported (Cloud Control
 * path), and `CidrBlock` holds whichever destination kind the route declares,
 * measured live; see the splitter's comment. But it is NOT returned verbatim:
 * EC2 clears host bits on the way in, so the SDK path can have stored a
 * destination AWS never held, and the identifier is always the CANONICAL form.
 *
 * The recorded properties are then read to CROSS-CHECK it, the way
 * {@link resolveGatewayAttachmentType} reads them to recover a field cdkd never
 * stores. Two very different things can make them disagree, and conflating them
 * is why this is not a plain warn:
 *
 *  - **Benign.** One side carries AWS's CANONICALIZED CIDR and the other what
 *    the user wrote; CFn documents rewriting e.g. `100.68.0.18/18` to
 *    `100.68.0.0/18`. The identifier is CORRECT here, so refusing would block an
 *    export that would have succeeded. Both sides are compared in canonical
 *    form, so this case never even registers as a divergence.
 *  - **Dangerous.** If state is merely stale, the id's destination can name a
 *    DIFFERENT route that still exists in the same table. IMPORT then succeeds
 *    against the wrong resource, and phase 2's UPDATE reconciles it to the
 *    template — REPLACING, i.e. DELETING, a route the user never targeted.
 *    Silently continuing here trades an opaque failure for data loss.
 *
 * So the outcome depends on whether the benign explanation is DECIDABLE, which
 * {@link routeDestinationNormalizationIsModelled} answers per declared value.
 * When every declared destination is a shape cdkd models — an IPv4 CIDR or a
 * prefix-list id — normalization either explains the difference or it does not,
 * and a non-match is refused. When any declared destination is an IPv6 CIDR,
 * whose AWS-side canonicalization cdkd does not reproduce, the divergence is
 * reported as a WARNING naming the replace-the-wrong-route outcome, because
 * refusing on an undecidable signal would block exports that are fine.
 *
 * Properties that declare NO destination at all are NOT treated as suspicious:
 * a partial / hand-edited state record must not become a refusal, and the id
 * alone is enough to build the identifier.
 */
/** Exported for unit testing. */
export function resolveRouteDestination(
  segment: string,
  properties: Record<string, unknown>
): string {
  // CANONICALIZE FIRST, before any comparison or early return. `createRoute`
  // packs the destination it SENT into the physicalId, and EC2 rewrites host
  // bits on the way in (`100.68.0.18/18` -> `100.68.0.0/18`), so an SDK-written
  // state entry can hold a destination AWS never stored. Its recorded
  // properties hold that same non-canonical value, so the agreement check below
  // passes — and shipping the segment verbatim would hand CloudFormation an
  // identifier it cannot resolve, which is the exact opaque rejection this
  // function exists to prevent. Non-IPv4 shapes (IPv6 CIDR, `pl-…`) are
  // returned untouched: cdkd does not model their canonicalization.
  const identifier = canonicalizeIpv4Cidr(segment) ?? segment;

  const declared = ROUTE_DESTINATION_KEYS.filter(
    (key) => typeof properties[key] === 'string' && properties[key] !== ''
  );
  if (declared.length === 0) return identifier;

  const declaredValues = declared.map((key) => String(properties[key]));
  // Compare CANONICAL forms on both sides, so a host-bit difference between
  // what the template declares and what the id carries is recognized as the
  // same destination regardless of which side is the non-canonical one.
  if (declaredValues.some((value) => (canonicalizeIpv4Cidr(value) ?? value) === identifier)) {
    return identifier;
  }

  const recorded = declared
    .map((key) => `${key}=${recordValueOrNotShown(properties[key])}`)
    .join(', ');
  const shared =
    `AWS::EC2::Route: cdkd state's recorded properties declare ${recorded}, but the physical ` +
    `id's destination segment is ${recordValueOrNotShown(segment)}. CloudFormation identifies the route by the ` +
    `destination, so IMPORT would adopt whatever route currently sits at ${recordValueOrNotShown(identifier)} — and ` +
    `if that is a DIFFERENT route than the template declares, phase 2 would then REPLACE ` +
    `(delete) it. The state entry is stale; re-deploy the resource to refresh it`;

  // Decidable when every declared destination is a shape whose AWS-side
  // normalization cdkd models: an IPv4 CIDR (canonicalized above) or a
  // prefix-list id (measured to be stored VERBATIM on both sides — Cloud
  // Control `GetResource`, us-east-1, 2026-08-13, reports
  // `CidrBlock: 'pl-63a5400a'` for a `DestinationPrefixListId` route). For
  // those, failing to explain the gap is conclusive: the id names a different
  // route, and continuing would import it and let phase 2 delete it.
  if (declaredValues.every((value) => routeDestinationNormalizationIsModelled(value))) {
    throw new Error(`${shared}.`);
  }

  // Bounded as a whole: each value is capped, but up to five of them share
  // this one line (a throw of the same text is bounded by `groupBlockedReasons`).
  getLogger().warn(
    displayAwsMessage(
      `${shared}, or pass the resource through ${proseQuoted(cdkdRemedy('cdkd import', '--resource'))} with the correct id. ` +
        `Continuing with the physical id because at least one recorded destination is an IPv6 ` +
        `CIDR, whose AWS-side canonicalization cdkd does not model — so the difference may be ` +
        `benign.`
    )
  );
  return identifier;
}

/**
 * An EC2 managed prefix list id (`pl-` + hex). Matched EXACTLY rather than by
 * prefix so a malformed value falls into the unmodelled class instead of being
 * treated as a comparable destination.
 */
const ROUTE_PREFIX_LIST_ID_PATTERN = /^pl-[0-9a-f]+$/;

/**
 * True when cdkd models how AWS normalizes this destination value, i.e. when a
 * mismatch against the physical id's segment is CONCLUSIVE rather than possibly
 * explained by a rewrite cdkd cannot reproduce.
 *
 * Two classes qualify:
 *   - an IPv4 CIDR, whose host-bit rewrite {@link canonicalizeIpv4Cidr} reproduces;
 *   - a prefix-list id, measured to be stored verbatim on both sides, so a
 *     `pl-AAA` vs `pl-BBB` difference is a genuine wrong-route signal.
 *
 * An IPv6 CIDR does not: AWS canonicalizes those too (zero-run compression,
 * host-bit clearing) and cdkd does not reproduce it, so a mismatch there could
 * still be the same route written two ways.
 */
function routeDestinationNormalizationIsModelled(value: string): boolean {
  return canonicalizeIpv4Cidr(value) !== undefined || ROUTE_PREFIX_LIST_ID_PATTERN.test(value);
}

/**
 * Build a splitter for an `AWS::ApiGateway::*` child type whose CFn primary
 * identifier is the parent `RestApiId` plus one child field.
 *
 * Two stored shapes are accepted, because both exist in state in the wild:
 * the SDK providers store the BARE child value and read the parent from the
 * recorded properties, while a type routed through Cloud Control by the #614
 * SDK-unwired rule stores CC's `|`-joined composite — in CFn
 * primaryIdentifier order, which is why `childFirstInCompositeId` exists
 * (`AWS::ApiGateway::Deployment` declares `[DeploymentId, RestApiId]`, every
 * other member of the family declares `RestApiId` first).
 *
 * `narrowOverlayToRestApiId` is set for the types whose child field is
 * `readOnlyProperties` — writing one into the synth template's `Properties`
 * is rejected by CFn at changeset-create.
 */
export function restApiChildSplitter(options: {
  resourceType: string;
  childField: string;
  childFirstInCompositeId: boolean;
  narrowOverlayToRestApiId: boolean;
}): CompositeIdSplitter {
  const { resourceType, childField, childFirstInCompositeId, narrowOverlayToRestApiId } = options;
  const compositeShape = childFirstInCompositeId
    ? `<${childField}>|<restApiId>`
    : `<restApiId>|<${childField}>`;

  return (physicalId, properties) => {
    // `.trim()`, not truthiness: a blank id is as unusable as an empty one and
    // would otherwise ship a whitespace identifier into the changeset.
    if (!physicalId.trim()) {
      throw new Error(`empty physical id for ${resourceType} (expected a ${childField})`);
    }
    const parts = physicalId.split('|');
    if (parts.length > 2) {
      throw new Error(
        `expected a bare ${childField} or '${compositeShape}', got ${parts.length} parts: ` +
          `${showRecordValue(physicalId)}`
      );
    }

    let restApiId: string;
    let childValue: string;
    if (parts.length === 2) {
      const [a, b] = parts as [string, string];
      if (!a || !b) {
        throw new Error(`empty part in '${compositeShape}': ${showRecordValue(physicalId)}`);
      }
      [restApiId, childValue] = childFirstInCompositeId ? [b, a] : [a, b];
    } else {
      restApiId = readStringProperty(properties, 'RestApiId', resourceType);
      childValue = physicalId;
    }

    const resourceIdentifier = { RestApiId: restApiId, [childField]: childValue };
    return narrowOverlayToRestApiId
      ? { resourceIdentifier, propertiesOverlay: { RestApiId: restApiId } }
      : { resourceIdentifier };
  };
}

export function readStringProperty(
  properties: Record<string, unknown>,
  key: string,
  resourceType: string
): string {
  const v = properties[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(
      `cdkd state's properties for ${resourceType} is missing '${key}' (the parent identifier ` +
        `required to build the CFn ResourceIdentifier map). State entry may be corrupt or written ` +
        `by an older cdkd binary; re-deploy the resource to refresh state.`
    );
  }
  return v;
}
