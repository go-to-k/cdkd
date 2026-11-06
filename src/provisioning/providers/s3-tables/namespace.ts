import type { S3TablesProvider } from '../s3-tables-provider.js';
import {
  CreateNamespaceCommand,
  DeleteNamespaceCommand,
  NotFoundException,
} from '@aws-sdk/client-s3tables';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNotGone } from '../../not-gone.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { compositeIdFormatMessage, packCompositeId } from '../../composite-id.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { S3_TABLES_NAMESPACE_ID_FORMAT } from './shared.js';

// ─── AWS::S3Tables::Namespace ─────────────────────────────────────

export async function createNamespace(
  this: S3TablesProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating S3 Tables Namespace ${logicalId}`);

  const tableBucketARN = properties['TableBucketARN'] as string | undefined;
  if (!tableBucketARN) {
    throw new ProvisioningError(
      `TableBucketARN is required for S3 Tables Namespace ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // The CFn schema types `Namespace` as a STRING — live `DescribeType`,
  // us-east-1, 2026-08-13: `definitions.Namespace = {"type": "string"}` —
  // and CDK 2.x's `s3tables.CfnNamespace` matches it, accepting a plain
  // `string` and emitting it as a string (not a singleton array). AWS's
  // CreateNamespace API takes an array. An array IS still reachable in a
  // template via `addPropertyOverride('Namespace', [...])`, so both wire
  // shapes are accepted here (issue #1771 corrected the earlier claim that
  // the schema itself typed this `List<String>`).
  const rawNs = properties['Namespace'];
  let namespaceName: string | undefined;
  if (Array.isArray(rawNs) && rawNs.length > 0 && typeof rawNs[0] === 'string') {
    namespaceName = rawNs[0];
  } else if (typeof rawNs === 'string' && rawNs.length > 0) {
    namespaceName = rawNs;
  }
  if (!namespaceName) {
    throw new ProvisioningError(
      `Namespace is required for S3 Tables Namespace ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // Refuse a `|` in either segment BEFORE `CreateNamespace` runs (issue
  // #1672), so the refusal cannot orphan a namespace AWS already holds.
  // Neither segment is realistically pipe-capable — a table-bucket ARN is
  // structurally `|`-free, and S3 Tables constrains a namespace name to
  // lowercase alphanumerics and underscores — so this is uniform
  // defense-in-depth rather than a live hazard. The replay downgrade is
  // wired anyway: `.claude/rules/providers.md` records a MISSING `context`
  // parameter as its own failure mode (no type error, no warning, just a
  // refusal that still fires on a replay — the `SNSTopicProvider` case), and
  // three lines retire the burden of re-deriving the unreachability argument
  // every time this file is read.
  const physicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      { name: 'tableBucketARN', value: tableBucketARN },
      { name: 'namespace', value: namespaceName },
    ],
    {
      // Issue #2176: the refusal QUOTES the offending segment value, on the
      // thrown arm (durable) and the warn arm (terminal) alike, so the masker
      // goes through unconditionally -- it is absent on the paths that have no
      // context, where it degrades to identity.
      maskSecrets: context?.maskSecrets,
      ...(context?.replayingState === true && {
        onRefusal: (message: string) => this.logger.warn(message),
      }),
    }
  );

  try {
    await this.getCreateClient().send(
      new CreateNamespaceCommand({
        tableBucketARN,
        namespace: [namespaceName],
      })
    );

    this.logger.debug(`Successfully created S3 Tables Namespace ${logicalId}: ${physicalId}`);

    return {
      physicalId,
      attributes: {},
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create S3 Tables Namespace ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function deleteNamespace(
  this: S3TablesProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting S3 Tables Namespace ${logicalId}: ${physicalId}`);

  const [tableBucketARN, namespaceName] = physicalId.split('|');
  if (!tableBucketARN || !namespaceName) {
    throw new ProvisioningError(
      compositeIdFormatMessage(S3_TABLES_NAMESPACE_ID_FORMAT, logicalId, physicalId),
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    await this.getClient().send(
      new DeleteNamespaceCommand({
        tableBucketARN,
        namespace: namespaceName,
      })
    );
    this.logger.debug(`Successfully deleted S3 Tables Namespace ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`S3 Tables Namespace ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete S3 Tables Namespace ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
