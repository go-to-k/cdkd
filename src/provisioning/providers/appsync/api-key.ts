import {
  CreateApiKeyCommand,
  DeleteApiKeyCommand,
  ListApiKeysCommand,
  type CreateApiKeyCommandInput,
  type CreateApiKeyCommandOutput,
} from '@aws-sdk/client-appsync';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import {
  compositeIdFormatMessage,
  compositeIdSkipResult,
  packCompositeId,
} from '../../composite-id.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceDeleteResult,
} from '../../../types/resource.js';
import {
  createMaskedLogSinks,
  maskerOrIdentity,
  type MaskedLogSinks,
} from '../../masked-retry-logger.js';
import { injectiveKey } from '../../../state/record-keys.js';
import { markNotGone } from '../../not-gone.js';
import { replayedSendWindow, type AmbiguousCreateWindow } from '../ambiguous-create.js';
import {
  collectOrphanIds,
  orphanCommandRegionArg,
  reportPossibleOrphans,
} from '../orphan-report.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import {
  createApiKeyLatch,
  apiKeysCreatedByThisProcess,
  APPSYNC_APIKEY_ID_FORMAT,
  displayApiKeyPhysicalId,
  maskedApiKeyId,
  withApiKeyMasked,
} from './shared.js';
import type { AppSyncProvider } from '../appsync-provider.js';

// ─── AWS::AppSync::ApiKey ──────────────────────────────────────────

export async function createApiKey(
  this: AppSyncProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating ApiKey ${logicalId}`);

  const apiId = properties['ApiId'] as string;
  if (!apiId) {
    throw new ProvisioningError(
      `ApiId is required for ApiKey ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  let apiKeyId: string;
  try {
    const input: CreateApiKeyCommandInput = { apiId };

    if (properties['Description']) {
      input.description = properties['Description'] as string;
    }
    if (properties['Expires']) {
      input.expires = properties['Expires'] as number;
    }

    // Issue #2080: after an earlier ambiguous attempt, name the key it may
    // have made before a second CreateApiKey is sent. Detection only.
    const orphanWindow = createApiKeyLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await this.reportPossibleOrphanApiKeys(
        logicalId,
        input,
        orphanWindow,
        createMaskedLogSinks(this.logger, context?.maskSecrets)
      );
    }
    const attemptStartMs = Date.now();
    let response: CreateApiKeyCommandOutput;
    try {
      response = await this.getCreateClient().send(new CreateApiKeyCommand(input));
    } catch (error) {
      createApiKeyLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    apiKeyId = response.apiKey!.id!;
    apiKeysCreatedByThisProcess.add(injectiveKey(apiId, apiKeyId));
    // Issue #4687: the SDK replayed this CreateApiKey inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await this.reportPossibleOrphanApiKeys(
        logicalId,
        input,
        replayWindow,
        createMaskedLogSinks(this.logger, context?.maskSecrets)
      );
    }
    this.logger.debug(`Successfully created ApiKey ${logicalId}: ${maskedApiKeyId(apiKeyId)}`);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create ApiKey ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }

  // One of only two sites in this change where the guard cannot run before
  // the AWS call: `apiKeyId` is minted by `CreateApiKey`, so there is nothing
  // to check until the key exists (issue #1672). It sits OUTSIDE the try on
  // purpose — that `catch` re-wraps anything thrown as
  // `ProvisioningError('Failed to create ApiKey …')`, so a refusal raised
  // inside it would be reported as an AWS creation failure for a key AWS had
  // in fact created. Acceptable here in the first place only because neither
  // segment is pipe-capable — both are AWS-generated ids — so this is a fence
  // against a future id-shape change, not a live refusal that could strand a
  // created key.
  const physicalId = packCompositeId(
    resourceType,
    logicalId,
    [
      { name: 'apiId', value: apiId },
      { name: 'apiKeyId', value: apiKeyId },
    ],
    {
      // Issue #2176: the refusal QUOTES the offending segment value, on the
      // thrown arm (durable) and the warn arm (terminal) alike, so the masker
      // goes through unconditionally -- it is absent on the paths that have no
      // context, where it degrades to identity. The key segment is masked on
      // top: it is the credential itself (go-to-k/cdkd#5860).
      maskSecrets: withApiKeyMasked(maskerOrIdentity(context?.maskSecrets), apiKeyId),
      ...(context?.replayingState === true && {
        onRefusal: (message: string) => this.logger.warn(message),
      }),
    }
  );

  // Always rebuilt — `CreateApiKey` reports no ARN at all — so this is the
  // arm most exposed to the post-create throw described in `createDataSource`.
  const apiKeyArn = await this.buildAppSyncArnOrWarn(
    `apis/${apiId}/apikeys/${apiKeyId}`,
    logicalId,
    // The warn this may emit names the id, whose key segment is the
    // credential (go-to-k/cdkd#5860).
    displayApiKeyPhysicalId(physicalId)
  );

  return {
    physicalId,
    attributes: {
      ApiKey: apiKeyId,
      // CFn's `Ref` and `Fn::GetAtt Arn` for this type return the API key
      // ARN with the PLURAL segment, `.../apis/<apiId>/apikeys/<keyId>`
      // (measured on a live stack, issue #5540). The CFn docs print the
      // singular `apikey`, which #1681 followed; the measurement wins.
      // Unlike its DataSource / Resolver siblings, `CreateApiKey` reports no
      // ARN at all, so this one must be reconstructed.
      ...(apiKeyArn !== undefined && { Arn: apiKeyArn }),
    },
  };
}

/**
 * After an attempt at `CreateApiKey` ended AMBIGUOUS (a 5xx: AppSync may
 * have made the key and lost the answer), name the keys on the same API that
 * could be its orphan (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)). Detection only, and
 * undated: an `ApiKey` has no name and no creation date, so the candidates
 * are the keys on `input.apiId` with the same description that this process
 * did not record -- which can include this stack's own key from an earlier
 * process or another stack's key on a shared API. Hence a read command and
 * no delete command (`orphan-report.ts`).
 *
 * `expires` is not used to narrow the set: AWS rounds it down to the hour,
 * so neither an explicit value nor the 7-day default pins one attempt.
 *
 * A key's id IS the credential a client sends as `x-api-key`, so the report
 * never prints one: each candidate is named by its last four characters and
 * its expiry, enough to find it in `list-api-keys` output, which the read
 * command prints.
 */
export async function reportPossibleOrphanApiKeys(
  this: AppSyncProvider,
  logicalId: string,
  input: CreateApiKeyCommandInput,
  window: AmbiguousCreateWindow,
  log: MaskedLogSinks
): Promise<void> {
  const apiId = String(input.apiId);
  const description = input.description ?? '';
  const aws = pasteableAwsCommand(log.mask);
  const regionArg = await orphanCommandRegionArg(this.getClient(), aws);
  await reportPossibleOrphans(logicalId, window, log, {
    action: 'CreateApiKey',
    service: 'AppSync',
    listAction: 'ListApiKeys',
    subject: `an API key on GraphQL API ${log.value(apiId)}${
      description === '' ? '' : ` described ${log.value(description)}`
    }`,
    noun: 'API key(s)',
    list: () =>
      collectOrphanIds(
        async (nextToken) => {
          const page = await this.getClient().send(
            new ListApiKeysCommand({ apiId, maxResults: 25, ...(nextToken && { nextToken }) })
          );
          return { items: page.apiKeys ?? [], next: page.nextToken };
        },
        (key) =>
          key.id &&
          (key.description ?? '') === description &&
          !apiKeysCreatedByThisProcess.has(injectiveKey(apiId, key.id))
            ? `${maskedApiKeyId(key.id)}${
                key.expires === undefined || !Number.isFinite(key.expires)
                  ? ''
                  : ` (expires ${new Date(key.expires * 1000).toISOString()})`
              }`
            : undefined
      ),
    inspect: () => aws`aws appsync list-api-keys --api-id ${apiId}${regionArg}`.render(),
  });
}

export async function deleteApiKey(
  this: AppSyncProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting ApiKey ${logicalId}: ${displayApiKeyPhysicalId(physicalId)}`);

  const [apiId, apiKeyId] = physicalId.split('|');
  if (!apiId || !apiKeyId) {
    this.logger.warn(
      compositeIdFormatMessage(
        APPSYNC_APIKEY_ID_FORMAT,
        logicalId,
        displayApiKeyPhysicalId(physicalId),
        { skipping: true }
      )
    );
    // Issue #1752: report the SKIP rather than returning void — a bare
    // `return` was counted as a successful delete by the destroy summary.
    return compositeIdSkipResult();
  }

  try {
    await this.getClient().send(new DeleteApiKeyCommand({ apiId, id: apiKeyId }));
    this.logger.debug(`Successfully deleted ApiKey ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(
        `ApiKey ${displayApiKeyPhysicalId(physicalId)} does not exist, skipping deletion`
      );
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      // AWS's own text, which goes to `debug`, may quote the key back.
      withApiKeyMasked(maskerOrIdentity(context?.maskSecrets), apiKeyId),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete ApiKey ${logicalId}: ${text}`,
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

// ─── Helpers ───────────────────────────────────────────────────────

export function isNotFoundError(this: AppSyncProvider, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const name = (error as { name?: string }).name ?? '';
  return (
    message.includes('not found') ||
    message.includes('does not exist') ||
    name === 'NotFoundException'
  );
}
