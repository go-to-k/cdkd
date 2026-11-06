import { isAwsAuthoredFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { isTruthyCfnBoolean } from '../../data-delete-intent.js';
import { isPlainImportValue, VALUE_NOT_SHOWN } from '../../import-helpers.js';
import { COMPOSITE_ID_SEPARATOR } from '../../composite-id.js';

/**
 * True when Route 53 refused a zone mutation because the zone's
 * AcceleratedRecoveryStatus is mid-transition — the
 * "HostedZone <id> is marked disabled for mutation" rejection (issue #1467).
 * Exported for the delete-path retry in this provider and for tests; the
 * same substring is also in `RETRYABLE_ERROR_MESSAGE_PATTERNS` so the
 * generic retry net covers the create/update paths.
 */
export function isZoneDisabledForMutationError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('is marked disabled for mutation');
}

/**
 * Whether a HostedZone's properties enable accelerated recovery. The
 * CloudFormation member is `HostedZoneFeatures.EnableAcceleratedRecovery`
 * (boolean, the schema's only member); `AcceleratedRecoveryStatus` is the
 * GetHostedZone read-side status, not a template property (issue #5465).
 *
 * `acceptReadSideKey` also reads that status, for two sides that can carry
 * it: a `drift --revert` desired side (a drift baseline recorded before #5465
 * holds the readback under it) and an update's previous side (state recorded
 * from a template that used it as an override, which the pre-#5465 provider
 * enabled). Never a deploy's desired side: it is not a template property.
 */
export function declaresAcceleratedRecovery(
  properties: Record<string, unknown>,
  acceptReadSideKey = false
): boolean {
  const features = properties['HostedZoneFeatures'] as Record<string, unknown> | undefined;
  if (isTruthyCfnBoolean(features?.['EnableAcceleratedRecovery'])) return true;
  const legacyStatus = features?.['AcceleratedRecoveryStatus'];
  return (
    acceptReadSideKey &&
    features?.['EnableAcceleratedRecovery'] === undefined &&
    typeof legacyStatus === 'string' &&
    ACCELERATED_RECOVERY_ON_STATUSES.has(legacyStatus)
  );
}

/**
 * The `AcceleratedRecoveryStatus` values `readCurrentState` reports as
 * `EnableAcceleratedRecovery: true`: settled on, on its way there, or a
 * DISABLE that failed (the feature is still on). Every other status
 * (DISABLED, a disabling phase, a failed enable) reads `false`.
 */
export const ACCELERATED_RECOVERY_ON_STATUSES: ReadonlySet<string> = new Set([
  'ENABLED',
  'ENABLING',
  'ENABLING_HOSTED_ZONE_LOCKED',
  'DISABLE_FAILED',
]);

/**
 * A `HostedZoneName` that resolved cleanly but matches no zone.
 *
 * Distinct from "no zone was specified": the DELETE path treats a vanished
 * zone as already-gone (the zone's records went with it) rather than surfacing
 * a misconfiguration error that would block `cdkd destroy`.
 */
export class HostedZoneNameNotFoundError extends ProvisioningError {
  constructor(
    message: string,
    resourceType: string,
    logicalId: string,
    physicalId?: string,
    cause?: Error
  ) {
    super(message, resourceType, logicalId, physicalId, cause);
    this.name = 'HostedZoneNameNotFoundError';
    // REQUIRED: `CdkdError`'s constructor chain ends with
    // `Object.setPrototypeOf(this, ProvisioningError.prototype)`, which erases
    // the subclass identity — without re-setting it here, `instanceof
    // HostedZoneNameNotFoundError` is FALSE for an instance of this class and
    // the delete path's skip-as-gone arm silently never fires.
    Object.setPrototypeOf(this, HostedZoneNameNotFoundError.prototype);
  }
}

/**
 * Parse cdkd's composite record-set physicalId `<hostedZoneId>|<Name>|<Type>`.
 *
 * The record NAME may itself contain `|` (issue #3890): Route 53's domain-name
 * format admits it, and CloudFormation manages such a record. The hosted zone
 * id (AWS-minted) and the type (an enum) never do, so the name is everything
 * between the FIRST and the LAST separator. A three-part id is read exactly as
 * before; a longer one is only a CANDIDATE, flagged `nameCarriesSeparator`,
 * and every caller must anchor it on the recorded `Name` and `Type`
 * (`compositeAgreesWithTemplate`) before trusting it.
 *
 * Returns `undefined` for anything with fewer than three non-empty parts. The
 * anchor is what tells the composite apart from CloudFormation's OWN
 * physicalId for this type, the record name alone (`Ref` on an
 * `AWS::Route53::RecordSet` returns the domain name): `cdkd import` stored
 * that scalar verbatim before issue #1658, so state files in the wild carry
 * BOTH shapes, and the scalar can contain `|` too.
 */
export function parseRecordSetCompositeId(physicalId: string):
  | {
      hostedZoneId: string;
      name: string;
      type: string;
      nameCarriesSeparator: boolean;
    }
  | undefined {
  const firstPipe = physicalId.indexOf(COMPOSITE_ID_SEPARATOR);
  const lastPipe = physicalId.lastIndexOf(COMPOSITE_ID_SEPARATOR);
  if (firstPipe < 0 || lastPipe === firstPipe) return undefined;
  const hostedZoneId = physicalId.slice(0, firstPipe);
  const name = physicalId.slice(firstPipe + 1, lastPipe);
  const type = physicalId.slice(lastPipe + 1);
  if (!hostedZoneId || !name || !type) return undefined;
  return {
    hostedZoneId,
    name,
    type,
    nameCarriesSeparator: name.includes(COMPOSITE_ID_SEPARATOR),
  };
}

/** The one spelling of the `<hostedZoneId>|<Name>|<Type>` join. */
export function recordSetCompositeId(hostedZoneId: unknown, name: unknown, type: unknown): string {
  return [hostedZoneId, name, type].map(String).join(COMPOSITE_ID_SEPARATOR);
}

/**
 * Octal escapes that must NOT be decoded, because decoding them is not
 * injective — two genuinely different names would compare EQUAL:
 *
 * - `056` is a period INSIDE a label. Route 53 reports the single-label
 *   record `a.b` (period escaped) as `a\\056b.example.com.`, which decodes to
 *   `a.b.example.com.` — identical to the different, two-label record
 *   `a.b.example.com`.
 * - `134` is a literal backslash, which would re-introduce escape ambiguity.
 *
 * A false MATCH is far worse than a false miss here: the compare drives which
 * record `readCurrentState` reports and which hosted zone `create` picks, so
 * collapsing two records would target the wrong one.
 */
export const UNDECODABLE_OCTAL_ESCAPES = new Set(['056', '134']);

/**
 * Canonicalize a record name for comparison.
 *
 * Two AWS-side spellings have to be absorbed, and missing either one makes
 * `readCurrentState` return `undefined` — which reads as "drift unknown"
 * rather than as an error:
 *
 * - Route 53 reports every name fully qualified with a TRAILING DOT, while a
 *   template may declare it either way.
 * - Special characters come back OCTAL-ESCAPED: `*.example.com` is reported as
 *   `\\052.example.com.`. That affects every wildcard record, including ones
 *   cdkd created itself, so decoding it here fixes drift for the whole
 *   population rather than only the imported ones.
 *
 * Known bound: Route 53 escapes per BYTE, so a non-ASCII name decodes to
 * latin-1 mojibake and will not match its template spelling. That is a false
 * MISS (drift unknown), never a false match, and CDK emits punycode for
 * internationalized names in practice.
 */
export function normalizeRecordName(name: string): string {
  // `\\ddd` -> the character it encodes. Strictly octal digits, and never the
  // structure-significant escapes above.
  const decoded = name.replace(/\\([0-7]{3})/g, (match, oct: string) =>
    UNDECODABLE_OCTAL_ESCAPES.has(oct) ? match : String.fromCharCode(parseInt(oct, 8))
  );
  // DNS is case-insensitive and AWS lowercases what it returns, so compare
  // lowercased. Without this a template spelling `Example.com` fails to match
  // the zone AWS reports as `example.com.` — which, on the delete path, now
  // resolves to "zone is gone" and would DROP the state row while leaving the
  // record live in AWS.
  const lowered = decoded.toLowerCase();
  return lowered.endsWith('.') ? lowered : `${lowered}.`;
}

/**
 * Is this value ONLY an unresolved intrinsic — `{Ref: …}` / `{Fn::If: […]}` —
 * rather than a real object with members?
 *
 * `import.ts` runs two pre-passes before calling a provider:
 * `resolvePseudoParameterIntrinsics` evaluates a `Ref` / `Fn::Join` /
 * `Fn::Sub` built only from literals and the `AWS::AccountId` /
 * `AWS::Region` / `AWS::Partition` / `AWS::URLSuffix` pseudo-parameters, and
 * `substituteOverrideRefs` replaces a `{Ref}` to an overridden resource.
 * Neither removes an `Fn::If` wrapper (`substituteOverrideRefs` only rewrites
 * an overridden `{Ref}` inside its arms), so an element behind a condition
 * still reaches `import()` in this shape.
 */
export function isIntrinsicOnly(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || (keys[0] ?? '').startsWith('Fn::'));
}

/**
 * Read a hosted zone's PUBLIC-vs-PRIVATE visibility off its own template
 * properties (issue #1702), for the `import()` name lookup's zone filter.
 *
 * CloudFormation has no `PrivateZone` property — visibility is implied by
 * `VPCs`: a zone associated with at least one VPC is private, one with none is
 * public. So:
 *
 * - `VPCs` ABSENT -> `false` (public). This is the CDK `PublicHostedZone`
 *   shape and by far the common one.
 * - an array carrying at least one element that is NOT purely an unresolved
 *   intrinsic -> `true` (private). Such an element proves the template
 *   attaches a VPC unconditionally, even when the `VPCId` inside it is itself
 *   a `Ref` this provider cannot resolve.
 * - anything else -> `undefined` (do not narrow), and the caller's ambiguity
 *   guard then refuses rather than adopting the wrong zone. Three shapes land
 *   here and each would otherwise be a GUESS: a non-array (an unresolved
 *   intrinsic is a truthy OBJECT); an EMPTY array (more likely a
 *   condition-collapsed value than a deliberate "public"); and — the one that
 *   is easy to miss — an array whose every element is intrinsic-only
 *   (`[{Ref: 'AWS::NoValue'}]`, the CFn spelling of a conditionally-absent
 *   element), which is non-empty yet may resolve to a PUBLIC zone.
 */
export function templateZoneVisibility(properties: Record<string, unknown>): boolean | undefined {
  const vpcs = properties['VPCs'];
  if (vpcs == null) return false;
  if (!Array.isArray(vpcs)) return undefined;
  const attachesAVpc = vpcs.some(
    (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && !isIntrinsicOnly(v)
  );
  return attachesAVpc ? true : undefined;
}

/**
 * Issue #1160: a `VPCs` REMOVED whole from the template, or emptied to `[]`,
 * is not applied. CloudFormation does the same (CFn A/B us-east-1
 * 2026-10-20: a private zone with one VPC and one with two, each updated to
 * drop `VPCs`, kept every association, and the two-VPC zone updated again to
 * `VPCs: []` kept both; no update failed). Route 53 also cannot make a private
 * zone public, and refuses to disassociate its last VPC, so no reset exists.
 * {@link Route53Provider.syncVPCAssociations} returns early on either shape,
 * and `updateHostedZone` names the kept associations in one warning.
 */
export const VPCS_KEPT_ON_REMOVAL_NOTE =
  'A private hosted zone stays private and keeps at least one VPC; to change its associations, declare the VPCs you want and deploy.';

/** True when a desired `VPCs` value declares no VPC: absent, null or `[]`. */
export function declaresNoVpcs(vpcs: unknown): boolean {
  return vpcs == null || (Array.isArray(vpcs) && vpcs.length === 0);
}

/** The `VPCId`s a `VPCs` value names; a malformed value or entry names none. */
export function declaredVpcIds(vpcs: unknown): unknown[] {
  if (!Array.isArray(vpcs)) return [];
  return vpcs.map((vpc) => (vpc as Record<string, unknown> | null)?.['VPCId']);
}

/** `text` closed as a sentence, for a wrap that continues after it. */
export function sentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

/**
 * Route 53's refusal to CREATE a CNAME beside another record of the same DNS
 * name. Measured (us-east-1, 2026-09-26, `InvalidChangeBatch`):
 *
 *   [RRSet of type CNAME with DNS name y.<zone>. is not permitted as it
 *   conflicts with other records with the same DNS name in zone <zone>.]
 *
 * The mirror case (any other type beside a live CNAME) and a duplicate record
 * already say "already exists", which `isNameCollisionError` reads; this one
 * does not. So a rollback reversing a CNAME -> A rename (#3741) re-created the
 * CNAME, collided with the live A of the same name, and the delete-new-first
 * arm never ran. Keyed on the message because `InvalidChangeBatch` also
 * carries every non-collision batch refusal.
 */
export function isCnameConflictRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'InvalidChangeBatch' &&
    isAwsAuthoredFailure(error) &&
    // The WHOLE message, names as non-space tokens (Route 53 escapes a space
    // as `\040`): an unanchored match also fired on a refusal ECHOING a
    // template value that quotes this sentence (an unquoted TXT value), and
    // the verdict drives a delete-first.
    /^\[?RRSet of type CNAME with DNS name \S+ is not permitted as it conflicts with other records with the same DNS name in zone \S+\]?$/.test(
      error.message
    )
  );
}

/**
 * Placed after the logical id of a create failure `isCnameConflictRefusal`
 * recognises, ahead of the failure text so it reads cleanly after the
 * redacted class sentence (go-to-k/cdkd#2319). The
 * collision classifier reads the `markNameCollision` marker the same site
 * sets (#3816), but this text is still what `isRecreateRetryableError` sees
 * on the delete-then-re-create retry — removing it stops that retry.
 */
export const CNAME_CONFLICT_COLLISION_NOTE =
  ' (a record with the same DNS name already exists in the hosted zone)';

/**
 * Whether `desired` names a DIFFERENT Route 53 record from `previous` (issue
 * #3741): Route 53 identifies a record by name, type and SetIdentifier, so a
 * change to any of them is a rename the provider must carry out as a
 * DELETE + CREATE rather than an UPSERT, which would leave the old record live.
 *
 * Names compare the way Route 53 does (trailing dot, letter case and `\\ddd`
 * escapes do not make a different name). Answers `false` — the pre-#3741
 * UPSERT — whenever the recorded side cannot be compared: a missing or
 * non-string `Name` / `Type`, or a redacted dynamic reference
 * (`redactSecretsForState` writes `{{resolve:...}}` where the desired side holds
 * the plaintext), since deleting from an identity cdkd cannot read is a guess.
 */
export function recordIdentityChanged(
  previous: Record<string, unknown>,
  desired: Record<string, unknown>
): boolean {
  const comparable = (value: unknown): value is string =>
    typeof value === 'string' && value !== '' && !value.includes('{{resolve:');
  const prevName = previous['Name'];
  const prevType = previous['Type'];
  const name = desired['Name'];
  const type = desired['Type'];
  if (!comparable(prevName) || !comparable(prevType)) return false;
  if (!comparable(name) || !comparable(type)) return false;
  if (normalizeRecordName(prevName) !== normalizeRecordName(name)) return true;
  if (prevType !== type) return true;
  const prevSetIdentifier = previous['SetIdentifier'];
  const setIdentifier = desired['SetIdentifier'];
  if (prevSetIdentifier === setIdentifier) return false;
  // Absent on one side only is a change (a simple record becoming a weighted
  // one, or back).
  // Present on both, or on one side only, it must be readable to compare.
  if (prevSetIdentifier === undefined) return comparable(setIdentifier);
  if (setIdentifier === undefined) return comparable(prevSetIdentifier);
  return comparable(prevSetIdentifier) && comparable(setIdentifier);
}

/**
 * A template's `HostedZoneName` as the refusals ending in a `--resource`
 * remedy print it: inside cdkd's `"..."` when plain, described otherwise
 * (go-to-k/cdkd#4226). A shell expands `$( )` inside double quotes, so a name
 * carrying one ran when the refusal was pasted. A Route 53 octal escape
 * (`\052.example.com`) is still shown: it is the spelling that reaches the
 * inconclusive-listing refusal, and a backslash before a digit is literal
 * inside double quotes in both bash and zsh.
 */
export function zoneNameShown(name: string): string {
  return isPlainImportValue(name.replace(/\\[0-7]{3}/g, 'x')) ? `"${name}"` : VALUE_NOT_SHOWN;
}
