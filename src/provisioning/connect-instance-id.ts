/**
 * The instance id inside a Connect instance ARN
 * (`arn:<partition>:connect:<region>:<account>:instance/<id>`). The physical
 * id of an `AWS::Connect::Instance` is the ARN, as Cloud Control's (the
 * schema's primary identifier); the instance APIs are addressed by the id. A
 * value that is not an instance ARN is returned unchanged.
 *
 * A leaf module, so the `Fn::GetAtt` resolver can read it without importing
 * the provider (and its SDK client) onto every command's startup path.
 */
export function connectInstanceIdOf(physicalId: string): string {
  const marker = ':instance/';
  const at = physicalId.indexOf(marker);
  if (!physicalId.startsWith('arn:') || at < 0) return physicalId;
  return physicalId.slice(at + marker.length).split('/')[0] ?? physicalId;
}
