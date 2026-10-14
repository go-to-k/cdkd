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
 * the ways through — never asserts the cause.
 *
 * Wording constraint: it is appended to an error message that downstream
 * matchers read (`isNotFoundMessage`, the retryable-error pattern table), so it
 * must not carry a "not found" / "does not exist" / "no such" phrase nor any
 * retryable-pattern substring. Pinned by a unit test.
 */

// The shapes `src/cli/options.ts` accepts (`RESOURCE_PROPERTY_FORMAT`,
// `LOGICAL_ID_FORMAT`), so a value shown in a flag is one the flag parses.
const TYPE_FORMAT = /^[A-Z][A-Za-z0-9]+(::[A-Z][A-Za-z0-9]+)+$/;
const PROPERTY_FORMAT = /^[A-Z][A-Za-z0-9]*$/;
const LOGICAL_ID_FORMAT = /^[A-Za-z][A-Za-z0-9]{0,254}$/;

/**
 * The note to append to the failed update's message. A value the flags would
 * not parse is replaced by a placeholder, so the flags stay pasteable and a
 * template-chosen string never reaches the line verbatim.
 *
 * `nestedChild`: the resource lives in a nested stack, whose resources
 * `--recreate-via-cc-api` cannot address (it matches the deployed stack's own
 * template only), so that remedy is not offered there.
 */
export function ccAutoRouteUpdateFailureRemedy(
  logicalId: string,
  resourceType: string,
  autoRoutedProperties: readonly string[],
  nestedChild = false
): string {
  const id = LOGICAL_ID_FORMAT.test(logicalId) ? logicalId : '<logicalId>';
  const type = TYPE_FORMAT.test(resourceType) ? resourceType : '<Type>';
  const props = autoRoutedProperties.map((p) => (PROPERTY_FORMAT.test(p) ? p : '<Property>'));
  const shown = props.length > 0 ? props.join(', ') : 'a property';
  const override =
    props.length > 0 ? props.map((p) => `${type}:${p}`).join(',') : `${type}:<Property>`;
  const them = props.length === 1 ? 'that property' : 'those properties';
  const preferSdk = `keep it on the SDK provider without sending ${them} with --prefer-sdk-route ${override}`;
  return (
    `\nThis update moved the resource from its SDK provider to Cloud Control API, ` +
    `because the SDK provider does not handle ${shown}. Cloud Control addresses it by ` +
    `the physical id the SDK provider recorded, and for some types that is not an ` +
    `identifier Cloud Control accepts. ` +
    (nestedChild
      ? `It is in a nested stack, which --recreate-via-cc-api cannot address: ` +
        `${preferSdk}, or remove ${them} from the template.`
      : `Two ways through: re-create the resource on Cloud Control with ` +
        `--recreate-via-cc-api ${id} (destroys and re-creates it), or ${preferSdk}.`)
  );
}
