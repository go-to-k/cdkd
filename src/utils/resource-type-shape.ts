/**
 * Resource-type shapes shared by the CLI parser and the messages that name a
 * type. An import-free LEAF, so `src/cli/options.ts` and
 * `src/utils/error-handler.ts` read ONE spelling of the pattern a message may
 * only suggest when the parser accepts it (go-to-k/cdkd#3773).
 */

/**
 * The LEFT-hand side `--resource-timeout` / `--resource-warn-after` accept in
 * `TYPE=<DURATION>`: exactly three segments (`AWS::S3::Bucket`). Intentionally
 * loose — there is no closed list of types — but it rejects obvious typos and
 * missing scopes at parse time.
 */
export const TIMEOUT_FLAG_RESOURCE_TYPE =
  /^[A-Z][A-Za-z0-9]+::[A-Z][A-Za-z0-9]+::[A-Z][A-Za-z0-9]+$/;

/**
 * The longest resource type a message names as typed: the CloudFormation
 * registry's `TypeName` limit. A longer value is described instead.
 */
export const RESOURCE_TYPE_MAX_LENGTH = 204;

const RESOURCE_TYPE_SHAPE =
  /^(?:[A-Z][A-Za-z0-9]+(?:::[A-Z][A-Za-z0-9]+)+|Custom::[A-Za-z0-9_@-]+)$/;

/**
 * True when `value` has a CloudFormation resource type's shape and fits
 * {@link RESOURCE_TYPE_MAX_LENGTH}: `AWS::S3::Bucket`, or a custom resource,
 * whose name after `Custom::` may also carry `-`, `_` and `@`
 * (`Custom::my-resource`). No whitespace and no `: `, so a value it admits can
 * neither open nor wrap into a labelled line of a message.
 */
export function hasResourceTypeShape(value: string): boolean {
  return value.length <= RESOURCE_TYPE_MAX_LENGTH && RESOURCE_TYPE_SHAPE.test(value);
}
