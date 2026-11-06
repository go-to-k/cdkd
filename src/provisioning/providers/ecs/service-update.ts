import type { ECSProvider } from '../ecs-provider.js';
import {
  UpdateServiceCommand,
  type PropagateTags,
  type AvailabilityZoneRebalancing,
  type ServiceConnectConfiguration,
  type ServiceVolumeConfiguration,
  type VpcLatticeConfiguration,
  type MonitoringConfiguration,
} from '@aws-sdk/client-ecs';
import { ecsServiceLaunchTypeSetOrChanged } from '../../../analyzer/replacement-rules.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult } from '../../../types/resource.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import { clearOnUpdateRemoval } from '../../update-removal.js';
import { readConfigString } from '../../config-shape.js';
import {
  recordedServiceNames,
  requestedRolloutOf,
  controllerSkipsWait,
  gatewayConnectorsGateKey,
} from './shared.js';

export async function updateService(
  this: ECSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  /** `cdkd drift --revert` (`UpdateContext.desiredFromAwsReadback`). */
  desiredFromAwsReadback: boolean,
  /** The rollback executor's revert arms (`UpdateContext.replayingState`). */
  replayingState: boolean
): Promise<ResourceUpdateResult> {
  log.debug(`Updating ECS service ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const client = this.getClient();

  // ServiceName is immutable - if changed, requires replacement. A
  // secret-derived name is recorded as its `{{resolve:...}}` reference and
  // handed here resolved: the name the physical id carries decides instead
  // (go-to-k/cdkd#4263).
  const newServiceName = properties['ServiceName'] as string | undefined;
  const oldServiceName = previousProperties['ServiceName'] as string | undefined;
  if (
    newServiceName &&
    oldServiceName &&
    newServiceName !== oldServiceName &&
    !(await unchangedBehindSecretReference({
      resourceType,
      key: 'ServiceName',
      desired: newServiceName,
      previous: oldServiceName,
      physicalName: recordedServiceNames(physicalId).service,
    }))
  ) {
    throw new ProvisioningError(
      `Cannot update ServiceName for ECS service ${logicalId} (immutable property, requires replacement)`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  // `UpdateService` has no `launchType` member: a changed LaunchType is a
  // replacement (issue #5392, the registry's predicate), so one that still
  // reaches here is refused rather than recorded while AWS keeps the old
  // value. A removal keeps the live value, as CloudFormation does.
  //
  // An ADD: an ordinary deploy never brings one here, because the
  // replacement rule replaces on an add first. Outside `cdkd drift
  // --revert` the one caller that does is the rollback revert, restoring
  // the value a removal left live, so the add passes and sends nothing.
  // Under drift --revert the previous side is the AWS readback, which omits
  // LaunchType for a service moved to a capacity provider strategy out of
  // band; restoring it needs a replacement, so the add is refused too. Only
  // `desiredFromAwsReadback` is read: every other caller passes.
  const previousLaunchType = previousProperties['LaunchType'];
  if (
    (previousLaunchType != null || desiredFromAwsReadback) &&
    ecsServiceLaunchTypeSetOrChanged(previousLaunchType, properties['LaunchType'])
  ) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      desiredFromAwsReadback
        ? // The template and state are unchanged, so `deploy --replace`
          // would plan nothing here.
          'UpdateService cannot change a service launch type, so drift --revert cannot restore it. Destroy + redeploy the stack to restore it, or run cdkd drift --accept to keep the live value'
        : 'UpdateService cannot change a service launch type; CloudFormation replaces the service. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack'
    );
  }

  // loadBalancers / serviceRegistries are only accepted by UpdateService when
  // the service uses the ECS rolling-update deployment controller. For
  // CODE_DEPLOY (blue/green) and EXTERNAL controllers, AWS rejects these
  // parameters (blue/green updates them via a new CodeDeploy deployment;
  // EXTERNAL via a new task set) — see the AWS UpdateService API docs. The
  // deployment controller defaults to ECS when unspecified. enableECSManagedTags
  // / propagateTags are accepted under ALL three controllers, so they are
  // mapped unconditionally.
  // Wrapped: this point in `updateService` has no enclosing catch, so the
  // helper's plain Error would otherwise escape untyped into the deploy
  // engine's retry loop instead of surfacing as a ProvisioningError.
  let deploymentControllerType: string;
  try {
    deploymentControllerType = readConfigString(
      properties['DeploymentController'],
      'Type',
      'ECS',
      'AWS::ECS::Service DeploymentController'
    );
  } catch (error) {
    // The refusal can describe the bag value it read (issue #2177).
    throw this.wrapCaughtError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          text,
          resourceType,
          logicalId,
          physicalId,
          error instanceof Error ? error : undefined
        )
    );
  }
  const isEcsController = deploymentControllerType === 'ECS';

  // Only send loadBalancers / serviceRegistries when they actually changed, so
  // a no-drift update stays mutation-free and doesn't trigger a spurious new
  // deployment. Removal-from-template is sent as an empty list (the AWS-
  // documented "clear" sentinel), not an omitted field (which AWS treats as
  // "leave unchanged"). Both fields are gated on the ECS rolling controller.
  const loadBalancersChanged =
    JSON.stringify(previousProperties['LoadBalancers'] ?? null) !==
    JSON.stringify(properties['LoadBalancers'] ?? null);
  const serviceRegistriesChanged =
    JSON.stringify(previousProperties['ServiceRegistries'] ?? null) !==
    JSON.stringify(properties['ServiceRegistries'] ?? null);

  // A LoadBalancers / ServiceRegistries change under a non-ECS controller
  // (CODE_DEPLOY blue/green or EXTERNAL) is applied by AWS via a new
  // CodeDeploy deployment / task set, NOT UpdateService — cdkd does not
  // orchestrate those. Fail loudly rather than silently omitting the field
  // (which would report success, poison state with the new value, and leave
  // AWS on the old config — the exact silent-drop class #975 fixes).
  if (!isEcsController && (loadBalancersChanged || serviceRegistriesChanged)) {
    // The controller type is a bag value, masked RAW (issue #2177).
    throw new ProvisioningError(
      `AWS::ECS::Service '${logicalId}' changes LoadBalancers/ServiceRegistries under the ` +
        `'${log.value(deploymentControllerType)}' deployment controller, which applies them via a new ` +
        `CodeDeploy deployment / task set rather than UpdateService. cdkd does not support ` +
        `updating these under a non-ECS controller; recreate the service or manage the ` +
        `blue/green deployment out-of-band.`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  const loadBalancersInput =
    isEcsController && loadBalancersChanged
      ? (this.convertLoadBalancers(
          properties['LoadBalancers'] as Array<Record<string, unknown>> | undefined
        ) ?? [])
      : undefined;
  const serviceRegistriesInput =
    isEcsController && serviceRegistriesChanged
      ? (this.convertServiceRegistries(
          properties['ServiceRegistries'] as Array<Record<string, unknown>> | undefined
        ) ?? [])
      : undefined;

  // Removal semantics (issue #5004). UpdateService treats an ABSENT input
  // field as "no change". CloudFormation KEEPS the live value of
  // CapacityProviderStrategy / PlacementConstraints / PlacementStrategies /
  // PlatformVersion / HealthCheckGracePeriodSeconds / EnableECSManagedTags /
  // PropagateTags / EnableExecuteCommand when they are removed from the
  // template (real A/B), so those eight send NOTHING on removal. LoadBalancers
  // / ServiceRegistries still clear via #975 (their change-detected
  // empty-list sentinel above).
  //
  // The array fields below are converted from CFn PascalCase to SDK camelCase
  // via their `convert*` helpers (issue #1165 — the same silent-drop class as
  // `DeploymentConfiguration` below; without the conversion the SDK reads the
  // camelCase keys, finds them absent, and drops the whole value on update).
  //
  // `DeploymentConfiguration` casing is now fixed on both create() and
  // update() (converted via `convertDeploymentConfiguration`). Its removal
  // RESET and its kept-but-partial normalization were BOTH deferred to
  // issues #1160 / #1225 pending a live probe; that probe is done and for
  // the TOP-LEVEL shapes the answer is that cdkd's verbatim pass-through IS
  // CloudFormation parity, so NO reset and NO normalization is correct here.
  // Measured us-east-1, 2026-08-13, SDK and CloudFormation A/B against the
  // same service (baseline MaximumPercent 200 / MinimumHealthyPercent 50 /
  // DeploymentCircuitBreaker {Enable,Rollback} true; a ROLLING, REPLICA,
  // Fargate service). Two limits of that probe, stated rather than
  // dismissed: the DAEMON scheduling strategy was not exercised — the
  // ORIGINAL dismissal here read "harmless, since the deployment-type-
  // dependent defaults only mattered for the reset that is no longer being
  // added", and issue #1861 INVALIDATED it by adding a reset, so the
  // reasoning is restated rather than left standing. It is still harmless,
  // but for ONE reason, not two: the SDK documents the two defaults this
  // provider sends (`resetOnHealthyTask` true, `thresholdConfiguration`
  // {BOUNDED_PERCENT, 50}) with no scheduling-strategy dimension, so there
  // is no DAEMON-specific value for the reset to get wrong. Read that as
  // the PER-FIELD claim it is, not a general one about this property: the
  // sibling `minimumHealthyPercent` IS strategy-dependent (100% for a
  // replica service, 0% for DAEMON via the SDK/CLI/API — models_0.d.ts),
  // and it is only safe here because it is a PASS-THROUGH that cdkd never
  // defaults. A second reason was drafted here and REMOVED because it
  // argued the opposite of its own conclusion: "the circuit breaker is only
  // usable under the rolling-update (ECS) deployment type" does not put
  // DAEMON out of scope, it puts DAEMON squarely IN it — the SDK states
  // that CODE_DEPLOY / EXTERNAL controllers do not support the DAEMON
  // scheduling strategy, so a DAEMON service NECESSARILY runs the ECS
  // rolling-update type and can therefore carry a circuit breaker and reach
  // this reset. Scheduling strategy and deployment type are different
  // dimensions; do not let the second stand in for the first.
  // The DAEMON gap remains real for the OTHER rows in this block (they are
  // pass-throughs, so it costs nothing) — and ROLLING did not exercise the
  // traffic-shifting blocks (LinearConfiguration / CanaryConfiguration /
  // LifecycleHooks), so #1805 left them UNMEASURED. That mattered because they
  // carry no (or a partial) `required` list, unlike the two required-listed
  // blocks whose rows follow, so a kept-but-partial block there IS reachable
  // from a template CFn accepts. Issue #1806 measured them: the three blocks
  // it names are PARITY (the API default-fills the omitted member), while
  // the sweep of the REST of the tree found a loud AWS refusal for some
  // shapes and ONE genuine DIVERGENCE — see the last two bullets. That
  // divergence (issue #1861) is FIXED: it is the only shape in this whole
  // property that is NOT a pass-through, and it lives in
  // `resolveDeploymentConfiguration`.
  //   - KEPT block, sub-field dropped (send only `MaximumPercent: 150`):
  //     UpdateService MERGES server-side — MinimumHealthyPercent stayed 50
  //     and the circuit breaker survived. A CloudFormation stack given the
  //     same partial block reached the IDENTICAL end state, via a real
  //     UPDATE_IN_PROGRESS -> UPDATE_COMPLETE on the resource rather than a
  //     no-op. (What was measured is the END STATE; that CFn's handler
  //     submits the same partial to UpdateService is the inference, not an
  //     observation.) So the retained value is CFn's behavior too, and
  //     normalizing to an explicit clear shape would DIVERGE from it.
  //   - WHOLE block removed: CloudFormation issued a real resource UPDATE
  //     and did NOT reset the configuration — the live values survived
  //     intact. Passing `undefined` (below) reproduces that exactly, so the
  //     #1160 removal-reset this field was holding open must NOT be added.
  //   - Sub-field dropped one level DOWN (kept `DeploymentCircuitBreaker`,
  //     `Rollback` omitted): this one is NOT parity, and the difference is
  //     worth stating precisely because the obvious reading gets it
  //     backwards. The nested struct is REPLACED rather than merged, and
  //     the SDK ACCEPTS the partial — a live `rollback` went true -> false.
  //     CloudFormation refuses the same template up front (`Model
  //     validation failed (#/DeploymentConfiguration/
  //     DeploymentCircuitBreaker: required key [Rollback] not found)`,
  //     UPDATE_ROLLBACK_COMPLETE with the live config intact), because the
  //     registry schema marks the `DeploymentCircuitBreaker` definition
  //     required [Enable, Rollback] and `DeploymentAlarms` (the `Alarms`
  //     property) required [AlarmNames, Rollback, Enable]. cdkd used to
  //     DEPLOY that template and silently flip the live setting; the deploy
  //     pre-flight now refuses it as CloudFormation does
  //     (`nested-required.ts`, issue #1802), so a LITERAL partial block no
  //     longer reaches this method (one behind `Fn::If`, or a member
  //     resolving to `AWS::NoValue`, still can). It is deliberately NOT papered over
  //     here by re-filling `Rollback` from the previous side, which would
  //     invent a value the template never declared. Do NOT read this row as the ASG
  //     InstanceMaintenancePolicy disposition (#1227): there AWS ITSELF
  //     rejected the partial, so cdkd failed loudly too and pass-through
  //     really was parity.
  //   - The three DEPTH-1 sibling blocks #1806 names — `LinearConfiguration`
  //     and `CanaryConfiguration` (neither carries a required list) and
  //     `LifecycleHooks[]`, whose element requires only `LifecycleStages` —
  //     are PARITY, which is the answer the row above makes it easy to guess
  //     wrong. Measured us-east-1 2026-08-13
  //     on a real traffic-shifting service, SDK and CloudFormation A/B.
  //     A kept-but-partial block IS replaced like the depth-2 case, but the
  //     absent member is filled with an AWS-side DEFAULT rather than left
  //     at its live value: `LinearConfiguration` {StepPercent 33,
  //     StepBakeTimeInMinutes 9} re-sent as {StepPercent 44} came back
  //     {44, 6}; `CanaryConfiguration` {21, 9} re-sent as {CanaryPercent
  //     30} came back {30, 10}; a hook's `TimeoutConfiguration` {31,
  //     CONTINUE} re-sent as {TimeoutInMinutes 45} came back {45,
  //     ROLLBACK}. The defaults are FIXED, not derived from the sibling
  //     member — an empty `LinearConfiguration: {}` sent from a live
  //     {33, 9} came back {10, 6}. CloudFormation given the SAME partial
  //     template reached the IDENTICAL end state in all three cases, so the
  //     reset is ECS's own behavior and normalizing it away would DIVERGE —
  //     the top-level row's conclusion, reached the same way. What was
  //     measured is again the END STATE; that CFn's handler submits the same
  //     partial to `UpdateService` is the inference, though a CFn-side
  //     fill-from-previous would have produced {44, 9} rather than the
  //     observed {44, 6}. One PREMISE of #1806 did not survive contact: these
  //     configs are NOT BLUE_GREEN-reachable (`Linear configuration can only
  //     be present with LINEAR deployment strategy` — each is gated on its
  //     OWN strategy, while `LifecycleHooks` is not, measured under CANARY;
  //     its reach under ROLLING was not probed), so the heavier BLUE_GREEN
  //     fixture the issue prescribed could not have reached two of them at
  //     all. And one FINDING the issue does not discuss: the default-fill
  //     does not become phantom drift, because the deploy engine captures
  //     `observedProperties` from `readCurrentState` — which reverse-maps
  //     this whole block from `DescribeServices` — so the AWS-filled value
  //     lands in the drift baseline. That holds only while the property
  //     stays drift-COMPARED; the test file fences it.
  //     (The hook block's schema definition is named `HookTimeoutConfig`,
  //     NOT the unrelated ServiceConnect `TimeoutConfiguration` definition —
  //     the property PATH is `LifecycleHooks[].TimeoutConfiguration`.)
  //   - The shapes the rows ABOVE do not already cover split TWO ways (plus
  //     the array shape at the end of this bullet), so
  //     neither "the rest of the tree is fine" nor "the other blocks are
  //     refused" is the takeaway, and `DeploymentAlarms` keeps the #1802 (now pre-flight-refused)
  //     disposition the row above gives it. Enumerated from
  //     the LIVE registry definitions (`describe-type`, us-east-1
  //     2026-08-13) rather than from the blocks #1806 names, and measured
  //     the same day on the same service:
  //       * AWS ITSELF REFUSES (the ASG `InstanceMaintenancePolicy`
  //         disposition, #1227 — cdkd fails LOUDLY, no nested required-ness
  //         check involved): a hook element missing `LifecycleStages`
  //         (`InvalidParameterException: Lifecycle stage cannot be null or
  //         empty for any deployment lifecycle hooks`); a hook element
  //         missing `TargetType` (`Role arn or Hook Target arn is missing
  //         for one or more deployment lifecycle hooks`, because an absent
  //         `TargetType` DEFAULTS to `AWS_LAMBDA`, which then requires
  //         members a PAUSE hook does not carry — dropping ONE member arms a
  //         requirement for TWO others); and
  //         `DeploymentCircuitBreaker.ThresholdConfiguration` missing
  //         `Value` (`Invalid deployment circuit breaker threshold value.`) —
  //         a block the issue's depth-1 scan never listed.
  //         That one is REFUSED BY CFn TOO — its definition carries
  //         `required: [Type, Value]` — so it is NOT an example of a
  //         CFn-accepted partial, and the parity comes from both engines
  //         failing rather than from agreeing on an end state. What decides
  //         the verdict is whether AWS ACCEPTS, not whether CFn refuses:
  //         `DeploymentCircuitBreaker` missing `Rollback` is refused by CFn
  //         and ACCEPTED by AWS, which is exactly why that row was the #1802
  //         divergence and this one is not.
  //       * AWS RETAINS the live value AND CLOUDFORMATION RESETS IT — the
  //         one DIVERGENT row this sweep found, opposite in polarity to
  //         #1802 and tracked as issue #1861. `DeploymentCircuitBreaker`'s
  //         OPTIONAL children (`ResetOnHealthyTask`, and the whole
  //         `ThresholdConfiguration` block) dropped from an otherwise
  //         complete parent form a partial CFn ACCEPTS, so it reaches AWS.
  //         From the IDENTICAL baseline, with `Rollback` flipped in the same
  //         call so the update demonstrably applied: cdkd's `UpdateService`
  //         left `resetOnHealthyTask: false` / `{COUNT, 7}` intact, while
  //         CloudFormation handed the same template RESET them to AWS's
  //         defaults (`true` / `{BOUNDED_PERCENT, 50}`). So cdkd silently
  //         fails to apply a removal CFn applies — too STICKY, where #1802
  //         is too PERMISSIVE. THIS ROW IS NOW FIXED (#1861): those two
  //         members — and ONLY those two, only when BOTH sides still declare
  //         the `DeploymentCircuitBreaker` block — are routed through
  //         `clearOnUpdateRemoval` in `resolveDeploymentConfiguration`, so a
  //         declared-then-dropped member is sent as its AWS default. Every
  //         other shape in this comment block still ships as the verbatim
  //         pass-through the rows above measured as parity.
  //         What CFn is doing there is applying a REMOVAL, not materializing
  //         defaults wholesale — measured, because the distinction decides
  //         the fix: a member the template NEVER declared (set out of band)
  //         SURVIVED a CFn update that changed only `MinimumHealthyPercent`,
  //         while the same member declared-then-dropped was reset. That is
  //         a previous-present / current-absent REMOVAL — the semantic
  //         `clearOnUpdateRemoval` implements one level up, though the
  //         member-vs-whole-property boundary here is EMPIRICAL rather than
  //         derived from it: removing the WHOLE `DeploymentConfiguration`
  //         resets nothing under either engine, so only a member dropped
  //         from a struct the template STILL DECLARES is treated as a
  //         removal. Two details make that arm discriminating, and both had
  //         to be measured because the obvious one alone does not: the block
  //         itself STAYED DECLARED while the member was absent, AND a later
  //         arm flipped `Rollback` INSIDE the block while the optional
  //         members remained never-declared — they still survived. That
  //         excludes the competing reading "CFn re-serializes a nested
  //         struct with defaults whenever its declared content CHANGED",
  //         which the first two arms fit just as well. Service identity was captured on
  //         both sides (same `serviceArn` / `createdAt`, stack events showing
  //         UPDATE not a second CREATE) so a replacement cannot be mistaken
  //         for a reset. Two things this row teaches. ONE nested block holds
  //         members with DIFFERENT semantics — the required `Rollback` reads
  //         as replaced while the optional children are retained — so do not
  //         generalize a row to its siblings. And the shape to carry: where
  //         the API RETAINS an omitted optional member of a STILL-DECLARED
  //         struct, cdkd diverges, because CFn treats the omission as a
  //         removal; the `LinearConfiguration` family above is parity only
  //         because the API ITSELF default-fills there, which is exactly why
  //         each block had to be measured rather than reasoned about.
  //     The `LifecycleHooks` ARRAY itself is REPLACED WHOLESALE (a 2-element
  //     list re-sent with one element left exactly that one), which is the
  //     #1227 array shape and makes a per-element DROP a non-issue.
  //     A note on HOW that was probed, because it changes the answer: the
  //     AWS CLI refuses the `ThresholdConfiguration` partial CLIENT-side
  //     (botocore validates the required trait before sending), so it never
  //     reaches the service. The JS SDK cdkd uses declares the same member
  //     required in its TYPE (`value: number | undefined`, a non-optional
  //     key, vs the optional `targetType?:`) but performs no runtime
  //     required check, so it SERIALIZES the partial and cdkd's refusal
  //     arrives from the SERVICE. The models agree; only where the
  //     validation runs differs — which is why the row was probed through
  //     `@aws-sdk/client-ecs` directly rather than through the CLI.
  // Pinned by `ecs-deployment-configuration-subfield.test.ts`.
  // Absent-from-template still passes `undefined` (no reset) below. Also not
  // reset (immutable / required / always-carried): ServiceName (immutable,
  // guarded above), Cluster / TaskDefinition / DesiredCount /
  // NetworkConfiguration, SchedulingStrategy (create-only).
  // Removal of CapacityProviderStrategy / PlacementConstraints /
  // PlacementStrategies / PlatformVersion / HealthCheckGracePeriodSeconds /
  // EnableECSManagedTags / PropagateTags / EnableExecuteCommand sends NOTHING:
  // CloudFormation keeps the live value (real A/B, #5004), and UpdateService
  // treats an absent member as unchanged.
  const capacityProviderStrategyInput = this.convertCapacityProviderStrategy(
    properties['CapacityProviderStrategy'] as Array<Record<string, unknown>> | undefined
  );
  const placementConstraintsInput = this.convertPlacementConstraints(
    properties['PlacementConstraints'] as Array<Record<string, unknown>> | undefined
  );
  const placementStrategyInput = this.convertPlacementStrategies(
    (properties['PlacementStrategies'] ?? properties['PlacementStrategy']) as
      | Array<Record<string, unknown>>
      | undefined
  );
  const platformVersionInput = properties['PlatformVersion'] as string | undefined;
  const healthCheckGracePeriodSecondsInput = properties['HealthCheckGracePeriodSeconds'] as
    | number
    | undefined;
  const enableECSManagedTagsInput = properties['EnableECSManagedTags'] as boolean | undefined;
  const propagateTagsInput = properties['PropagateTags'] as PropagateTags | undefined;
  const enableExecuteCommandInput = properties['EnableExecuteCommand'] as boolean | undefined;

  // issue #609 backfill — the previously SDK-unwired Service members on
  // the update path. All of the config blobs below are change-gated (like
  // LoadBalancers / ServiceRegistries above) because the AWS docs mark them
  // "this parameter triggers a new service deployment": re-sending an
  // unchanged value on an unrelated update could start a spurious rollout.
  //
  // Removal (present before, absent now) semantics per member, each settled
  // by a real CloudFormation A/B (#5004, #1160):
  //   - ServiceConnectConfiguration -> `{ enabled: false }`: CloudFormation
  //     resets it to disabled on removal.
  //   - VolumeConfigurations / VpcLatticeConfigurations -> `[]`:
  //     CloudFormation clears both (the service revision carries neither
  //     afterwards), and UpdateService clears on an empty list.
  //   - AvailabilityZoneRebalancing -> no reset sent: CloudFormation KEEPS
  //     the live value (DISABLED stayed DISABLED, not the schema's ENABLED
  //     default), and UpdateService keeps an absent member.
  //   - GatewayConnectors -> no reset sent (#5634): CloudFormation KEEPS
  //     the live connector; see the block below.
  //   - Monitoring -> `{ metricConfigurations: [] }`: CloudFormation resets
  //     the service revision to exactly that, while UpdateService keeps an
  //     absent member (the old 20-second resolution survived).
  //   - DeploymentController -> no reset by design: absent means the
  //     default ECS controller, and sending nothing keeps AWS's current
  //     controller (the property is only sent when present AND changed —
  //     the SDK supports an explicit change for ECS<->CODE_DEPLOY
  //     migration).
  //   - Role -> create-only (registry schema createOnlyProperties); a
  //     change is classified as replacement by the diff layer, so update()
  //     never delivers it (UpdateService has no role member).
  const availabilityZoneRebalancingChanged =
    JSON.stringify(previousProperties['AvailabilityZoneRebalancing'] ?? null) !==
    JSON.stringify(properties['AvailabilityZoneRebalancing'] ?? null);
  const availabilityZoneRebalancingInput =
    availabilityZoneRebalancingChanged && properties['AvailabilityZoneRebalancing'] !== undefined
      ? (properties['AvailabilityZoneRebalancing'] as AvailabilityZoneRebalancing)
      : undefined;

  const deploymentControllerChanged =
    JSON.stringify(previousProperties['DeploymentController'] ?? null) !==
    JSON.stringify(properties['DeploymentController'] ?? null);
  const deploymentControllerInput =
    deploymentControllerChanged && properties['DeploymentController'] != null
      ? this.convertDeploymentController(
          properties['DeploymentController'] as Record<string, unknown>
        )
      : undefined;

  const serviceConnectChanged =
    JSON.stringify(previousProperties['ServiceConnectConfiguration'] ?? null) !==
    JSON.stringify(properties['ServiceConnectConfiguration'] ?? null);
  const serviceConnectConfigurationInput = serviceConnectChanged
    ? clearOnUpdateRemoval(
        this.convertServiceConnectConfiguration(
          properties['ServiceConnectConfiguration'] as Record<string, unknown> | undefined
        ),
        previousProperties['ServiceConnectConfiguration'] as
          | ServiceConnectConfiguration
          | undefined,
        { enabled: false }
      )
    : undefined;

  const volumeConfigurationsChanged =
    JSON.stringify(previousProperties['VolumeConfigurations'] ?? null) !==
    JSON.stringify(properties['VolumeConfigurations'] ?? null);
  const volumeConfigurationsInput = volumeConfigurationsChanged
    ? clearOnUpdateRemoval(
        this.convertServiceVolumeConfigurations(
          properties['VolumeConfigurations'] as Array<Record<string, unknown>> | undefined
        ),
        previousProperties['VolumeConfigurations'] as ServiceVolumeConfiguration[] | undefined,
        []
      )
    : undefined;

  const vpcLatticeConfigurationsChanged =
    JSON.stringify(previousProperties['VpcLatticeConfigurations'] ?? null) !==
    JSON.stringify(properties['VpcLatticeConfigurations'] ?? null);
  const vpcLatticeConfigurationsInput = vpcLatticeConfigurationsChanged
    ? clearOnUpdateRemoval(
        this.convertVpcLatticeConfigurations(
          properties['VpcLatticeConfigurations'] as Array<Record<string, unknown>> | undefined
        ),
        previousProperties['VpcLatticeConfigurations'] as VpcLatticeConfiguration[] | undefined,
        []
      )
    : undefined;

  const monitoringChanged =
    JSON.stringify(previousProperties['Monitoring'] ?? null) !==
    JSON.stringify(properties['Monitoring'] ?? null);
  const monitoringInput = monitoringChanged
    ? clearOnUpdateRemoval(
        this.convertMonitoringConfiguration(
          properties['Monitoring'] as Record<string, unknown> | undefined
        ),
        previousProperties['Monitoring'] as MonitoringConfiguration | undefined,
        { metricConfigurations: [] }
      )
    : undefined;

  // go-to-k/cdkd#5634: GatewayConnectors, change-gated like the blobs above.
  // A CloudFormation A/B settled removal: dropping the property (alone, or
  // beside another change) starts no deployment and the live connector
  // stays, so sending nothing is parity — UpdateService keeps an absent
  // member. Only a DECLARED `[]` clears it (CloudFormation sends it, and
  // the next service revision carries no connector), and it reaches here
  // as a change like any other value. The gate compares
  // `Filters.AccessTypes` as a set (CFn schema `insertionOrder: false`), so
  // a pure reorder starts no deployment; the value SENT keeps the
  // template's order.
  const gatewayConnectorsChanged =
    gatewayConnectorsGateKey(previousProperties['GatewayConnectors']) !==
    gatewayConnectorsGateKey(properties['GatewayConnectors']);
  const gatewayConnectorsInput = gatewayConnectorsChanged
    ? this.convertGatewayConnectors(
        properties['GatewayConnectors'] as Array<Record<string, unknown>> | undefined
      )
    : undefined;

  // CFn ForceNewDeployment `{EnableForceNewDeployment, ForceNewDeploymentNonce}`
  // -> the SDK's plain `forceNewDeployment` boolean (only send `true`; the
  // field is a one-shot trigger, never persisted state).
  const forceNewDeploymentInput = this.resolveForceNewDeployment(
    properties,
    previousProperties,
    log
  );

  // Verbatim PascalCase->camelCase conversion PLUS the member-level removal
  // reset inside `DeploymentCircuitBreaker` (issue #1861 — the last bullet
  // of the block above). Everything else in this property stays a
  // pass-through, which the same measurement established as parity.
  const deploymentConfigurationInput = this.resolveDeploymentConfiguration(
    properties,
    previousProperties
  );

  try {
    const response = await client.send(
      new UpdateServiceCommand({
        cluster: properties['Cluster'] as string | undefined,
        service: physicalId,
        taskDefinition: properties['TaskDefinition'] as string | undefined,
        desiredCount: properties['DesiredCount'] as number | undefined,
        networkConfiguration: this.convertNetworkConfiguration(
          properties['NetworkConfiguration'] as Record<string, unknown> | undefined
        ),
        capacityProviderStrategy: capacityProviderStrategyInput,
        // DeploymentConfiguration is converted PascalCase->camelCase (issue
        // #1165); a change is sent through and an absent value passes
        // undefined (no WHOLE-property removal RESET — measured as
        // CloudFormation parity). The one member-level removal reset the
        // measurement DID find lives in `resolveDeploymentConfiguration`
        // (issue #1861); see the comment block above the try.
        deploymentConfiguration: deploymentConfigurationInput,
        placementConstraints: placementConstraintsInput,
        placementStrategy: placementStrategyInput,
        platformVersion: platformVersionInput,
        healthCheckGracePeriodSeconds: healthCheckGracePeriodSecondsInput,
        enableECSManagedTags: enableECSManagedTagsInput,
        propagateTags: propagateTagsInput,
        enableExecuteCommand: enableExecuteCommandInput,
        loadBalancers: loadBalancersInput,
        serviceRegistries: serviceRegistriesInput,
        // issue #609 backfill (change-gated; removal semantics documented
        // in the block above the try).
        availabilityZoneRebalancing: availabilityZoneRebalancingInput,
        deploymentController: deploymentControllerInput,
        serviceConnectConfiguration: serviceConnectConfigurationInput,
        volumeConfigurations: volumeConfigurationsInput,
        vpcLatticeConfigurations: vpcLatticeConfigurationsInput,
        monitoring: monitoringInput,
        gatewayConnectors: gatewayConnectorsInput,
        forceNewDeployment: forceNewDeploymentInput,
      })
    );

    const service = response.service;

    // Apply tag diff. ECS Service ARN comes from the UpdateService response.
    if (service?.serviceArn) {
      await this.applyTagDiff(
        service.serviceArn,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags'],
        log
      );
    }

    // The rolling deployment UpdateService starts settles minutes later;
    // the default waits for it and fails on a circuit-breaker verdict.
    try {
      await this.settleService(
        logicalId,
        service?.serviceName ?? physicalId,
        properties['Cluster'] as string | undefined,
        log,
        requestedRolloutOf(service),
        // `cdkd drift --revert` (go-to-k/cdkd#5571) does not wait at all:
        // the outcome of its wait could only ever be the warning below
        // (a revert must not fail on the rollout it restores), and drift
        // has no `--no-wait` to skip a wait that only costs time.
        desiredFromAwsReadback
          ? 'a drift revert does not wait for it'
          : controllerSkipsWait(properties)
      );
    } catch (waitError) {
      // Not a template deploy (go-to-k/cdkd#5571): the rollback executor's
      // revert arms (`replayingState`) re-apply a configuration the service
      // held before — a STATE record. Failing the rollback on its steady
      // state would leave the stack un-rollbackable (the user cannot fix a
      // state record through the template), and the revert has already
      // been accepted by AWS: what follows is the service's rollout, not
      // cdkd's write. So warn, with the same diagnosis commands, and report
      // the update applied. A template deploy throws: its rollout is the
      // deploy's outcome. (`drift --revert` never waits; see above.)
      if (replayingState) {
        log.warn(
          `${this.wrapSteadyStateError(logicalId, waitError, properties['Cluster'], log, false).message} The rollback update was applied; continuing.`
        );
      } else {
        throw this.wrapSteadyStateError(logicalId, waitError, properties['Cluster'], log);
      }
    }

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        ServiceArn: service?.serviceArn || physicalId,
        Name: service?.serviceName,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update ECS service ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
