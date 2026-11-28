/**
 * The fifth rule of `preFixBaselineUncomparedDriftKeys` (go-to-k/cdkd#7132):
 * members whose deploy-time baseline was read while AWS still answered a
 * transitional value. Each predicate answers whether the LIVE member is the
 * declared one, spelled the way the provider's read spells it; the caller then
 * leaves the key uncompared, so a stale baseline is not reported.
 */
import { coerceCfnBoolean } from '../../../provisioning/config-shape.js';

type Bag = Record<string, unknown>;

const isBag = (value: unknown): value is Bag =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A scalar spelled as the read spells it (`HttpPutResponseHopLimit` may resolve as `"2"`). */
const scalarText = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;

/**
 * `AWS::EC2::Instance` `Monitoring`: the read emits a boolean (`enabled` /
 * `pending` → true). The declared value is read with `coerceCfnBoolean`; an
 * undeclared `Monitoring` never heals.
 */
export function instanceMonitoringIsDeclared(properties: Bag, aws: Bag): boolean {
  const declared = coerceCfnBoolean(properties['Monitoring']);
  return declared !== undefined && aws['Monitoring'] === declared;
}

/**
 * `AWS::EC2::Instance` `IamInstanceProfile`: the read emits the profile ARN,
 * while the template may name the profile (a CDK `Ref`) or give its ARN.
 * Healed on an exact match, or on a declared plain name equal to the last path
 * segment of a live `:instance-profile/` ARN. A declared value that is neither
 * (a path-qualified name) keeps the key compared.
 */
export function instanceProfileIsDeclared(properties: Bag, aws: Bag): boolean {
  const declared = properties['IamInstanceProfile'];
  const live = aws['IamInstanceProfile'];
  if (typeof declared !== 'string' || declared === '' || typeof live !== 'string') return false;
  if (live === declared) return true;
  // A declared ARN or path-qualified name never equals a single path segment.
  return (
    live.startsWith('arn:') &&
    live.includes(':instance-profile/') &&
    live.slice(live.lastIndexOf('/') + 1) === declared
  );
}

/**
 * `AWS::EC2::Instance` `MetadataOptions`: every declared member is the live
 * one, and every member the template leaves out reads as the baseline
 * recorded it. An out-of-band change to an undeclared member (a hop limit the
 * template does not set) therefore keeps the whole key compared.
 */
export function instanceMetadataOptionsIsDeclared(
  properties: Bag,
  aws: Bag,
  observed: Bag
): boolean {
  const declared = properties['MetadataOptions'];
  const live = aws['MetadataOptions'];
  const recorded = observed['MetadataOptions'];
  if (!isBag(declared) || !isBag(live) || !isBag(recorded)) return false;
  const declaredKeys = Object.keys(declared);
  if (declaredKeys.length === 0) return false;
  for (const key of declaredKeys) {
    const want = scalarText(declared[key]);
    if (want === undefined || scalarText(live[key]) !== want) return false;
  }
  for (const key of new Set([...Object.keys(live), ...Object.keys(recorded)])) {
    if (declaredKeys.includes(key)) continue;
    if (scalarText(live[key]) !== scalarText(recorded[key])) return false;
  }
  return true;
}

/**
 * `AWS::EFS::FileSystem` `BackupPolicy`: the read emits `{ Status }` verbatim,
 * so a baseline taken right after `PutBackupPolicy` holds `ENABLING` /
 * `DISABLING`. Healed while the live `Status` is the declared one; an
 * undeclared `BackupPolicy` never heals.
 */
export function efsBackupPolicyIsDeclared(properties: Bag, aws: Bag): boolean {
  const declared = properties['BackupPolicy'];
  const live = aws['BackupPolicy'];
  if (!isBag(declared) || !isBag(live)) return false;
  const status = declared['Status'];
  return typeof status === 'string' && status !== '' && live['Status'] === status;
}
