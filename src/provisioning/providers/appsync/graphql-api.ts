import {
  CreateGraphqlApiCommand,
  ListGraphqlApisCommand,
  DeleteGraphqlApiCommand,
  type AuthenticationType,
  type GraphQLApiType,
  type GraphQLApiVisibility,
  type CreateGraphqlApiCommandInput,
  type CreateGraphqlApiCommandOutput,
} from '@aws-sdk/client-appsync';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { definedAttributes } from '../../attribute-map.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { markNotGone } from '../../not-gone.js';
import {
  ambiguousAttemptLead,
  replayedSendWindow,
  type AmbiguousCreateWindow,
} from '../ambiguous-create.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import {
  createGraphqlApiLatch,
  graphqlApisCreatedByThisProcess,
  MAX_GRAPHQL_API_LIST_PAGES,
  MAX_REPORTED_ORPHAN_APIS,
  type ShapeGuardOptions,
} from './shared.js';
import type { AppSyncProvider } from '../appsync-provider.js';

// ─── AWS::AppSync::GraphQLApi ──────────────────────────────────────

export async function createGraphQLApi(
  this: AppSyncProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating GraphQL API ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const name = properties['Name'] as string;
  if (!name) {
    throw new ProvisioningError(
      `Name is required for GraphQLApi ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const authenticationType = properties['AuthenticationType'] as AuthenticationType | undefined;

  // Atomicity: `EnvironmentVariables` rides a SEPARATE API that can only run
  // after CreateGraphqlApi succeeds, so a failure there would throw before
  // create() returns the physicalId — the deploy engine never learns the API
  // exists and it orphans (and the next attempt collides on the name).
  // Mirrors the CognitoUserPoolProvider / DynamoDBTableProvider post-create
  // rollback pattern.
  let createdApiId: string | undefined;

  // A rollback replay hands `create()` a cdkd STATE record, which the user
  // cannot edit — so every pre-flight refusal below downgrades to a warning
  // there (.claude/rules/providers.md). An ordinary template-path create
  // keeps the refusal.
  const shapeGuard: ShapeGuardOptions = {
    logicalId,
    ...(context?.replayingState === true
      ? {
          onUnusable: (message: string) =>
            this.logger.warn(`${message} (state replay — proceeding without it)`),
        }
      : {}),
  };

  try {
    const input: CreateGraphqlApiCommandInput = {
      name,
      authenticationType: authenticationType ?? 'API_KEY',
    };

    if (properties['XrayEnabled'] !== undefined) {
      input.xrayEnabled = properties['XrayEnabled'] as boolean;
    }

    if (properties['LogConfig']) {
      const logConfig = properties['LogConfig'] as Record<string, unknown>;
      input.logConfig = {
        cloudWatchLogsRoleArn: logConfig['CloudWatchLogsRoleArn'] as string,
        fieldLogLevel: logConfig['FieldLogLevel'] as 'NONE' | 'ERROR' | 'ALL',
        excludeVerboseContent: logConfig['ExcludeVerboseContent'] as boolean | undefined,
      };
    }

    // Tags
    if (properties['Tags']) {
      input.tags = Object.fromEntries(desiredTags.map((t) => [t.Key, t.Value]));
    }

    this.applyGraphQLApiConfig(input, properties, { logicalId, shapeGuard });

    // Create-only members — no `UpdateGraphqlApi` counterpart exists,
    // which is why both are replacement properties in
    // `src/analyzer/replacement-rules.ts`.
    if (properties['ApiType'] !== undefined) {
      input.apiType = properties['ApiType'] as GraphQLApiType;
    }
    if (properties['Visibility'] !== undefined) {
      input.visibility = properties['Visibility'] as GraphQLApiVisibility;
    }

    // Issue #2080: after an earlier ambiguous attempt, name the API it may
    // have made before a second CreateGraphqlApi is sent. Detection only.
    const orphanWindow = createGraphqlApiLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await this.reportPossibleOrphanApis(
        logicalId,
        input,
        orphanWindow,
        maskerOrIdentity(context?.maskSecrets)
      );
    }
    const attemptStartMs = Date.now();
    let response: CreateGraphqlApiCommandOutput;
    try {
      response = await this.getCreateClient().send(new CreateGraphqlApiCommand(input));
    } catch (error) {
      createGraphqlApiLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }
    // Recorded BEFORE any other dereference: if `graphqlApi` came back
    // malformed the API may still exist, and the rollback below is the only
    // thing that keeps it from orphaning.
    createdApiId = response.graphqlApi?.apiId;
    // go-to-k/cdkd#5511: report before the follow-up calls.
    if (createdApiId) reportCreatedResource(logicalId, resourceType, createdApiId);

    const apiId = response.graphqlApi!.apiId!;
    // Issue #4687: the SDK replayed this CreateGraphqlApi inside its `send`,
    // so an earlier attempt may have made an API too. Detection only, and
    // before the follow-up call below, so its failure cannot skip it; the
    // returned API is excluded from its own lookup. Excluded by id, NOT added
    // to the process set yet: a follow-up failure whose rollback fails leaves
    // this API behind, and a later lookup must still name it.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await this.reportPossibleOrphanApis(
        logicalId,
        input,
        replayWindow,
        maskerOrIdentity(context?.maskSecrets),
        apiId
      );
    }
    const arn = response.graphqlApi!.arn!;
    const graphQLUrl = response.graphqlApi!.uris?.['GRAPHQL'];

    // Separate API — must run AFTER the API exists.
    const envRecord = await this.applyEnvironmentVariables(
      apiId,
      resourceType,
      logicalId,
      properties,
      undefined,
      context?.replayingState === true,
      maskerOrIdentity(context?.maskSecrets)
    );

    this.logger.debug(`Successfully created GraphQL API ${logicalId}: ${apiId}`);
    graphqlApisCreatedByThisProcess.add(apiId);

    return {
      physicalId: apiId,
      attributes: definedAttributes({
        ApiId: apiId,
        Arn: arn,
        GraphQLUrl: graphQLUrl,
        // go-to-k/cdkd#6242: the default host names are NOT derived from the
        // api id (AppSync serves an endpoint id of its own), so they are
        // recorded from the response.
        GraphQLDns: response.graphqlApi?.dns?.['GRAPHQL'],
        RealtimeDns: response.graphqlApi?.dns?.['REALTIME'],
      }),
      // A state replay that skipped all or part of the map records what was
      // actually put, not the record it could not send.
      ...(envRecord && {
        effectiveProperties: this.withEnvironmentVariablesRecord(properties, envRecord),
      }),
    };
  } catch (error) {
    let apiLeftBehind = false;
    if (createdApiId) {
      // The API itself was created: a later "already exists" is an
      // auxiliary call's, not this API's collision (#3826).
      markAuxiliaryFailure(error, logicalId);
      try {
        await this.getClient().send(new DeleteGraphqlApiCommand({ apiId: createdApiId }));
        retractCreatedResource(logicalId, resourceType, createdApiId);
        this.logger.debug(`Rolled back partially-created GraphQL API ${createdApiId}`);
      } catch (rollbackError) {
        apiLeftBehind = true;
        // The class at warn, AWS's text at debug under the same head
        // (go-to-k/cdkd#2319): a denied `DeleteGraphqlApi` names the caller.
        // A cdkd-authored error keeps its text at warn.
        const rollbackFailure = describeAwsFailure(rollbackError);
        const cleanupHead = `Failed to roll back partially-created GraphQL API ${createdApiId}: `;
        const mask = maskerOrIdentity(context?.maskSecrets);
        if (rollbackFailure.redacted) {
          this.logger.debug(mask(`${cleanupHead}${rollbackFailure.detail}`));
        }
        this.logger.warn(
          mask(
            `${cleanupHead}${rollbackFailure.redacted ? rollbackFailure.summary : rollbackFailure.detail}`
          )
        );
      }
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create GraphQL API ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    // go-to-k/cdkd#4583: the rollback delete failed, so this API has no state
    // record; name it for the failed-CREATE journal.
    if (apiLeftBehind && createdApiId) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdApiId);
      // go-to-k/cdkd#4945: terminal. CreateGraphqlApi sends no name and no token, so the
      // engine's retry would make another API while the journal names one.
      markNonRetryable(thrown);
    }
    throw thrown;
  }
}

/**
 * The ` --region <r>` fragment for a pasteable command, from the client the
 * call or lookup went through (issue #4307): without it the command runs in
 * the user's shell-default region, where it answers NotFound. An unreadable
 * region renders no fragment rather than failing the warning. Built with the
 * caller's `aws` tag, since a fragment from another tag withholds the command.
 */
export async function regionArg(
  this: AppSyncProvider,
  aws: ReturnType<typeof pasteableAwsCommand>
): Promise<ReturnType<ReturnType<typeof pasteableAwsCommand>>> {
  let region: string | undefined;
  try {
    region = await this.getClient().config.region();
  } catch {
    region = undefined;
  }
  return region ? aws` --region ${region}` : aws``;
}

/**
 * After an attempt at this create ended AMBIGUOUS (in practice a 5xx, the
 * only ambiguous failure the engine retries: AppSync may have made the API
 * and lost the answer), name the APIs
 * that could be its orphan (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)). Detection only:
 * this never adopts and never deletes.
 *
 * Why not adopt: `CreateGraphqlApi` has no token, the name is the
 * template's own and not unique, and `GraphqlApi` carries NO creation date,
 * so a same-named API from another stack, an earlier run or a console user
 * cannot be told from this create's orphan. Binding the wrong one would
 * point this stack's schema, resolvers and `cdkd destroy` at an API it does
 * not own; an orphan costs nothing while it serves no traffic. The one exact
 * channel, a cdkd token tag on the create, was rejected: it would make
 * `appsync:TagResource` a requirement of every API create, collide with tag
 * policies, and leave a cdkd tag each read path then has to strip.
 *
 * With no date to window on, the report says only what it knows: which
 * APIs carry this name and type, excluding the ones this process recorded.
 * That set can include this stack's OWN live API (the old one during a
 * replacement, recorded by an earlier process) or another stack's API of the
 * same name, so the report prints a READ command per id and no delete
 * command: nothing here attributes any of them to this create.
 * Every failure warns and returns: the lookup must never fail a deploy.
 */
export async function reportPossibleOrphanApis(
  this: AppSyncProvider,
  logicalId: string,
  input: CreateGraphqlApiCommandInput,
  window: AmbiguousCreateWindow,
  mask: MaskerFn,
  returnedId?: string
): Promise<void> {
  const since = new Date(window.floorMs).toISOString();
  const lead = ambiguousAttemptLead('CreateGraphqlApi', logicalId, window);
  const replayed = window.replayedInSend === true;
  const name = mask(String(input.name));
  const wantedType = input.apiType ?? 'GRAPHQL';
  const candidates: string[] = [];
  let truncated = false;
  try {
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const page = await this.getClient().send(
        new ListGraphqlApisCommand({ maxResults: 25, ...(nextToken && { nextToken }) })
      );
      for (const api of page.graphqlApis ?? []) {
        if (
          api.apiId &&
          api.name === input.name &&
          (api.apiType ?? 'GRAPHQL') === wantedType &&
          api.apiId !== returnedId &&
          !graphqlApisCreatedByThisProcess.has(api.apiId)
        ) {
          candidates.push(api.apiId);
        }
      }
      nextToken = page.nextToken;
      pages++;
    } while (nextToken && pages < MAX_GRAPHQL_API_LIST_PAGES);
    truncated = nextToken !== undefined;
  } catch (error) {
    const failure = describeAwsFailure(error);
    this.logger.debug(mask(`ListGraphqlApis failed with: ${failure.detail}`));
    this.logger.warn(
      mask(
        `${lead} (at ${since}), so AppSync may have created an API named ${name} that no cdkd state records, and cdkd could not list APIs to look for it (${failure.summary}). ${replayed ? 'Check' : 'Creating a new API; check'} for another API of that name.`
      )
    );
    return;
  }

  const incomplete = truncated
    ? ` The search was incomplete: the API list was cut at ${MAX_GRAPHQL_API_LIST_PAGES} pages.`
    : '';
  if (candidates.length === 0) {
    const line = mask(
      `No listed GraphQL API named ${name} is unrecorded by this deploy, so the listing shows no orphan of the ${replayed ? 'replayed' : 'earlier ambiguous'} CreateGraphqlApi attempt for ${logicalId} (at ${since}).${incomplete}`
    );
    if (truncated) {
      this.logger.warn(line);
    } else {
      this.logger.debug(line);
    }
    return;
  }
  const shown = candidates.slice(0, MAX_REPORTED_ORPHAN_APIS);
  const aws = pasteableAwsCommand(mask);
  const region = await this.regionArg(aws);
  this.logger.warn(
    mask(
      `${lead} (at ${since}), and AppSync may have created an API then that no cdkd state records. ${candidates.length} GraphQL API(s) named ${name} exist that this deploy did not record: ${shown.join(', ')}${candidates.length > shown.length ? ', ...' : ''}. AppSync reports no creation time, so any of them may instead be this stack's own recorded API, another stack's, or older than this deploy; cdkd does not adopt or delete them. ${replayed ? 'cdkd recorded the API the create returned.' : 'Creating a new API.'} Inspect each before deleting anything: ${shown
        .map((apiId) => aws`aws appsync get-graphql-api --api-id ${apiId}${region}`.render())
        .join(' ; ')}${incomplete}`
    )
  );
}

export async function deleteGraphQLApi(
  this: AppSyncProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting GraphQL API ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(new DeleteGraphqlApiCommand({ apiId: physicalId }));
    this.logger.debug(`Successfully deleted GraphQL API ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`GraphQL API ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete GraphQL API ${logicalId}: ${text}`,
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
