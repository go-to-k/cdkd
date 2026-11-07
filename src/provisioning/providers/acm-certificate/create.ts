import type { ACMCertificateProvider } from '../acm-certificate-provider.js';
import {
  RequestCertificateCommand,
  DeleteCertificateCommand,
  ResourceNotFoundException,
  type RequestCertificateRequest,
} from '@aws-sdk/client-acm';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { CdkdError, ProvisioningError } from '../../../utils/error-handler.js';
import { isPlainImportValue, VALUE_NOT_SHOWN } from '../../import-helpers.js';
import { logicalIdShown } from '../../composite-id.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { acquireIdempotencyToken, type IdempotencyToken } from '../idempotency-token.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { dnsValidationZones } from './shared.js';

export async function create(
  this: ACMCertificateProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Requesting ACM certificate ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const domainName = properties['DomainName'] as string | undefined;
  if (!domainName) {
    throw new ProvisioningError(
      `DomainName is required for ACM certificate ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const input: Record<string, unknown> = { DomainName: domainName };
  if (properties['ValidationMethod']) {
    input['ValidationMethod'] = properties['ValidationMethod'];
  }
  if (Array.isArray(properties['SubjectAlternativeNames'])) {
    input['SubjectAlternativeNames'] = properties['SubjectAlternativeNames'];
  }
  if (Array.isArray(properties['DomainValidationOptions'])) {
    // CFn shape is `{DomainName, HostedZoneId?, ValidationDomain?}`. The ACM
    // API's `DomainValidationOption` is `{DomainName, ValidationDomain}` with
    // BOTH required, so an entry without a `ValidationDomain` cannot be sent:
    // the SDK serializes the missing member as null and ACM answers
    // "Member must not be null". Such an entry carries nothing ACM needs (the
    // CDK writes `{DomainName, HostedZoneId}` for DNS validation by hosted
    // zone), so it is left out and ACM applies its own default. `HostedZoneId`
    // is not an ACM input; it is used for the Route 53 write below.
    const options = (properties['DomainValidationOptions'] as Array<Record<string, unknown>>)
      .filter((opt) => opt['DomainName'] && opt['ValidationDomain'])
      .map((opt) => ({
        DomainName: opt['DomainName'],
        ValidationDomain: opt['ValidationDomain'],
      }));
    if (options.length > 0) input['DomainValidationOptions'] = options;
  }
  if (properties['CertificateAuthorityArn']) {
    input['CertificateAuthorityArn'] = properties['CertificateAuthorityArn'];
  }
  if (properties['KeyAlgorithm']) {
    input['KeyAlgorithm'] = properties['KeyAlgorithm'];
  }
  // CFn flat top-level `CertificateTransparencyLoggingPreference` /
  // `CertificateExport` map to the SDK's nested `Options: { ... }`.
  const options: Record<string, unknown> = {};
  if (properties['CertificateTransparencyLoggingPreference']) {
    options['CertificateTransparencyLoggingPreference'] =
      properties['CertificateTransparencyLoggingPreference'];
  }
  if (properties['CertificateExport']) {
    options['Export'] = properties['CertificateExport'];
  }
  if (Object.keys(options).length > 0) {
    input['Options'] = options;
  }
  if (tags.length > 0) {
    input['Tags'] = tags;
  }

  // Issue #2039's mechanism applied to `RequestCertificate` (issue #2169
  // names its absence). The engine's outer `withRetry` re-invokes `create()`
  // from the top on a transient failure, and since issue #2026 a bare HTTP
  // 5xx counts as one — so a request that actually SUCCEEDED server-side
  // before the connection broke would mint a SECOND certificate, with the
  // first left un-named by anything. `acquireIdempotencyToken` returns the
  // same value for every attempt of one logical create and a fresh one after
  // a success, which is exactly ACM's contract ("if you call
  // RequestCertificate multiple times with the same idempotency token within
  // one hour, ACM ... will issue only one").
  //
  // `charset: 'alphanumeric'` / `maxLength: 32` are ACM's documented
  // constraints on the field (`Pattern: \w+`, `Maximum length of 32`); the
  // helper's default `cdkd-<hex>` spelling contains a hyphen, which `\w`
  // does not accept, so the request would be REJECTED rather than merely
  // un-deduplicated.
  //
  // Note this closes the IN-PROCESS duplicate window only. ACM retires the
  // token after an hour and cdkd mints a per-process nonce into it anyway, so
  // a re-run of `cdkd deploy` after a failed one is a genuinely new request —
  // that half is what `cleanupRequestedCertificate` addresses, by leaving the
  // failed attempt's certificate deleted so there is nothing to accumulate.
  const idempotencyToken = acquireIdempotencyToken({
    scope: 'RequestCertificate',
    logicalId,
    maxLength: 32,
    charset: 'alphanumeric',
  });
  input['IdempotencyToken'] = idempotencyToken.value;

  // The certificate this call brought into being, tracked from the moment AWS
  // confirms it (issue #2169). Everything after `RequestCertificate` can
  // fail, and until this existed the ARN left the method only inside an
  // error's message TEXT -- which nothing downstream can act on.
  let requestedArn: string | undefined;

  try {
    const response = await this.acmClient.send(
      new RequestCertificateCommand(input as unknown as RequestCertificateRequest)
    );
    const certificateArn = response.CertificateArn;
    if (!certificateArn) {
      throw new ProvisioningError(
        `RequestCertificate succeeded but no CertificateArn returned for ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    requestedArn = certificateArn;
    // go-to-k/cdkd#5511: report before the issuance wait.
    reportCreatedResource(logicalId, resourceType, certificateArn);
    this.logger.debug(`Requested ACM certificate: ${certificateArn}`);

    const noWait = process.env['CDKD_NO_WAIT'] === 'true';
    if (!noWait) {
      await this.waitForCertificateIssued(
        certificateArn,
        logicalId,
        resourceType,
        dnsValidationZones(properties)
      );
    } else {
      this.logger.warn(
        `Skipping wait for ACM certificate ${logicalId} (CDKD_NO_WAIT=true). ` +
          `Downstream consumers (CloudFront / ALB) will fail until the cert reaches ISSUED.`
      );
    }

    // Success path only, per `acquireIdempotencyToken`'s contract: releasing
    // on failure would hand the next attempt a different token and reinstate
    // the duplicate window the token exists to close.
    idempotencyToken.release();

    return {
      physicalId: certificateArn,
      attributes: {
        Arn: certificateArn,
        CertificateArn: certificateArn,
      },
    };
  } catch (error) {
    // Issue #2169: retire the certificate this call created before the error
    // leaves. `requestedArn` is set only once AWS has answered, so a failure
    // BEFORE the request (a missing DomainName, a rejected input) deletes
    // nothing.
    const survivorNote = requestedArn
      ? await this.cleanupRequestedCertificate(
          requestedArn,
          logicalId,
          idempotencyToken,
          context?.maskSecrets
        )
      : undefined;
    // go-to-k/cdkd#5511: the cleanup deleted the certificate.
    if (requestedArn && survivorNote === undefined) {
      retractCreatedResource(logicalId, resourceType, requestedArn);
    }

    // Pass through cdkd-typed errors untouched (#1272): re-labelling an inner
    // ProvisioningError replaces its precise message with this outer one.
    // This is also what carries the ARN out of the two
    // `waitForCertificateIssued` throws (issue #2169) -- they are
    // `ProvisioningError`s whose `physicalId` is the certificate, and
    // re-wrapping them here would drop it. The one thing worth overriding
    // that for is a cleanup that FAILED: the user needs the survivor's id
    // more than they need the original wording preserved byte-for-byte, so
    // that case appends rather than passing through silently.
    if (error instanceof CdkdError) {
      if (survivorNote === undefined) throw error;
      const thrown = new ProvisioningError(
        `${error.message} ${survivorNote}`,
        resourceType,
        logicalId,
        requestedArn,
        error
      );
      // go-to-k/cdkd#4583: the cleanup could not delete the certificate this
      // call requested, so name its ARN (the id delete() takes) for the journal.
      // A survivor note implies a request returned, so `requestedArn` is set.
      if (requestedArn) markCreatedBeforeFailure(thrown, logicalId, resourceType, requestedArn);
      throw thrown;
    }
    const cause = error instanceof Error ? error : undefined;
    // The survivor note can join this line with a pasteable `aws acm
    // delete-certificate`, so the logical id is shown only when plain
    // (go-to-k/cdkd#4295).
    const build = (text: string): ProvisioningError =>
      new ProvisioningError(
        `Failed to create ACM certificate ${logicalIdShown(logicalId)}: ` +
          (survivorNote !== undefined ? `${text} ${survivorNote}` : text),
        resourceType,
        logicalId,
        // The reporter's own ask (issue #2169): the ARN `RequestCertificate`
        // returned survives the failure instead of being dropped. It names a
        // DELETED certificate on the ordinary path, and a live one when the
        // cleanup could not retire it -- which the survivor note appends.
        requestedArn,
        cause
      );
    if (!requestedArn || survivorNote === undefined) {
      throw this.wrapCaughtError(context?.maskSecrets, error, build);
    }
    const thrown = this.wrapCaughtError(context?.maskSecrets, error, build);
    // go-to-k/cdkd#4583: only a FAILED cleanup leaves the certificate behind.
    markCreatedBeforeFailure(thrown, logicalId, resourceType, requestedArn);
    throw thrown;
  }
}

/**
 * Retire the certificate a FAILED `create()` just requested, so the failure
 * leaves nothing behind (issue
 * [#2169](https://github.com/go-to-k/cdkd/issues/2169)).
 *
 * Returns `undefined` when the certificate is gone, or a one-line note naming
 * the survivor when it could not be deleted. Never throws: the original
 * create error is what the user needs to see, and a cleanup failure must
 * degrade that message rather than replace it.
 *
 * ## Why DELETING is right, when the obvious objection is that it throws away
 * the user's DNS work
 *
 * It does not. ACM derives a domain's validation CNAME from the domain and
 * the account, not from the certificate, and documents that the record "must
 * be added to your DNS database only once": *"Without the need to repeat
 * validation, you can request additional ACM certificates for your fully
 * qualified domain name (FQDN) for as long as the CNAME record remains in
 * place ... You can also replace a deleted certificate."*
 * (https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
 * So the CNAMEs a user adds after seeing this failure validate the NEXT
 * certificate too, and the retry issues normally. The intuition that a
 * `PENDING_VALIDATION` certificate is precious does not hold for ACM.
 *
 * ## Why not RECORD the remnant in cdkd state instead
 *
 * That was this fix's first shape, and it does not work. A state record makes
 * the next deploy diff the resource as `NO_CHANGE` -- the recorded properties
 * ARE the template's -- so cdkd would never touch that certificate again:
 * `cdkd deploy` would print "No changes detected" and exit 0 over a
 * certificate that is still unusable, and the CloudFront / ALB consuming it
 * would fail with no explanation. Turning a loud failure into a silent one is
 * worse than the orphan it fixes. Making the diff re-provision it instead
 * needs a marker on the state record -- a schema bump -- to buy behaviour
 * that deleting gives for free.
 *
 * ## The "keep it" escape hatch already exists
 *
 * A user who WANTS the certificate to outlive the deploy has
 * `CDKD_NO_WAIT=true` (`cdkd deploy --no-wait`), which returns success with
 * the certificate recorded in state and never reaches this path. "Wait for
 * it" and "keep it even if the wait fails" are different requests, and cdkd
 * already has a flag for the second.
 */
export async function cleanupRequestedCertificate(
  this: ACMCertificateProvider,
  certificateArn: string,
  logicalId: string,
  idempotencyToken: IdempotencyToken,
  maskSecrets: ((text: string) => string) | undefined
): Promise<string | undefined> {
  try {
    await this.acmClient.send(new DeleteCertificateCommand({ CertificateArn: certificateArn }));
    this.logger.info(
      `Deleted the ACM certificate ${certificateArn} that the failed create of ${logicalId} requested, ` +
        `so nothing is left behind. DNS validation records you have already added stay valid for the retry.`
    );
    // Retire the TOKEN too, and this is load-bearing rather than tidiness:
    // ACM answers a repeat of the same idempotency token within an hour with
    // the SAME certificate -- which no longer exists. Without this the next
    // attempt (including the replacement create inside `update()`, which
    // shares this key) could be handed the ARN just deleted.
    idempotencyToken.release();
    return undefined;
  } catch (cleanupError) {
    // Matched by CLASS with a NAME fallback, on the same reasoning
    // `isCertificateInUseError` above sets out: a re-thrown error can lose
    // the SDK class while keeping its identity. Deliberately only the TOP
    // error, not the cause chain that helper walks -- this catches the error
    // `acmClient.send` raised directly, and nothing between here and the SDK
    // wraps it. Getting it wrong is not cosmetic: a missed not-found tells
    // the user to delete an ARN that does not exist AND keeps the idempotency
    // token, which is the hazard the release below exists to prevent.
    if (
      cleanupError instanceof ResourceNotFoundException ||
      (cleanupError instanceof Error && cleanupError.name === 'ResourceNotFoundException')
    ) {
      // Already gone: nothing was left behind either way.
      //
      // Logged rather than silent, because this is the ONE arm that releases
      // the token without having proved the certificate is gone -- it takes
      // AWS's word for it. If that answer were ever wrong (a spurious or
      // eventually-consistent not-found), the next attempt mints a SECOND
      // certificate and the first is orphaned with nothing naming it, which
      // is the accumulation this whole change exists to end. A line here is
      // what makes that case findable afterwards instead of invisible.
      this.logger.info(
        `The ACM certificate ${certificateArn} that the failed create of ${logicalId} requested was already gone; nothing to clean up.`
      );
      idempotencyToken.release();
      return undefined;
    }
    // An AWS-authored failure is named by its class at warn, and AWS's text
    // (a denied `DeleteCertificate` names the caller) goes to `debug` under
    // the same head, both through the create's masker (go-to-k/cdkd#2319).
    const mask = maskSecrets ?? ((text: string) => text);
    const cleanupFailure = describeAwsFailure(cleanupError);
    const cleanupHead = `Could not delete the ACM certificate ${certificateArn} that the failed create of ${logicalId} requested: `;
    if (cleanupFailure.redacted) {
      this.logger.debug(mask(`${cleanupHead}${cleanupFailure.detail}`));
    }
    this.logger.warn(
      mask(
        `${cleanupHead}${cleanupFailure.redacted ? cleanupFailure.summary : cleanupFailure.detail}`
      )
    );
    // Deliberately NOT releasing the token here: the certificate is still
    // there, so a retry being answered with that same one is the outcome we
    // want rather than a hazard -- and it is what stops a retry from adding a
    // SECOND survivor.
    //
    // AWS's text stays in the lines above and out of this note, which is
    // spliced into the THROWN message. `isRetryableTransientError` classifies
    // by substring-matching that message against
    // `RETRYABLE_ERROR_MESSAGE_PATTERNS`, so an AWS cleanup error whose text
    // happened to contain `does not exist` or `DependencyViolation` would
    // re-classify a terminal create failure as transient. Every word below is
    // therefore ours and pattern-free by construction.
    return (
      // Appended to the refusal's own line, so the ARN is shown only when
      // plain, as the refusal head shows it (go-to-k/cdkd#4295).
      `The certificate ${isPlainImportValue(certificateArn) ? certificateArn : VALUE_NOT_SHOWN} this attempt created could NOT be deleted, ` +
      `and cdkd is not tracking it -- retire it with ` +
      `${pasteableAwsCommand()`aws acm delete-certificate --certificate-arn ${certificateArn} --region ${this.regionOfArn(certificateArn)}`.render()} ` +
      `(the reason is in the warning above).`
    );
  }
}
