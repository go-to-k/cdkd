/**
 * The attempted policy document a failed create's delete compares with what
 * AWS holds (go-to-k/cdkd#4612), shared by the `AWS::SQS::QueuePolicy` and
 * `AWS::SNS::TopicPolicy` orphan deletes so both classify and compare it the
 * same way. Its one import is the `retryable-errors` leaf.
 *
 * The journal stores the attempted bag with secret references redacted, so it
 * is re-resolved first. What then cannot be compared splits in two:
 *
 * - `unusable`: only a failure KNOWN to be permanent — no document, a `***`
 *   mask a `NoEcho` value left, a reference still there after resolving, a
 *   secret or parameter that does not exist or lacks the value, a refusal
 *   cdkd marked non-retryable (the resolver's deliberate refusals; a region
 *   refusal whose journaled bag cannot change), or cdkd's refusal of a
 *   reference whose recorded token does not match. A nested child's region
 *   refusal is NOT permanent: re-running from the parent stack settles it.
 *   Keeping the entry would block every later destroy and deploy forever, so
 *   the delete clears nothing, names every target for a check by hand, and
 *   settles the entry (`leftInPlace`).
 * - `retry`: everything else (throttling, expired or missing credentials,
 *   access denied, KMS, the network). The delete reports `skipped`, the entry
 *   is kept, and a re-run tries again once the cause is fixed.
 *
 * The comparison itself ({@link policyContentKey}) reads both documents in
 * an IAM-equivalent form, because the service may store an equivalent
 * spelling of what was written (SQS stores a bare account-id principal as
 * `arn:aws:iam::<id>:root`).
 */
import { isMarkedNonRetryable } from '../deployment/retryable-errors.js';

/** The state mask (`SECRET_MASK` in `src/deployment/secret-redaction`). */
const MASK = '***';

/**
 * cdkd's own refusal code no re-run of this entry can change: the journaled
 * reference's recorded token does not match.
 */
const PERMANENT_CDKD_CODES: ReadonlySet<string> = new Set(['ROLLBACK_SECRET_TOKEN_SCAN_MISMATCH']);

/**
 * cdkd's refusal codes that are permanent only when the refusal is MARKED
 * non-retryable (`markNonRetryable`, read over the cause chain): the
 * resolver's deliberate refusals (`INTRINSIC_RESOLUTION_REFUSAL*`, e.g. a
 * cross-account secret or an `ssm-secure` reference to a String parameter),
 * and the replay's region refusal, which is marked only where the journaled
 * bag can never change (a non-nested stack with another producer region on
 * record). Its nested-child twin is unmarked: re-running from the parent
 * stack settles it. `DYNAMIC_REFERENCE_REGION_AMBIGUOUS` is not listed: the
 * replay's resolver context records no producer regions, so it is
 * unreachable here, and if it ever were reached it would keep the entry.
 */
const MARKED_PERMANENT_CODE_PREFIXES: readonly string[] = [
  'INTRINSIC_RESOLUTION_REFUSAL',
  'ROLLBACK_SECRET_REGION_AMBIGUOUS',
];

/** AWS error names that say the referenced secret or parameter does not exist. */
const NOT_FOUND_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ResourceNotFoundException',
  'ParameterNotFound',
  'ParameterVersionNotFound',
]);

/** What {@link attemptedPolicyDocument} found. */
export type AttemptedPolicyDocument =
  | { kind: 'document'; document: unknown }
  | { kind: 'retry'; errorName: string }
  | { kind: 'unusable'; why: string };

/**
 * Whether any string leaf of `document` (a string document is read as JSON
 * when it parses) is the mask or holds a `{{resolve:` reference.
 */
export function holdsUnresolvedValue(document: unknown): boolean {
  let root = document;
  if (typeof document === 'string') {
    try {
      root = JSON.parse(document) as unknown;
    } catch {
      root = document;
    }
  }
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') return v === MASK || v.includes('{{resolve:');
    if (Array.isArray(v)) return v.some(walk);
    if (v !== null && typeof v === 'object') return Object.values(v).some(walk);
    return false;
  };
  return walk(root);
}

/**
 * Whether a failed resolution is KNOWN to fail again on a re-run: a secret or
 * parameter that does not exist, the resolver's own `Dynamic reference:`
 * refusals (no SecretString, a missing JSON key, not JSON), a cdkd refusal
 * marked non-retryable, or cdkd's token-scan refusal. Walks the `cause`
 * chain.
 */
export function isPermanentResolutionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    const e = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.name === 'string' && NOT_FOUND_ERROR_NAMES.has(e.name)) return true;
    if (typeof e.code === 'string') {
      if (PERMANENT_CDKD_CODES.has(e.code)) return true;
      const code = e.code;
      if (
        MARKED_PERMANENT_CODE_PREFIXES.some((p) => code.startsWith(p)) &&
        // The mark of the refusal whose code matched, not of a wrapper above
        // it: a marked wrapper must not make a fixable refusal permanent.
        isMarkedNonRetryable(current)
      ) {
        return true;
      }
    }
    if (typeof e.message === 'string' && e.message.startsWith('Dynamic reference: ')) return true;
    current = e.cause;
  }
  return false;
}

/** An error's `name` for a log line (never its message), or `'error'`. */
function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[\w.-]{1,128}$/.test(name) ? name : 'error';
}

/**
 * The attempted `PolicyDocument` (`recorded`, the journal's), replaced by the
 * re-resolved one when `resolve` is offered, and classified (see the module
 * doc). The caller reads `PolicyDocument` from each bag itself.
 */
export async function attemptedPolicyDocument(
  recorded: unknown,
  resolve: (() => Promise<unknown>) | undefined
): Promise<AttemptedPolicyDocument> {
  let document = recorded;
  if (resolve) {
    try {
      document = await resolve();
    } catch (error) {
      return isPermanentResolutionError(error)
        ? { kind: 'unusable', why: 'a secret it references does not exist or cannot be used' }
        : { kind: 'retry', errorName: errorName(error) };
    }
  }
  const usable =
    (typeof document === 'string' && document.length > 0) ||
    (document !== null && typeof document === 'object');
  if (!usable) return { kind: 'unusable', why: 'no policy document it attempted is recorded' };
  if (holdsUnresolvedValue(document)) {
    return {
      kind: 'unusable',
      why: 'its policy document still holds a secret reference or masked value',
    };
  }
  return { kind: 'document', document };
}

const ACCOUNT_ID = /^\d{12}$/;
/**
 * An account's root principal in any partition. The partition is not compared:
 * a policy cannot name a principal of another partition, so an id's root ARN
 * and the bare id name the same account wherever the policy lives.
 */
const ACCOUNT_ROOT_ARN = /^arn:[a-z-]+:iam::(\d{12}):root$/;
/** Statement keys whose one-element list equals its scalar. */
const LIST_KEYS = ['Action', 'NotAction', 'Resource', 'NotResource'];
const PRINCIPAL_KEYS = ['Principal', 'NotPrincipal'];

/** A one-element list as its scalar; anything else as it is. */
function unwrapSingle(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

/** An account principal in one spelling: a bare id and its root ARN agree. */
function accountKey(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (ACCOUNT_ID.test(value)) return `account:${value}`;
  const m = ACCOUNT_ROOT_ARN.exec(value);
  return m ? `account:${m[1]}` : value;
}

/** `"*"` and `{ "AWS": "*" }` (in any list spelling) name everyone alike. */
const ANYONE = 'anyone:*';

function normalizePrincipal(principal: unknown): unknown {
  if (principal === '*') return ANYONE;
  if (principal === null || typeof principal !== 'object' || Array.isArray(principal)) {
    return principal;
  }
  const keys = Object.keys(principal);
  if (
    keys.length === 1 &&
    keys[0] === 'AWS' &&
    unwrapSingle((principal as Record<string, unknown>)['AWS']) === '*'
  ) {
    return ANYONE;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(principal as Record<string, unknown>)) {
    const value =
      key === 'AWS' ? (Array.isArray(raw) ? raw.map(accountKey) : accountKey(raw)) : raw;
    out[key] = unwrapSingle(value);
  }
  return out;
}

function normalizeStatement(statement: unknown): unknown {
  if (statement === null || typeof statement !== 'object' || Array.isArray(statement)) {
    return statement;
  }
  const out: Record<string, unknown> = { ...(statement as Record<string, unknown>) };
  for (const key of LIST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = unwrapSingle(out[key]);
  }
  for (const key of PRINCIPAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = normalizePrincipal(out[key]);
  }
  return out;
}

/** A JSON value with object keys sorted at every depth, serialized; array order kept. */
function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === 'object') {
      // Null prototype: a `__proto__` member stays an own key and is compared.
      const out = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(v).sort()) {
        out[key] = sortKeys((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

/**
 * A policy document's content key, IAM-equivalent spellings folded: within
 * each statement, a one-element `Action` / `NotAction` / `Resource` /
 * `NotResource` / principal list equals its scalar, a bare 12-digit account id
 * in `Principal.AWS` equals its `arn:<partition>:iam::<id>:root`, a `"*"`
 * principal equals `{ "AWS": "*" }`, and a single `Statement` object equals a
 * one-element list. Object keys are sorted; list
 * order is kept. A string is read as JSON; text that does not parse is keyed
 * as itself under a prefix no JSON form can produce.
 */
export function policyContentKey(document: unknown): string {
  let value = document;
  if (typeof document === 'string') {
    try {
      value = JSON.parse(document) as unknown;
    } catch {
      return `raw:${document}`;
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const doc = { ...(value as Record<string, unknown>) };
    if (Object.prototype.hasOwnProperty.call(doc, 'Statement')) {
      const statements = Array.isArray(doc['Statement']) ? doc['Statement'] : [doc['Statement']];
      doc['Statement'] = statements.map(normalizeStatement);
    }
    value = doc;
  }
  return canonicalJson(value);
}
