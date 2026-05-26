import {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand,
  DeleteCertificateCommand,
  ListCertificatesCommand,
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
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { matchesCdkPath, normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

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

      const noWait = process.env['CDKD_NO_WAIT'] === 'true';
      if (!noWait) {
        await this.waitForCertificateIssued(certificateArn, logicalId);
      } else {
        this.logger.warn(
          `Skipping wait for ACM certificate ${logicalId} (CDKD_NO_WAIT=true). ` +
            `Downstream consumers (CloudFront / ALB) will fail until the cert reaches ISSUED.`
        );
      }

      return {
        physicalId: certificateArn,
        attributes: {
          Arn: certificateArn,
          CertificateArn: certificateArn,
        },
      };
    } catch (error) {
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
      const createResult = await this.create(logicalId, resourceType, properties);
      try {
        await this.delete(logicalId, physicalId, resourceType, previousProperties);
      } catch (error) {
        this.logger.warn(
          `Failed to delete old ACM certificate ${physicalId} during replacement: ${String(error)}. ` +
            `The old certificate may be orphaned and require manual cleanup.`
        );
      }
      const result: ResourceUpdateResult = {
        physicalId: createResult.physicalId,
        wasReplaced: true,
      };
      if (createResult.attributes) {
        result.attributes = createResult.attributes;
      }
      return result;
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
  ): Promise<void> {
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
   *  2. Tag-based `aws:cdk:path` match across `ListCertificates` +
   *     `ListTagsForCertificate`. NOTE: ACM has no `Scope: Local` filter —
   *     `ListCertificates` returns customer-managed certs only (AWS-managed
   *     certs are not surfaced via this API), so no extra guard is needed.
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

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.acmClient.send(
        new ListCertificatesCommand({ ...(nextToken ? { NextToken: nextToken } : {}) })
      );
      for (const summary of list.CertificateSummaryList ?? []) {
        if (!summary.CertificateArn) continue;
        try {
          const tags = await this.acmClient.send(
            new ListTagsForCertificateCommand({ CertificateArn: summary.CertificateArn })
          );
          if (matchesCdkPath(tags.Tags, input.cdkPath)) {
            return {
              physicalId: summary.CertificateArn,
              attributes: {
                Arn: summary.CertificateArn,
                CertificateArn: summary.CertificateArn,
              },
            };
          }
        } catch (err) {
          if (err instanceof ResourceNotFoundException) continue;
          throw err;
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
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
   */
  private async waitForCertificateIssued(certificateArn: string, logicalId: string): Promise<void> {
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
          throw new Error(
            `ACM certificate ${logicalId} (${certificateArn}) entered terminal status ${status} during validation. ` +
              `Check ACM console / DNS records to diagnose.`
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

      throw new Error(
        `ACM certificate ${logicalId} (${certificateArn}) did not reach ISSUED status within ${(this.maxPollAttempts * this.pollIntervalMs) / 1000}s. ` +
          `If your DNS zone is manually managed, you may need to increase --resource-timeout AWS::CertificateManager::Certificate=<duration> or set CDKD_NO_WAIT=true.`
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
