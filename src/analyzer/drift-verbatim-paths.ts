import { nullPrototypeRecord } from '../utils/own-keys.js';

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
 * property other than the default of an omitted `Version` (go-to-k/cdkd#6624, the
 * `drift-verbatim-readback` integ fixture).
 * IAM and the Cloud Control-routed IAM inline policy types return the document
 * as submitted, key order aside. S3, SQS, SNS, KMS, Secrets Manager — and IAM's
 * role trust policy — add no key either, but return a single-OBJECT `Statement`
 * as a one-element array; the comparator reads the two spellings as one
 * ({@link isVerbatimStatementPath}), as IAM's policy grammar does. Those
 * services also write `Version: 2008-10-17` into a document submitted
 * without one, which is what an omitted `Version` means, so that is not
 * drift on the template-only baseline either ({@link isOmittedVersionDefault}).
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

/**
 * The policy language version an omitted `Version` means, which S3, SQS, SNS,
 * KMS, Secrets Manager and IAM's role trust policy write into a document
 * submitted without one (go-to-k/cdkd#6624, measured).
 */
export const OMITTED_POLICY_VERSION = '2008-10-17';

/**
 * True when `value` at `path` is `2008-10-17` at the `Version` of a document
 * at one of `verbatimKeys`: the policy language version an omitted `Version`
 * means. S3, SQS, SNS, KMS, Secrets Manager and IAM's role trust policy write
 * it into a document submitted without one (go-to-k/cdkd#6624, measured); the
 * Cloud Control IAM inline policies and `AWS::IAM::Policy` do not, and there
 * an out-of-band `2008-10-17` changes nothing either. So against a template
 * that omits `Version`, the comparator does not report it on the
 * template-only baseline. A live `2012-10-17` there turns policy variables on
 * and is still drift, as is any change to a declared `Version`.
 */
export function isOmittedVersionDefault(
  path: string,
  value: unknown,
  verbatimKeys: readonly string[]
): boolean {
  return value === OMITTED_POLICY_VERSION && verbatimKeys.some((key) => path === `${key}.Version`);
}

/**
 * The spellings of one policy-statement value that the services behind the
 * verbatim-echo keys return for what the template submitted (go-to-k/cdkd#6852,
 * measured in us-east-1 on 2026-11-23 through each service's plain API). The
 * comparator reads a pair equal at a `<verbatim key>.Statement` path (or a
 * path inside it) when their {@link canonicalPolicyFoldForm}s are equal; the
 * values it REPORTS stay the originals.
 *
 * Every fold below is symmetric and applies on both baselines. The template-only
 * baseline is where they matter (the observed baseline captured AWS's own
 * spelling). What stays compared strictly, as AWS keeps it as sent (same
 * measurement): the order of `Action` / `Resource` / Condition values and of
 * statements, a `"Sid": ""`, a Sid-less statement (no Sid is added), and a
 * Condition value's one-element list against its scalar (go-to-k/cdkd#6842).
 *
 * Sibling rules: `policyContentKey` (`provisioning/policy-document-content.ts`)
 * for the one-element and account-root folds, and cdk-real-drift
 * `src/normalize/policy-canonical.ts` (`toSortedArray`,
 * `normalizeAccountPrincipal`), which folds the same two but also sorts.
 */
const POLICY_LIST_KEYS = new Set(['Action', 'NotAction', 'Resource', 'NotResource']);
const POLICY_PRINCIPAL_KEYS = new Set(['Principal', 'NotPrincipal']);
const BARE_ACCOUNT_ID = /^\d{12}$/;
/**
 * An account's root principal, in any real partition. Only the measured pair
 * is folded: a bare id against the root ARN of the same id (the readback is in
 * the resource's partition, which the comparator cannot know). Two root ARNs
 * are compared as strings, so a partition change is still drift.
 */
const ACCOUNT_ROOT_PRINCIPAL = /^arn:aws(?:-[a-z]+)*:iam::(\d{12}):root$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapRecord(
  value: Record<string, unknown>,
  fn: (key: string, member: unknown) => unknown
): Record<string, unknown> {
  const out = nullPrototypeRecord();
  for (const key of Object.keys(value)) out[key] = fn(key, value[key]);
  return out;
}

/**
 * M1: S3 (`GetBucketPolicy`), SQS (`GetQueueAttributes`), SNS
 * (`GetTopicAttributes`) and IAM's role trust policy (`GetRole`) return a
 * one-element `Action` / `Resource` / `Principal.<key>` list as its scalar
 * (IAM's managed policy, `GetPolicyVersion`, keeps the list). A list of two or
 * more, and an empty one, is never unwrapped. cdk-real-drift
 * `src/normalize/policy-canonical.ts` `toSortedArray` has the same fold.
 */
function unwrapOneElementList(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

/**
 * M2: IAM's role trust policy (`GetRole`) returns `"Principal": {"AWS":
 * "<12-digit id>"}` as `"arn:aws:iam::<id>:root"` (SQS stores it the same
 * way, `policyContentKey`). Only under the `AWS` key: a 12-digit value under
 * `Service`, `Federated` or `CanonicalUser` names no account and is kept as
 * written. Two root ARNs compare as strings ({@link policyFoldLeafEqual}).
 * cdk-real-drift `src/normalize/policy-canonical.ts`
 * `normalizeAccountPrincipal` folds the same pair, looser: under every
 * principal key, and two root ARNs of different partitions alike.
 */
function accountPrincipalForm(value: unknown): unknown {
  // The NUL-prefixed form cannot meet a real principal: IAM refuses a NUL in one.
  return typeof value === 'string' && BARE_ACCOUNT_ID.test(value)
    ? `${BARE_ACCOUNT_MARK}${value}`
    : value;
}

const BARE_ACCOUNT_MARK = '\u0000account:';

/**
 * The leaf rule of the account fold, for two STRING leaves at the same
 * position of two folded values: a bare id (marked by
 * {@link canonicalPolicyFoldForm}, only under `Principal.AWS` /
 * `NotPrincipal.AWS`) equals the root ARN of the same id. Everything else
 * compares as written.
 */
export function policyFoldLeafEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const [bare, other] = a.startsWith(BARE_ACCOUNT_MARK) ? [a, b] : [b, a];
  if (!bare.startsWith(BARE_ACCOUNT_MARK)) return false;
  const root = ACCOUNT_ROOT_PRINCIPAL.exec(other);
  return root !== null && root[1] === bare.slice(BARE_ACCOUNT_MARK.length);
}

/**
 * M4: S3 (`GetBucketPolicy`) returns a Condition JSON number `1.2` as the
 * string `"1.2"` and `false` as `"false"` (CDK's `minimumTLSVersion` writes
 * `NumericLessThan {"s3:TlsVersion": 1.2}`). A number or boolean equals
 * exactly its `String()` form: `"1.20"` is another string and stays different.
 * A one-element list is NOT unwrapped here (go-to-k/cdkd#6842).
 */
function conditionValueForm(value: unknown): unknown {
  const scalar = (v: unknown): unknown =>
    typeof v === 'number' || typeof v === 'boolean' ? String(v) : v;
  return Array.isArray(value) ? value.map(scalar) : scalar(value);
}

/**
 * The fold form of the value at `field` (segments below one statement:
 * `[]` is the statement itself, `['Action']`, `['Principal', 'AWS']`,
 * `['Condition', <op>, <key>]`, ...). An unknown position is returned as it
 * is, so it compares strictly.
 */
function statementFieldForm(field: readonly string[], value: unknown): unknown {
  const [head, second, third, ...rest] = field;
  if (head === undefined) {
    return isRecord(value) ? mapRecord(value, (k, v) => statementFieldForm([k], v)) : value;
  }
  if (rest.length > 0) return value;
  if (POLICY_LIST_KEYS.has(head)) {
    return second === undefined ? unwrapOneElementList(value) : value;
  }
  if (head === 'Effect') {
    // M3: S3 (`PutBucketPolicy`) accepts `"Effect": "allow"` and returns
    // `"Allow"`; IAM refuses it (MalformedPolicyDocument), so only the case
    // differs between what a template can deploy and what is returned.
    return second === undefined && typeof value === 'string' ? value.toLowerCase() : value;
  }
  if (POLICY_PRINCIPAL_KEYS.has(head)) {
    if (second === undefined) {
      return isRecord(value) ? mapRecord(value, (k, v) => statementFieldForm([head, k], v)) : value;
    }
    if (third !== undefined) return value;
    const unwrapped = unwrapOneElementList(value);
    if (second !== 'AWS') return unwrapped;
    return Array.isArray(unwrapped)
      ? unwrapped.map(accountPrincipalForm)
      : accountPrincipalForm(unwrapped);
  }
  if (head === 'Condition') {
    if (second === undefined) {
      return isRecord(value)
        ? mapRecord(value, (op, v) => statementFieldForm([head, op], v))
        : value;
    }
    if (third === undefined) {
      return isRecord(value)
        ? mapRecord(value, (k, v) => statementFieldForm([head, second, k], v))
        : value;
    }
    return conditionValueForm(value);
  }
  return value;
}

/**
 * `rest` (a dotted path below one statement) as field segments. A Condition
 * KEY may itself hold dots (`token.actions.githubusercontent.com:sub`), so
 * everything after the operator is one segment; no other statement position
 * the folds read has a dotted name.
 */
function statementFieldSegments(rest: string): string[] {
  const segments = rest.split('.');
  return segments[0] === 'Condition' && segments.length > 3
    ? [segments[0], segments[1]!, segments.slice(2).join('.')]
    : segments;
}

/** {@link canonicalPolicyFoldForm}'s answer for a path outside every policy statement. */
export const NOT_A_POLICY_PATH: unique symbol = Symbol('not a policy path');

/**
 * The fold form of `value` at `path` when `path` is a policy document's
 * `Statement` under one of `verbatimKeys`, or a path inside an object-form
 * statement; {@link NOT_A_POLICY_PATH} anywhere else. A list-form `Statement`
 * is compared whole (the comparator does not descend into arrays), so each of
 * its statements is folded, in order.
 */
export function canonicalPolicyFoldForm(
  path: string,
  value: unknown,
  verbatimKeys: readonly string[]
): unknown {
  for (const key of verbatimKeys) {
    const statementPath = `${key}.Statement`;
    if (path === statementPath) {
      return Array.isArray(value)
        ? value.map((s) => statementFieldForm([], s))
        : statementFieldForm([], value);
    }
    if (path.startsWith(`${statementPath}.`)) {
      return statementFieldForm(
        statementFieldSegments(path.slice(statementPath.length + 1)),
        value
      );
    }
  }
  return NOT_A_POLICY_PATH;
}
