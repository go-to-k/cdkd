/**
 * The drift baseline the deploy captures right after cdkd's own write
 * (`ReadCurrentStateContext.afterOwnWrite`), for reads AWS answers eventually
 * consistently (go-to-k/cdkd#6609).
 *
 * Right after a put or delete, a policy read can still answer with what the
 * resource held BEFORE the write, or with nothing. Taken as the baseline, that
 * stale answer makes `cdkd drift` report an untouched stack and makes
 * `drift --revert` restore it: re-grant a replaced policy, or remove the
 * declared one. A provider whose read reflects such a write re-asks on the
 * post-write capture until the answer matches what the deploy just wrote, and
 * believes AWS on every other read (drift, import, `state refresh-observed`),
 * where a member that really changed must report.
 *
 * An answer that never matches splits in two. One that still finds NOTHING
 * written records no baseline, so drift compares against the template. One
 * that finds ANOTHER document is recorded as read, as before: the service may
 * store an equivalent spelling no comparison here folds, and leaving that
 * resource without a baseline would report it against the template on every
 * drift run. A replaced document still visible after the whole schedule is
 * the residual. For a MEMBER of a bigger resource (a key's policy, a log
 * group's data protection policy), "nothing written" keeps the declared value
 * instead ({@link settleDeclaredMember}): the rest of the resource still needs
 * its baseline.
 *
 * Only a first answer that disagrees costs more calls, and the capture runs
 * beside the rest of the deploy, so a deploy whose reads agree pays nothing.
 */
import { coerceCfnBoolean } from './config-shape.js';
import {
  isAmbiguousOutcomeError,
  isThrottlingError,
  isTransientServerError,
} from '../deployment/retryable-errors.js';
import { safeMsg } from '../utils/display-safe.js';
import { cdkdRemedy, proseQuoted } from '../utils/pasteable-command.js';
import { accountKey, policyContentKey } from './policy-document-content.js';
import { OMITTED_POLICY_VERSION } from '../analyzer/drift-verbatim-paths.js';

/**
 * Waits between the re-reads of a disagreeing answer: four reads and 3.5 s at
 * most. The measured lag of a just-deleted DynamoDB table policy was about
 * 2 s (go-to-k/cdkd#6604); this is a measurement, not a documented bound.
 */
export const OWN_WRITE_REREAD_DELAYS_MS: readonly number[] = [500, 1000, 2000];

/**
 * Run `read`, re-asking after each delay until `settled` accepts the answer.
 * Returns the last answer and whether it settled.
 */
export async function reReadUntilSettled<T>(
  read: () => Promise<T>,
  settled: (answer: T) => boolean,
  delaysMs: readonly number[]
): Promise<{ answer: T; settled: boolean }> {
  let answer = await read();
  for (const delayMs of delaysMs) {
    if (settled(answer)) return { answer, settled: true };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    answer = await read();
  }
  return { answer, settled: settled(answer) };
}

/**
 * One read of a MEMBER of a bigger resource (a key policy on a key, a data
 * protection policy on a log group): its value as the resource read records
 * it, `'absent'` when AWS answered that none is set, `'failed'` when the read
 * threw a transient error ({@link memberReadFailure}) or answered something
 * that is not the member, or `'refused'` when it threw a deterministic one
 * (go-to-k/cdkd#6609).
 */
export type MemberRead<T> = { value: T } | 'absent' | 'failed' | 'refused';

/**
 * A member read's failure: `'failed'` for a throttle, a 5xx or a socket
 * failure the SDK's retries did not absorb, which a re-read can outlast;
 * `'refused'` for anything else (`AccessDenied` and the like), which a re-read
 * would only repeat. Deliberately not `isRetryableTransientError`, whose
 * message patterns count `not authorized to perform` as IAM propagation (the
 * #4112 reasoning in `dynamodb-table/read-current-state.ts`).
 */
export function memberReadFailure(err: unknown): 'failed' | 'refused' {
  return isThrottlingError(err) || isTransientServerError(err) || isAmbiguousOutcomeError(err)
    ? 'failed'
    : 'refused';
}

/**
 * The member to record on the post-write capture, given the member as the
 * resource read found it (`first`): while the newest answer is not the
 * declared value, re-read the member alone after each delay. A first answer
 * that agrees, or one REFUSED (a deterministic failure), makes no extra call;
 * a refused re-read ends the schedule.
 *
 * Returns the newest answer AWS gave (a failed re-read keeps the one before
 * it), except that a member still ABSENT after the schedule records `declared`
 * (already in the read's shape): the write just succeeded, and recording
 * "none" would let `drift --revert` delete it. Another value is recorded as
 * read (the module comment says why). `'failed'` / `'refused'` only when no
 * read answered, so the caller records what its single read always did.
 * `unsettled` runs once when the schedule ends without the declared value
 * after some read answered, so the caller can say so (value-free:
 * {@link warnUnsettledMember}).
 */
export async function settleDeclaredMember<T>(
  first: MemberRead<T>,
  read: () => Promise<MemberRead<T>>,
  matches: (value: T) => boolean,
  declared: T,
  delaysMs: readonly number[],
  unsettled: () => void
): Promise<MemberRead<T>> {
  const settled = (answer: MemberRead<T>): boolean =>
    typeof answer === 'object' && matches(answer.value);
  if (first === 'refused' || settled(first)) return first;
  let newest = first;
  for (const delayMs of delaysMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    let answer: MemberRead<T>;
    try {
      answer = await read();
    } catch (err) {
      answer = memberReadFailure(err);
    }
    if (answer === 'refused') break;
    if (answer !== 'failed') newest = answer;
    if (settled(newest)) return newest;
  }
  // Nothing answered: the caller records (or throws) what its single read
  // did, and that is the message; a second one here would only repeat it.
  if (newest !== 'failed') unsettled();
  return newest === 'absent' ? { value: declared } : newest;
}

/**
 * Warn that a member's post-write read never matched the template, naming
 * only the resource and the member key (no value: the document can carry
 * account ids and principals), and how to re-capture the baseline.
 */
export function warnUnsettledMember(
  logger: { warn: (message: string) => void },
  logicalId: string,
  resourceType: string,
  memberKey: string
): void {
  logger.warn(
    safeMsg`${resourceType} ${logicalId}: the read right after the write never showed ${memberKey} as the write left it (a declared value missing, or a removed one still present), so its drift baseline may not match the live resource; run ${proseQuoted(cdkdRemedy('cdkd state refresh-observed'))} on the stack to re-capture it`
  );
}

/**
 * The policy document a member declares: a non-null object, or a non-empty
 * string parsed as JSON when it parses (the read's shape). `undefined` when it
 * declares nothing to settle on.
 */
export function declaredMemberDocument(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === '') return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/** The `Id` of the default key policy KMS attaches when none is set. */
export const KMS_DEFAULT_KEY_POLICY_ID = 'key-default-1';

/** A statement `Resource` EFS adds to a stored file system policy: the file system's own ARN. */
const EFS_FILE_SYSTEM_ARN =
  /^arn:[a-z-]+:elasticfilesystem:[a-z0-9-]+:\d{12}:file-system\/fs-[0-9a-f]+$/;

/**
 * Whether a read EFS file system policy is the declared one
 * ({@link policyDocumentMatchesDeclared}). EFS stores a statement that
 * declares no `Resource` with the file system's ARN added (measured,
 * us-east-1, 2026-11-19), so that `Resource` is dropped from the read
 * statement where the declared statement at the same position has none.
 * With `fileSystemId`, only that file system's own ARN is dropped. Without it
 * (the drift-side heal, which has no physical id), any file system ARN is:
 * EFS refuses a policy naming another file system's ARN (`InvalidPolicyException
 * ... Must be the filesystem's ARN`, measured the same day), so a stored one
 * is always the policy's own. `Resource: "*"` is stored as sent, never folded.
 */
export function efsPolicyMatchesDeclared(
  answer: unknown,
  declared: unknown,
  fileSystemId?: string
): boolean {
  return policyDocumentMatchesDeclared(
    withoutAddedResource(answer, declared, fileSystemId),
    declared
  );
}

function withoutAddedResource(
  answer: unknown,
  declared: unknown,
  fileSystemId: string | undefined
): unknown {
  const read = parsedDocument(answer);
  const want = parsedDocument(declared);
  const statements = (doc: unknown): unknown[] | undefined => {
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined;
    const s = (doc as Record<string, unknown>)['Statement'];
    return s === undefined ? undefined : Array.isArray(s) ? s : [s];
  };
  const readStatements = statements(read);
  const wantStatements = statements(want);
  if (readStatements === undefined || wantStatements === undefined) return answer;
  return {
    ...(read as Record<string, unknown>),
    Statement: readStatements.map((entry, index) => {
      const wanted = wantStatements[index];
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof wanted !== 'object' ||
        wanted === null ||
        Object.prototype.hasOwnProperty.call(wanted, 'Resource')
      ) {
        return entry;
      }
      const resource = (entry as Record<string, unknown>)['Resource'];
      if (
        typeof resource !== 'string' ||
        !EFS_FILE_SYSTEM_ARN.test(resource) ||
        (fileSystemId !== undefined && !resource.endsWith(`:file-system/${fileSystemId}`))
      ) {
        return entry;
      }
      const { Resource: _added, ...rest } = entry as Record<string, unknown>;
      return rest;
    }),
  };
}

/**
 * The `PolicyDocument` a desired bag declares: a non-null object or a
 * non-empty string. Anything else declares nothing to settle on, so the read
 * is taken as AWS gives it.
 */
export function declaredPolicyDocument(properties: unknown): unknown {
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return undefined;
  }
  const doc = (properties as Record<string, unknown>)['PolicyDocument'];
  if (typeof doc === 'string') return doc === '' ? undefined : doc;
  return typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? doc : undefined;
}

/**
 * Whether a read policy is the declared one, IAM-equivalent spellings folded
 * ({@link policyContentKey}), plus a one-element condition value list, which
 * SQS stores as its scalar (measured, us-east-1, 2026-11-19), plus a read
 * `Version: 2008-10-17` against a declared document with no `Version`: what an
 * omitted `Version` means, which S3, SQS, SNS, KMS, Secrets Manager and IAM's
 * role trust policy write into it (go-to-k/cdkd#6634). A read `2012-10-17`
 * there, or any change to a declared `Version`, still differs.
 *
 * `partition` is the policy's resource partition, when the caller knows it: a
 * bare account id then equals only that partition's root ARN
 * ({@link policyContentKey}, go-to-k/cdkd#6854).
 */
export function policyDocumentMatchesDeclared(
  answer: unknown,
  declared: unknown,
  partition?: string
): boolean {
  return (
    answer !== undefined &&
    policyContentKey(
      foldConditionValues(withoutOmittedVersionDefault(answer, declared)),
      partition
    ) === policyContentKey(foldConditionValues(declared), partition)
  );
}

/** `answer` without its `Version` when that is the default `declared` omits. */
function withoutOmittedVersionDefault(answer: unknown, declared: unknown): unknown {
  const read = parsedDocument(answer);
  const want = parsedDocument(declared);
  if (
    typeof read !== 'object' ||
    read === null ||
    Array.isArray(read) ||
    typeof want !== 'object' ||
    want === null ||
    Array.isArray(want) ||
    Object.prototype.hasOwnProperty.call(want, 'Version') ||
    (read as Record<string, unknown>)['Version'] !== OMITTED_POLICY_VERSION
  ) {
    return answer;
  }
  const { Version: _default, ...rest } = read as Record<string, unknown>;
  return rest;
}

/** A policy document string parsed as JSON when it parses; anything else as given. */
function parsedDocument(document: unknown): unknown {
  if (typeof document !== 'string') return document;
  try {
    return JSON.parse(document) as unknown;
  } catch {
    return document;
  }
}

/** A policy document with every one-element condition value list as its scalar. */
function foldConditionValues(document: unknown): unknown {
  let doc = document;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc) as unknown;
    } catch {
      return document;
    }
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return doc;
  const statement = (doc as Record<string, unknown>)['Statement'];
  if (statement === undefined) return doc;
  const statements = Array.isArray(statement) ? statement : [statement];
  return {
    ...(doc as Record<string, unknown>),
    Statement: statements.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
      const condition = (entry as Record<string, unknown>)['Condition'];
      if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) {
        return entry;
      }
      // Null prototypes: a `__proto__` operator or condition key stays an own
      // key and is compared, where `{}` would take it as the prototype.
      const folded = Object.create(null) as Record<string, unknown>;
      for (const [operator, block] of Object.entries(condition as Record<string, unknown>)) {
        if (typeof block !== 'object' || block === null || Array.isArray(block)) {
          folded[operator] = block;
          continue;
        }
        const values = Object.create(null) as Record<string, unknown>;
        for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
          values[key] = Array.isArray(value) && value.length === 1 ? value[0] : value;
        }
        folded[operator] = values;
      }
      return { ...(entry as Record<string, unknown>), Condition: folded };
    }),
  };
}

/**
 * The `Id` SNS gives the policy every topic holds until one is set. Read back
 * after a `TopicPolicy` write, it is the write not yet visible, never a
 * declared document.
 */
export const SNS_DEFAULT_POLICY_ID = '__default_policy_ID';

/** The `AWS::Lambda::Permission` keys `readCurrentState` reads off the policy statement. */
export const LAMBDA_PERMISSION_STATEMENT_KEYS = [
  'Action',
  'Principal',
  'SourceArn',
  'SourceAccount',
  'PrincipalOrgID',
  'EventSourceToken',
  'FunctionUrlAuthType',
  'InvokedViaFunctionUrl',
] as const;

/**
 * Whether a read `AWS::Lambda::Permission` is the declared one, on every key
 * the read emits. An account principal reads back as its root ARN, and
 * `InvokedViaFunctionUrl: false` reads back absent, so both compare as the
 * same value. A declared `null` or `''` declares nothing, so it matches a
 * read that omits the key.
 */
export function lambdaPermissionMatchesDeclared(
  read: Record<string, unknown>,
  declared: Record<string, unknown>
): boolean {
  return LAMBDA_PERMISSION_STATEMENT_KEYS.every((key) => {
    if (key === 'InvokedViaFunctionUrl') {
      return (read[key] === true) === (coerceCfnBoolean(declared[key]) === true);
    }
    const want = declared[key];
    const got = read[key];
    if (want === undefined || want === null || want === '') return got === undefined;
    return key === 'Principal' ? accountKey(got) === accountKey(want) : got === want;
  });
}
