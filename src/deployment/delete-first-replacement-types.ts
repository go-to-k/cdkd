/**
 * go-to-k/cdkd#6958: the types a property-driven replacement deletes FIRST,
 * on a plain `cdkd deploy`, as CloudFormation does.
 *
 * Each one links two resources AWS lets hold only one such link at a time, so
 * the new copy is refused (`Resource.AlreadyAssociated`) while the old one
 * exists:
 *
 * - `AWS::EC2::VPCGatewayAttachment`: one internet gateway per VPC and one
 *   VPC per gateway (a VPN gateway attaches to one VPC at a time).
 * - `AWS::EC2::SubnetRouteTableAssociation`: one route table association per
 *   subnet.
 *
 * CloudFormation's events for both read "Requested update requires the
 * replacement of the existing resource; deleting existing resource, then
 * creating a new one." `AWS::EC2::SubnetNetworkAclAssociation` takes the same
 * CloudFormation path but is NOT listed: its create replaces the subnet's
 * current association, so cdkd's create-first order already succeeds there.
 *
 * Neither type holds anything beyond its recorded properties, so a failed
 * deploy's rollback re-creates the old link whole. A LEAF: the deploy engine
 * and the plan note (`analyzer/destructive-changes.ts`) both read it.
 */
const DELETE_FIRST_REPLACEMENT_TYPES: ReadonlySet<string> = new Set([
  'AWS::EC2::VPCGatewayAttachment',
  'AWS::EC2::SubnetRouteTableAssociation',
]);

/**
 * Whether a property-driven replacement from `oldType` to `newType` deletes
 * the old resource before it creates the new one. Only within one type: a
 * `Type` change creates a different kind of resource, which the old one does
 * not block.
 */
export function replacesDeleteFirst(oldType: string, newType: string): boolean {
  return oldType === newType && DELETE_FIRST_REPLACEMENT_TYPES.has(newType);
}
