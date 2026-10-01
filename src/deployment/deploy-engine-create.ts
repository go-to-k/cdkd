import type { DeployEngine } from './deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from './deploy-engine.js';
import type { ProvisionedBy } from '../provisioning/provider-registry.js';
import type { CloudFormationTemplate, ResourceProvider } from '../types/resource.js';
import type { ResourceChange, ResourceState } from '../types/state.js';
import { displayAwsMessage, displaySafe } from '../utils/display-safe.js';
import { CdkdError } from '../utils/error-handler.js';
import { getLiveRenderer } from '../utils/live-renderer.js';
import { formatResourceLine } from '../utils/resource-line.js';
import { getAccountInfo } from './intrinsic-function-resolver.js';
import {
  createNameQuestion,
  probeErrorMeansNameHeld,
  createLookupArn,
  probeFoundSameId,
} from './replacement-name-holder.js';
import { withCurrentResourceSecrets } from './resource-secrets-scope.js';
import { markNonRetryable } from './retryable-errors.js';
import {
  type RecordedSecretValues,
  createSecretMasker,
  maskSecretsInText,
  recordNestedStackParameterExpressions,
} from './secret-redaction.js';

declare module './deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    provisionCreate: OmitThisParameter<typeof provisionCreate>;
  }
}

/** The `CREATE` arm of `DeployEngine.provisionResourceBody` (#4200 phase 3a). */
export async function provisionCreate(
  this: DeployEngine,
  logicalId: string,
  change: ResourceChange,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  template?: CloudFormationTemplate,
  parameterValues?: Record<string, unknown>,
  conditions?: Record<string, boolean>,
  counts?: ProvisionCounts,
  progress?: { current: number; total: number }
): Promise<ResourceOutcomeSignal | void> {
  const resourceType = change.resourceType;
  const renderer = getLiveRenderer();
  const desiredProps = change.desiredProperties || {};

  // Resolve intrinsic functions in properties
  const context = this.buildResolverContext(
    {
      template: template!,
      resources: stateResources,
      ...(parameterValues && { parameters: parameterValues }),
      ...(conditions && { conditions }),
      // ONE OF THE TWO SITES THAT OPT IN. The bag's presence is what lets
      // the resolver skip a masked `Ref` state key, and this arm calls
      // `refuseRedactedAttributeReads` below — the reader that makes the
      // skip safe. See the field's doc on `buildResolverContext`.
      redactedAttributeReads: [],
    },
    stackName
  );

  // Store the secrets substituted during THIS resource's resolution so the
  // save choke point (and the async observed-capture drain) redact this
  // record only with its own secrets (GHSA fix — see perResourceSecrets).
  //
  // Issue #2038 review: registered BEFORE `resolve`, not after. The
  // resolver MUTATES `context.recordedSecretValues` in place, so the map
  // this line publishes is the very one the resolution fills — but a
  // throw from INSIDE `resolve()`, after a secret was already
  // substituted, used to reach the catch in this method with NO entry for
  // this resource, so the error line, the durable event and the
  // `ProvisioningError` cause all masked against an EMPTY bag. No
  // resolver throw is known to inline a resolved value, so this closes a
  // WINDOW rather than a demonstrated leak. The hoist cannot expose a
  // STALE bag: the map is keyed by logical id, `deploy()` resets it per
  // run, and each logical id is provisioned once — so this key has no
  // prior entry and the only thing another reader can observe earlier is
  // this resource's own map, empty, which every masking site treats
  // identically to an absent entry.
  if (context.recordedSecretValues) {
    this.perResourceSecrets.set(logicalId, context.recordedSecretValues);
  }
  const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
    string,
    unknown
  >;
  // Issue #2274: before ANY of the resolved bag reaches a provider, refuse
  // if the resolution had to serve an attribute a previous deploy
  // redacted. See the helper — the value would be the literal `***`.
  this.refuseRedactedAttributeReads(logicalId, resourceType, context);
  // Capture the UNRESOLVED bag as the redaction position source (#1904).
  this.perResourceTemplateProps.set(logicalId, desiredProps);
  this.perResourceResolvedType.set(logicalId, resourceType);
  // Named so the provider call below can bind the SAME bag into its
  // masker (issue #1932 item 3), mirroring `updateSecrets` on the UPDATE
  // path. `?? new Map()` rather than a conditional: `buildResolverContext`
  // always sets the field, so the fallback is unreachable in practice,
  // but a masker bound to a real map is what keeps the provider call
  // shape identical on both paths.
  const createSecrets = context.recordedSecretValues ?? new Map<string, string>();
  // Issue #2291: for an `AWS::CloudFormation::Stack` row, remember which
  // `{{resolve:...}}` expression each `Parameters` entry was resolved
  // FROM, keyed by the child's parameter NAME. The bag above is keyed by
  // PLAINTEXT, so two parameters resolving to one value have already
  // collapsed there — the parent's own template is the only uncollapsed
  // source left, and this is the last point at which both it and the
  // resolved values are in hand. `withCurrentResourceSecrets` binds THIS
  // bag around the provider call below, so the child engine reads the
  // associations off the same object. No-op for every other type.
  recordNestedStackParameterExpressions(createSecrets, resourceType, resolvedProps, desiredProps);

  this.auditResolvedAssetReferences(logicalId, resourceType, resolvedProps);

  // #1198: snapshot the attempted (resolved) properties so a failed
  // CREATE can be journaled with what it tried to apply.
  this.attemptedResolvedProps.set(logicalId, resolvedProps);

  // #614 routing: consult the registry with the resolved properties.
  // If the SDK provider would silent-drop a top-level key (and the
  // user has not overridden it via `--allow-unsupported-properties`),
  // we auto-route via Cloud Control API. The chosen `provisionedBy`
  // is persisted on state so the next update / delete uses the
  // same layer.
  const createDecision = this.providerRegistry.getProviderFor({
    resourceType,
    properties: resolvedProps,
  });
  const createProvider = createDecision.provider;
  const createProps =
    createDecision.provisionedBy === 'cc-api'
      ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
      : resolvedProps;

  // go-to-k/cdkd#4180: a create that hands back or overwrites a resource
  // already holding its explicit name must not run onto one.
  await refuseTakenCreateName.call(this, {
    logicalId,
    resourceType,
    stackName,
    createProvider,
    createdVia: createDecision.provisionedBy,
    createProps,
    secrets: createSecrets,
    stateResources,
  });

  const result = await this.withRetry(
    () =>
      // Issue #1903: the SAME bag, bound to this call's async chain so
      // `NestedStackProvider` can seed it into the child engine it
      // builds. Inside the retry arrow, so every attempt is scoped.
      withCurrentResourceSecrets(createSecrets, () =>
        createProvider.create(logicalId, resourceType, createProps, {
          // Issue #1932 item 3. The bag handed to the provider is RESOLVED,
          // so a `{{resolve:secretsmanager:...}}` property is plaintext by
          // now; a provider that echoes one into its own warn is outside
          // both existing masking boundaries (this engine's error/reason
          // text and the resolver's debug line). Give it the capability
          // rather than the bag — see `SecretMaskingContext`.
          maskSecrets: createSecretMasker(createSecrets),
        })
      ),
    logicalId,
    undefined,
    undefined,
    createProvider
  );

  // Issue #2274: BEFORE the record is built, so the needles exist by the
  // time anything is persisted, and before any dependent resolves against
  // this resource's fresh attributes.
  this.registerNoEchoAttributes(logicalId, result, createSecrets, resolvedProps);

  // Extract ALL dependencies from template (Ref, Fn::GetAtt, DependsOn)
  // so that deletion order is correct even without implicit type-based deps
  const dependencies = this.extractAllDependencies(template, logicalId);
  const templateAttrs = this.extractTemplateAttributes(template, logicalId);

  stateResources[logicalId] = {
    physicalId: result.physicalId,
    resourceType,
    properties: this.propertiesToRecord(
      resolvedProps,
      result,
      resourceType,
      createDecision.provisionedBy
    ),
    // The REAL attribute values, deliberately: this in-memory record is
    // what `Fn::GetAtt` serves to dependents in this same run, and
    // CloudFormation delivers a `NoEcho` custom resource's `Data` to a
    // dependent in the clear (issue #2274, measured). Masking happens at
    // the PERSIST choke point, from the needles registered above.
    ...(result.attributes && { attributes: result.attributes }),
    ...(dependencies && dependencies.length > 0 && { dependencies }),
    ...templateAttrs,
    provisionedBy: createDecision.provisionedBy,
  };
  this.recordInlinePolicyWrite(logicalId, 'create');

  const createCaptureSiblings = await this.buildObservedCaptureSiblings(
    resourceType,
    logicalId,
    result.physicalId,
    template,
    stateResources,
    stackName,
    parameterValues,
    conditions
  );
  this.kickOffObservedCapture(
    createProvider,
    logicalId,
    result.physicalId,
    resourceType,
    resolvedProps,
    { ...createCaptureSiblings, afterOwnWrite: true }
  );

  if (counts) counts.created++;
  if (progress) progress.current++;
  const createPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
  renderer.removeTask(logicalId);
  this.logger.info(`${createPrefix}${formatResourceLine('created', logicalId, resourceType)}`);
  return;
}

/**
 * Refuse a plain CREATE whose explicit name another resource already holds,
 * for a type whose SDK create would hand that resource back or overwrite it
 * instead of failing (go-to-k/cdkd#4180, {@link createNameQuestion}). Without
 * it the deploy "succeeds" with the existing resource, records it as this
 * stack's, and a later `cdkd destroy` deletes it. CloudFormation fails the
 * same create with "already exists", so this refuses with nothing created —
 * also when the lookup cannot be made or fails, since a guess either way can
 * take over someone else's resource.
 *
 * A holder this stack's state records under ANOTHER logical id (a construct
 * moved or renamed, keeping its explicit name) is refused with its own
 * advice: deleting or importing it would hand one resource to two records,
 * and the plan's later DELETE of the old id would then delete it.
 *
 * The lookup and the create are two calls: a resource created under the name
 * between them is not seen.
 */
async function refuseTakenCreateName(
  this: DeployEngine,
  input: {
    logicalId: string;
    resourceType: string;
    stackName: string;
    createProvider: ResourceProvider;
    createdVia: ProvisionedBy | undefined;
    createProps: Record<string, unknown>;
    secrets: RecordedSecretValues;
    stateResources: Record<string, ResourceState>;
  }
): Promise<void> {
  const { logicalId, resourceType, secrets } = input;
  const question = createNameQuestion({
    resourceType,
    createdVia: input.createdVia,
    properties: input.createProps,
  });
  if (question === undefined) return;
  // Every SDK provider of a name-adopting type implements `import()` (pinned
  // in `replacement-name-holder.test.ts`); one without it is a test double.
  const lookup = input.createProvider.import?.bind(input.createProvider);
  if (lookup === undefined) return;

  // Mask BEFORE sanitizing: `displaySafe` rewrites control characters, after
  // which a secret-derived value no longer matches its needle.
  const shown = (value: string): string => displaySafe(maskSecretsInText(value, secrets));
  const subject = `${displaySafe(logicalId)} (${displaySafe(resourceType)})`;
  const named = `${question.property} ${shown(question.desiredName)}`;
  const adoptsText =
    `its create API hands back or overwrites an existing resource of that name instead of ` +
    `refusing it`;
  const refuse = (message: string, cause?: unknown): never => {
    throw markNonRetryable(
      new CdkdError(
        maskSecretsInText(message, secrets),
        'NAMED_CREATE_COLLISION',
        cause instanceof Error ? cause : undefined
      )
    );
  };

  // Step Functions and SNS are looked up by the ARN the name would take.
  let knownPhysicalId: string | undefined;
  const byArn = ['AWS::SNS::Topic', 'AWS::StepFunctions::StateMachine'].includes(resourceType)
    ? createLookupArn(resourceType, question.desiredName, await getAccountInfo(this.stackRegion))
    : undefined;
  if (byArn !== undefined && 'unbuildable' in byArn) {
    return refuse(
      byArn.unbuildable === 'name'
        ? `${subject} is created with ${named}, and ${adoptsText}, but cdkd cannot build the ` +
            `ARN that name would take to check whether another resource already holds it: ` +
            `the name contains ":". Nothing was created. Choose a name without ":".`
        : `${subject} is created with ${named}, and ${adoptsText}, but cdkd cannot check ` +
            `whether another resource already holds it: STS did not report this deploy's ` +
            `account. Nothing was created. Re-run the deploy once STS can report the account.`
    );
  }
  if (byArn !== undefined) knownPhysicalId = byArn.arn;

  let found: Awaited<ReturnType<NonNullable<ResourceProvider['import']>>>;
  try {
    found = await this.withRetry(
      () =>
        lookup({
          logicalId,
          resourceType,
          stackName: input.stackName,
          region: this.stackRegion,
          // The name as a STRING: a provider's lookup reads only a string
          // name, so a numeric one (which the create sends as its decimal
          // spelling) would otherwise look up nothing and read as free.
          properties: { ...input.createProps, [question.property]: question.desiredName },
          ...(knownPhysicalId !== undefined && { knownPhysicalId }),
        }),
      logicalId,
      undefined,
      undefined,
      input.createProvider
    );
  } catch (probeError) {
    if (probeErrorMeansNameHeld(resourceType, probeError)) {
      return refuse(
        `${subject} is created with ${named}, and S3 answered 403 Forbidden for that bucket: ` +
          `another account owns that name, or a bucket of this account denies this identity ` +
          `\`s3:ListBucket\`, or the request's credentials were rejected. Nothing was created. ` +
          `Choose another name, or if the bucket is yours grant \`s3:ListBucket\` on it (or ` +
          `delete it) and re-run.`,
        probeError
      );
    }
    const status = (probeError as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
      ?.httpStatusCode;
    if (resourceType === 'AWS::S3::Bucket' && status === 301) {
      return refuse(
        `${subject} is created with ${named}, and S3 answered 301 for that bucket: a bucket of ` +
          `that name already exists in another region. Nothing was created. Choose another ` +
          `name, or delete that bucket if it is yours and re-run.`,
        probeError
      );
    }
    return refuse(
      `${subject} is created with ${named}, and ${adoptsText}, but cdkd could not check ` +
        `whether another resource already holds it: ` +
        `${displayAwsMessage(maskSecretsInText(probeError instanceof Error ? probeError.message : String(probeError), secrets))}. ` +
        `Nothing was created. Re-run the deploy once the check can succeed.`,
      probeError
    );
  }
  if (found === null) return;
  const holderId = found.physicalId;
  const ownHolder = Object.entries(input.stateResources).find(
    ([otherId, record]) =>
      otherId !== logicalId &&
      record.resourceType === resourceType &&
      probeFoundSameId(resourceType, record.physicalId, holderId)
  );
  if (ownHolder !== undefined) {
    return refuse(
      `${subject} is created with ${named}, which this stack's ${displaySafe(ownHolder[0])} ` +
        `(${shown(holderId)}) already holds — a construct moved or renamed keeps its explicit ` +
        `name under a new logical id. Since ${adoptsText}, the create would hand back that ` +
        `resource and the removal of ${displaySafe(ownHolder[0])} would then delete it. Nothing ` +
        `was created. Give the new resource another name, or deploy the removal of ` +
        `${displaySafe(ownHolder[0])} first. Do not delete or import that resource: it is ` +
        `already this stack's.`
    );
  }
  // A nested-stack child (`<parent>~<logicalId>`) cannot be a `cdkd import`
  // target: import resolves top-level stacks from the assembly only, the
  // reason `orphanedNameCollisionAdvice` withholds the command there too.
  const ownRemedy = input.stackName.includes('~')
    ? `if the resource is this stack's own, left by an earlier interrupted deploy, delete it ` +
      `and re-run.`
    : `if the resource is this stack's own, left by an earlier interrupted deploy, delete it ` +
      `or adopt it with \`cdkd import\` and re-run.`;
  return refuse(
    `${subject} is created with ${named}, and an existing resource ` +
      `(${shown(holderId)}) already holds that name. Since ${adoptsText}, ` +
      `creating it would take that resource over and record it as this stack's, for a later ` +
      `\`cdkd destroy\` to delete. Nothing was created. Choose a name no other resource holds; ` +
      ownRemedy
  );
}
