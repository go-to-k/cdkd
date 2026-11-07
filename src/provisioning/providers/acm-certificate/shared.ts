import { describeAwsFailure } from '../../../utils/aws-failure-text.js';

/**
 * go-to-k/cdkd#4911: the name half of {@link isCertificateInUseError}, the one
 * that may decide a verdict (`oldResourceSurvivor`): a message is never read
 * for one.
 */
export function certificateInUseByName(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current.name === 'ResourceInUseException') return true;
    current = current.cause;
  }
  return false;
}

/**
 * True for ACM's refusal to delete a certificate a consumer still references
 * (issue [#1922](https://github.com/go-to-k/cdkd/issues/1922)).
 *
 * Matched by error NAME first, with a message fallback: the SDK raises
 * `ResourceInUseException`, but a wrapped / re-thrown error can lose the class
 * while keeping the text. Deliberately narrow — this only picks the
 * remediation wording and the reason phrasing, and every other failure still
 * reaches the same `'partial'` outcome, so a miss degrades to a less specific
 * message rather than to the pre-#1922 silence.
 */
export function isCertificateInUseError(error: unknown): boolean {
  // Walk the CAUSE CHAIN, not just the top error. `delete()` wraps every
  // non-not-found failure in a `ProvisioningError`, so by the time the
  // replacement's catch sees it the SDK class is one level down and the top
  // `name` is always `ProvisioningError`. Checking only the top is how the
  // first version of this classifier could never fire on the real path -- and
  // its unit test still passed, because that test's fixture message had been
  // hand-authored to contain the phrase the regex looked for.
  // Depth-BOUNDED, like both walks in `retryable-errors.ts`: a cyclic `.cause`
  // chain would spin synchronously and never yield, so `withResourceDeadline`'s
  // timer could not fire and the deploy would hang at 100% CPU rather than time
  // out. Five levels is far more than any real wrap depth here (provider ->
  // ProvisioningError is one).
  if (certificateInUseByName(error)) return true;
  // Message fallback for a re-thrown error that kept the text but lost the
  // class. `/in use/i`, NOT `/still in use/`: ACM's own wording is
  // `Certificate arn:... is in use.` -- the stricter phrase matched nothing AWS
  // actually sends.
  // `.detail`, byte-identical to the `instanceof Error ? .message : String()`
  // ternary, but it cannot throw on a value `String()` cannot convert (a
  // null-prototype object). Defence in depth: this runs inside the
  // replacement's catch, whose `'partial'` outcome an out-throw would discard,
  // but `delete()` wraps every failure in a `ProvisioningError` today, so no
  // non-`Error` reaches it (go-to-k/cdkd#3361).
  const message = describeAwsFailure(error).detail;
  return /ResourceInUseException|in use/i.test(message);
}

/** TTL CloudFormation gives the DNS validation record it writes. */
export const VALIDATION_RECORD_TTL = 300;

/**
 * The hosted zone to write each domain's DNS validation record into, from the
 * template's `DomainValidationOptions[].HostedZoneId`. Only for DNS validation
 * (CloudFormation allows `HostedZoneId` with no other method); a domain without
 * a zone is left to the user, who is shown the record to add.
 */
export function dnsValidationZones(properties: Record<string, unknown>): Map<string, string> {
  const zones = new Map<string, string>();
  const options = properties['DomainValidationOptions'];
  if (properties['ValidationMethod'] !== 'DNS' || !Array.isArray(options)) return zones;
  for (const option of options as Array<Record<string, unknown>>) {
    const domain = option['DomainName'];
    const zone = option['HostedZoneId'];
    if (typeof domain === 'string' && domain && typeof zone === 'string' && zone) {
      zones.set(domain, zone);
    }
  }
  return zones;
}
