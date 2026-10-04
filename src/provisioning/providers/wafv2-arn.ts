import type { Scope } from '@aws-sdk/client-wafv2';

// A leaf, imported by the intrinsic resolver as well as the provider: keeping
// it out of wafv2-provider.ts keeps that module (and its SDK client) off every
// command's startup path (issue #4521).

/**
 * Parse WAFv2 WebACL ARN to extract Id, Name, and Scope.
 *
 * ARN format:
 *   arn:aws:wafv2:{region}:{account}:regional/webacl/{name}/{id}
 *   arn:aws:wafv2:{region}:{account}:global/webacl/{name}/{id}
 *
 * A short / malformed ARN yields `undefined` for `name` / `id` (the path
 * segments simply are not there) — callers must guard. `scope` is always
 * defined (anything not `global` maps to `REGIONAL`).
 */
export function parseWebACLArn(arn: string): {
  id: string | undefined;
  name: string | undefined;
  scope: Scope;
} {
  // Example: arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123
  const parts = arn.split(':');
  // parts[5] = "regional/webacl/my-acl/abc-123" or "global/webacl/my-acl/abc-123"
  const resourcePart = parts.slice(5).join(':');
  const segments = resourcePart.split('/');
  // segments: ["regional", "webacl", "my-acl", "abc-123"]
  const scopeRaw = segments[0]; // "regional" or "global"
  const name = segments[2];
  const id = segments[3];

  const scope: Scope = scopeRaw === 'global' ? 'CLOUDFRONT' : 'REGIONAL';

  return { id, name, scope };
}
