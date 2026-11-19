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
 * Only a first answer that disagrees costs more calls, and the capture runs
 * beside the rest of the deploy, so a deploy whose reads agree pays nothing.
 */
import { coerceCfnBoolean } from './config-shape.js';
import { accountKey, policyContentKey } from './policy-document-content.js';

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

/** Whether a read policy is the declared one, IAM-equivalent spellings folded. */
export function policyDocumentMatchesDeclared(answer: unknown, declared: unknown): boolean {
  return answer !== undefined && policyContentKey(answer) === policyContentKey(declared);
}

/** The `AWS::Lambda::Permission` keys `readCurrentState` reads off the policy statement. */
export const LAMBDA_PERMISSION_STATEMENT_KEYS = [
  'Action',
  'Principal',
  'SourceArn',
  'SourceAccount',
  'PrincipalOrgID',
  'InvokedViaFunctionUrl',
] as const;

/**
 * Whether a read `AWS::Lambda::Permission` is the declared one, on every key
 * the read emits. An account principal reads back as its root ARN, and
 * `InvokedViaFunctionUrl: false` reads back absent, so both compare as the
 * same value.
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
    if (want === undefined || want === null) return got === undefined;
    return key === 'Principal' ? accountKey(got) === accountKey(want) : got === want;
  });
}
