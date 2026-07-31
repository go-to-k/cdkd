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
}

const CC_PROTECTION_PROPERTIES: Record<string, CcProtectionEntry> = {
  // Verified via tests/integration/dsql (issue #1312).
  'AWS::DSQL::Cluster': { property: 'DeletionProtectionEnabled', offValue: false },
  // Verified via tests/integration/cc-protection-flip (issue #1314).
  'AWS::NeptuneGraph::Graph': { property: 'DeletionProtection', offValue: false },
  'AWS::SMSVOICE::ProtectConfiguration': {
    property: 'DeletionProtectionEnabled',
    offValue: false,
  },
  'AWS::VerifiedPermissions::PolicyStore': {
    property: 'DeletionProtection',
    offValue: { Mode: 'DISABLED' },
  },
  // Verified via tests/integration/cc-protection-flip (RDS / DocDB global
  // cluster shells) and tests/integration/cc-protection-flip-eks (issue #1315).
  'AWS::EKS::Cluster': { property: 'DeletionProtection', offValue: false },
  'AWS::RDS::GlobalCluster': { property: 'DeletionProtection', offValue: false },
  'AWS::DocDB::GlobalCluster': { property: 'DeletionProtection', offValue: false },
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
