/**
 * What a failed UPDATE says when this deploy auto-routed an SDK-provisioned
 * resource through Cloud Control (issue
 * [#4904](https://github.com/go-to-k/cdkd/issues/4904)).
 *
 * The update addresses the resource by the physical id its SDK provider
 * recorded, sent verbatim as the Cloud Control `Identifier`. Whether that is
 * the type's Cloud Control identifier is a per-type fact nobody has measured
 * for most types (see `STICKY_CC_MIGRATION_EXEMPT`), so the failure may be that
 * mismatch or anything else Cloud Control rejected. The note therefore says
 * the update was the move, names the possible cause conditionally, and gives
 * the two ways through — never asserts the cause.
 *
 * Wording constraint: it is appended to an error message that downstream
 * matchers read (`isNotFoundMessage`, the retryable-error pattern table), so it
 * must not carry a "not found" / "does not exist" / "no such" phrase nor any
 * retryable-pattern substring. Pinned by a unit test.
 */

const PLAIN_TYPE = /^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/;
const PLAIN_PROPERTY = /^[A-Za-z0-9]+$/;
const PLAIN_LOGICAL_ID = /^[A-Za-z0-9]+$/;

/**
 * The note to append to the failed update's message. Values that are not plain
 * identifiers are replaced by placeholders, so the flags stay pasteable and a
 * template-chosen string never reaches the line verbatim.
 */
export function ccAutoRouteUpdateFailureRemedy(
  logicalId: string,
  resourceType: string,
  autoRoutedProperties: readonly string[]
): string {
  const id = PLAIN_LOGICAL_ID.test(logicalId) ? logicalId : '<logicalId>';
  const type = PLAIN_TYPE.test(resourceType) ? resourceType : '<Type>';
  const props = autoRoutedProperties.map((p) => (PLAIN_PROPERTY.test(p) ? p : '<Property>'));
  const shown = props.length > 0 ? props.join(', ') : 'a property';
  const override =
    props.length > 0 ? props.map((p) => `${type}:${p}`).join(',') : `${type}:<Property>`;
  return (
    `\nThis update moved the resource from its SDK provider to Cloud Control API, ` +
    `because the SDK provider does not handle ${shown}. Cloud Control addresses it by ` +
    `the physical id the SDK provider recorded, and for some types that is not an ` +
    `identifier Cloud Control accepts. Two ways through: re-create the resource on ` +
    `Cloud Control with --recreate-via-cc-api ${id} (destroys and re-creates it), or ` +
    `keep it on the SDK provider without sending ${props.length === 1 ? 'that property' : 'those properties'} ` +
    `with --prefer-sdk-route ${override}.`
  );
}
