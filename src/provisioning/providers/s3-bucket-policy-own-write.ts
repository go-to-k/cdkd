/**
 * The `AWS::S3::BucketPolicy` baseline captured right after cdkd's own write
 * (`ReadCurrentStateContext.afterOwnWrite`, go-to-k/cdkd#6609). A sibling of
 * `s3-bucket-policy-provider.ts`, which sits near the source file size cap.
 */
import { type ResourceNotFound, RESOURCE_NOT_FOUND } from '../../types/resource.js';
import type { ReadCurrentStateContext } from '../../types/resource.js';
import {
  declaredPolicyDocument,
  type MemberRead,
  policyDocumentMatchesDeclared,
  settleDeclaredMember,
  warnUnsettledMember,
} from '../settle-after-own-write.js';

type BucketPolicyRead = Record<string, unknown> | ResourceNotFound | undefined;

/** Stands for "no baseline" in {@link settleDeclaredMember}'s kept-declared arm. */
const NO_BASELINE: Record<string, unknown> = {};

/**
 * The bucket policy to record. `first` is one read as AWS gave it; on the
 * capture right after cdkd's own write, with a declared `PolicyDocument`, a
 * first answer that is not the declared document is re-read
 * (`PutBucketPolicy` / `DeleteBucketPolicy` are eventually consistent):
 *
 *  - settled: recorded as read;
 *  - still no policy after the schedule: no baseline (the policy IS the
 *    resource, so drift compares against the template, A1's queue-policy
 *    arm), never `RESOURCE_NOT_FOUND`, which would read as the policy gone;
 *  - another document: recorded as read;
 *  - a deterministic re-read failure ends the schedule, a transient one keeps
 *    the newest answer.
 *
 * Every other read (drift, import, `state refresh-observed`) takes `first`.
 */
export async function settleBucketPolicyRead(
  first: BucketPolicyRead,
  read: () => Promise<BucketPolicyRead>,
  options: {
    logicalId: string;
    properties: Record<string, unknown> | undefined;
    context: ReadCurrentStateContext | undefined;
    delaysMs: readonly number[];
    /** The bucket's partition, for the account id / root ARN fold (go-to-k/cdkd#6854). */
    partition?: string | undefined;
    logger: { warn: (message: string) => void };
  }
): Promise<BucketPolicyRead> {
  const declared =
    options.context?.afterOwnWrite === true
      ? declaredPolicyDocument(options.properties)
      : undefined;
  if (declared === undefined || first === undefined) return first;
  const asMember = (answer: BucketPolicyRead): MemberRead<Record<string, unknown>> =>
    answer === RESOURCE_NOT_FOUND ? 'absent' : answer === undefined ? 'failed' : { value: answer };
  const settled = await settleDeclaredMember(
    asMember(first),
    async () => asMember(await read()),
    (value) => policyDocumentMatchesDeclared(value['PolicyDocument'], declared, options.partition),
    NO_BASELINE,
    options.delaysMs,
    () =>
      warnUnsettledMember(
        options.logger,
        options.logicalId,
        'AWS::S3::BucketPolicy',
        'PolicyDocument'
      )
  );
  if (typeof settled !== 'object') return first;
  return settled.value === NO_BASELINE ? undefined : settled.value;
}
