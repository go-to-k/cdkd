import {
  dynamicReferenceTokens,
  MIN_NEEDLE_LENGTH,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../deployment/secret-redaction.js';

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

/**
 * Did THIS resource's resolution record a SECRET (go-to-k/cdkd#4009)? The
 * resolve-time half of the rule above, for the routes a template scan cannot
 * see:
 *
 * - a plain `{{resolve:ssm:...}}` that names a SecureString (the template says
 *   `ssm`; the resolver decrypts it and records it as a secret);
 * - a nested child stack's custom resource reading a parent parameter the
 *   parent resolved from a secret (the child template spells only `Ref`);
 * - a rollback replay re-resolving a recorded reference -- on EITHER side of an
 *   update: `cdkd rollback --revert-failed` re-resolves the failed op's
 *   attempted properties as the PREVIOUS side, sent as `OldResourceProperties`.
 *
 * `secrets` is the per-resource bag the caller bound with
 * `withCurrentResourceSecrets` (deploy, rollback replay and the nested child
 * engine all do); it is created fresh per resource, so an entry in it means
 * this resource's properties consumed that secret. EVERY property reaches the
 * handler, so the secret reached the event in some form -- whole, embedded,
 * base64-encoded (`Fn::Base64` records only a mask-only DERIVED needle for the
 * encoding, but the source pair is recorded too), split by `Fn::Select`, or
 * shorter than a needle. So the test is the bag, not a leaf match.
 *
 * The bag over-approximates on purpose (fail closed): a secret resolved but not
 * delivered -- an unused `Fn::Sub` variable, a `Fn::Select` element not picked,
 * a use that discloses nothing such as `Fn::Length` -- is refused too.
 *
 * Only EXPRESSION entries count: a mask-only entry alone (value `***`) is a
 * `NoEcho` value, which CloudFormation does deliver to a dependent in the clear.
 */
export function carriesResolvedSecret(secrets: RecordedSecretValues | undefined): boolean {
  if (secrets === undefined) return false;
  for (const [plaintext, expression] of secrets) {
    if (expression !== SECRET_MASK && plaintext.length > 0) return true;
  }
  return false;
}

/**
 * Where the recorded secrets sit, for the refusal to NAME: the paths of
 * `properties` whose leaf equals a secret plaintext, or contains one of at
 * least {@link MIN_NEEDLE_LENGTH} characters. Empty when the secret reached the
 * bag only in a transformed form (base64, a fragment, a short embedding); the
 * refusal still fires on {@link carriesResolvedSecret}.
 */
export function findResolvedSecretPaths(
  properties: Record<string, unknown> | undefined,
  secrets: RecordedSecretValues | undefined
): string[] {
  if (properties == null || secrets === undefined || secrets.size === 0) return [];
  const plaintexts = [...secrets.entries()]
    .filter(([plaintext, expression]) => expression !== SECRET_MASK && plaintext.length > 0)
    .map(([plaintext]) => plaintext);
  if (plaintexts.length === 0) return [];
  const carries = (leaf: string): boolean =>
    plaintexts.some(
      (plaintext) =>
        leaf === plaintext || (plaintext.length >= MIN_NEEDLE_LENGTH && leaf.includes(plaintext))
    );
  const paths: string[] = [];
  const onPath = new Set<object>();
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (carries(node)) paths.push(path);
      return;
    }
    if (node === null || typeof node !== 'object' || onPath.has(node)) return;
    onPath.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else {
      for (const [key, child] of Object.entries(node)) {
        walk(child, path ? `${path}.${key}` : key);
      }
    }
    onPath.delete(node);
  };
  walk(properties, '');
  return paths;
}
