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
import { acquireIdempotencyToken } from './idempotency-token.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
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
 * **A create that fails after requesting keeps its certificate** (issue
 * [#2169](https://github.com/go-to-k/cdkd/issues/2169)). `RequestCertificate`
 * materializes the certificate immediately and everything after it can fail —
 * most commonly the ISSUED wait, which a DNS-validated certificate whose
 * records are not live yet exhausts by construction. `create()` therefore
 * reports the ARN through {@link CreateContext.reportMaterialized} the moment
 * AWS returns it, and the engine writes it into state when the create fails.
 * The certificate is then visible to `cdkd state show`, deleted by
 * `cdkd destroy`, and ADOPTED by the next `cdkd deploy` — which reaches
 * `update()` instead of `create()`, so no second certificate is requested.
 * `update()` resumes the ISSUED wait for a certificate that is still
 * PENDING_VALIDATION, so that re-run reaches the same verdict the create would
 * have rather than reporting success on an unusable certificate.
 *
 * The remnant is deliberately KEPT rather than deleted (the Cloud Control
 * provider's `cleanupFailedCreateRemnant` makes the opposite call for its own
 * case). A `PENDING_VALIDATION` certificate is exactly the thing the user has
 * just added DNS records for, ACM goes on validating it asynchronously after
 * cdkd stops waiting, and deleting it would throw that away and restart a
 * validation cycle that can take hours.
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
    properties: Record<string, unknown>,
    context?: CreateContext
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
    // that half is what `reportMaterialized` below addresses, by making the
    // first certificate part of the stack's state so the re-run ADOPTS it.
    const idempotencyToken = acquireIdempotencyToken({
      scope: 'RequestCertificate',
      logicalId,
      maxLength: 32,
      charset: 'alphanumeric',
    });
    input['IdempotencyToken'] = idempotencyToken.value;

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
      this.logger.debug(`Requested ACM certificate: ${certificateArn}`);

      // Issue #2169: the certificate EXISTS from this line on, and everything
      // after it can fail — the ISSUED wait is bounded and a DNS-validated
      // certificate whose records are not live yet reliably exhausts it, and
      // the engine's own `--resource-timeout` can abort this method from
      // outside without it reaching a single `catch` of its own. Reporting the
      // ARN here rather than on the way out is what makes it survive BOTH: the
      // engine keeps the report and, if the create fails, writes it into state.
      // Without it the certificate is orphaned with nothing naming it, and the
      // next deploy requests another one.
      context?.reportMaterialized?.(certificateArn, {
        Arn: certificateArn,
        CertificateArn: certificateArn,
      });

      const noWait = process.env['CDKD_NO_WAIT'] === 'true';
      if (!noWait) {
        // `recorded` is the PRESENCE of the report channel, not an assumption
        // about it. Without one — the replacement create inside `update()`,
        // `drift --revert`, a direct call — nothing will write this
        // certificate to state, and the wait's failure message must not claim
        // otherwise: telling a user `cdkd destroy` will clean up a certificate
        // cdkd does not track is worse than saying nothing, because it is the
        // sentence that stops them looking.
        await this.waitForCertificateIssued(certificateArn, logicalId, resourceType, {
          recorded: context?.reportMaterialized !== undefined,
        });
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
      // Pass through cdkd-typed errors untouched (#1272): re-labelling an inner
      // ProvisioningError replaces its precise message with this outer one.
      // This is also what carries the ARN out of the two `waitForCertificateIssued`
      // throws (issue #2169) — they are `ProvisioningError`s whose `physicalId`
      // is the certificate, and re-wrapping them here would drop it.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create ACM certificate ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
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
      // KNOWN GAP, issue [#2173](https://github.com/go-to-k/cdkd/issues/2173):
      // this create gets no `CreateContext`, so its ISSUED wait timing out
      // still orphans the NEW certificate the way issue #2169 describes for
      // the plain-create path. Recording it is not the fix — the state record
      // for this logical id still names the OLD certificate, which is live and
      // which cdkd must stay able to delete — so the remedy is a policy choice
      // (delete the new one, or report it as a survivor) that #2173 decides.
      // The wait's message names the new ARN either way, so it is findable.
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

      // Issue #2169: RESUME the ISSUED wait for a certificate that is still
      // PENDING_VALIDATION.
      //
      // Once a create that timed out waiting for validation records leaves its
      // certificate in state, the NEXT `cdkd deploy` finds a state record and
      // takes this path instead of `create()` — which is the whole point, since
      // it is what stops a second certificate being requested. But the tag /
      // options work above says nothing about validation, so without this the
      // re-run would report the resource as updated and exit 0 while the
      // certificate is still unusable, and the CloudFront / ALB that depends on
      // it would fail with no explanation. The re-run has to reach the same
      // verdict the create would have.
      //
      // Gated on the status being PENDING_VALIDATION, NOT on "not ISSUED": an
      // ordinary update of an EXPIRED / REVOKED / INACTIVE certificate
      // succeeded before this existed, and `waitForCertificateIssued` treats
      // every one of those as a terminal failure — so waiting unconditionally
      // would newly break deploys that have nothing to do with this issue
      // (typically the very deploy replacing the expired certificate). A
      // status reached DURING the wait is a different matter and stays fatal.
      // `CDKD_NO_WAIT` is honoured exactly as on the create path.
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        const current = await this.acmClient.send(
          new DescribeCertificateCommand({ CertificateArn: physicalId })
        );
        if (current.Certificate?.Status === 'PENDING_VALIDATION') {
          this.logger.info(
            `ACM certificate ${logicalId} (${physicalId}) is still PENDING_VALIDATION; waiting for it to be issued`
          );
          // Reached only from a state record, so the certificate is tracked by
          // definition here.
          await this.waitForCertificateIssued(physicalId, logicalId, resourceType, {
            recorded: true,
          });
        }
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: physicalId,
          CertificateArn: physicalId,
        },
      };
    } catch (error) {
      // Same #1272 pass-through as `create()`: the resumed ISSUED wait above
      // throws a `ProvisioningError` whose message already names the
      // certificate, the status it reached and what to do next, and re-wrapping
      // it would bury that behind a generic "failed to update" label.
      if (error instanceof CdkdError) throw error;
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
   * piece of the failure path that should still be able to name it — the
   * durable half is `create()`'s `reportMaterialized` call, which does not
   * depend on this method throwing at all.
   *
   * `recorded` says whether this certificate will end up in cdkd's state, and
   * exists only so the failure message tells the truth for BOTH callers: the
   * engine-driven create (and the resumed wait on an already-recorded
   * certificate) can promise `cdkd destroy` will clean it up, while a create
   * with no report channel — the replacement inside `update()`, `drift
   * --revert` — cannot, and there the message points at manual retirement
   * instead.
   */
  private async waitForCertificateIssued(
    certificateArn: string,
    logicalId: string,
    resourceType: string,
    options: { recorded: boolean }
  ): Promise<void> {
    const trackingNote = options.recorded
      ? `The certificate is recorded in this stack's state: re-run \`cdkd deploy\` to wait for the SAME certificate, or \`cdkd destroy\` to delete it.`
      : `cdkd is NOT tracking this certificate, so \`cdkd destroy\` will not remove it — retire it with ` +
        `\`aws acm delete-certificate --certificate-arn ${certificateArn}\`, or adopt it with \`cdkd import\`.`;
    this.logger.debug(`Waiting for ACM certificate ${certificateArn} to reach ISSUED status...`);
    let interrupted = false;
    let validationOptionsLogged = false;

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
              `Check ACM console / DNS records to diagnose. ${trackingNote}`,
            resourceType,
            logicalId,
            certificateArn
          );
        }

        if (status === 'PENDING_VALIDATION' && !validationOptionsLogged && validations.length > 0) {
          this.logValidationOptions(validations);
          validationOptionsLogged = true;
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
          `Add the validation records printed above to your DNS zone. ` +
          `If your zone is manually managed, you may need to increase --resource-timeout AWS::CertificateManager::Certificate=<duration> or set CDKD_NO_WAIT=true. ` +
          `${trackingNote}`,
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
  private logValidationOptions(validations: DomainValidation[]): void {
    const lines: string[] = [
      'ACM certificate is PENDING_VALIDATION. Add the following DNS records to validate:',
    ];
    for (const v of validations) {
      if (v.ValidationMethod === 'DNS' && v.ResourceRecord) {
        const r = v.ResourceRecord;
        lines.push(`  ${v.DomainName} — ${r.Type} ${r.Name} -> ${r.Value}`);
      } else if (v.ValidationMethod === 'EMAIL') {
        const emails = (v.ValidationEmails ?? []).join(', ');
        lines.push(`  ${v.DomainName} — confirmation email sent to: ${emails || '<none>'}`);
      }
    }
    this.logger.info(lines.join('\n'));
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
