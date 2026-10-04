import {
  LambdaClient,
  PublishLayerVersionCommand,
  DeleteLayerVersionCommand,
  GetLayerVersionByArnCommand,
  ListLayerVersionsCommand,
  ResourceNotFoundException,
  type PublishLayerVersionCommandOutput,
  type LayerVersionContentInput,
  type Runtime,
  type Architecture,
} from '@aws-sdk/client-lambda';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { wrapMaskedAwsError } from '../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceDeleteResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
} from '../masked-retry-logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import {
  AmbiguousCreateLatch,
  RecentIdSet,
  isInsideWindow,
  withoutServerErrorRetries,
  type AmbiguousCreateWindow,
} from './ambiguous-create.js';
import {
  collectOrphanIds,
  orphanCommandRegionArg,
  reportPossibleOrphans,
} from './orphan-report.js';

/**
 * Retry-safety state for `PublishLayerVersion`, which mints the next version
 * number and carries no idempotency token (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)): a replay of a publish
 * AWS completed adds a SECOND version under the same layer name, and the first
 * is in no state record. See `orphan-report.ts`. Module-scoped: a provider
 * instance is per registry, and one process can build several.
 */
const publishLayerVersionLatch = new AmbiguousCreateLatch('lambda:PublishLayerVersion');
/** Layer version ARNs this process published and recorded, never reported as orphan candidates. */
const versionsPublishedByThisProcess = new RecentIdSet();

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetLayerVersionCreateRetryStateForTests(): void {
  publishLayerVersionLatch.resetForTests();
  versionsPublishedByThisProcess.resetForTests();
}

/**
 * `ListLayerVersions`' `CreatedDate` (ISO 8601, documented as
 * `2018-11-27T15:10:45.123+0000`) as a `Date`, or `undefined` when it does not
 * parse -- which leaves that version out of a window lookup (missed, never
 * wrongly reported). The offset is given its colon first: `+0000` is not the
 * ECMAScript date-time format.
 */
export function parseLayerCreatedDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The short `ResourceDeleteResult.reason` the two malformed-`LayerVersionArn`
 * DELETE arms report (issue
 * [#1770](https://github.com/go-to-k/cdkd/issues/1770)).
 *
 * Rendered inline on the destroy status line
 * (`⚠ MyLayer (AWS::Lambda::LayerVersion) skipped (<reason>)`), so it is the
 * SHORT form — the full remediation sentence goes out as the `logger.warn`
 * beside it. Exported so the wording is pinned by a test rather than retyped.
 */
export const LAYER_ARN_SKIP_REASON = 'malformed LayerVersionArn in state — no delete issued';

/**
 * Sibling of {@link LAYER_ARN_SKIP_REASON} for the arm where the ARN has the
 * right shape but its trailing version segment is not a number. Kept distinct
 * because the two point at different halves of the id, and the destroy line is
 * all the user sees.
 */
export const LAYER_VERSION_SKIP_REASON =
  'unparsable version in state LayerVersionArn — no delete issued';

/**
 * The deploy-side caveat both skip warnings in this file carry (issue
 * [#1762](https://github.com/go-to-k/cdkd/issues/1762)).
 *
 * "Repair state.json and re-run" holds on DESTROY and, since #1762, on the
 * deploy engine's template-removal DELETE — both keep the record. It does NOT
 * hold for a deploy-side REPLACEMENT or rollback delete: those now FAIL the
 * resource rather than reporting success, and the old resource can be left
 * untracked, so it has to be removed by hand. Mirrors the caveat
 * `compositeIdFormatMessage` carries for the composite-id family.
 */
const DEPLOY_SKIP_CAVEAT =
  `NOTE this arm is ALSO reached from cdkd deploy. Since issue 1762 the DELETE of a resource ` +
  `removed from the template behaves like destroy — the record is KEPT and the next deploy ` +
  `re-attempts it — but a REPLACEMENT / rollback delete FAILS the resource instead ` +
  `(https://github.com/go-to-k/cdkd/issues/1762), leaving the old one untracked; there, remove the resource by hand.`;

/**
 * The layer NAME inside a layer ARN (`arn:...:layer:<name>[:<version>]`), or
 * `undefined` for any other spelling. A secret-masking needle only (issue
 * #2177).
 */
function layerNameSegment(value: string): string | undefined {
  return /:layer:([^:]+)/.exec(value)?.[1];
}

/**
 * AWS Lambda LayerVersion Provider
 *
 * Implements resource provisioning for AWS::Lambda::LayerVersion using the Lambda SDK.
 * WHY: PublishLayerVersion is synchronous - the CC API does not support this resource type.
 *
 * Note: Lambda LayerVersions are immutable. Updates publish a new version (new ARN).
 * Deletes target the specific version extracted from the ARN.
 */
export class LambdaLayerVersionProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private createClient: Promise<LambdaClient> | undefined;
  private logger = getLogger().child('LambdaLayerVersionProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::LayerVersion',
      new Set([
        'LayerName',
        'Content',
        'CompatibleRuntimes',
        'CompatibleArchitectures',
        'Description',
        'LicenseInfo',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
  }

  /**
   * The client `PublishLayerVersion` goes through: SDK retries on, except a
   * 5xx (`withoutServerErrorRetries`, issue #2080). Separate so every other
   * call -- and every other provider sharing `getAwsClients().lambda` -- keeps
   * the full SDK retry. Built in the shared client's REGION (read from it, as
   * `config.region()` resolves it), so the create cannot land in another
   * region than the calls around it. The PROMISE is cached, so two creates on
   * a cold provider build one client; a rejected region read is not cached,
   * so the next create retries it.
   */
  private getCreateClient(): Promise<LambdaClient> {
    this.createClient ??= this.lambdaClient.config.region().then(
      (region) =>
        withoutServerErrorRetries(new LambdaClient({ ...ambientClientDefaults(), region })),
      (error: unknown) => {
        this.createClient = undefined;
        throw error;
      }
    );
    return this.createClient;
  }

  /**
   * Issue #2080: list the versions of `layerName` an earlier ambiguous
   * `PublishLayerVersion` attempt may have published -- created inside its
   * window and not recorded by this process -- and warn, with a read command
   * and then a delete command to run only after confirming. Detection only:
   * a layer name is per account and region while cdkd's stack lock is per
   * state location, so a version in the window can be another deploy's.
   */
  private async reportPossibleLayerOrphans(
    logicalId: string,
    window: AmbiguousCreateWindow,
    log: MaskedLogSinks,
    layerName: string
  ): Promise<void> {
    const aws = pasteableAwsCommand(log.mask);
    const regionArg = await orphanCommandRegionArg(this.lambdaClient, aws);
    // The version number is the ARN's last segment; the layer name argument
    // stays the one this create publishes under (a name or a layer ARN).
    const versionOf = (arn: string): string => /:(\d+)$/.exec(arn)?.[1] ?? '';
    await reportPossibleOrphans(logicalId, window, log, {
      action: 'PublishLayerVersion',
      service: 'Lambda',
      listAction: 'ListLayerVersions',
      subject: `a version of layer ${log.value(layerName)}`,
      noun: 'layer version(s)',
      list: () =>
        collectOrphanIds(
          async (marker) => {
            const page = await this.lambdaClient.send(
              new ListLayerVersionsCommand({
                LayerName: layerName,
                ...(marker && { Marker: marker }),
              })
            );
            return { items: page.LayerVersions ?? [], next: page.NextMarker };
          },
          (item) =>
            item.LayerVersionArn &&
            versionOf(item.LayerVersionArn) !== '' &&
            isInsideWindow(parseLayerCreatedDate(item.CreatedDate), window) &&
            !versionsPublishedByThisProcess.has(item.LayerVersionArn)
              ? item.LayerVersionArn
              : undefined
        ),
      inspect: (id) =>
        aws`aws lambda get-layer-version --layer-name ${layerName} --version-number ${versionOf(id)}${regionArg}`.render(),
      remove: (id) =>
        aws`aws lambda delete-layer-version --layer-name ${layerName} --version-number ${versionOf(id)}${regionArg}`.render(),
    });
  }

  /**
   * Create a Lambda layer version.
   *
   * `context` is read for its masker only (issue #2177): every line and
   * failure goes through one masked sink set, and the layer version ARN
   * embeds `LayerName`, which the template may have resolved from a secret.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const layerName =
      (properties['LayerName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });
    // Built per call; never cached on the provider, which serves concurrent
    // resources. A generated name is not secret-derived, so the pair adds a
    // needle only when the template's `LayerName` is.
    const log = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      [
        [properties['LayerName'], layerName],
        // `LayerName` may be a layer ARN; AWS may quote the bare name.
        [properties['LayerName'], layerNameSegment(layerName)],
      ]
    );
    log.debug(`Creating Lambda layer version ${logicalId}`);

    const content = properties['Content'] as Record<string, unknown> | undefined;
    if (!content) {
      throw new ProvisioningError(
        `Content is required for Lambda layer version ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const contentInput: LayerVersionContentInput = {};
      if (content['S3Bucket']) contentInput.S3Bucket = content['S3Bucket'] as string;
      if (content['S3Key']) contentInput.S3Key = content['S3Key'] as string;
      if (content['S3ObjectVersion'])
        contentInput.S3ObjectVersion = content['S3ObjectVersion'] as string;

      // Issue #2080: after an earlier ambiguous attempt, name the version it
      // may have published before a second PublishLayerVersion is sent.
      // Detection only -- see `orphan-report.ts`.
      const orphanWindow = publishLayerVersionLatch.take(logicalId);
      if (orphanWindow !== undefined) {
        await this.reportPossibleLayerOrphans(logicalId, orphanWindow, log, layerName);
      }
      const createClient = await this.getCreateClient();
      const attemptStartMs = Date.now();
      let response: PublishLayerVersionCommandOutput;
      try {
        response = await createClient.send(
          new PublishLayerVersionCommand({
            LayerName: layerName,
            Content: contentInput,
            CompatibleRuntimes: properties['CompatibleRuntimes'] as Runtime[] | undefined,
            CompatibleArchitectures: properties['CompatibleArchitectures'] as
              | Architecture[]
              | undefined,
            Description: properties['Description'] as string | undefined,
            LicenseInfo: properties['LicenseInfo'] as string | undefined,
          })
        );
      } catch (error) {
        publishLayerVersionLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
        throw error;
      }

      const layerVersionArn = response.LayerVersionArn!;
      if (layerVersionArn) versionsPublishedByThisProcess.add(layerVersionArn);
      log.debug(`Successfully created Lambda layer version ${logicalId}: ${layerVersionArn}`);

      return {
        physicalId: layerVersionArn,
        attributes: {
          LayerVersionArn: layerVersionArn,
        },
      };
    } catch (error) {
      // AWS quotes a rejected request value back (issue #2177); a message the
      // mask changed is stamped so the retry classifiers read the unmasked
      // `cause` (issue #4244).
      const cause = error instanceof Error ? error : undefined;
      throw wrapMaskedAwsError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create Lambda layer version ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
    }
  }

  /**
   * Update a Lambda layer version.
   *
   * Lambda layer versions are immutable on AWS — there is no API to mutate
   * `Content` / `CompatibleRuntimes` / `CompatibleArchitectures` /
   * `Description` / `LicenseInfo` of an existing version. The only path to
   * a "new value" is publishing a new version (new LayerVersionArn).
   *
   * Why this rejects with `ResourceUpdateNotSupportedError` instead of
   * silently publishing a new version:
   *
   *   - `cdkd drift --revert` calls `update(observed, observed)` to push
   *     state values back into AWS. For an immutable resource that cannot
   *     have its in-place value changed, the only AWS-side effect of an
   *     "update" is leaking a duplicate version of the same content,
   *     which is never what `--revert` should do.
   *   - On the deploy path, content / runtime / arch changes flow
   *     through CDK's hash-based logical naming, which produces a fresh
   *     logical ID and a CREATE+DELETE in cdkd's diff. For a hand-authored
   *     template that edits the SAME logical id in place, the replacement
   *     rule for `AWS::Lambda::LayerVersion` (every property is
   *     "Update requires: Replacement") drives a DELETE+CREATE before
   *     `update()` is ever reached, so this method is a defensive fallback
   *     that should not fire in normal use.
   */
  async update(
    logicalId: string,
    _physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'AWS Lambda LayerVersion is immutable on AWS — there is no UpdateLayerVersion API; every change requires PublishLayerVersion (a new version with a new LayerVersionArn). cdkd normally classifies any LayerVersion property change as a replacement (DELETE + CREATE), so reaching this path is unexpected; re-run the deploy or change the resource definition to publish a new version.'
      )
    );
  }

  /**
   * Delete a Lambda layer version
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting Lambda layer version ${logicalId}: ${physicalId}`);

    // Extract layer name and version number from the ARN
    // ARN format: arn:aws:lambda:region:account:layer:name:version
    //
    // Issue #1770: both malformed-ARN arms below report `outcome: 'skipped'`.
    // Neither means the layer version is GONE — cdkd simply cannot name it in
    // a DeleteLayerVersion call, so the version stays published in AWS. The
    // repair is in state.json (or a re-import), which is what the reason says.
    //
    // The ARN is the ONLY source here, unlike the Lambda-permission and
    // IAM-policy arms which fall back to a second one: `DeleteLayerVersion`
    // needs LayerName AND VersionNumber, and the version is AWS-assigned, so it
    // appears nowhere in the template properties. Nor does "LEFT IN PLACE" need
    // the in-stack-parent qualifier those two carry — a layer version is
    // standalone, so nothing else in the destroy removes it on its way out.
    const arnParts = physicalId.split(':');
    if (arnParts.length < 8) {
      this.logger.warn(
        `Invalid LayerVersionArn format: ${physicalId}, skipping deletion — no AWS call is ` +
          `issued, so the layer version is LEFT IN PLACE and still counts against the account's ` +
          `storage quota. Repair the physicalId in state.json and re-run, or delete the layer ` +
          `version by hand. ${DEPLOY_SKIP_CAVEAT}`
      );
      return { outcome: 'skipped', reason: LAYER_ARN_SKIP_REASON };
    }
    const layerName = arnParts[6]!;
    const versionNumber = parseInt(arnParts[7]!, 10);

    if (isNaN(versionNumber)) {
      this.logger.warn(
        `Could not parse version number from ARN: ${physicalId}, skipping deletion — no AWS ` +
          `call is issued, so the layer version is LEFT IN PLACE and still counts against the ` +
          `account's storage quota. Repair the physicalId in state.json and re-run, or delete ` +
          `the layer version by hand. ${DEPLOY_SKIP_CAVEAT}`
      );
      return { outcome: 'skipped', reason: LAYER_VERSION_SKIP_REASON };
    }

    try {
      await this.lambdaClient.send(
        new DeleteLayerVersionCommand({
          LayerName: layerName,
          VersionNumber: versionNumber,
        })
      );
      this.logger.debug(`Successfully deleted Lambda layer version ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.lambdaClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Lambda layer version ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Lambda layer version ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current Lambda layer version configuration in CFn-property
   * shape.
   *
   * Issues `GetLayerVersionByArn` (the physical id is the version ARN) and
   * surfaces `LayerName`, `Description`, `CompatibleRuntimes`,
   * `CompatibleArchitectures`, and `LicenseInfo`. AWS-managed fields
   * (`Version`, `CreatedDate`, `LayerVersionArn`, `LayerArn`,
   * `Content.CodeSize`, `Content.CodeSha256`) are filtered at the wire
   * layer.
   *
   * `Content` is intentionally omitted: like Lambda function `Code`, the
   * `GetLayerVersionByArn` response contains a pre-signed S3 URL for the
   * deployed content, not the asset hash cdkd state stored. The two could
   * never match, so excluding it avoids a guaranteed false-positive.
   *
   * `LayerName` is derived from the ARN tail when not surfaced directly:
   * the version ARN format is
   *   `arn:aws:lambda:<region>:<account>:layer:<name>:<version>`.
   *
   * Returns `RESOURCE_NOT_FOUND` when the layer version is gone
   * (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let resp;
    try {
      resp = await this.lambdaClient.send(new GetLayerVersionByArnCommand({ Arn: physicalId }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }

    const result: Record<string, unknown> = {};

    // Derive LayerName from ARN if needed. ARN format:
    //   arn:aws:lambda:<region>:<account>:layer:<name>:<version>
    const arnParts = physicalId.split(':');
    if (arnParts.length >= 7 && arnParts[6]) {
      result['LayerName'] = arnParts[6];
    }

    if (resp.Description !== undefined && resp.Description !== '') {
      result['Description'] = resp.Description;
    }
    if (resp.CompatibleRuntimes !== undefined && resp.CompatibleRuntimes.length > 0) {
      result['CompatibleRuntimes'] = [...resp.CompatibleRuntimes];
    }
    if (resp.CompatibleArchitectures !== undefined && resp.CompatibleArchitectures.length > 0) {
      result['CompatibleArchitectures'] = [...resp.CompatibleArchitectures];
    }
    if (resp.LicenseInfo !== undefined && resp.LicenseInfo !== '') {
      result['LicenseInfo'] = resp.LicenseInfo;
    }

    return result;
  }

  /**
   * `Content: { S3Bucket, S3Key }` is set on create but
   * `GetLayerVersionByArn` only returns a pre-signed URL for the deployed
   * content — the original asset key is unrecoverable. Tell the drift
   * comparator to skip the whole `Content` subtree to avoid the guaranteed
   * false-positive that would fire on every clean run.
   */
  getDriftUnknownPaths(): string[] {
    return ['Content'];
  }

  /**
   * Adopt an existing Lambda layer version into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<layerVersionArn>` override → verify with
   *     `GetLayerVersionByArn`. (Note: there is no `LayerName` field that
   *     uniquely names a *version*; a layer name resolves to the latest
   *     version, so an explicit ARN is the only unambiguous override.)
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.lambdaClient.send(
          new GetLayerVersionByArnCommand({ Arn: input.knownPhysicalId })
        );
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a layer
    // version reaching here needs an explicit `--resource <id>=<arn>` override.
    return null;
  }
}
