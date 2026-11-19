/**
 * Top-level properties whose readback echoes the template VERBATIM: the
 * service stores the submitted document and returns it with no key of its
 * own added (go-to-k/cdkd#6622).
 *
 * The drift comparator walks only the baseline's keys on the template-only
 * `properties` baseline (`calculateResourceDrift` without `unionWalkObjects`),
 * because a readback usually carries AWS-side defaults the template never
 * declared. Under a key listed here there are none, so a key only the live
 * side holds was added out of band — a policy document's object-form
 * `Statement` gaining a `Condition` narrows a `Deny` — and the comparator walks
 * the union of keys there on either baseline. For the same reason `--revert`
 * sends the template's value WHOLE at these keys instead of merging the live
 * side's untemplated keys into it (`buildRevertNewProperties`'s
 * `preserveUntemplated`), and the revert plan does not report them as kept.
 *
 * Arrays stay compared whole (a list-form `Statement` was already compared
 * strictly). Entries are TOP-LEVEL property names: the revert side overlays
 * per top-level key.
 *
 * A type is listed only with a readback measured to add no key under the
 * property (go-to-k/cdkd#6624, the `drift-verbatim-readback` integ fixture).
 * IAM and the Cloud Control-routed IAM inline policy types return the document
 * as submitted, key order aside. S3, SQS, SNS, KMS, Secrets Manager — and IAM's
 * role trust policy — add no key either, but return a single-OBJECT `Statement`
 * as a one-element array; the comparator reads the two spellings as one
 * ({@link isVerbatimStatementPath}), as IAM's policy grammar does.
 *
 * Not listed: `AWS::ECR::Repository` `RepositoryPolicyText`, which the ECR
 * readback does not carry at all (go-to-k/cdkd#6631), and every resource policy
 * not yet measured (OpenSearch `AccessPolicies`, Lambda layer and EventBridge
 * bus policies, ...). Adding a type is a row, after a measured readback.
 */
const VERBATIM_ECHO_DRIFT_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::IAM::Role': ['AssumeRolePolicyDocument'],
  'AWS::IAM::Policy': ['PolicyDocument'],
  'AWS::IAM::ManagedPolicy': ['PolicyDocument'],
  'AWS::IAM::RolePolicy': ['PolicyDocument'],
  'AWS::IAM::UserPolicy': ['PolicyDocument'],
  'AWS::IAM::GroupPolicy': ['PolicyDocument'],
  'AWS::S3::BucketPolicy': ['PolicyDocument'],
  'AWS::SQS::QueuePolicy': ['PolicyDocument'],
  'AWS::SNS::TopicPolicy': ['PolicyDocument'],
  'AWS::KMS::Key': ['KeyPolicy'],
  'AWS::SecretsManager::ResourcePolicy': ['ResourcePolicy'],
};

const NONE: readonly string[] = [];

/** The verbatim-echo top-level keys of `resourceType`, or none. */
export function verbatimEchoDriftKeys(resourceType: string): readonly string[] {
  return Object.hasOwn(VERBATIM_ECHO_DRIFT_KEYS, resourceType)
    ? VERBATIM_ECHO_DRIFT_KEYS[resourceType]!
    : NONE;
}

/**
 * True when `path` is the `Statement` of a document at one of
 * `verbatimKeys` (`PolicyDocument.Statement`). A policy document's `Statement`
 * is one statement object or a list of them, and a service may return the
 * first spelling as the second (go-to-k/cdkd#6624), so the comparator reads a
 * statement object and a ONE-element list holding it as the same value there.
 */
export function isVerbatimStatementPath(path: string, verbatimKeys: readonly string[]): boolean {
  return verbatimKeys.some((key) => path === `${key}.Statement`);
}
