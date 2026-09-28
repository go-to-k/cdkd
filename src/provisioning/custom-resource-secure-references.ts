import { dynamicReferenceTokens } from '../deployment/secret-redaction.js';

/**
 * CloudFormation parity for SECURE dynamic references in a custom resource's
 * properties (go-to-k/cdkd#3976).
 *
 * CloudFormation's rule: "Dynamic references can't be used for secure values
 * (like those stored in Parameter Store or Secrets Manager) in custom
 * resources" (User Guide, dynamic references, general considerations). cdkd
 * used to resolve such a reference and send the PLAINTEXT to the handler (a
 * third party's Lambda may log its whole event), and to persist the reference
 * expression where the delete path later read it (#3960). The template path
 * now refuses it pre-flight, before anything is resolved.
 *
 * Only the SECURE services are refused: a plain `{{resolve:ssm:...}}` is
 * supported by CloudFormation in custom resources and stays accepted.
 *
 * Two spellings reach here. A secret named by a literal renders as one whole
 * token in one string. A secret created in the SAME stack -- the commonest CDK
 * shape, `secret.secretValueFromJson('password')` -- renders SPLIT around its
 * `Ref`: `{"Fn::Join": ["", ["{{resolve:secretsmanager:", {"Ref": "Secret"},
 * ":SecretString:password::}}"]]}`, and an `Fn::Sub` spelling puts a `${...}`
 * inside the token. Neither holds a complete token in any one string, so
 * inside an intrinsic the secure OPENER alone is enough.
 *
 * Pre-flight only sees the TEMPLATE, so a rollback replay of a state record
 * never reaches it (`.claude/rules/provider-replay-and-refusals.md`).
 */

/** The resource types CloudFormation treats as custom resources. */
export function isCustomResourceType(resourceType: string): boolean {
  return (
    resourceType === 'AWS::CloudFormation::CustomResource' || resourceType.startsWith('Custom::')
  );
}

/** The dynamic-reference services CloudFormation calls secure. */
const SECURE_REFERENCE_SERVICES: ReadonlySet<string> = new Set(['secretsmanager', 'ssm-secure']);

/**
 * A secure reference's OPENER, or one whose service is itself a `${...}`
 * substitution (it can only be decided after resolution, so it is refused).
 * Matched only inside an intrinsic, where the token may be completed by a
 * sibling part or a substitution.
 */
const SECURE_REFERENCE_OPENERS: readonly string[] = [
  '{{resolve:secretsmanager:',
  '{{resolve:ssm-secure:',
  '{{resolve:${',
];

function referenceService(token: string): string {
  return token.slice('{{resolve:'.length).split(':')[0] ?? '';
}

/**
 * The property paths (`Password`, `Config.Credentials[0]`) of `properties`
 * whose string leaf holds a SECURE dynamic reference, in walk order. Empty for
 * any type that is not a custom resource.
 */
export function findSecureReferencePaths(
  resourceType: string,
  properties: Record<string, unknown> | undefined
): string[] {
  if (!isCustomResourceType(resourceType) || properties == null) return [];
  const paths: string[] = [];
  // Objects on the CURRENT walk path, so only a cycle is cut, never an object
  // reached twice through two properties.
  const onPath = new Set<object>();
  // Inside an intrinsic the path stops growing: the offending PROPERTY is what
  // the user edits, not the position of a part within `Fn::Join`.
  const walk = (node: unknown, path: string, inIntrinsic: boolean): void => {
    if (typeof node === 'string') {
      const tokens = dynamicReferenceTokens(node);
      if (
        tokens.some((t) => SECURE_REFERENCE_SERVICES.has(referenceService(t))) ||
        (inIntrinsic && SECURE_REFERENCE_OPENERS.some((opener) => node.includes(opener)))
      ) {
        paths.push(path === '' ? '(Properties)' : path);
      }
      return;
    }
    if (node === null || typeof node !== 'object' || onPath.has(node)) return;
    onPath.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, inIntrinsic ? path : `${path}[${i}]`, inIntrinsic));
    } else {
      for (const [key, child] of Object.entries(node)) {
        if (key.startsWith('Fn::') || key === 'Ref') {
          walk(child, path, true);
        } else {
          walk(child, inIntrinsic ? path : path ? `${path}.${key}` : key, inIntrinsic);
        }
      }
    }
    onPath.delete(node);
  };
  walk(properties, '', false);
  return [...new Set(paths)];
}

/** One line of the aggregated refusal. Names paths, never the reference. */
export function buildSecureReferenceMessage(logicalId: string, paths: readonly string[]): string {
  return `  - ${logicalId}: ${paths.join(', ')}`;
}
