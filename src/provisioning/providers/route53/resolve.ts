import type { Route53Provider } from '../route53-provider.js';
import { ListHostedZonesByNameCommand } from '@aws-sdk/client-route-53';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markRedactedCause } from '../../../deployment/retryable-errors.js';
import {
  canonicalizeRoute53QueryName as canonicalizeQueryName,
  logicalIdShown,
} from '../../composite-id.js';
import {
  HostedZoneNameNotFoundError,
  parseRecordSetCompositeId,
  normalizeRecordName,
  zoneNameShown,
} from './shared.js';

// ─── RecordSet Helpers ────────────────────────────────────────────

/**
 * Resolve HostedZoneId from properties.
 * If HostedZoneId is provided, use it directly.
 * If HostedZoneName is provided, resolve it to a HostedZoneId via ListHostedZonesByName.
 *
 * `options.requirePrivateZone` narrows the name match to PRIVATE (`true`) or
 * PUBLIC (`false`) zones before the ambiguity decision below; leave it
 * undefined to match either. Split-horizon DNS is exactly a public and a
 * private zone sharing one name, so a caller that already knows which side
 * it wants resolves cleanly where the ambiguity guard would otherwise
 * refuse. `importHostedZone` is the one caller today, deriving the answer
 * from the template's own `VPCs` (declared = private, absent = public);
 * every RecordSet caller leaves it undefined, since a record set's template
 * says nothing about the zone's visibility.
 *
 * `options.subject` names what is being resolved FOR in the errors this
 * raises, and what remedy to point at. It exists because the messages are
 * user-facing and this helper is no longer RecordSet-only: telling someone
 * adopting a hosted zone to "pass the '<zoneId>|<name>|<type>' composite"
 * names a physicalId shape their resource does not have.
 */
export async function resolveHostedZoneId(
  this: Route53Provider,
  properties: Record<string, unknown>,
  logicalId: string,
  resourceType: string,
  physicalId?: string,
  options?: {
    requireUnambiguousZoneName?: boolean;
    requirePrivateZone?: boolean | undefined;
    subject?: { noun: string; remedy: string };
  }
): Promise<string> {
  const subject = options?.subject ?? {
    noun: 'record set',
    remedy:
      "set HostedZoneId explicitly, or pass the '<zoneId>|<name>|<type>' composite via --resource",
  };
  // Guard the TYPE, not just presence: an unresolved intrinsic
  // (`Fn::ImportValue` / `Fn::GetAtt` / a Parameter `Ref`) is an OBJECT and
  // therefore truthy, so an unguarded read stringifies it to
  // `[object Object]` and sends that to AWS as a zone id.
  const hostedZoneId = properties['HostedZoneId'];
  if (typeof hostedZoneId === 'string' && hostedZoneId) return hostedZoneId;

  // Declared out here because the terminal throw below is outside the
  // branch: a lookup that FAILED must surface its cause rather than the
  // misleading "specify one of these" message.
  let lookupErrorMessage: string | undefined;
  let lookupErrorCause: Error | undefined;
  // What the throw below shows of the lookup failure: AWS-authored text is
  // reduced to its class (go-to-k/cdkd#2319), and the warn beside the
  // assignment carries AWS's own text.
  let lookupErrorShown: string | undefined;
  let lookupErrorRedacted = false;

  // Declared outside the try for the same reason the two lookup-error
  // bindings above are: the ambiguity + sound-negative decisions below sit
  // outside it and both read this.
  const narrowing = options?.requirePrivateZone !== undefined;

  const hostedZoneName = properties['HostedZoneName'];
  if (typeof hostedZoneName === 'string' && hostedZoneName) {
    // The lookup keeps its ORIGINAL warn-and-continue catch — a transient
    // failure here must still fall through to the "specify one of these"
    // error below rather than surfacing raw. The ambiguity decision is made
    // AFTER the try deliberately: raising inside it would make this catch a
    // conditional re-throw rather than a swallow, which un-protects the
    // `.send()` for the `update-wrap-coverage` critic (and would be a real
    // hazard if a later edit widened what the try covers).
    let matched: {
      Id?: string | undefined;
      Name?: string | undefined;
      Config?: { PrivateZone?: boolean | undefined } | undefined;
    }[] = [];
    // NOT "the lookup returned" — "an empty result PROVES the zone is gone".
    // Only this flag authorizes the delete path's already-deleted arm, which
    // drops a state row, so it stays false for every answer we cannot read
    // as a sound negative.
    let absenceIsSound = false;
    try {
      const response = await this.getClient().send(
        new ListHostedZonesByNameCommand({
          // Case-folded + encoded: this is the START KEY of AWS's ordering,
          // not a filter. Sending the template's spelling verbatim
          // positions the window by `Example.com` while AWS orders by
          // `example.com.`, so an existing zone can fall outside a bounded
          // page and read as ABSENT — which on the delete path drops the
          // state row and orphans the record. That is the failure the
          // compare-side case fold alone does NOT close.
          DNSName: canonicalizeQueryName(hostedZoneName),
          // Deliberately > 1: split-horizon DNS lets a public and a private
          // zone share one name, and `MaxItems: 1` silently picks whichever
          // AWS lists first. Callers that DELETE through this resolution ask
          // for the ambiguity to be refused instead.
          MaxItems: 5,
        })
      );
      const zones = response.HostedZones ?? [];
      // Normalize BOTH sides — AWS returns the trailing dot and escapes
      // special characters, the template may do neither.
      const normalizedName = normalizeRecordName(hostedZoneName);
      matched = zones.filter((z) => normalizeRecordName(z.Name ?? '') === normalizedName);
      // Visibility narrowing, BEFORE the ambiguity decision below: a
      // split-horizon pair is two zones of one name that differ only in
      // `Config.PrivateZone`, so a caller that knows which side it wants
      // gets a clean resolution instead of a refusal.
      if (narrowing) {
        matched = matched.filter(
          (z) => (z.Config?.PrivateZone ?? false) === options?.requirePrivateZone
        );
      }
      // AWS starts the page AT the requested key, so same-named zones are
      // the first entries and a page that shows a LATER zone has already
      // proven ours is not there. An EMPTY truncated page proves nothing —
      // and neither does a name we could not position confidently, so a
      // template spelling that already carries a backslash escape is
      // refused the negative rather than guessed at.
      //
      // NARROWING CHANGES WHAT "a zone was returned" PROVES. Without it,
      // this line is only ever reached with an EMPTY `matched`, so any
      // returned zone is a LATER one and the run of same-named zones is
      // provably over. With it, `matched` can be emptied by the visibility
      // filter while the whole page is same-named zones of the other side —
      // and if that page is TRUNCATED, the zone we want may be the next
      // entry. Treating that as a sound negative would decline a zone that
      // exists and let the next deploy CREATE a duplicate, so the narrowed
      // case demands the stronger evidence: a DIFFERENT name on the page
      // (the same-named run ended inside it) or an untruncated page.
      const sawLaterName = zones.some((z) => normalizeRecordName(z.Name ?? '') !== normalizedName);
      absenceIsSound =
        !hostedZoneName.includes('\\') &&
        (narrowing
          ? sawLaterName || response.IsTruncated !== true
          : zones.length > 0 || response.IsTruncated !== true);
    } catch (error) {
      // `.detail` keeps this binding IDENTICAL to what the old expression
      // produced -- same text, so same truthiness at the condition below.
      // Stated as identity rather than as "non-empty", which an earlier
      // revision claimed and which is false: `new Error('')` yields `''`
      // under both spellings. The point is that nothing about this binding
      // changes, not that it is always populated.
      //
      // The THROWN `ProvisioningError` below shows `lookupErrorShown`
      // instead, since that message is persisted to `deployments/*.jsonl`
      // (go-to-k/cdkd#2319): the class for an AWS-authored failure, stamped
      // so `withRetry` still reads AWS's text on the `cause` chain.
      const failure = describeAwsFailure(error);
      lookupErrorMessage = failure.detail;
      lookupErrorCause = error instanceof Error ? error : undefined;
      lookupErrorRedacted = error instanceof Error && failure.redacted;
      // `failure.redacted`, not `lookupErrorRedacted`: a non-`Error` throw
      // is withheld too (its `String()` is the whole payload), unstamped.
      lookupErrorShown = failure.redacted ? failure.summary : failure.detail;
      // The class at warn, AWS's text at debug (go-to-k/cdkd#2319): a denied
      // listing names the caller's assumed-role ARN.
      const lookupHead = `Failed to resolve HostedZoneName "${hostedZoneName}" for ${logicalId}: `;
      this.logger.warn(`${lookupHead}${this.warnFailureText(lookupHead, error, undefined)}`);
    }

    if (matched.length > 1 && options?.requireUnambiguousZoneName) {
      // Split-horizon is the usual cause, but ONLY when nothing narrowed the
      // match — after a visibility filter the survivors are all on one side,
      // so naming public/private there would point at the wrong thing.
      const cause = narrowing ? '' : ' (split-horizon public/private DNS)';
      // Ends in `subject.remedy`, a `--resource` fragment, so the logical id
      // and the zone name are shown only when plain (go-to-k/cdkd#4226).
      throw new ProvisioningError(
        `HostedZoneName ${zoneNameShown(hostedZoneName)} matches ${matched.length} hosted zones ` +
          `for ${logicalIdShown(logicalId)}${cause}. Refusing to guess which one is meant — ${subject.remedy}.`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const matchedZone = matched[0];
    if (matchedZone?.Id) {
      return matchedZone.Id.replace('/hostedzone/', '');
    }

    // A name WAS specified and the lookup returned a SOUND NEGATIVE —
    // materially different from "no zone was specified", and the delete path
    // treats it as already-gone rather than as a misconfiguration.
    if (absenceIsSound) {
      // Name the SIDE when one was required: "matches no hosted zone" would
      // be wrong for a template whose public twin is sitting right there.
      const visibility =
        options?.requirePrivateZone === undefined
          ? ''
          : options.requirePrivateZone
            ? 'private '
            : 'public ';
      throw new HostedZoneNameNotFoundError(
        `HostedZoneName "${hostedZoneName}" matches no ${visibility}hosted zone ` +
          `in this account/region for ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  // Three ways to land here, and they are NOT the same failure. The middle
  // arm exists because reaching this line with a name in hand is possible
  // (the listing was INCONCLUSIVE — a truncated page that never showed a
  // later name, or a template spelling carrying a backslash escape we will
  // not position against AWS's ordering), and reporting that as "specify a
  // zone" names neither the cause nor a remedy for a user who did specify
  // one.
  // The first arm reaches a THROWN message that `extractDeploymentEventError`
  // persists, so it shows `lookupErrorShown` (AWS's class, not its text, for
  // an AWS-authored failure; go-to-k/cdkd#2319) and is stamped below. Its
  // truthiness stays keyed on `lookupErrorMessage`. The middle arm ends in
  // `subject.remedy`, a `--resource` fragment, so it shows the logical id
  // and the zone name only when plain (go-to-k/cdkd#4226).
  const unresolved = new ProvisioningError(
    lookupErrorMessage
      ? `Could not resolve HostedZoneName "${String(hostedZoneName)}" for ${subject.noun} ` +
          `${logicalId}: ${lookupErrorShown}`
      : typeof hostedZoneName === 'string' && hostedZoneName
        ? `Could not determine whether HostedZoneName ${zoneNameShown(hostedZoneName)} exists for ` +
          `${subject.noun} ${logicalIdShown(logicalId)} — the hosted-zone listing ended before the name ` +
          `could be resolved either way, so cdkd will not assume it is absent. ` +
          `${subject.remedy}.`
        : `Either HostedZoneId or HostedZoneName is required for ${subject.noun} ${logicalId}`,
    resourceType,
    logicalId,
    physicalId,
    lookupErrorCause
  );
  throw lookupErrorMessage && lookupErrorRedacted ? markRedactedCause(unresolved) : unresolved;
}

/**
 * Recover `(hostedZoneId, name, type)` for a record set from EITHER shape of
 * physicalId (issue #1658).
 *
 * cdkd's own composite carries all three. CloudFormation's physicalId is the
 * record name alone, so the zone has to be resolved from the recorded
 * properties — which is exactly what `createRecordSet` does, so the answer is
 * the same triple the composite would have held. Returns `undefined` (rather
 * than throwing) when the zone cannot be resolved, because both callers of
 * this helper treat "cannot determine" as "nothing to report" rather than as
 * a failure.
 */
export async function resolveRecordSetIdentity(
  this: Route53Provider,
  physicalId: string,
  properties?: Record<string, unknown>,
  options?: { requireUnambiguousZoneName?: boolean }
): Promise<{ hostedZoneId: string; name: string; type: string } | undefined> {
  // Cross-checked against the template for the same reason `importRecordSet`
  // cross-checks its own early accept (issue #1711): three non-empty segments
  // is not proof of a composite, and a record NAME carrying two pipes decodes
  // to a different zone here just as it does there. Without `properties`
  // there is nothing to check against, so the pre-#1711 behavior stands.
  // A name carrying `|` (issue #3890) is only a candidate split, so with no
  // bag to anchor it on it is never trusted.
  const composite = parseRecordSetCompositeId(physicalId);
  if (
    composite &&
    (properties
      ? this.compositeAgreesWithTemplate(composite, properties)
      : !composite.nameCarriesSeparator)
  ) {
    return composite;
  }
  if (!properties) return undefined;

  const name = typeof properties['Name'] === 'string' ? properties['Name'] : physicalId;
  const type = properties['Type'];
  if (!name || typeof type !== 'string' || !type) return undefined;

  try {
    const hostedZoneId = await this.resolveHostedZoneId(
      properties,
      'RecordSet',
      'AWS::Route53::RecordSet',
      physicalId,
      options
    );
    return { hostedZoneId, name, type };
  } catch (err) {
    // Both callers treat "cannot determine" as "nothing to report" rather
    // than as a failure, but say WHY at debug level — a swallowed throttle
    // or credential error is otherwise indistinguishable from a template
    // that simply does not name a zone.
    this.logger.debug(
      `Cannot resolve record-set identity for '${physicalId}': ${describeAwsFailure(err).detail}`
    );
    return undefined;
  }
}
