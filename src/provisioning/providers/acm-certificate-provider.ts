import { ACMClient, type DomainValidation } from '@aws-sdk/client-acm';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import type { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type { IdempotencyToken } from './idempotency-token.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { markRedactedCause, relayedNameCollision } from '../../deployment/retryable-errors.js';
import { create, cleanupRequestedCertificate } from './acm-certificate/create.js';
import { update, updateTags } from './acm-certificate/update.js';
import { deleteImpl } from './acm-certificate/delete.js';
import { readCurrentState, importImpl } from './acm-certificate/read-state.js';
import {
  waitForCertificateIssued,
  writeValidationRecords,
  renderValidationOptions,
} from './acm-certificate/wait.js';

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
  acmClient: ACMClient;
  logger: ConsoleLogger = getLogger().child('ACMCertificateProvider');

  // Configurable via env for test runs; default = 10 min (60 polls × 10s)
  // matching the handover's recommendation. Internal cap only; the deploy
  // engine's per-resource timeout (default 30m) still wraps the whole loop,
  // so a `--resource-timeout AWS::CertificateManager::Certificate=5m`
  // override caps us at 5m via Promise.race.
  readonly maxPollAttempts = Number(process.env['CDKD_ACM_POLL_ATTEMPTS'] ?? 60);
  readonly pollIntervalMs = Number(process.env['CDKD_ACM_POLL_INTERVAL_MS'] ?? 10000);

  /**
   * The failure wrap the create / update / delete catches build.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug` through the
   * operation's `maskSecrets` (`mask`), and the wrap is stamped
   * `markRedactedCause`, so the retry classifiers read the withheld text on the
   * `cause` chain. An "already exists" is restated ({@link relayedNameCollision}).
   * A cdkd-authored or transport error, or a non-`Error` throw, keeps its text;
   * the deploy engine masks a thrown message. The delete checks
   * `ResourceNotFoundException` by type before it wraps, and the in-use check
   * ({@link isCertificateInUseError}) reads the error class, which the summary
   * keeps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error) || !failure.redacted) return build(failure.detail);
    const m = mask ?? ((text: string) => text);
    this.logger.debug(m(build(m(failure.detail)).message));
    return markRedactedCause(build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`));
  }

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

  /**
   * Issue #1160: CloudFormation documents removing
   * `CertificateTransparencyLoggingPreference` as the same as declaring
   * `ENABLED`, applied through `UpdateCertificateOptions`, while that call
   * keeps an absent option's live value.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::CertificateManager::Certificate',
      new Map<string, unknown>([['CertificateTransparencyLoggingPreference', 'ENABLED']]),
    ],
  ]);

  /**
   * Issue #1160: every other property, each removal handled — the immutable
   * ones replace the certificate in `update()` (`CertificateExport` cannot be
   * updated after creation), and Tags are diffed.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CertificateManager::Certificate',
      new Set([
        'DomainName',
        'ValidationMethod',
        'SubjectAlternativeNames',
        'DomainValidationOptions',
        'CertificateAuthorityArn',
        'CertificateExport',
        'KeyAlgorithm',
        'Tags',
      ]),
    ],
  ]);

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  /**
   * The region an ACM ARN names, for the manual retire command. Taken from the
   * ARN rather than from the client so the command a user pastes matches the
   * certificate it names even when their shell default differs. Falls back to
   * the literal placeholder for a shape this cannot parse -- a wrong region
   * would make the command silently address a different account/region.
   */
  regionOfArn(arn: string): string {
    return arn.split(':')[3] || '<region>';
  }

  /** See {@link cleanupRequestedCertificate} in `acm-certificate/create.ts`. */
  cleanupRequestedCertificate(
    certificateArn: string,
    logicalId: string,
    idempotencyToken: IdempotencyToken,
    maskSecrets: ((text: string) => string) | undefined
  ): Promise<string | undefined> {
    return cleanupRequestedCertificate.call(
      this,
      certificateArn,
      logicalId,
      idempotencyToken,
      maskSecrets
    );
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
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

  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType, properties);
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

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  // ── helpers ───────────────────────────────────────────────────────

  waitForCertificateIssued(
    certificateArn: string,
    logicalId: string,
    resourceType: string,
    zones?: ReadonlyMap<string, string>
  ): Promise<void> {
    return waitForCertificateIssued.call(this, certificateArn, logicalId, resourceType, zones);
  }

  writeValidationRecords(
    validations: DomainValidation[],
    zones: ReadonlyMap<string, string>,
    written: Map<string, Set<string>>,
    certificateArn: string,
    logicalId: string,
    resourceType: string
  ): Promise<void> {
    return writeValidationRecords.call(
      this,
      validations,
      zones,
      written,
      certificateArn,
      logicalId,
      resourceType
    );
  }

  renderValidationOptions(validations: DomainValidation[]): string | undefined {
    return renderValidationOptions.call(this, validations);
  }

  updateTags(
    certificateArn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    return updateTags.call(this, certificateArn, resourceType, logicalId, oldTagsRaw, newTagsRaw);
  }
}
