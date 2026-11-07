import { SSMClient } from '@aws-sdk/client-ssm';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { displaySafe } from '../../utils/display-safe.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { clientDefaultsFor, type CredentialConfig } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { getAccountInfo } from '../../deployment/intrinsic-function-resolver.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import { refuseMalformedDesiredTags, tagMapAsList, type CfnTagEntry } from '../tag-list.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { create } from './ssm-parameter/create.js';
import { update } from './ssm-parameter/update.js';
import { deleteImpl } from './ssm-parameter/delete.js';
import { readCurrentState } from './ssm-parameter/read-state.js';
import { refuseUnwritableParameterId, importImpl } from './ssm-parameter/import.js';

/**
 * AWS SSM Parameter Provider
 *
 * Implements resource provisioning for AWS::SSM::Parameter using the SSM SDK.
 * This is required because SSM Parameter is not supported by Cloud Control API.
 */
export class SSMParameterProvider implements ResourceProvider {
  ssmClient: SSMClient;
  private createClient: Promise<SSMClient> | undefined;
  /** The credential half of the `AwsClients` `ssmClient` came from (#4639). */
  private readonly credentialConfig: CredentialConfig;
  logger: ConsoleLogger = getLogger().child('SSMParameterProvider');

  /**
   * The failure wrap this provider's create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN (a `PutParameter` `AllowedPattern` rejection quotes the
   * offending `Name` / `Value` back, issue #2176). AWS's own text goes to
   * `debug` through the operation's masker, and the wrap is stamped
   * `markRedactedCause`, so the retry classifiers read the withheld text on
   * the `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}), so a create-first replacement still
   * recognises the collision. A cdkd-authored or transport error keeps its
   * text, masked, stamped only when the mask changed it (`wrapMaskedAwsError`,
   * issue #4244); a non-`Error` throw is withheld like an AWS one, unstamped
   * (it has no chain). A delete catch tests not-found before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call. A method, so `gen-update-wrap-coverage`
   * sees the catch that throws it as a wrap.
   */
  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

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

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every property,
   * each removal handled. `Name` is create-only (a removal replaces the
   * parameter); `Value` is required (`update()` refuses its absence); `Type`
   * is required by the schema, so CloudFormation refuses its removal, and the
   * CDK always emits it (`update()` would default it to `String`); `Tags` are
   * diffed. A removed `Description` / `AllowedPattern` / `Tier` / `DataType` /
   * `Policies` is KEPT, as CloudFormation keeps it: `update()` omits it from
   * the `PutParameter` overwrite, which leaves the stored value in place. A
   * real CloudFormation A/B (us-east-1) removed each of the five from a
   * deployed parameter and read every one back unchanged, `Tier: Advanced`,
   * `DataType: aws:ec2:image` and an `Expiration` policy included. No reset is
   * declared, since none exists to match.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
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
    // A test double may carry no `credentialConfig`: degrade to `{}`, as
    // `ambientCredentialConfig` does.
    this.credentialConfig =
      (awsClients as { credentialConfig?: CredentialConfig }).credentialConfig ?? {};
  }

  /**
   * The client `create`'s `PutParameter` (`Overwrite: false`) goes through:
   * SDK retries on, except a 5xx (`withoutServerErrorRetries`, issue #4639).
   * Separate so every other call -- `update`'s overwriting `PutParameter`
   * included, and every other user of `getAwsClients().ssm` -- keeps the full
   * SDK retry. Built in the shared client's REGION (read from it, as
   * `config.region()` resolves it), and with the credentials of the SAME
   * `AwsClients` that client came from, read at construction, so a later
   * `setAwsClients` switch cannot give the create another identity. The
   * PROMISE is cached, so two creates on a cold provider build one client; a
   * rejected region read is not cached, so the next create retries it. A
   * shared client that is not an `SSMClient` -- a unit-test double -- is used
   * as is: `AwsClients` always supplies a real one.
   *
   * `PutParameter` carries no idempotency token, and with `Overwrite: false`
   * a parameter name is unique per account and region, so the SDK's own
   * replay of a 5xx whose request had succeeded collides with the parameter
   * the first send made, and that `ParameterAlreadyExists` surfaced from the
   * engine's FIRST attempt as a name somebody else holds. Refused here, the
   * 5xx reaches the deploy engine's retry, which marks the create as possibly
   * replayed (`withRetry`, #3978). Nothing is adopted on that collision: a
   * name is not attribution (`docs/provider-rules.md`, "Adopt only on EXACT
   * attribution").
   */
  getCreateClient(): Promise<SSMClient> {
    const shared = this.ssmClient;
    if (!(shared instanceof SSMClient)) return Promise.resolve(shared);
    this.createClient ??= shared.config.region().then(
      (region) =>
        withoutServerErrorRetries(
          new SSMClient({ ...clientDefaultsFor(this.credentialConfig), region })
        ),
      (error: unknown) => {
        this.createClient = undefined;
        throw error;
      }
    );
    return this.createClient;
  }

  /** `aws:`-prefixed keys are reserved: AWS rejects a user's attempt to set or remove them. */
  static userTags(tags: CfnTagEntry[]): CfnTagEntry[] {
    return tags.filter((t) => !t.Key.startsWith('aws:'));
  }

  /**
   * Refuse a malformed desired `Tags` before any call (go-to-k/cdkd#3994) and
   * return it as the SDK `Tag[]`. `AWS::SSM::Parameter.Tags` is a key -> value
   * MAP (`{ "Env": "prod" }`), which CDK synthesizes, so it is converted with
   * `tagMapAsList`; a `{Key,Value}[]` list (a hand-authored template) is read
   * as it is.
   */
  static desiredSsmTags(
    raw: unknown,
    resourceType: string,
    logicalId: string,
    physicalId?: string
  ): CfnTagEntry[] {
    return SSMParameterProvider.userTags(
      refuseMalformedDesiredTags(
        tagMapAsList(raw),
        resourceType,
        logicalId,
        physicalId,
        'Tags',
        'a map of tag keys to scalar values or a list of tags with a non-empty string Key and a scalar Value'
      )
    );
  }

  /**
   * Build the `Arn` attribute for an SSM parameter (issue #1824).
   *
   * WHY THIS EXISTS. An output / cross-resource `Fn::GetAtt` reads the CACHED
   * `resource.attributes[<CFnName>]` in
   * `constructAttribute` (`deployment/intrinsic-resolver/getatt.ts`), which never calls a
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
   *    `getAccountInfo` + `derivePartitionAndUrlSuffix` pair this method
   *    reuses.
   *
   * The PARTITION is DERIVED, never hardcoded `arn:aws:` — that hardcoding is an
   * active bug class here (#1794 / #1815), and on a `cn-` / `us-gov-` deploy it
   * would record an ARN naming a partition the parameter is not in.
   *
   * When STS cannot name the account, `getAccountInfo` REJECTS (issue #1730)
   * and this yields NO attribute rather than one built from a wrong account.
   * Returning `undefined` degrades to exactly the pre-fix behavior — the
   * resolver's shape guard fails LOUDLY on the name-shaped physicalId — never
   * to a silently wrong value.
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
   * resource's next UPDATE re-records it (as does the deploy engine's re-read
   * on a `Fn::GetAtt` miss, issue #1852). A loud missing value beats a quiet
   * wrong one — the same reasoning the unknown-account arm above applies.
   *
   * Two honest bounds on that "next update re-records it". `getAccountInfo`
   * caches a SUCCESSFUL identity for the process, so within one deploy only a run
   * whose `GetCallerIdentity` calls fail degrades at all — a failure is never
   * cached, so each parameter asks again. And a plain re-deploy does NOT heal it: a
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
   * for that is deliberately out of reach by then. `getAccountInfo` rejects when
   * STS cannot name the account, and `config.region()` is a resolver that can
   * reject, so the whole body is wrapped: either failure degrades to "no Arn
   * recorded".
   */
  async buildParameterArn(name: string, mask: MaskerFn): Promise<string | undefined> {
    try {
      return await this.buildParameterArnUnguarded(name);
    } catch (error) {
      // The class at warn, AWS's text at debug (go-to-k/cdkd#2319): a denied
      // `GetCallerIdentity` names the caller's assumed-role ARN.
      const failure = describeAwsFailure(error);
      const head = `Could not build the Arn attribute for SSM parameter ${displaySafe(mask(name))}: `;
      if (failure.redacted) this.logger.debug(mask(`${head}${mask(failure.detail)}`));
      this.logger.warn(
        mask(
          `${head}${failure.redacted ? `${failure.summary} ` : `${failure.detail}. `}` +
            `The parameter itself is ` +
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
  private async buildParameterArnUnguarded(name: string): Promise<string | undefined> {
    const region = await this.ssmClient.config.region();
    // REJECTS when STS cannot name the account (issue #1730); the caller's
    // catch warns and records no `Arn`.
    const accountInfo = await getAccountInfo(region);
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
    // interpolated here is not. The SOURCE now folds
    // (`effectiveAccountInfoRegion`, issue #1882), so this local fold is defense
    // in depth rather than the only one. Both are kept: double-folding is a
    // no-op, and an earlier revision of this comment called the region "folded
    // nowhere", which is exactly the claim that goes stale silently. The
    // reachability it also claimed -- that `cdkd deploy --region US-EAST-1`
    // SUCCEEDS because DNS is case-insensitive -- is FALSE and was corrected
    // with issue #1882's measurement -- but the mechanism is the
    // opposite of "it fails": `foldRegionOption` folds `--region` and
    // `AWS_REGION` at every handler's entry (issue #2065) and `AwsClients`
    // folds again, so the flag is CANONICAL before it can reach anything. It
    // never dies, because a raw spelling never gets that far. (It would if it
    // did: SigV4 compares a credential's region scope case-sensitively.) What
    // IS reachable is a Cloud Assembly carrying a raw region in its
    // `environment` string, which cdkd accepts and whose clients it folds.
    // Unfolded, this records `arn:aws:ssm:US-EAST-1:...`, which matches no IAM
    // policy, is rejected by every SDK call taking the ARN, and is persisted
    // into `state.json`, so the wrong value outlives the deploy. Folding here rather
    // than at the read above keeps ONE fold covering every source
    // `effectiveAccountInfoRegion` can fall back to.
    return `arn:${partition}:ssm:${canonicalizeRegion(accountInfo.region)}:${accountInfo.accountId}:parameter/${qualifiedName}`;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
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
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType);
  }

  refuseUnwritableParameterId(input: ResourceImportInput, explicit: string): void {
    return refuseUnwritableParameterId.call(this, input, explicit);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}

/**
 * The empty policy that removes every policy from a parameter, as the Systems
 * Manager user guide spells it ("Assigning parameter policies").
 */
export const SSM_CLEAR_POLICIES = '[{}]';

/**
 * `PutParameter`'s `Policies`, which is a JSON STRING (CloudFormation's
 * `AWS::SSM::Parameter.Policies` too). A template passes that string through.
 * The bag `cdkd drift --revert` replays is `readCurrentState`'s, which holds
 * the PARSED policies as an array (`[]` when the parameter has none); sent as
 * is, the array made AWS refuse the whole update ("Start of list found where
 * not expected"), so a non-empty array is re-serialized and an empty one, the
 * no-policies placeholder, is sent as no `Policies` at all, as an absent
 * template property is (a revert that must clear live policies sends
 * `SSM_CLEAR_POLICIES` instead; see `update`).
 */
export function ssmPoliciesParameter(policies: unknown): string | undefined {
  if (policies === undefined || policies === null || policies === '') return undefined;
  if (typeof policies === 'string') return policies;
  if (Array.isArray(policies)) return policies.length === 0 ? undefined : JSON.stringify(policies);
  return JSON.stringify(policies);
}
