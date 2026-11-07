import type { ACMCertificateProvider } from '../acm-certificate-provider.js';
import { DescribeCertificateCommand, type DomainValidation } from '@aws-sdk/client-acm';
import { ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { displayIdent, safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { getAwsClients } from '../../../utils/aws-clients.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { isPlainImportValue, VALUE_NOT_SHOWN } from '../../import-helpers.js';
import { logicalIdShown } from '../../composite-id.js';
import { commandHole } from '../../../utils/pasteable-command.js';
import { VALIDATION_RECORD_TTL } from './shared.js';

/**
 * Poll `DescribeCertificate` until status === `ISSUED`. On the FIRST poll
 * that returns PENDING_VALIDATION, log the DomainValidationOptions AWS
 * posted so the user knows which CNAME records to add to their DNS zone.
 *
 * Throws on `VALIDATION_TIMED_OUT` / `FAILED` (terminal failures) and on
 * polling-cap exhaustion (treated as timeout). SIGINT short-circuits the
 * loop and returns control to the deploy engine's cleanup path.
 *
 * Both throws are `ProvisioningError`s carrying `certificateArn` as their
 * `physicalId` (issue
 * [#2169](https://github.com/go-to-k/cdkd/issues/2169)). They used to be
 * plain `Error`s whose only reference to the certificate was the message
 * TEXT, which is not something a caller can act on. The certificate is real
 * by the time either fires, so the error that reports the failure is the one
 * piece of the failure path that should still be able to name it.
 *
 * Says nothing about what happens to the certificate afterwards: the caller
 * owns that. `create()`'s catch retires it (see
 * {@link ACMCertificateProvider.cleanupRequestedCertificate}) and appends a
 * note to this message only when that cleanup could NOT.
 */
export async function waitForCertificateIssued(
  this: ACMCertificateProvider,
  certificateArn: string,
  logicalId: string,
  resourceType: string,
  zones: ReadonlyMap<string, string> = new Map()
): Promise<void> {
  this.logger.debug(`Waiting for ACM certificate ${certificateArn} to reach ISSUED status...`);
  /** Validation records already written, so a later poll does not write one twice. */
  const written = new Map<string, Set<string>>();
  let interrupted = false;
  /** The last validation-record block printed, so we re-print only on a CHANGE. */
  let lastValidationOptions: string | undefined;

  const sigintHandler = () => {
    interrupted = true;
  };
  process.on('SIGINT', sigintHandler);

  try {
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt++) {
      if (interrupted) {
        this.logger.debug(
          `ACM certificate ${certificateArn} wait interrupted by SIGINT, proceeding`
        );
        return;
      }

      const resp = await this.acmClient.send(
        new DescribeCertificateCommand({ CertificateArn: certificateArn })
      );
      const status = resp.Certificate?.Status;
      const validations = resp.Certificate?.DomainValidationOptions ?? [];

      if (status === 'ISSUED') {
        this.logger.debug(`ACM certificate ${certificateArn} is ISSUED`);
        return;
      }
      // Every terminal-failure status: validation timed out, validation
      // failed, or the cert was administratively disabled / revoked / let
      // expire while we were polling. Looping past any of these would just
      // time out with a misleading "did not reach ISSUED" message.
      if (
        status === 'FAILED' ||
        status === 'VALIDATION_TIMED_OUT' ||
        status === 'INACTIVE' ||
        status === 'REVOKED' ||
        status === 'EXPIRED'
      ) {
        // A failed cleanup appends the survivor note, with its pasteable
        // `aws acm delete-certificate`, to this line, so the logical id and
        // the ARN are shown only when plain (go-to-k/cdkd#4295).
        throw new ProvisioningError(
          `ACM certificate ${logicalIdShown(logicalId)} ${isPlainImportValue(certificateArn) ? `(${certificateArn})` : VALUE_NOT_SHOWN} entered terminal status ${status} during validation. ` +
            `Check ACM console / DNS records to diagnose.`,
          resourceType,
          logicalId,
          certificateArn
        );
      }

      // Print the validation records whenever what we can show has CHANGED,
      // rather than latching after the first attempt (issue #2169, review
      // rounds 2 and 3). Two failure modes made a latch wrong, and the second
      // is why this is content-based rather than a smarter boolean:
      //
      //  - The first `DescribeCertificate` fires seconds after
      //    `RequestCertificate`, and ACM commonly answers it with
      //    `DomainValidationOptions` carrying no `ResourceRecord` yet -- the
      //    API reference warns of exactly that delay. Latching there printed
      //    a header with nothing under it and suppressed every later poll.
      //  - For a certificate with SANs, ACM fills those records in per
      //    domain and not necessarily together. Latching on "I printed
      //    SOMETHING" then shows one domain's CNAME and permanently hides
      //    the rest, which is the same dead end one level down.
      //
      // Both used to be survivable because the certificate outlived the
      // failed deploy and the records could be read from the ACM console.
      // This provider now DELETES it, so whatever this loop printed is
      // generally the user's only copy -- and if no poll ever carried a
      // `ResourceRecord`, there is no copy at all, which is why the message
      // below tells them to re-run rather than to look further up.
      if (status === 'PENDING_VALIDATION') {
        // A record whose domain has a `HostedZoneId` is written here, on the poll
        // that first carries it; only the rest is left for the user to add.
        await this.writeValidationRecords(
          validations,
          zones,
          written,
          certificateArn,
          logicalId,
          resourceType
        );
        const rendered = this.renderValidationOptions(
          validations.filter((v) => !(v.DomainName && zones.has(v.DomainName)))
        );
        if (rendered !== undefined && rendered !== lastValidationOptions) {
          this.logger.info(rendered);
          lastValidationOptions = rendered;
        }
      }

      this.logger.debug(
        `ACM certificate ${certificateArn} status: ${status} (attempt ${attempt}/${this.maxPollAttempts})`
      );

      // Interruptible sleep, check SIGINT every second (or the full
      // interval if it's < 1s, so test runs with `CDKD_ACM_POLL_INTERVAL_MS=50`
      // don't waste a full second per attempt).
      const sleepEnd = Date.now() + this.pollIntervalMs;
      const tickMs = Math.min(1000, this.pollIntervalMs);
      while (Date.now() < sleepEnd && !interrupted) {
        await new Promise((resolve) => setTimeout(resolve, tickMs));
      }
    }

    // This line also names `--resource-timeout`, so the logical id and the
    // ARN are shown only when plain and the per-type duration is a quoted
    // hole (go-to-k/cdkd#4295): a bare `<duration>` redirects when pasted.
    throw new ProvisioningError(
      `ACM certificate ${logicalIdShown(logicalId)} ${isPlainImportValue(certificateArn) ? `(${certificateArn})` : VALUE_NOT_SHOWN} did not reach ISSUED status within ${(this.maxPollAttempts * this.pollIntervalMs) / 1000}s. ` +
        // Conditional, because the certificate is about to be deleted and
        // this sentence is the user's instruction for what to do next. If no
        // poll ever carried a `ResourceRecord`, nothing was printed and
        // "printed above" sends them looking for output that does not exist.
        (lastValidationOptions === undefined
          ? `AWS had not published this certificate's validation records before the wait ran out, so none were printed — ` +
            `re-run the deploy to request them again. `
          : `Add the validation records printed above to your DNS zone and re-run the deploy. `) +
        `ACM reuses a domain's validation CNAME across certificates, so records you add now validate the next attempt. ` +
        `To wait LONGER, raise CDKD_ACM_POLL_ATTEMPTS / CDKD_ACM_POLL_INTERVAL_MS — this cap is the provider's OWN ` +
        `and is what just fired; --resource-timeout alone will not lengthen it. Past ~30m also raise ` +
        `--resource-timeout AWS::CertificateManager::Certificate=${commandHole('duration')}, or the engine's per-resource deadline ` +
        `becomes the shorter of the two. Or set CDKD_NO_WAIT=true to keep the certificate and validate it out of band.`,
      resourceType,
      logicalId,
      certificateArn
    );
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }
}

/**
 * Write the DNS validation CNAME of every domain that names a hosted zone, as
 * CloudFormation does for `DomainValidationOptions[].HostedZoneId`. An UPSERT:
 * the record is derived from the domain and the account, so a certificate
 * that is replaced finds it already there with the same value.
 *
 * The record is NOT removed when the certificate is deleted. It is shared by
 * every certificate for the domain, and CloudFormation leaves it too.
 *
 * @throws ProvisioningError (carrying the certificate ARN) when the write fails,
 *   so the caller retires the certificate it requested.
 */
export async function writeValidationRecords(
  this: ACMCertificateProvider,
  validations: DomainValidation[],
  zones: ReadonlyMap<string, string>,
  written: Map<string, Set<string>>,
  certificateArn: string,
  logicalId: string,
  resourceType: string
): Promise<void> {
  for (const validation of validations) {
    const zone = validation.DomainName ? zones.get(validation.DomainName) : undefined;
    const record = validation.ResourceRecord;
    if (!zone || !record?.Name || !record.Value) {
      continue;
    }
    if (written.get(zone)?.has(record.Name)) continue;
    try {
      await getAwsClients().route53.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: zone,
          ChangeBatch: {
            Changes: [
              {
                Action: 'UPSERT',
                ResourceRecordSet: {
                  Name: record.Name,
                  Type: 'CNAME',
                  TTL: VALIDATION_RECORD_TTL,
                  ResourceRecords: [{ Value: record.Value }],
                },
              },
            ],
          },
        })
      );
    } catch (error) {
      throw new ProvisioningError(
        safeMsg`ACM certificate ${displayIdent(logicalId)} could not get its DNS validation record ${displayIdent(record.Name)} written to hosted zone ${displayIdent(zone)}: ${describeAwsFailure(error).summary}. The caller needs route53:ChangeResourceRecordSets on that zone.`,
        resourceType,
        logicalId,
        certificateArn,
        error instanceof Error ? error : undefined
      );
    }
    const inZone = written.get(zone) ?? new Set<string>();
    inZone.add(record.Name);
    written.set(zone, inZone);
    this.logger.info(
      safeMsg`Wrote DNS validation record ${displayIdent(record.Name)} to hosted zone ${displayIdent(zone)} for ${displayIdent(validation.DomainName)}`
    );
  }
}

/**
 * Pretty-print the validation records AWS expects in the DNS zone, so the
 * user can copy / paste them into Route 53 / Cloudflare / etc. while the
 * cert is still PENDING_VALIDATION.
 */
export function renderValidationOptions(
  this: ACMCertificateProvider,
  validations: DomainValidation[]
): string | undefined {
  const lines: string[] = [
    'ACM certificate is PENDING_VALIDATION. Add the following DNS records to validate:',
  ];
  for (const v of validations) {
    if (v.ValidationMethod === 'DNS' && v.ResourceRecord) {
      const r = v.ResourceRecord;
      lines.push(`  ${v.DomainName} — ${r.Type} ${r.Name} with value ${r.Value}`);
    } else if (v.ValidationMethod === 'EMAIL' && (v.ValidationEmails ?? []).length > 0) {
      lines.push(
        `  ${v.DomainName} — confirmation email sent to: ${v.ValidationEmails!.join(', ')}`
      );
    }
    // Anything else is a domain AWS has not filled in yet. Skipped rather
    // than rendered as a placeholder: a `<none>` line reads like an answer,
    // and it would make this block differ from the one printed once the real
    // value arrives only in ways the user cannot act on.
  }
  // Header alone: nothing actionable to show on this poll. Returning
  // `undefined` (rather than the bare header) is what stops a lone header
  // going out and, with it, the caller recording it as "already shown".
  return lines.length === 1 ? undefined : lines.join('\n');
}
