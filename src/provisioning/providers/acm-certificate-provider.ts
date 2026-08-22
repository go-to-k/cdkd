import {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand,
  DeleteCertificateCommand,
  ListTagsForCertificateCommand,
  AddTagsToCertificateCommand,
  RemoveTagsFromCertificateCommand,
  UpdateCertificateOptionsCommand,
  ResourceNotFoundException,
  type DomainValidation,
  type RequestCertificateRequest,
  type CertificateOptions,
} from '@aws-sdk/client-acm';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { acquireIdempotencyToken, type IdempotencyToken } from './idempotency-token.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

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
function isCertificateInUseError(error: unknown): boolean {
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
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current.name === 'ResourceInUseException') return true;
    current = current.cause;
  }
  // Message fallback for a re-thrown error that kept the text but lost the
  // class. `/in use/i`, NOT `/still in use/`: ACM's own wording is
  // `Certificate arn:... is in use.` -- the stricter phrase matched nothing AWS
  // actually sends.
  const message = error instanceof Error ? error.message : String(error);
  return /ResourceInUseException|in use/i.test(message);
}

/**
 * AWS ACM Certificate Provider
 *
 * Implements `AWS::CertificateManager::Certificate` using the ACM SDK.
 *
 * **DNS / EMAIL validation is asynchronous.** `RequestCertificate` returns
 * immediately with status `PENDING_VALIDATION`; the certificate only reaches
 * `ISSUED` once AWS has confirmed the DNS records (or the email click).
 *
 * `create()` polls `DescribeCertificate` until status flips to `ISSUED`. On
 * the first poll that returns PENDING_VALIDATION, the provider logs the
 * `DomainValidationOptions` AWS posted so the user knows which CNAME records
 * to add to their DNS zone. `CDKD_NO_WAIT=true` (or `cdkd deploy --no-wait`)
 * short-circuits the loop and returns immediately with the ARN — downstream
 * consumers (CloudFront, ALB) will fail to start if they reach the cert
 * before it issues, but that's the documented trade-off.
 *
 * **A create that fails after requesting DELETES its certificate** (issue
 * [#2169](https://github.com/go-to-k/cdkd/issues/2169)). `RequestCertificate`
 * materializes the certificate immediately and everything after it can fail —
 * most commonly the ISSUED wait, which a DNS-validated certificate whose
 * validation records are not live yet exhausts by construction. Before this,
 * the ARN was thrown away with the error: the certificate existed in AWS with
 * nothing naming it (absent from state, so invisible to `cdkd state show` and
 * unreachable by `cdkd destroy`), and the next `cdkd deploy` requested another
 * one — an orphan per attempt. `create()` now retires the certificate it just
 * requested before re-throwing, so a failed deploy leaves nothing behind and a
 * retry starts clean. See {@link ACMCertificateProvider.cleanupRequestedCertificate}
 * for why deleting is safe and why it is preferred over recording the remnant.
 *
 * **CloudFront cross-region note**: ACM certificates referenced by a
 * CloudFront Distribution MUST live in `us-east-1`. cdkd does not enforce
 * this — it's the developer's responsibility to deploy the certificate
 * stack to `us-east-1`. The provider uses the single ACMClient configured
 * in `aws-clients.ts` (region = stack's region) and does NOT override.
 *
 * Physical id is the certificate ARN. CFn exposes only `Ref` (returns the
 * ARN); `getAttribute('Arn')` / `getAttribute('CertificateArn')` also
 * return the ARN for any defensive call site.
 */
export class ACMCertificateProvider implements ResourceProvider {
  private acmClient: ACMClient;
  private logger = getLogger().child('ACMCertificateProvider');

  // Configurable via env for test runs; default = 10 min (60 polls × 10s)
  // matching the handover's recommendation. Internal cap only; the deploy
  // engine's per-resource timeout (default 30m) still wraps the whole loop,
  // so a `--resource-timeout AWS::CertificateManager::Certificate=5m`
  // override caps us at 5m via Promise.race.
  private readonly maxPollAttempts = Number(process.env['CDKD_ACM_POLL_ATTEMPTS'] ?? 60);
  private readonly pollIntervalMs = Number(process.env['CDKD_ACM_POLL_INTERVAL_MS'] ?? 10000);

  constructor() {
    this.acmClient = getAwsClients().acm;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CertificateManager::Certificate',
      new Set([
        'DomainName',
        'ValidationMethod',
        'SubjectAlternativeNames',
        'DomainValidationOptions',
        'CertificateAuthorityArn',
        'CertificateTransparencyLoggingPreference',
        'CertificateExport',
        'KeyAlgorithm',
        'Tags',
      ]),
    ],
  ]);

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Requesting ACM certificate ${logicalId}`);

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
      // CFn shape is `{DomainName, HostedZoneId?, ValidationDomain?}`. ACM
      // SDK accepts only `{DomainName, ValidationDomain}` — drop HostedZoneId
      // (a CDK auto-validation custom-resource concept, not an ACM input).
      input['DomainValidationOptions'] = (
        properties['DomainValidationOptions'] as Array<Record<string, unknown>>
      )
        .map((opt) => {
          const cleaned: Record<string, unknown> = { DomainName: opt['DomainName'] };
          if (opt['ValidationDomain']) cleaned['ValidationDomain'] = opt['ValidationDomain'];
          return cleaned;
        })
        .filter((opt) => opt['DomainName']);
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
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    if (tags && Array.isArray(tags) && tags.length > 0) {
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
      this.logger.debug(`Requested ACM certificate: ${certificateArn}`);

      const noWait = process.env['CDKD_NO_WAIT'] === 'true';
      if (!noWait) {
        await this.waitForCertificateIssued(certificateArn, logicalId, resourceType);
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
        ? await this.cleanupRequestedCertificate(requestedArn, logicalId, idempotencyToken)
        : undefined;

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
        throw new ProvisioningError(
          `${error.message} ${survivorNote}`,
          resourceType,
          logicalId,
          requestedArn,
          error
        );
      }
      const cause = error instanceof Error ? error : undefined;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ProvisioningError(
        `Failed to create ACM certificate ${logicalId}: ${detail}` +
          (survivorNote === undefined ? '' : ` ${survivorNote}`),
        resourceType,
        logicalId,
        // The reporter's own ask (issue #2169): the ARN `RequestCertificate`
        // returned survives the failure instead of being dropped. It names a
        // DELETED certificate on the ordinary path, and a live one when the
        // cleanup could not retire it -- which is what `survivorNote` says.
        requestedArn,
        cause
      );
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
  /**
   * The region an ACM ARN names, for the manual retire command. Taken from the
   * ARN rather than from the client so the command a user pastes matches the
   * certificate it names even when their shell default differs. Falls back to
   * the literal placeholder for a shape this cannot parse -- a wrong region
   * would make the command silently address a different account/region.
   */
  private regionOfArn(arn: string): string {
    return arn.split(':')[3] || '<region>';
  }

  private async cleanupRequestedCertificate(
    certificateArn: string,
    logicalId: string,
    idempotencyToken: IdempotencyToken
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
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      this.logger.warn(
        `Could not delete the ACM certificate ${certificateArn} that the failed create of ${logicalId} requested: ${detail}`
      );
      // Deliberately NOT releasing the token here: the certificate is still
      // there, so a retry being answered with that same one is the outcome we
      // want rather than a hazard -- and it is what stops a retry from adding a
      // SECOND survivor.
      //
      // The raw `detail` stays in the warn above and out of this note, which is
      // spliced into the THROWN message. `isRetryableTransientError` classifies
      // by substring-matching that message against
      // `RETRYABLE_ERROR_MESSAGE_PATTERNS`, so an AWS cleanup error whose text
      // happened to contain `does not exist` or `DependencyViolation` would
      // re-classify a terminal create failure as transient. Every word below is
      // therefore ours and pattern-free by construction.
      return (
        `The certificate ${certificateArn} this attempt created could NOT be deleted, ` +
        `and cdkd is not tracking it -- retire it with ` +
        `\`aws acm delete-certificate --certificate-arn ${certificateArn} --region ${this.regionOfArn(certificateArn)}\` ` +
        `(the reason is in the warning above).`
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating ACM certificate ${logicalId}: ${physicalId}`);

    // ACM certs are largely immutable. The fields that ARE mutable are
    // Tags and Options.CertificateTransparencyLoggingPreference. Anything
    // else → replace.
    const immutableFields = [
      'DomainName',
      'ValidationMethod',
      'SubjectAlternativeNames',
      'DomainValidationOptions',
      'CertificateAuthorityArn',
      'KeyAlgorithm',
    ] as const;
    const changedImmutable = immutableFields.find(
      (k) => JSON.stringify(properties[k]) !== JSON.stringify(previousProperties[k])
    );
    if (changedImmutable) {
      this.logger.debug(`${changedImmutable} changed, replacing ACM certificate: ${physicalId}`);
      // Issue #2169 covers this call too, for free: if the new certificate's
      // ISSUED wait fails, `create()`'s own catch retires it before the error
      // leaves, so the replacement aborts with the OLD certificate still live,
      // still in state, and no orphan. Recording the new one instead was never
      // available here — the state record for this logical id names the old
      // certificate, which cdkd must stay able to delete — which is a second
      // reason the delete policy is the right one for this provider rather
      // than a merely convenient one.
      const createResult = await this.create(logicalId, resourceType, properties);
      // What the inner delete left behind, if anything. `undefined` means the
      // old certificate is genuinely gone; a string is the short reason that
      // rides out on the update's `'partial'` outcome (issue #1819) so the
      // deploy engine can record and count the survivor instead of the
      // warn-only treatment that preceded it (issue #1922).
      let orphanReason: string | undefined;
      try {
        const deleteResult = await this.delete(
          logicalId,
          physicalId,
          resourceType,
          previousProperties
        );
        // Issue #1778: a SKIP is a non-throwing "I did not address this
        // resource", so it sails straight past the catch below — the one path
        // that would have told the user the old certificate is still there.
        if (deleteResult?.outcome === 'skipped') {
          orphanReason = `old certificate ${physicalId} was not deleted: ${deleteResult.reason}`;
          this.logger.warn(
            `Skipped deleting old ACM certificate ${physicalId} during replacement: ${deleteResult.reason}. ` +
              `The old certificate may be orphaned and require manual cleanup.`
          );
        }
      } catch (error) {
        // Issue #1922: the in-use rejection is the COMMON case here, not an
        // anonymous failure. ACM refuses to delete a certificate a consumer
        // still references — typically a CloudFront distribution in another
        // stack not yet updated to the new certificate — so the rejection is
        // usually an ordering artifact rather than a permanent block. Either
        // way the new certificate already exists, so the replacement cannot be
        // aborted: the honest outcome is "updated, and the old certificate
        // survives", which is what `'partial'` says.
        const inUse = isCertificateInUseError(error);
        orphanReason = inUse
          ? `old certificate ${physicalId} is still in use by another resource and was not deleted`
          : `old certificate ${physicalId} could not be deleted: ${String(error)}`;
        this.logger.warn(
          `Failed to delete old ACM certificate ${physicalId} during replacement: ${String(error)}. ` +
            (inUse
              ? `This usually means a consumer (e.g. a CloudFront distribution) still references it; ` +
                `it can be deleted once DescribeCertificate.InUseBy is empty. `
              : '') +
            `The old certificate may be orphaned and require manual cleanup.`
        );
      }
      const base = {
        physicalId: createResult.physicalId,
        wasReplaced: true as const,
        ...(createResult.attributes ? { attributes: createResult.attributes } : {}),
      };
      // The old physical id travels in the reason, because the state record
      // now points at the NEW certificate — nothing else downstream still
      // knows the ARN that survived.
      return orphanReason !== undefined
        ? { ...base, outcome: 'partial', reason: orphanReason }
        : base;
    }

    try {
      // CertificateTransparencyLoggingPreference + CertificateExport: both
      // map to nested SDK `Options.*` and route through UpdateCertificateOptions.
      const newCt = properties['CertificateTransparencyLoggingPreference'] as string | undefined;
      const oldCt = previousProperties['CertificateTransparencyLoggingPreference'] as
        | string
        | undefined;
      const newExport = properties['CertificateExport'] as string | undefined;
      const oldExport = previousProperties['CertificateExport'] as string | undefined;
      if (newCt !== oldCt || newExport !== oldExport) {
        const options: Record<string, unknown> = {};
        if (newCt) options['CertificateTransparencyLoggingPreference'] = newCt;
        if (newExport) options['Export'] = newExport;
        if (Object.keys(options).length > 0) {
          await this.acmClient.send(
            new UpdateCertificateOptionsCommand({
              CertificateArn: physicalId,
              Options: options as CertificateOptions,
            })
          );
          this.logger.debug(`Updated certificate Options on ${physicalId}`);
        }
      }

      // Tags: diff and Add/Remove.
      await this.updateTags(
        physicalId,
        properties['Tags'] as Array<{ Key: string; Value: string }> | undefined,
        previousProperties['Tags'] as Array<{ Key: string; Value: string }> | undefined
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: physicalId,
          CertificateArn: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update ACM certificate ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting ACM certificate ${logicalId}: ${physicalId}`);

    try {
      try {
        await this.acmClient.send(new DeleteCertificateCommand({ CertificateArn: physicalId }));
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          const clientRegion = await this.acmClient.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Certificate ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }
      this.logger.debug(`Successfully deleted ACM certificate ${logicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete ACM certificate ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // CFn exposes `Ref` = ARN (handled by physicalId). Defensive aliases
    // `Arn` / `CertificateArn` return the same.
    if (attributeName === 'Arn' || attributeName === 'CertificateArn') return physicalId;
    return undefined;
  }

  /**
   * Read the AWS-current certificate properties in CFn-property shape.
   *
   * Coverage:
   *  - `DomainName`, `SubjectAlternativeNames`, `KeyAlgorithm` straight from
   *    `DescribeCertificate.Certificate.*`.
   *  - `CertificateTransparencyLoggingPreference` extracted from the nested
   *    `Options` field and flattened to match CFn shape.
   *  - `Tags` via `ListTagsForCertificate`, with the `aws:cdk:path` etc.
   *    auto-tags filtered out by `normalizeAwsTagsToCfn`.
   *  - `ValidationMethod` / `DomainValidationOptions` are intentionally NOT
   *    surfaced — the deployed cert's validation state is observation-only;
   *    cdkd state stores the request-time input, which can legitimately
   *    diverge from the observed state without indicating drift.
   *
   * Returns `undefined` when the cert is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    let cert;
    try {
      const resp = await this.acmClient.send(
        new DescribeCertificateCommand({ CertificateArn: physicalId })
      );
      cert = resp.Certificate;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
    if (!cert) return undefined;

    const result: Record<string, unknown> = {};
    if (cert.DomainName !== undefined) result['DomainName'] = cert.DomainName;
    if (Array.isArray(cert.SubjectAlternativeNames)) {
      result['SubjectAlternativeNames'] = cert.SubjectAlternativeNames;
    }
    if (cert.KeyAlgorithm !== undefined) result['KeyAlgorithm'] = cert.KeyAlgorithm;
    if (cert.CertificateAuthorityArn !== undefined) {
      result['CertificateAuthorityArn'] = cert.CertificateAuthorityArn;
    }
    if (cert.Options?.CertificateTransparencyLoggingPreference !== undefined) {
      result['CertificateTransparencyLoggingPreference'] =
        cert.Options.CertificateTransparencyLoggingPreference;
    }
    if (cert.Options?.Export !== undefined) {
      result['CertificateExport'] = cert.Options.Export;
    }

    try {
      const tagsResp = await this.acmClient.send(
        new ListTagsForCertificateCommand({ CertificateArn: physicalId })
      );
      result['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }

    return result;
  }

  /**
   * Path the deploy engine queries to compare drift snapshots — paths
   * `readCurrentState` deliberately does NOT round-trip.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    // ValidationMethod + DomainValidationOptions: see readCurrentState
    // docstring. Validation state is observation-only.
    return ['ValidationMethod', 'DomainValidationOptions'];
  }

  /**
   * Adopt an existing certificate into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override (must be an ARN — ACM has no other unique id).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      const arn = input.knownPhysicalId;
      if (!arn.startsWith('arn:')) {
        throw new Error(
          `--resource override for ${input.logicalId} must be an ARN (got '${arn}'). ACM certificates have no human-readable physical id.`
        );
      }
      try {
        await this.acmClient.send(new DescribeCertificateCommand({ CertificateArn: arn }));
        return { physicalId: arn, attributes: { Arn: arn, CertificateArn: arn } };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a
    // certificate reaching here needs an explicit `--resource` override.
    return null;
  }

  // ── helpers ───────────────────────────────────────────────────────

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
  private async waitForCertificateIssued(
    certificateArn: string,
    logicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Waiting for ACM certificate ${certificateArn} to reach ISSUED status...`);
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
          throw new ProvisioningError(
            `ACM certificate ${logicalId} (${certificateArn}) entered terminal status ${status} during validation. ` +
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
          const rendered = this.renderValidationOptions(validations);
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

      throw new ProvisioningError(
        `ACM certificate ${logicalId} (${certificateArn}) did not reach ISSUED status within ${(this.maxPollAttempts * this.pollIntervalMs) / 1000}s. ` +
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
          `--resource-timeout AWS::CertificateManager::Certificate=<duration>, or the engine's per-resource deadline ` +
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
   * Pretty-print the validation records AWS expects in the DNS zone, so the
   * user can copy / paste them into Route 53 / Cloudflare / etc. while the
   * cert is still PENDING_VALIDATION.
   */
  private renderValidationOptions(validations: DomainValidation[]): string | undefined {
    const lines: string[] = [
      'ACM certificate is PENDING_VALIDATION. Add the following DNS records to validate:',
    ];
    for (const v of validations) {
      if (v.ValidationMethod === 'DNS' && v.ResourceRecord) {
        const r = v.ResourceRecord;
        lines.push(`  ${v.DomainName} — ${r.Type} ${r.Name} -> ${r.Value}`);
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

  private async updateTags(
    certificateArn: string,
    newTags: Array<{ Key: string; Value: string }> | undefined,
    oldTags: Array<{ Key: string; Value: string }> | undefined
  ): Promise<void> {
    const newTagMap = new Map((newTags || []).map((t) => [t.Key, t.Value]));
    const oldTagMap = new Map((oldTags || []).map((t) => [t.Key, t.Value]));

    const tagsToRemove: Array<{ Key: string; Value?: string }> = [];
    for (const key of oldTagMap.keys()) {
      if (!newTagMap.has(key)) tagsToRemove.push({ Key: key });
    }
    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [key, value] of newTagMap) {
      if (oldTagMap.get(key) !== value) tagsToAdd.push({ Key: key, Value: value });
    }

    if (tagsToRemove.length > 0) {
      await this.acmClient.send(
        new RemoveTagsFromCertificateCommand({ CertificateArn: certificateArn, Tags: tagsToRemove })
      );
    }
    if (tagsToAdd.length > 0) {
      await this.acmClient.send(
        new AddTagsToCertificateCommand({ CertificateArn: certificateArn, Tags: tagsToAdd })
      );
    }
  }
}
