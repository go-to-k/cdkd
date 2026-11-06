import {
  CreateHttpNamespaceCommand,
  CreatePrivateDnsNamespaceCommand,
  CreatePublicDnsNamespaceCommand,
  UpdateHttpNamespaceCommand,
  UpdatePrivateDnsNamespaceCommand,
  UpdatePublicDnsNamespaceCommand,
  DeleteNamespaceCommand,
  GetNamespaceCommand,
  NamespaceNotFound,
  ResourceInUse,
  type HttpNamespaceChange,
  type PrivateDnsNamespaceChange,
  type PublicDnsNamespaceChange,
  type Tag,
} from '@aws-sdk/client-servicediscovery';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { withRetry } from '../../../deployment/retry.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  SecretMasker,
} from '../../../types/resource.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import type { ServiceDiscoveryProvider } from '../servicediscovery-provider.js';
import {
  PUBLIC_DNS_NAMESPACE_DEFAULT_SOA_TTL,
  PRIVATE_DNS_NAMESPACE_DEFAULT_SOA_TTL,
  markNotGoneOnNotFoundClass,
} from './shared.js';

// ─── AWS::ServiceDiscovery::PrivateDnsNamespace ───────────────────

export async function createNamespace(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating private DNS namespace ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags: Tag[] = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const client = this.getClient();

  const name = properties['Name'] as string;
  const vpc = properties['Vpc'] as string;
  const description = properties['Description'] as string | undefined;

  if (!name) {
    throw new ProvisioningError(
      `Name is required for PrivateDnsNamespace ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  if (!vpc) {
    throw new ProvisioningError(
      `Vpc is required for PrivateDnsNamespace ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // CFn `Properties.DnsProperties.SOA.TTL` is mutable. Pass it through to
  // CreatePrivateDnsNamespace so a templated TTL is actually applied
  // (without this, cdkd silently dropped the property and AWS used its
  // default 15 — readCurrentState would then surface the AWS default,
  // detected as drift on the very first run after deploy). PR #201
  // follow-up: also added `Properties` to the handledProperties set so
  // the deploy engine doesn't fall back to CC API on this resource type.
  const inputProperties = this.extractSoaTtlProperties(properties);

  // go-to-k/cdkd#4583: set once the create operation has SUCCEEDED; a failure
  // after it (the ARN lookup) leaves this namespace with no state record.
  let createdNamespaceId: string | undefined;
  try {
    const response = await client.send(
      new CreatePrivateDnsNamespaceCommand({
        Name: name,
        Vpc: vpc,
        ...(description && { Description: description }),
        ...(tags.length > 0 && { Tags: tags }),
        ...(inputProperties && { Properties: inputProperties }),
      })
    );

    const operationId = response.OperationId;
    if (!operationId) {
      throw new Error('CreatePrivateDnsNamespace did not return OperationId');
    }

    // Poll for operation completion
    const namespaceId = await this.pollOperation(operationId, logicalId, resourceType, maskSecrets);
    // pollOperation falls back to the operation id when AWS names no namespace;
    // that is not an id delete() can take, so leave it unmarked.
    if (namespaceId !== operationId) createdNamespaceId = namespaceId;

    // Build ARN
    const arn = await this.buildNamespaceArn(namespaceId);

    this.logger.debug(`Successfully created private DNS namespace ${logicalId}: ${namespaceId}`);

    return {
      physicalId: namespaceId,
      attributes: {
        Id: namespaceId,
        Arn: arn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    // `cause` carries the ORIGINAL error untouched (issue #2063): the
    // classifier walks it for `$metadata`, so only the human-readable
    // message is masked. The `ProvisioningError` passthrough below is why
    // {@link pollOperation} masks its OWN message rather than relying on
    // this line — a FAILED-operation error re-throws here untouched.
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            maskerOrIdentity(maskSecrets),
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create private DNS namespace ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                undefined,
                cause
              )
          );
    if (createdNamespaceId) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdNamespaceId);
    }
    throw thrown;
  }
}

/**
 * Update a private DNS namespace.
 *
 * AWS exposes `UpdatePrivateDnsNamespace` for two mutable surfaces:
 *  - `Description`
 *  - `Properties.DnsProperties.SOA.TTL`
 *
 * `Name` and `Vpc` are immutable; the deploy engine's
 * replacement-detection layer routes those through DELETE+CREATE
 * before this method is ever called, so we do not validate them here.
 * Tags ride on the separate `TagResource` / `UntagResource` APIs
 * (see {@link syncNamespaceTags} — wired in with issue #1044 so a
 * Tags-only change is no longer silently dropped, the ECR #981 class).
 *
 * Empty-string Description is intentionally allowed through (`!== undefined`
 * gate, not truthy) so `cdkd drift --revert` can clear a console-side ADD.
 *
 * Removal resets (issue #1160): the change object MERGES (absent = "no
 * change"), so a Description / SOA.TTL REMOVED from the template must be
 * reset explicitly — Description via the `''` clear sentinel, TTL to the
 * kind's Cloud Map default ({@link PRIVATE_DNS_NAMESPACE_DEFAULT_SOA_TTL}) —
 * the CFn-parity shape, live A/B'd 2026-08-11 on the private kind itself.
 */
export async function updateNamespace(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating private DNS namespace ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call
  // (read as empty, it would untag every recorded key).
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const client = this.getClient();

  const namespaceChange: PrivateDnsNamespaceChange = {};

  // A REMOVED Description arrives as its `removalDefaults` reset, `''`.
  const description = properties['Description'] as string | undefined;
  if (description !== undefined) {
    namespaceChange.Description = description;
  }

  const soaProperties = this.resolveSoaTtlChange(
    properties,
    previousProperties,
    PRIVATE_DNS_NAMESPACE_DEFAULT_SOA_TTL
  );
  if (soaProperties) {
    namespaceChange.Properties = soaProperties;
  }

  try {
    if (Object.keys(namespaceChange).length > 0) {
      const response = await client.send(
        new UpdatePrivateDnsNamespaceCommand({
          Id: physicalId,
          Namespace: namespaceChange,
        })
      );

      const operationId = response.OperationId;
      if (operationId) {
        await this.pollOperation(operationId, logicalId, resourceType, maskSecrets);
      }
    } else {
      this.logger.debug(`No mutable namespace-body diff for PrivateDnsNamespace ${logicalId}`);
    }

    await this.syncNamespaceTags(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties
    );

    this.logger.debug(`Successfully updated private DNS namespace ${logicalId}`);

    return { physicalId, wasReplaced: false };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update private DNS namespace ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Delete a Cloud Map namespace (shared by PrivateDnsNamespace,
 * HttpNamespace, and PublicDnsNamespace — `DeleteNamespace` is
 * kind-agnostic and operation-based for all three).
 */
export async function deleteNamespace(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Cloud Map namespace ${logicalId}: ${physicalId}`);
  const client = this.getClient();

  try {
    // ECS Service Connect creates Cloud Map services inside a namespace and
    // deletes them ASYNCHRONOUSLY after the owning ECS service is deleted,
    // so a destroy that removes the ECS service and then this namespace in
    // DAG order can hit `ResourceInUse: Namespace has associated services`
    // while the ECS-managed cleanup is still draining (observed live on the
    // ecs-fargate fixture once #609 flipped its Service to the SDK route:
    // destroy failed 22/23, and the associated services were gone minutes
    // later with no action taken). Retry the delete on that signal with a
    // bounded ~5.5 min budget; any other error surfaces immediately.
    //
    // Interruptible (issue #2053): 24 retries at 3s -> 15s is ~5.5 minutes of
    // backoff, and without the watch a Ctrl-C had to sit out all of it.
    const watch = startInterruptWatch(`Cloud Map namespace ${logicalId}`);
    try {
      await withRetry(
        async () => {
          const response = await client.send(new DeleteNamespaceCommand({ Id: physicalId }));

          const operationId = response.OperationId;
          if (operationId) {
            await this.pollOperation(operationId, logicalId, resourceType);
          }
        },
        logicalId,
        {
          maxRetries: 24,
          initialDelayMs: 3_000,
          maxDelayMs: 15_000,
          isRetryable: (message, error) =>
            error instanceof ResourceInUse || /has associated services/i.test(message),
          logger: this.logger,
          isInterrupted: watch.isInterrupted,
          onInterrupted: watch.onInterrupted,
        }
      );
    } finally {
      watch.dispose();
    }

    this.logger.debug(`Successfully deleted Cloud Map namespace ${logicalId}`);
  } catch (error) {
    if (error instanceof NamespaceNotFound) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Namespace ${physicalId} does not exist, skipping deletion`);
      return;
    }
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    // `OperationNotFound` from the poll's GetOperation names the class.
    const refused = markNotGoneOnNotFoundClass(
      error,
      this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete Cloud Map namespace ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      )
    );
    throw refused;
  }
}

// ─── AWS::ServiceDiscovery::HttpNamespace ─────────────────────────

export async function createHttpNamespace(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating HTTP namespace ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags: Tag[] = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const client = this.getClient();

  const name = properties['Name'] as string;
  const description = properties['Description'] as string | undefined;

  if (!name) {
    throw new ProvisioningError(
      `Name is required for HttpNamespace ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // go-to-k/cdkd#4583: set once the create operation has SUCCEEDED; a failure
  // after it (the ARN lookup) leaves this namespace with no state record.
  let createdNamespaceId: string | undefined;
  try {
    const response = await client.send(
      new CreateHttpNamespaceCommand({
        Name: name,
        ...(description && { Description: description }),
        ...(tags.length > 0 && { Tags: tags }),
      })
    );

    const operationId = response.OperationId;
    if (!operationId) {
      throw new Error('CreateHttpNamespace did not return OperationId');
    }

    const namespaceId = await this.pollOperation(operationId, logicalId, resourceType, maskSecrets);
    // pollOperation falls back to the operation id when AWS names no namespace;
    // that is not an id delete() can take, so leave it unmarked.
    if (namespaceId !== operationId) createdNamespaceId = namespaceId;
    const arn = await this.resolveNamespaceArn(namespaceId);

    this.logger.debug(`Successfully created HTTP namespace ${logicalId}: ${namespaceId}`);

    return {
      physicalId: namespaceId,
      attributes: {
        Id: namespaceId,
        Arn: arn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            maskerOrIdentity(maskSecrets),
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create HTTP namespace ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                undefined,
                cause
              )
          );
    if (createdNamespaceId) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdNamespaceId);
    }
    throw thrown;
  }
}

/**
 * Update an HTTP namespace.
 *
 * `UpdateHttpNamespace` exposes exactly one mutable field: `Description`
 * (the SDK's `HttpNamespaceChange` shape). `Name` is createOnly — the
 * replacement-detection layer routes a Name change through DELETE+CREATE
 * before this method is ever called. Tags ride on the separate
 * `TagResource` / `UntagResource` APIs (see {@link syncNamespaceTags}).
 *
 * Empty-string Description is intentionally allowed through
 * (`!== undefined` gate, not truthy) so `cdkd drift --revert` can clear a
 * console-side ADD.
 *
 * Removal reset (issue #1160): `HttpNamespaceChange` MERGES conceptually
 * (skipping the call keeps the live value), so a Description REMOVED from
 * the template must be cleared explicitly via the `''` sentinel — the
 * CFn-parity shape, measured on this kind (see {@link removalDefaults}).
 */
export async function updateHttpNamespace(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating HTTP namespace ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call
  // (read as empty, it would untag every recorded key).
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const client = this.getClient();

  // A REMOVED Description arrives as its `removalDefaults` reset, `''`.
  const description = properties['Description'] as string | undefined;

  try {
    if (description !== undefined) {
      const namespaceChange: HttpNamespaceChange = {
        Description: description,
      };
      const response = await client.send(
        new UpdateHttpNamespaceCommand({
          Id: physicalId,
          Namespace: namespaceChange,
        })
      );

      const operationId = response.OperationId;
      if (operationId) {
        await this.pollOperation(operationId, logicalId, resourceType, maskSecrets);
      }
    }

    await this.syncNamespaceTags(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties
    );

    this.logger.debug(`Successfully updated HTTP namespace ${logicalId}`);

    return { physicalId, wasReplaced: false };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update HTTP namespace ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

// ─── AWS::ServiceDiscovery::PublicDnsNamespace ────────────────────

export async function createPublicDnsNamespace(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating public DNS namespace ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags: Tag[] = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const client = this.getClient();

  const name = properties['Name'] as string;
  const description = properties['Description'] as string | undefined;

  if (!name) {
    throw new ProvisioningError(
      `Name is required for PublicDnsNamespace ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // Same mutable nested field as PrivateDnsNamespace:
  // `Properties.DnsProperties.SOA.TTL` — pass it through so a templated
  // TTL is applied instead of AWS's default.
  const inputProperties = this.extractSoaTtlProperties(properties);

  // go-to-k/cdkd#4583: set once the create operation has SUCCEEDED; a failure
  // after it (the ARN lookup) leaves this namespace with no state record.
  let createdNamespaceId: string | undefined;
  try {
    const response = await client.send(
      new CreatePublicDnsNamespaceCommand({
        Name: name,
        ...(description && { Description: description }),
        ...(tags.length > 0 && { Tags: tags }),
        ...(inputProperties && { Properties: inputProperties }),
      })
    );

    const operationId = response.OperationId;
    if (!operationId) {
      throw new Error('CreatePublicDnsNamespace did not return OperationId');
    }

    const namespaceId = await this.pollOperation(operationId, logicalId, resourceType, maskSecrets);
    // pollOperation falls back to the operation id when AWS names no namespace;
    // that is not an id delete() can take, so leave it unmarked.
    if (namespaceId !== operationId) createdNamespaceId = namespaceId;

    // PublicDnsNamespace exposes `HostedZoneId` as a CFn attribute (AWS
    // creates a public Route 53 hosted zone alongside the namespace);
    // GetNamespace returns both the Arn and the HostedZoneId.
    let arn: string | undefined;
    let hostedZoneId: string | undefined;
    try {
      const nsResp = await client.send(new GetNamespaceCommand({ Id: namespaceId }));
      arn = nsResp.Namespace?.Arn;
      hostedZoneId = nsResp.Namespace?.Properties?.DnsProperties?.HostedZoneId;
    } catch (err) {
      // Deliberately UNMASKED even though a masker is in scope here (issue
      // #2063 audit). Not an oversight and not "probably fine": the request
      // is `GetNamespace({ Id })` where `Id` came back from AWS's own
      // operation result, so NO resolved template value is in the payload
      // for AWS to quote back. The masked lines in this same `try` are the
      // ones whose payload IS built from `properties`. If this call ever
      // grows a template-derived member, mask it.
      this.logger.debug(
        `GetNamespace(${namespaceId}) after create failed: ${describeAwsFailure(err).detail}`
      );
    }
    if (!arn) {
      arn = await this.buildNamespaceArn(namespaceId);
    }

    this.logger.debug(`Successfully created public DNS namespace ${logicalId}: ${namespaceId}`);

    return {
      physicalId: namespaceId,
      attributes: {
        Id: namespaceId,
        Arn: arn,
        ...(hostedZoneId && { HostedZoneId: hostedZoneId }),
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            maskerOrIdentity(maskSecrets),
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create public DNS namespace ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                undefined,
                cause
              )
          );
    if (createdNamespaceId) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdNamespaceId);
    }
    throw thrown;
  }
}

/**
 * Update a public DNS namespace.
 *
 * `UpdatePublicDnsNamespace` exposes two mutable surfaces (the SDK's
 * `PublicDnsNamespaceChange` shape): `Description` and
 * `Properties.DnsProperties.SOA.TTL`. `Name` is createOnly — replacement
 * is routed through DELETE+CREATE upstream. Tags ride on the separate
 * `TagResource` / `UntagResource` APIs (see {@link syncNamespaceTags}).
 *
 * Removal resets (issue #1160): the change object MERGES (absent = "no
 * change"), so a Description / SOA.TTL REMOVED from the template must be
 * reset explicitly — Description via the `''` clear sentinel, TTL to the
 * kind's Cloud Map default ({@link PUBLIC_DNS_NAMESPACE_DEFAULT_SOA_TTL}) —
 * the CFn-parity shape. The TTL reset was live A/B'd 2026-08-11 on this
 * exact kind; the Description clear's measurements are on
 * {@link removalDefaults}.
 */
export async function updatePublicDnsNamespace(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating public DNS namespace ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call
  // (read as empty, it would untag every recorded key).
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const client = this.getClient();

  const namespaceChange: PublicDnsNamespaceChange = {};

  // A REMOVED Description arrives as its `removalDefaults` reset, `''`.
  const description = properties['Description'] as string | undefined;
  if (description !== undefined) {
    namespaceChange.Description = description;
  }

  const soaProperties = this.resolveSoaTtlChange(
    properties,
    previousProperties,
    PUBLIC_DNS_NAMESPACE_DEFAULT_SOA_TTL
  );
  if (soaProperties) {
    namespaceChange.Properties = soaProperties;
  }

  try {
    if (Object.keys(namespaceChange).length > 0) {
      const response = await client.send(
        new UpdatePublicDnsNamespaceCommand({
          Id: physicalId,
          Namespace: namespaceChange,
        })
      );

      const operationId = response.OperationId;
      if (operationId) {
        await this.pollOperation(operationId, logicalId, resourceType, maskSecrets);
      }
    }

    await this.syncNamespaceTags(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties
    );

    this.logger.debug(`Successfully updated public DNS namespace ${logicalId}`);

    return { physicalId, wasReplaced: false };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update public DNS namespace ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
