/**
 * Top-level properties whose readback echoes the template VERBATIM: the
 * service stores the submitted document and returns it with no key of its
 * own added (go-to-k/cdkd#6622).
 *
 * The drift comparator walks only the baseline's keys on the template-only
 * `properties` baseline (`calculateResourceDrift` without `unionWalkObjects`),
 * because a readback usually carries AWS-side defaults the template never
 * declared. Under a key listed here there are none, so a key only the live
 * side holds was added out of band — an IAM policy document's object-form
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
 * property. IAM stores and returns a policy document as submitted (the SDK
 * readers URL-decode and parse it, nothing else). Other services' resource
 * policies (S3 bucket, SQS queue, SNS topic, KMS key) are not listed until
 * their readback is measured: a service-added key there would be phantom
 * drift on every clean template-only resource, and `--revert` would strip it.
 * Adding a type is a row.
 */
const VERBATIM_ECHO_DRIFT_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::IAM::Role': ['AssumeRolePolicyDocument'],
  'AWS::IAM::Policy': ['PolicyDocument'],
  'AWS::IAM::ManagedPolicy': ['PolicyDocument'],
};

const NONE: readonly string[] = [];

/** The verbatim-echo top-level keys of `resourceType`, or none. */
export function verbatimEchoDriftKeys(resourceType: string): readonly string[] {
  return Object.hasOwn(VERBATIM_ECHO_DRIFT_KEYS, resourceType)
    ? VERBATIM_ECHO_DRIFT_KEYS[resourceType]!
    : NONE;
}
