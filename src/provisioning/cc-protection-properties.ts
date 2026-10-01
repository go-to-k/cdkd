/**
 * Deletion-protection properties for Cloud-Control-routed resource types.
 *
 * Cloud Control's DeleteResource has no notion of deletion protection: a
 * protected resource simply fails to delete. For types WITH an SDK provider,
 * `--remove-protection` is implemented inside each provider's `delete()`
 * (RDS / DynamoDB / Cognito / etc.), and two special cases are hardcoded in
 * `CloudControlProvider.delete` (ASG delegation, EC2 `DisableApiTermination`).
 * This registry covers the remaining case: a CC-routed type whose protection
 * is an ordinary top-level template property that can be set to its "off"
 * value in-place via a CC UpdateResource patch right before DeleteResource.
 *
 * Only add entries verified against real AWS (the property name must match
 * the type's CFn schema exactly, must NOT be createOnly, and the type's
 * UPDATE handler must support flipping it in-place). Remaining candidates
 * are tracked in issue #1320: SMSVOICE PhoneNumber/Pool are registrable via
 * SIMULATOR numbers; SenderId (per-country regulatory registration) and
 * AppConfig `DeletionProtectionCheck` (whose `BYPASS` off-value touches
 * account-global state, so no safe integ) stay excluded, as recorded there.
 * `AWS::QLDB::Ledger` is permanently excluded (Tier 3 non-provisionable in
 * cdkd; the QLDB service is sunset).
 */
import type { ProtectionGuardSite } from './providers/deletion-protection-compensation.js';
import { pasteableAwsCommand, type PasteableAwsCommand } from './replacement-protection-advice.js';
import { isWaitAbandonedError } from './wait-abandoned.js';

export interface CcProtectionEntry {
  /** Top-level CFn property carrying the protection setting. */
  property: string;
  /**
   * The value that disables protection, sent as a JSON-patch `add` op
   * (RFC 6902: replaces when the path exists, adds when absent — so the
   * flip is idempotent regardless of whether the live model carries the
   * property).
   */
  offValue: unknown;
  /**
   * The value that ENABLES protection (issue #2204). The pre-flip read records
   * a flip only when the live model holds exactly this value, and the
   * compensation of a terminally failed delete patches it back. A new entry
   * also needs a literal restore spelling in {@link ccProtectionSite}, or its
   * restore command is withheld.
   */
  onValue: unknown;
}

const CC_PROTECTION_PROPERTIES: Record<string, CcProtectionEntry> = {
  // Verified via tests/integration/dsql (issue #1312).
  'AWS::DSQL::Cluster': {
    property: 'DeletionProtectionEnabled',
    offValue: false,
    onValue: true,
  },
  // Verified via tests/integration/cc-protection-flip (issue #1314).
  'AWS::NeptuneGraph::Graph': { property: 'DeletionProtection', offValue: false, onValue: true },
  'AWS::SMSVOICE::ProtectConfiguration': {
    property: 'DeletionProtectionEnabled',
    offValue: false,
    onValue: true,
  },
  'AWS::VerifiedPermissions::PolicyStore': {
    property: 'DeletionProtection',
    offValue: { Mode: 'DISABLED' },
    onValue: { Mode: 'ENABLED' },
  },
  // Verified via tests/integration/cc-protection-flip (RDS / DocDB global
  // cluster shells) and tests/integration/cc-protection-flip-eks (issue #1315).
  'AWS::EKS::Cluster': { property: 'DeletionProtection', offValue: false, onValue: true },
  'AWS::RDS::GlobalCluster': { property: 'DeletionProtection', offValue: false, onValue: true },
  'AWS::DocDB::GlobalCluster': { property: 'DeletionProtection', offValue: false, onValue: true },
};

/**
 * Returns the protection entry for a CC-routed resource type, or undefined
 * when the type has no registered protection property.
 */
export function ccProtectionProperty(resourceType: string): CcProtectionEntry | undefined {
  return CC_PROTECTION_PROPERTIES[resourceType];
}

/**
 * Every resource type registered in the CC protection registry. Consumed by
 * the cross-site consistency test that keeps this registry, the destroy
 * confirm-prompt count map, the `--remove-protection` help strings, and the
 * docs tables from drifting apart.
 */
export function ccProtectionRegistryTypes(): string[] {
  return Object.keys(CC_PROTECTION_PROPERTIES);
}

/**
 * The `--patch-document` argument of the restore command, as a LITERAL span.
 *
 * The pasteable-command gate refuses a JSON document as a value (its quotes
 * and brackets are not inert), and the document is cdkd's own, from the
 * closed set of entries above, so each shape is spelled out here rather than
 * rendered. An entry with no spelling here gets a withheld command, never an
 * approximate one.
 */
function restorePatchArg(
  aws: ReturnType<typeof pasteableAwsCommand>,
  entry: CcProtectionEntry
): PasteableAwsCommand {
  const on = JSON.stringify(entry.onValue);
  if (entry.property === 'DeletionProtection' && on === 'true') {
    return aws` --patch-document '[{"op":"add","path":"/DeletionProtection","value":true}]'`;
  }
  if (entry.property === 'DeletionProtectionEnabled' && on === 'true') {
    return aws` --patch-document '[{"op":"add","path":"/DeletionProtectionEnabled","value":true}]'`;
  }
  if (entry.property === 'DeletionProtection' && on === '{"Mode":"ENABLED"}') {
    return aws` --patch-document '[{"op":"add","path":"/DeletionProtection","value":{"Mode":"ENABLED"}}]'`;
  }
  // An empty value is refused by the gate, which withholds the whole command.
  return aws`${''}`;
}

/**
 * The {@link ProtectionGuardSite} for a CC protection registry type (issue
 * #2204). The commands go through Cloud Control too, so one shape serves
 * every entry.
 *
 * The not-found arm covers both of Cloud Control's spellings: the synchronous
 * `ResourceNotFoundException` and a handler-reported `ErrorCode: NotFound` on
 * the re-enable's wait (`CloudControlOperationFailedError.ccErrorCode`, read
 * by name so this module does not import the provider).
 */
export function ccProtectionSite(
  resourceType: string,
  physicalId: string,
  entry: CcProtectionEntry,
  region: string | undefined
): ProtectionGuardSite {
  return {
    subject: resourceType,
    guardName: entry.property,
    noun: 'resource',
    isNotFound: (error) => {
      if (typeof error !== 'object' || error === null) return false;
      const e = error as { name?: unknown; ccErrorCode?: unknown };
      // An abandoned re-enable wait is cdkd not knowing, never a NotFound
      // answer: it takes the loud arm, which names the restore command.
      return (
        !isWaitAbandonedError(error) &&
        (e.name === 'ResourceNotFoundException' || e.ccErrorCode === 'NotFound')
      );
    },
    notFoundMeaning:
      'Cloud Control answered NotFound. That most commonly means the resource is gone, and it ' +
      'can also mean it is not in this region or account.',
    commands: () => {
      const aws = pasteableAwsCommand();
      const regionArg = region ? aws` --region ${region}` : aws``;
      const restore = aws`aws cloudcontrol update-resource --type-name ${resourceType} --identifier ${physicalId}${regionArg}${restorePatchArg(aws, entry)}`;
      return {
        check:
          aws`aws cloudcontrol get-resource --type-name ${resourceType} --identifier ${physicalId}${regionArg}`.render(),
        restoreAfterNotFound: restore.render(),
        restoreLive: restore.render(),
      };
    },
  };
}
