import { WRITABLE_GETATT_ATTRIBUTES } from '../provisioning/getatt-attributes.generated.js';
import { getPropertyCoverage } from '../provisioning/property-coverage.js';
import { isRecordedIdentityAttribute } from './recorded-identity-attributes.js';

/**
 * go-to-k/cdkd#6655: whether `attributeName` is the identity id cdkd records
 * for `resourceType` (`SURVIVOR_IDENTITY_ATTRIBUTES`) AND CloudFormation does
 * not expose it to `Fn::GetAtt` (`AWS::DynamoDB::Table`'s `TableId`), so a
 * template reading it is one CloudFormation rejects.
 *
 * "Exposed" is the type's committed schema: its read-only properties (the CFn
 * schema fixture) union the writable ones the resource specification also
 * lists ({@link WRITABLE_GETATT_ATTRIBUTES}). Offline on purpose: the live
 * `getTopLevelAttributeNames` would add a `DescribeType` call. A type with no
 * committed schema answers `false` (cannot tell, so no refusal). Identity keys
 * only: the committed lists are short of the resource specification's for a
 * few types, so they can certify an identity key as unexposed but not refuse
 * an arbitrary attribute.
 *
 * Read by the `Fn::GetAtt` resolver (`refuseUnexposedRecordedIdentity`) and
 * `cdkd orphan`'s attribute fetcher.
 */
export function isUnexposedRecordedIdentity(resourceType: string, attributeName: string): boolean {
  if (!isRecordedIdentityAttribute(resourceType, attributeName)) return false;
  const coverage = getPropertyCoverage(resourceType);
  if (coverage === undefined) return false;
  if (coverage.readOnly.has(attributeName)) return false;
  return !(
    Object.hasOwn(WRITABLE_GETATT_ATTRIBUTES, resourceType) &&
    WRITABLE_GETATT_ATTRIBUTES[resourceType]!.includes(attributeName)
  );
}
