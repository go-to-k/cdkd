import {
  SSMClient,
  DescribeParametersCommand,
  GetParameterCommand,
  ListTagsForResourceCommand,
  PutParameterCommand,
  DeleteParameterCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  ParameterNotFound,
  type ParameterType,
} from '@aws-sdk/client-ssm';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { getAccountInfo } from '../../deployment/intrinsic-function-resolver.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';

/**
 * AWS SSM Parameter Provider
 *
 * Implements resource provisioning for AWS::SSM::Parameter using the SSM SDK.
 * This is required because SSM Parameter is not supported by Cloud Control API.
 */
export class SSMParameterProvider implements ResourceProvider {
  private ssmClient: SSMClient;
  private logger = getLogger().child('SSMParameterProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SSM::Parameter',
      new Set([
        'Name',
        'Type',
        'Value',
        'Description',
        'Tags',
        'AllowedPattern',
        'Tier',
        'Policies',
        'DataType',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.ssmClient = awsClients.ssm;
  }

  /**
   * Normalize a CFn `AWS::SSM::Parameter.Tags` value into the SDK `Tag[]`
   * shape. Unlike most CFn resources (whose `Tags` is a `{Key,Value}[]` list),
   * `AWS::SSM::Parameter.Tags` is a key->value **map** (`{ "Env": "prod" }`) —
   * CDK synthesizes the map form, so `properties['Tags'].map(...)` throws
   * `Tags.map is not a function`. Accept the map (canonical) AND the list
   * (defensive, in case a hand-authored / escape-hatched template supplies it),
   * coerce each value to a string (SSM tag values must be strings), and drop
   * `aws:`-prefixed reserved keys (AWS rejects user attempts to set them).
   */
  private cfnTagsToSdkTags(raw: unknown): Array<{ Key: string; Value: string }> {
    if (raw === undefined || raw === null) return [];
    // SSM tag values must be strings; coerce primitives and drop objects
    // (which would otherwise stringify to "[object Object]").
    const coerce = (v: unknown): string =>
      typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
    let entries: Array<[unknown, unknown]>;
    if (Array.isArray(raw)) {
      entries = (raw as Array<Record<string, unknown>>).map((t) => [t?.['Key'], t?.['Value']]);
    } else if (typeof raw === 'object') {
      entries = Object.entries(raw as Record<string, unknown>);
    } else {
      entries = [];
    }
    const out: Array<{ Key: string; Value: string }> = [];
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.length === 0 || key.startsWith('aws:')) continue;
      out.push({ Key: key, Value: coerce(value) });
    }
    return out;
  }

  /**
   * Build the `Arn` attribute for an SSM parameter (issue #1824).
   *
   * WHY THIS EXISTS. An output / cross-resource `Fn::GetAtt` reads the CACHED
   * `resource.attributes[<CFnName>]` in
   * `IntrinsicFunctionResolver.constructAttribute`, which never calls a
   * provider's `getAttribute` — and for an `*Arn` name the resolver's shape
   * guard HARD-FAILS rather than degrading when the cached value is missing and
   * the physicalId is name-shaped (an SSM physicalId IS the parameter name). So
   * `new cdk.CfnOutput(this, 'ParamArn', { value: param.attrArn })` failed the
   * deploy until the ARN was cached under its CFn name.
   *
   * SOURCE DECISION — CONSTRUCTED, not read back. `PutParameter` returns only
   * `Version` / `Tier`, so there were exactly two candidate sources, and the
   * rejected one is recorded here so the call stays challengeable:
   *
   *  - `GetParameter`'s `Parameter.ARN` is authoritative, and cdkd already
   *    issues that call in `readCurrentState` / `import`, so it needs no new IAM
   *    permission. It was REJECTED on COST: it would be a brand-new round trip
   *    on EVERY parameter create AND every update, and SSM parameters are among
   *    the most numerous resources in real CDK stacks — a 50-parameter stack
   *    would pay 50 extra reads for a value that is a pure function of data
   *    cdkd already holds, against a project whose whole premise is removing
   *    round trips.
   *  - CONSTRUCTION is deterministic. The parameter ARN is the documented
   *    `arn:{partition}:ssm:{region}:{account}:parameter/{name}`, with the
   *    name's leading `/` folded into the separator — the same formula
   *    `aws-cdk-lib`'s `StringParameter.parameterArn` uses — so nothing has to
   *    be discovered from AWS. It is also the established idiom in this repo for
   *    "the create response carries no ARN": `AppSyncProvider.buildAppSyncArn`
   *    and the four `CloudControlProvider` enrichment sites (KMS key, ECR
   *    repository x2, Kinesis stream) all construct through the same
   *    `getAccountInfo` + `derivePartitionAndUrlSuffix` + `fabricated`-refusal
   *    pair this method reuses.
   *
   * The PARTITION is DERIVED, never hardcoded `arn:aws:` — that hardcoding is an
   * active bug class here (#1794 / #1815), and on a `cn-` / `us-gov-` deploy it
   * would record an ARN naming a partition the parameter is not in.
   *
   * The `fabricated`-account guard (#1730 / #1746) is honored by REFUSING rather
   * than by substituting: `getAccountInfo` catches its own STS failure and
   * answers the placeholder `123456789012`, which carries no wildcard and is
   * therefore invisible to `isPlaceholderArn`, so a fabricated id must yield NO
   * attribute instead of a plausible-looking wrong one. Returning `undefined`
   * degrades to exactly the pre-fix behavior — the resolver's shape guard fails
   * LOUDLY on the name-shaped physicalId — never to a silently wrong value.
   *
   * DEGRADATION ON THE UPDATE PATH is a DELIBERATE trade-off, not one this
   * design avoids. An update result's `attributes` REPLACE the state record's
   * rather than merging into it (`deploy-engine.ts`:
   * `result.attributes ?? (wasReplaced ? undefined : currentResource.attributes)`),
   * so whenever this method degrades during an `update` the returned map carries
   * no `Arn` and the create-time one is DROPPED. Construction does not prevent
   * that — it only swaps WHICH dependency can fail, STS plus the client's region
   * resolver instead of SSM — so read the source decision above as buying one
   * fewer round trip and nothing else.
   *
   * The alternative is to return NO `attributes` at all on the degraded path, so
   * the engine's `??` carries the previous map forward and the `Arn` survives.
   * That is REJECTED: the same map carries `Type` / `Value`, which are the values
   * THIS update just sent. Carrying the previous map forward would answer
   * `Fn::GetAtt [Param, Value]` with the SUPERSEDED value — silently, and to a
   * question cdkd can answer correctly — and would hand `cdkd drift` a baseline
   * AWS does not hold. Dropping the `Arn` instead degrades to the resolver's LOUD
   * `*Arn` shape-guard failure, which is exactly the pre-fix behavior, and the
   * resource's next UPDATE re-records it. A loud missing value beats a quiet
   * wrong one — the same reasoning the `fabricated`-account arm above applies.
   *
   * Two honest bounds on that "next update re-records it". `getAccountInfo`
   * caches a SUCCESSFUL identity for the process, so within one deploy only a run
   * whose FIRST `GetCallerIdentity` fails degrades at all — but the 10s
   * fabricated-answer TTL then covers every parameter created in that window
   * rather than a random subset. And a plain re-deploy does NOT heal it: a
   * resource whose resolved properties equal its state record is skipped with no
   * provider call, so healing needs a real property change (issue
   * [#1852](https://github.com/go-to-k/cdkd/issues/1852), which also covers the
   * resolver message that currently misattributes this to a missing enrichment).
   *
   * NEVER THROWS, and that is enforced here rather than asserted at the call
   * sites. `create` calls this AFTER `PutParameter` has already committed a
   * parameter, so a throw would surface as a failed create over a missing
   * ATTRIBUTE — leaving an orphan that makes the next deploy hit
   * `ParameterAlreadyExists` (the issue #376 class), and the cleanup that exists
   * for that is deliberately out of reach by then. `getAccountInfo` catches its
   * own STS failure, but `config.region()` is a resolver that can reject, so the
   * whole body is wrapped: an unexpected failure degrades to "no Arn recorded"
   * exactly as the fabricated-account arm does.
   */
  private async buildParameterArn(name: string, mask: MaskerFn): Promise<string | undefined> {
    try {
      return await this.buildParameterArnUnguarded(name, mask);
    } catch (error) {
      this.logger.warn(
        mask(
          `Could not build the Arn attribute for SSM parameter ${name}: ` +
            `${error instanceof Error ? error.message : String(error)}. The parameter itself is ` +
            `unaffected; the Arn is NOT recorded, so an Fn::GetAtt on it will fail until a later ` +
            `deploy records it.`
        )
      );
      return undefined;
    }
  }

  /**
   * {@link buildParameterArn}'s body. Only that method may call it.
   *
   * `name` is always a parameter NAME, never an ARN, and that is an INVARIANT
   * rather than an assumption this method has to defend (issue #1824 review
   * round 3). Both callers pass a value SSM has just accepted as a
   * `PutParameter` `Name`, and that field forbids an ARN outright — "You can't
   * enter the Amazon Resource Name (ARN) for a parameter, only the parameter
   * name itself", plus a name charset of `a-zA-Z0-9_.-` and `/` that excludes
   * `:`. So an ARN-shaped id fails at `PutParameter` several statements ABOVE
   * this method on both paths, and a guard here could only ever fire against a
   * mock. Round 2 added exactly such a guard, believing an ARN could arrive from
   * `cdkd import --resource Param=arn:...`; it can, but the defect is that the
   * import RECORDED it, so the fix belongs at the import boundary — where
   * `import()` now refuses it — and not here. Do not re-add it.
   */
  private async buildParameterArnUnguarded(
    name: string,
    mask: MaskerFn
  ): Promise<string | undefined> {
    const region = await this.ssmClient.config.region();
    const accountInfo = await getAccountInfo(region);
    if (accountInfo.fabricated) {
      this.logger.warn(
        mask(
          `Cannot determine the AWS account (STS is unreachable, and the resolved account id is ` +
            `a placeholder), so the Arn attribute for SSM parameter ${name} would be fabricated ` +
            `and is NOT recorded. An Fn::GetAtt on it will fail until a later deploy resolves ` +
            `the account.`
        )
      );
      return undefined;
    }
    // Derived locally through the closed region -> partition mapping the repo
    // already uses for `${AWS::Partition}`. `accountInfo.partition` derives
    // through the SAME helper since issue #1730, so the two agree; deriving here
    // states the dependency locally and costs no extra STS hop, matching
    // `AppSyncProvider.buildAppSyncArn`.
    const { partition } = derivePartitionAndUrlSuffix(accountInfo.region);
    // The ARN's resource part is `parameter/<fully-qualified name>`: a
    // hierarchical name already begins with `/`, which is the separator, so
    // emitting it verbatim would produce a double slash. A flat name (`foo`,
    // legal in SSM) has no leading slash and is appended as-is.
    const qualifiedName = name.startsWith('/') ? name.slice(1) : name;
    // The ARN's own region segment is CANONICALIZED (issue #1795 / #1814 class).
    // `derivePartitionAndUrlSuffix` folds the case INTERNALLY, so the PARTITION
    // above is already right for an upper-cased region — but the segment
    // interpolated here is not, and `accountInfo.region` is whatever spelling
    // reached `effectiveAccountInfoRegion` (`overrideRegion || AWS_REGION ||
    // 'us-east-1'`), folded nowhere. This is REACHABLE rather than theoretical:
    // DNS is case-insensitive, so `cdkd deploy --region US-EAST-1` SUCCEEDS and
    // then records `arn:aws:ssm:US-EAST-1:...`, which matches no IAM policy and
    // is rejected by every SDK call taking the ARN — and it is persisted into
    // `state.json`, so the wrong value outlives the deploy. Folding here rather
    // than at the read above keeps ONE fold covering every source
    // `effectiveAccountInfoRegion` can fall back to.
    return `arn:${partition}:ssm:${canonicalizeRegion(accountInfo.region)}:${accountInfo.accountId}:parameter/${qualifiedName}`;
  }

  /**
   * Create an SSM parameter
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    // Issue #2176: ONE masked sink per operation, rather than a `mask(...)` at
    // each interpolation. `properties['Name']` reaches five message sites here
    // (one of them a paste-ready `--name '<value>'` remediation command), and a
    // line added later is masked by construction instead of by remembering.
    // Absent context means identity, which is the back-compatible default the
    // contract mandates -- `create()` is also reached from the import path,
    // from `cdkd drift --revert`, and from tests.
    const mask = maskerOrIdentity(context?.maskSecrets);
    const warn = (message: string): void => this.logger.warn(mask(message));
    const debug = (message: string): void => this.logger.debug(mask(message));
    debug(`Creating SSM parameter ${logicalId}`);

    const name =
      (properties['Name'] as string | undefined) ||
      `/${generateResourceName(logicalId, { maxLength: 1023, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`;
    const type = (properties['Type'] as string | undefined) || 'String';
    const value = properties['Value'] as string | undefined;

    if (!value) {
      throw new ProvisioningError(
        `Value is required for SSM parameter ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const putParams: import('@aws-sdk/client-ssm').PutParameterCommandInput = {
        Name: name,
        Type: type as ParameterType,
        Value: value,
        Description: properties['Description'] as string | undefined,
        Overwrite: false,
      };
      if (properties['AllowedPattern']) {
        putParams.AllowedPattern = properties['AllowedPattern'] as string;
      }
      if (properties['Tier']) {
        putParams.Tier = properties['Tier'] as import('@aws-sdk/client-ssm').ParameterTier;
      }
      if (properties['Policies']) {
        putParams.Policies = properties['Policies'] as string;
      }
      if (properties['DataType']) {
        putParams.DataType = properties['DataType'] as string;
      }

      await this.ssmClient.send(new PutParameterCommand(putParams));

      // PutParameter has succeeded (Overwrite: false, so AWS has committed
      // a new parameter — not an idempotent pre-existing-resource path).
      // Wrap the post-create wiring in an inner try/catch that issues a
      // best-effort `DeleteParameterCommand` cleanup on failure, so the
      // next redeploy doesn't hit `ParameterAlreadyExists` from an orphan.
      // See Issue #376 for the cross-provider sweep.
      try {
        // Apply tags if specified. AWS::SSM::Parameter.Tags is a key->value
        // MAP (not the {Key,Value}[] list most CFn resources use), so the raw
        // template value cannot be `.map()`-ed directly — normalize via
        // cfnTagsToSdkTags first (which accepts both the map and the list).
        const ssmTags = this.cfnTagsToSdkTags(properties['Tags']);
        if (ssmTags.length > 0) {
          await this.ssmClient.send(
            new AddTagsToResourceCommand({
              ResourceType: 'Parameter',
              ResourceId: name,
              Tags: ssmTags,
            })
          );
        }
      } catch (innerError) {
        try {
          await this.ssmClient.send(new DeleteParameterCommand({ Name: name }));
          debug(
            `Cleaned up partially-created SSM parameter ${logicalId} (${name}) after wiring failure`
          );
        } catch (cleanupError) {
          warn(
            `Failed to clean up partially-created SSM parameter ${logicalId} (${name}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws ssm delete-parameter --name '${name}'`
          );
        }
        throw innerError;
      }

      debug(`Successfully created SSM parameter ${logicalId}: ${name}`);

      // Built AFTER the cleanup-guarded wiring block on purpose (issue #1824):
      // a failure here must NOT trigger the best-effort `DeleteParameter` above,
      // which would destroy a successfully created parameter over a missing
      // attribute. `buildParameterArn` never throws (enforced in its own body,
      // not assumed here), so it cannot fail the create either.
      const arn = await this.buildParameterArn(name, mask);

      return {
        physicalId: name,
        attributes: {
          Type: type as ParameterType,
          Value: value,
          // Spread CONDITIONALLY rather than writing `undefined`: a
          // present-but-undefined key survives `structuredClone` into the state
          // record, so every `Object.keys` consumer sees a key carrying nothing.
          ...(arn !== undefined && { Arn: arn }),
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        // Issue #2176: the AWS message is masked RAW, before interpolation.
        // `PutParameter` quotes the offending `Name` / `Value` back on an
        // `AllowedPattern` rejection, and this text reaches the durable
        // `deployments/*.jsonl`. Masking raw reaches the whole-value arm (no
        // length floor); the `cause` is left alone so the classifiers still
        // see the original error object.
        `Failed to create SSM parameter ${logicalId}: ${mask(
          error instanceof Error ? error.message : String(error)
        )}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an SSM parameter
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // Issue #2176 -- see `create()` for why this is one sink rather than a mask
    // per call site.
    const mask = maskerOrIdentity(context?.maskSecrets);
    const debug = (message: string): void => this.logger.debug(mask(message));
    debug(`Updating SSM parameter ${logicalId}: ${physicalId}`);

    const type = (properties['Type'] as string | undefined) || 'String';
    const value = properties['Value'] as string | undefined;

    if (!value) {
      throw new ProvisioningError(
        `Value is required for SSM parameter ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      const putParams: import('@aws-sdk/client-ssm').PutParameterCommandInput = {
        Name: physicalId,
        Type: type as ParameterType,
        Value: value,
        Overwrite: true,
      };
      // `!== undefined` (not truthy) so empty Description / AllowedPattern
      // ('') from `readCurrentState`'s placeholders reaches `PutParameterCommand`
      // on the `cdkd drift --revert` round-trip. A truthy gate would silently
      // drop the empty string and leave the AWS-side value untouched — drift
      // would report `✓ reverted` but the next run re-detects the same drift.
      if (properties['Description'] !== undefined) {
        putParams.Description = properties['Description'] as string;
      }
      if (properties['AllowedPattern'] !== undefined) {
        putParams.AllowedPattern = properties['AllowedPattern'] as string;
      }
      if (properties['Tier'] !== undefined) {
        putParams.Tier = properties['Tier'] as import('@aws-sdk/client-ssm').ParameterTier;
      }
      if (properties['Policies'] !== undefined) {
        putParams.Policies = properties['Policies'] as string;
      }
      if (properties['DataType'] !== undefined) {
        putParams.DataType = properties['DataType'] as string;
      }

      await this.ssmClient.send(new PutParameterCommand(putParams));

      // Update Tags if changed. AWS::SSM::Parameter.Tags is a key->value MAP;
      // normalize both sides to the SDK Tag[] shape before diffing/applying
      // (the raw map cannot be `.map()`-ed, and a map-vs-list mismatch would
      // otherwise wrongly look "changed").
      const newTags = this.cfnTagsToSdkTags(properties['Tags']);
      const oldTags = this.cfnTagsToSdkTags(previousProperties['Tags']);
      // Compare key-sorted so a pure key-reorder in the template map (no value
      // change) is not seen as a change — Tags are an unordered set, matching
      // the order-insensitive compare the drift-calculator already does.
      const tagKey = (t: { Key: string; Value: string }): string => t.Key;
      const sortedJson = (tags: Array<{ Key: string; Value: string }>): string =>
        JSON.stringify([...tags].sort((a, b) => tagKey(a).localeCompare(tagKey(b))));
      if (sortedJson(newTags) !== sortedJson(oldTags)) {
        // Remove old tags
        if (oldTags.length > 0) {
          await this.ssmClient.send(
            new RemoveTagsFromResourceCommand({
              ResourceType: 'Parameter',
              ResourceId: physicalId,
              TagKeys: oldTags.map((t) => t.Key),
            })
          );
        }
        // Apply new tags
        if (newTags.length > 0) {
          await this.ssmClient.send(
            new AddTagsToResourceCommand({
              ResourceType: 'Parameter',
              ResourceId: physicalId,
              Tags: newTags,
            })
          );
        }
        debug(`Updated tags for SSM parameter ${physicalId}`);
      }

      debug(`Successfully updated SSM parameter ${logicalId}`);

      // Re-report `Arn` here even though an in-place update cannot change it
      // (issue #1824): an update result's `attributes` REPLACE the state
      // record's rather than merging into it, so returning only Type / Value
      // would WIPE the ARN recorded at create time and re-break the `Fn::GetAtt`
      // the create-side fix repairs. Construction is what makes re-reporting it
      // cost no AWS call — see `buildParameterArn`'s source-decision note, which
      // also records why the DEGRADED case here still returns the partial map
      // (dropping `Arn`, a loud failure) rather than no attributes at all
      // (keeping a superseded `Value`, a silent wrong answer).
      const arn = await this.buildParameterArn(physicalId, mask);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Type: type as ParameterType,
          Value: value,
          ...(arn !== undefined && { Arn: arn }),
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        // Issue #2176: the AWS message is masked RAW, before interpolation.
        // `PutParameter` quotes the offending `Name` / `Value` back on an
        // `AllowedPattern` rejection, and this text reaches the durable
        // `deployments/*.jsonl`. Masking raw reaches the whole-value arm (no
        // length floor); the `cause` is left alone so the classifiers still
        // see the original error object.
        `Failed to update SSM parameter ${logicalId}: ${mask(
          error instanceof Error ? error.message : String(error)
        )}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an SSM parameter
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SSM parameter ${logicalId}: ${physicalId}`);

    try {
      await this.ssmClient.send(
        new DeleteParameterCommand({
          Name: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted SSM parameter ${logicalId}`);
    } catch (error) {
      if (error instanceof ParameterNotFound) {
        const clientRegion = await this.ssmClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Parameter ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SSM parameter ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current SSM parameter configuration in CFn-property shape.
   *
   * Issues `GetParameter` (with `WithDecryption: false` so SecureString
   * values stay encrypted on the wire) for `Type` / `Value` / `DataType`,
   * then `DescribeParameters` filtered on the parameter name to fetch
   * metadata (`Description`, `AllowedPattern`, `Tier`) that `GetParameter`
   * does not return.
   *
   * `Name` is set to the physical id. `Tags` is surfaced via a follow-up
   * `ListTagsForResource(ResourceType=Parameter)` call, with CDK's `aws:*`
   * auto-tags filtered out.
   *
   * `Policies` is surfaced from the same `DescribeParameters` response.
   * AWS returns `Parameters[0].Policies` as
   * `[{PolicyText, PolicyType, PolicyStatus}]`; cdkd state holds a JSON
   * string of the user-templated policy array (CFn's documented shape).
   * To compare cleanly we parse each `PolicyText` (itself JSON) into
   * objects, drop the AWS-managed `PolicyStatus` (Pending / InSync /
   * Expired), and emit the parsed object array. On the v3
   * `observedProperties` baseline this matches `observedProperties` (which
   * stored our parsed output at deploy time) exactly. On the v2 fallback
   * baseline (state.properties = JSON string) the comparator reports a
   * one-time drift on first run; users resolve via
   * `cdkd state refresh-observed`. Always-emit `[]` placeholder for
   * console-side ADD detection.
   *
   * **Note**: For `SecureString` parameters, AWS returns the encrypted
   * blob in `Value` (we pass `WithDecryption: false`). cdkd state usually
   * holds the plaintext value the user typed in their CDK app, so a
   * SecureString parameter will surface as `Value` drift on every run.
   * That's the correct conservative behavior — surfacing the discrepancy
   * is more useful than silently masking it.
   *
   * Returns `undefined` when the parameter is gone (`ParameterNotFound`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let getResp: {
      Parameter?: { Type?: string; Value?: string; DataType?: string };
    };
    try {
      getResp = (await this.ssmClient.send(
        new GetParameterCommand({ Name: physicalId, WithDecryption: false })
      )) as unknown as typeof getResp;
    } catch (err) {
      if (err instanceof ParameterNotFound) return undefined;
      throw err;
    }
    const param = getResp.Parameter;
    if (!param) return undefined;

    const result: Record<string, unknown> = { Name: physicalId };
    if (param.Type !== undefined) result['Type'] = param.Type;
    if (param.Value !== undefined) result['Value'] = param.Value;
    if (param.DataType !== undefined) result['DataType'] = param.DataType;

    // Fetch metadata via DescribeParameters filtered on the name. Best-effort:
    // a missing-permission error here should not fail the snapshot — we just
    // omit the metadata keys.
    let policiesEmitted = false;
    try {
      const desc = await this.ssmClient.send(
        new DescribeParametersCommand({
          ParameterFilters: [{ Key: 'Name', Values: [physicalId] }],
        })
      );
      const meta = desc.Parameters?.[0];
      result['Description'] = meta?.Description ?? '';
      result['AllowedPattern'] = meta?.AllowedPattern ?? '';
      if (meta?.Tier !== undefined) {
        result['Tier'] = meta.Tier;
      }

      // Policies — AWS returns [{PolicyText, PolicyType, PolicyStatus}];
      // we parse PolicyText (JSON) and emit the parsed objects. PolicyStatus
      // is AWS-managed (Pending / InSync / Expired) and intentionally
      // dropped — it's not part of the user's templated input.
      const parsedPolicies: unknown[] = [];
      for (const p of meta?.Policies ?? []) {
        if (!p.PolicyText) continue;
        try {
          parsedPolicies.push(JSON.parse(p.PolicyText));
        } catch {
          parsedPolicies.push(p.PolicyText);
        }
      }
      result['Policies'] = parsedPolicies;
      policiesEmitted = true;
    } catch {
      // Ignore — Type / Value / DataType already captured above.
    }
    // Always-emit guard: if DescribeParameters failed entirely, surface
    // an empty Policies placeholder so a console-side ADD on a previously-
    // un-policy'd parameter still surfaces as drift on the v3
    // observedProperties baseline.
    if (!policiesEmitted) result['Policies'] = [];

    // Tags via ListTagsForResource (best-effort; missing tag permission is
    // tolerated by simply omitting the key).
    try {
      const tagsResp = await this.ssmClient.send(
        new ListTagsForResourceCommand({
          ResourceType: 'Parameter',
          ResourceId: physicalId,
        })
      );
      // AWS::SSM::Parameter.Tags is a key->value MAP in CFn (cdkd stores the
      // template's map shape in state), so emit the readback as a map too — an
      // array shape here would false-positive drift on every clean run for a
      // tagged parameter (state map vs observed list never compare equal).
      const tagArr = normalizeAwsTagsToCfn(tagsResp.TagList);
      result['Tags'] = Object.fromEntries(tagArr.map((t) => [t.Key, t.Value]));
    } catch {
      // Ignore — tag drift is best-effort.
    }

    return result;
  }

  /**
   * Refuse a physical id SSM's WRITE APIs could never accept (issue #1824
   * review round 3).
   *
   * An SSM parameter's physicalId must always be the parameter NAME, because
   * that is the only thing the write APIs take. `PutParameterRequest.Name`:
   * "You can't enter the Amazon Resource Name (ARN) for a parameter, only the
   * parameter name itself", with a name charset of `a-zA-Z0-9_.-` plus `/` as
   * the hierarchy separator; `DeleteParameterRequest.Name` repeats the ARN
   * prohibition verbatim. A COLON therefore cannot appear in any writable name,
   * which is the single predicate used here — it covers both shapes
   * `GetParameter` additionally accepts and this method has to stop:
   *
   *  - an ARN (`arn:aws:ssm:us-east-1:111122223333:parameter/foo`), and
   *  - a version / label SELECTOR (`GetParameterRequest.Name`: "To query by
   *    parameter label, use `"Name": "name:label"`. To query by parameter
   *    version, use `"Name": "name:version"`").
   *
   * Both sail through this provider's existence check, so before this guard the
   * value was RECORDED as the physicalId and the damage landed later and
   * elsewhere: `cdkd deploy` failing at `PutParameter({Name: physicalId})` with
   * a `ValidationException` after a `Value` change, and `cdkd destroy` failing
   * identically at `DeleteParameter`. This is where the bad value ENTERS
   * (`--resource` / `Properties.Name`), so it is where it is stopped.
   *
   * REFUSED, NOT NORMALIZED to the name, and the ARN grammar is the reason. The
   * mapping back is genuinely ambiguous rather than merely awkward:
   *
   *  - The leading `/` is NOT recoverable. `arn:…:parameter/foo` is the ARN of
   *    BOTH the simple name `foo` and the one-level hierarchical name `/foo`,
   *    since the name's leading slash IS the separator — `aws-cdk-lib`'s
   *    `arnForParameterName` renders the two to the identical string, and that
   *    is precisely why CDK needs an explicit `simpleName` flag whenever the
   *    name is a token. Guessing wrong writes a physicalId naming a DIFFERENT
   *    parameter, i.e. converts a loud failure into a silent wrong-resource
   *    write.
   *  - A parameter SHARED from another account has no name form at all
   *    ("For parameters shared with you from another account, you must use the
   *    full ARN"), so for that shape there is nothing to normalize TO.
   *
   * A refusal is a loud, fixable error, and the message names the exact command
   * that prints the name to pass instead.
   */
  private refuseUnwritableParameterId(input: ResourceImportInput, explicit: string): void {
    if (!explicit.includes(':')) return;

    const isArn = explicit.startsWith('arn:');
    const shape = isArn ? 'an ARN' : 'a version / label selector';
    const remedy =
      input.knownPhysicalId === explicit
        ? `pass the parameter NAME instead: --resource ${input.logicalId}=<parameterName>`
        : `set Properties.Name to the parameter NAME rather than ${shape}`;
    // The ARN case is the one with a derivation a reader may expect cdkd to
    // perform, so only it carries the why-not note.
    const whyNotDerived = isArn
      ? ' cdkd deliberately does NOT derive the name from the ARN: the leading "/" is not ' +
        'recoverable (arn:...:parameter/foo is the ARN of BOTH the simple name "foo" and the ' +
        'hierarchical name "/foo"), and a parameter shared from another account has no name ' +
        'form at all — so a derived name could silently address a DIFFERENT parameter.'
      : '';

    throw new ProvisioningError(
      `Cannot adopt SSM parameter ${input.logicalId} from ${shape} ('${explicit}'): cdkd records ` +
        `a parameter's NAME as its physical id, because SSM's write APIs accept only the name ` +
        `(PutParameter and DeleteParameter both reject an ARN, and a name cannot contain ':'), ` +
        `so the next cdkd deploy and cdkd destroy would fail with a ValidationException. ` +
        `${remedy}.${whyNotDerived} Read the name AWS holds with: ` +
        `aws ssm get-parameter --name '${explicit}' --query Parameter.Name --output text`,
      input.resourceType,
      input.logicalId
    );
  }

  /**
   * Adopt an existing SSM parameter into cdkd state.
   *
   * SSM physical IDs ARE the parameter names (`/foo/bar`). The CDK template
   * usually carries `Properties.Name` explicitly, so the explicit-name path
   * covers most cases.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.Name` → refuse it outright when it
   *     is not a writable NAME (see {@link refuseUnwritableParameterId} — note
   *     `GetParameter` accepts an ARN and a `name:version` selector while every
   *     write API rejects both), else verify via `GetParameter`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (explicit) {
      this.refuseUnwritableParameterId(input, explicit);
      try {
        const resp = await this.ssmClient.send(new GetParameterCommand({ Name: explicit }));
        // Record `Arn` on the import path too (issue #1824): the state record an
        // import writes is what a later `Fn::GetAtt` reads, so leaving it empty
        // left an ADOPTED parameter hitting the same resolver shape-guard
        // hard-fail the create-side fix repairs. Unlike create / update this
        // needs no construction and no extra call — the existence-verification
        // `GetParameter` above ALREADY reports the authoritative ARN, so prefer
        // the value AWS holds over deriving one.
        const arn = resp.Parameter?.ARN;
        return { physicalId: explicit, attributes: { ...(arn !== undefined && { Arn: arn }) } };
      } catch (err) {
        if (err instanceof ParameterNotFound) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a
    // parameter reaching here needs an explicit `--resource` override.
    return null;
  }
}
