/**
 * The last segment of a stack's `AWS::StackId` (state schema v16,
 * go-to-k/cdkd#6170).
 *
 * CloudFormation's stack id ends in a per-stack UUID
 * (`arn:aws:cloudformation:<region>:<account>:stack/<name>/<uuid>`), and CDK
 * apps cut it out for a unique-per-stack name suffix
 * (`Fn.select(2, Fn.split('/', Aws.STACK_ID))`, then a `-` split). cdkd used
 * the constant `cdkd` there, so that idiom gave every stack the same suffix,
 * or an out-of-bounds `Fn::Select`.
 *
 * A stack whose record carries `stackIdFromInstance` gets a UUID derived
 * one-way from its `stackInstanceId`: unique per stack lifetime, stable across
 * deploys, and computed from the record alone, so resolving it costs no AWS
 * call. The id itself is never logged, and the digest does not disclose it.
 * Every other record keeps `cdkd`: its resources were named from that value.
 */
import { createHash } from 'node:crypto';
import { stackInstanceIdOf } from './stack-instance-id.js';

/** The tail every record without `stackIdFromInstance` keeps. */
export const LEGACY_STACK_ID_TAIL = 'cdkd';

/**
 * The UUID-shaped tail for `stackInstanceId`: the first 16 bytes of
 * `sha256("AWS::StackId" NUL id)`, with the RFC 4122 version (4) and variant
 * bits set, so a consumer parsing it as a UUID accepts it. The name-suffix
 * hash (`stackInstanceNameSuffix`) hashes `id NUL <name>`, whose input starts
 * with the lowercase-hex id, so no name -- whatever a template calls a
 * resource -- makes the two digests share an input.
 */
export function stackIdTailFromInstanceId(stackInstanceId: string): string {
  const bytes = createHash('sha256')
    .update('AWS::StackId')
    .update('\u0000')
    .update(stackInstanceId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The `AWS::StackId` tail for a stack record: the derived UUID when the record
 * carries `stackIdFromInstance`, else `undefined` (the resolver then uses
 * {@link LEGACY_STACK_ID_TAIL}). A marker that is not `true`, or one beside a
 * missing id, refuses rather than falling back: the fallback would change the
 * value the stack's resources were named from. A malformed id refuses through
 * `stackInstanceIdOf`.
 */
export function stackIdTailOf(
  state: { stackIdFromInstance?: unknown; stackInstanceId?: unknown } | null | undefined,
  stackLabel: string
): string | undefined {
  const marker = state?.stackIdFromInstance;
  if (marker === undefined) return undefined;
  if (marker !== true) {
    throw new Error(
      `The state record of ${stackLabel} holds a stackIdFromInstance that is not true. cdkd does ` +
        'not guess whether its AWS::StackId derives from its stackInstanceId, since resources may ' +
        'be named from it; restore the field from an earlier version of state.json.'
    );
  }
  const id = stackInstanceIdOf(state, stackLabel);
  if (id === undefined) {
    throw new Error(
      `The state record of ${stackLabel} marks its AWS::StackId as derived from its stackInstanceId, ` +
        'but holds no stackInstanceId. cdkd does not fall back to the legacy value, since resources ' +
        'may be named from it; restore the field from an earlier version of state.json.'
    );
  }
  return stackIdTailFromInstanceId(id);
}
