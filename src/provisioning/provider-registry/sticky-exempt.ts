import { ecsServiceSdkPhysicalId } from '../sticky-exempt-physical-id.js';

/**
 * How a type escapes the sticky `provisionedBy: 'cc-api'` routing rule.
 *
 * - `'cc-broken'` -- the CC handler CANNOT correctly manage the resource, so
 *   keeping existing state pinned to cc-api keeps a live bug alive. The
 *   fall-through is UNCONDITIONAL: no property check, and `forceCcApi` is
 *   ignored, because pinning here would be pinning to the broken handler.
 * - `'sdk-coverage'` -- CC routing WORKS (or misbehaves only on an update);
 *   the SDK provider has since been backfilled (issue #609) to cover the
 *   properties this resource actually uses. The fall-through is CONDITIONAL on
 *   that being true of the resource in hand, and suppressible with
 *   `forceCcApi`. A type admitted only for the SDK path's speed fits here
 *   too, since the next mutating deploy flips the record (the listener,
 *   issue #4679).
 */
export type StickyExemptMode = 'cc-broken' | 'sdk-coverage';

/**
 * One type's admission to the sticky-CC exemption, with the evidence that
 * admitted it.
 *
 * The fields are not documentation. `tests/unit/provisioning/
 * sticky-exempt-registry.test.ts` requires `integFixture` to name a directory
 * that EXISTS under `tests/integration/` and to have at least one row in
 * `docs/_generated/integ-last-run.tsv` -- so an entry naming a fixture that
 * never ran fails the unit suite. A fixture that ran before its parity arm was
 * added still passes, so that arm's real-AWS run is a merge condition of the
 * PR adding the entry. That is the mechanism behind "evidence rather than
 * assumption": physicalId parity is an
 * empirical per-type fact about what the CC handler mints as `Identifier`
 * versus what the SDK provider stores as `physicalId`, and it is FALSE in
 * general (composite ids, ARN-vs-name divergences). Asserting it from provider
 * source is not the same as observing it on a live resource.
 */
export interface StickyExemptEntry {
  mode: StickyExemptMode;
  /** What both layers store as physicalId, in words, for a reviewer. */
  physicalIdForm: string;
  /** The issue that admitted this type. */
  issue: string;
  /** The integ fixture whose run OBSERVED the parity. Must exist and have run. */
  integFixture: string;
  /**
   * Present only for a type whose Cloud Control id DIFFERS from the SDK
   * provider's (go-to-k/cdkd#5654): maps the recorded Cloud Control id to the
   * one the SDK provider stores for the same live resource. STRICT -- it
   * throws on any id that is not the measured Cloud Control form, so a record
   * it cannot place is refused rather than addressed under a guess. Its output
   * is evidence like parity is: the entry's fixture must observe it equal to
   * the SDK form on a live resource. Applied by {@link sdkAddressedPhysicalId}.
   */
  normalizeCcPhysicalId?: (ccPhysicalId: string) => string;
}

/**
 * Types exempt from the sticky `provisionedBy: 'cc-api'` routing rule.
 *
 * The sticky rule (rule 2 in `getProviderFor`) exists to avoid physical-ID
 * churn when an SDK provider is backfilled for a type Cloud Control was
 * already managing fine. Both exemption modes are narrow escapes from it; see
 * `StickyExemptMode` for which applies when.
 *
 * Condition 2 -- physicalId parity, or a declared `normalizeCcPhysicalId`
 * whose output the fixture observed equal to the SDK form -- is a hard
 * requirement in BOTH modes and is what makes a flip churn-free. It is also
 * why this is a curated table rather than a predicate: an automatic flip keyed
 * on "the type has coverage" would assert parity for types nobody measured.
 */
export const STICKY_CC_MIGRATION_EXEMPT: ReadonlyMap<string, StickyExemptEntry> = new Map([
  [
    'AWS::Scheduler::Schedule',
    {
      // A schedule in a custom ScheduleGroup is unaddressable via CC (the
      // handlers resolve the bare-Name identifier against the DEFAULT group)
      // -- CC UPDATE fails NotFound and CC DELETE silently no-ops, orphaning a
      // live schedule. Broken, not slow.
      mode: 'cc-broken' as const,
      physicalIdForm:
        'both layers store the bare schedule name; the state properties carry ' +
        'GroupName, so the SDK provider addresses existing records correctly',
      issue: 'https://github.com/go-to-k/cdkd/issues/961',
      integFixture: 'scheduler-custom-group',
    },
  ],
  [
    'AWS::AppConfig::Environment',
    {
      // CC DELETE sends only the identifier, so the write-only
      // `DeletionProtectionCheck` (a parameter of AppConfig's DeleteEnvironment,
      // stored nowhere) is lost and AppConfig applies the account default: a
      // recently read environment cannot be destroyed, however the template
      // declares BYPASS (issue #5875). Every record written before the SDK
      // provider existed says `cc-api`, and the destroy's routing gets no
      // properties, so nothing but this unconditional exemption moves those to
      // the provider that forwards the value. Broken, not slow.
      mode: 'cc-broken' as const,
      physicalIdForm:
        'both layers store <ApplicationId>|<EnvironmentId>: that is the Cloud ' +
        'Control primary identifier and what AppConfigEnvironmentProvider.create records',
      issue: 'https://github.com/go-to-k/cdkd/issues/5875',
      integFixture: 'appconfig-environment-delete-protection',
    },
  ],
  [
    'AWS::RDS::DBProxyTargetGroup',
    {
      // CC READ and DELETE always fail: the handlers cannot derive DBProxyName
      // from the TargetGroupArn identifier and send it null (issue #385;
      // re-measured for issue #4087). A record pinned to cc-api could never be
      // read back or destroyed.
      mode: 'cc-broken' as const,
      physicalIdForm:
        'both layers store the TargetGroupArn: the schema primaryIdentifier is ' +
        'TargetGroupArn and RDSDBProxyTargetGroupProvider.create records the ' +
        'DescribeDBProxyTargetGroups TargetGroupArn',
      issue: 'https://github.com/go-to-k/cdkd/issues/4087',
      integFixture: 'rds-aurora',
    },
  ],
  [
    'AWS::Lambda::EventInvokeConfig',
    {
      // CC UPDATE always fails: the read handler injects empty
      // `DestinationConfig.OnSuccess` / `OnFailure` objects the model then
      // rejects (issue #4091, re-measured). A record pinned to cc-api could
      // never be updated. Cloud Control CREATE works, so the mode costs the
      // unrecognized-key route; and a schema refresh that lands an SDK-unwired property
      // here must wire it in the provider, since the unwired property would auto-route to
      // that broken UPDATE.
      mode: 'cc-broken' as const,
      physicalIdForm:
        'both layers store `<FunctionName>|<Qualifier>`: the schema primaryIdentifier ' +
        'is FunctionName + Qualifier and LambdaEventInvokeConfigProvider.create packs ' +
        'the same two with `|`',
      issue: 'https://github.com/go-to-k/cdkd/issues/4091',
      integFixture: 'lambda-event-invoke-config-update',
    },
  ],
  [
    'AWS::Pipes::Pipe',
    {
      // CC UPDATE cannot change a mutable member of a stream / broker source's
      // write-only `SourceParameters` (issue #4423, measured): every patch
      // either re-adds the create-only `StartingPosition` (refused as a
      // create-only change) or omits it (model validation fails). A record
      // pinned to cc-api could never take such a change.
      mode: 'cc-broken' as const,
      physicalIdForm:
        'both layers store the pipe Name: the schema primaryIdentifier is Name and ' +
        'PipesPipeProvider.create records the Name it sent to CreatePipe',
      issue: 'https://github.com/go-to-k/cdkd/issues/4423',
      integFixture: 'cc-write-only-create-only',
    },
  ],
  [
    'AWS::SNS::Topic',
    {
      // The first 'sdk-coverage' member (issue #2719). CC manages topics
      // correctly -- it is only slower -- so this is the mode that had no
      // members before: the type's sdkUnwired map is empty (issue #609
      // backfill), so a resource using it takes the SDK path on a fresh
      // deploy, and there was no way for one already pinned to cc-api to
      // follow it there short of a destroy + recreate.
      //
      // "Empty" is a MOVING premise, not a fact about the type: the daily
      // schema refresh re-adds an unwired property whenever AWS publishes a property the
      // provider does not write (issue #3413: `MaximumMessageSize`, 2026-09-18,
      // made the both-bags gate below live and `cdkd diff`'s sticky annotation
      // reachable under --allow-unsupported-properties). A refresh that lands
      // an unwired property on an admitted type owes the wiring in the same cycle, or the
      // admission stops meaning what docs/provider-rules.md step 1 says.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the topic ARN: the schema primaryIdentifier is ' +
        'TopicArn and SnsTopicProvider.create records the CreateTopic TopicArn',
      issue: 'https://github.com/go-to-k/cdkd/issues/2719',
      integFixture: 'cc-to-sdk-reroute',
    },
  ],
  [
    'AWS::Lambda::WebFunctionRevision',
    {
      // Every revision created before its SDK provider (go-to-k/cdkd#4926) is
      // pinned to cc-api, and the replacement a code change makes reads that
      // record, so without this entry no existing stack would leave Cloud
      // Control on the per-deploy path the provider exists for.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the revision ARN: the schema primaryIdentifier is ' +
        'RevisionArn and LambdaWebFunctionRevisionProvider.create records the ' +
        'CreateWebFunctionRevision revisionArn',
      issue: 'https://github.com/go-to-k/cdkd/issues/4926',
      integFixture: 'lambda-web-function-revision-replace',
    },
  ],
  [
    'AWS::Lambda::WebFunctionEndpoint',
    {
      // The endpoint is UPDATED on every code change; see the revision above.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the endpoint ARN: the schema primaryIdentifier is ' +
        'EndpointArn and LambdaWebFunctionEndpointProvider.create records the ' +
        'CreateWebFunctionEndpoint endpointArn',
      issue: 'https://github.com/go-to-k/cdkd/issues/4926',
      integFixture: 'lambda-web-function-revision-replace',
    },
  ],
  [
    'AWS::Lambda::NetworkConnector',
    {
      // Every connector created before its SDK provider (go-to-k/cdkd#4928) is
      // pinned to cc-api; this lets the next deploy that changes it move it.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the connector ARN: the schema primaryIdentifier is ' +
        'Arn and LambdaNetworkConnectorProvider.create records the ' +
        'CreateNetworkConnector Arn',
      issue: 'https://github.com/go-to-k/cdkd/issues/4928',
      integFixture: 'lambda-network-connector',
    },
  ],
  [
    'AWS::ElasticLoadBalancingV2::Listener',
    {
      // Pinned to cc-api: every listener first deployed while tagged, before
      // the provider declared `Tags` handled. Cloud Control manages it
      // correctly, and both routes leave a removed `ListenerAttributes` key at
      // its live value, as CloudFormation does (issue #1160, CFn A/B
      // 2026-10-17). It is admitted for the SDK path's speed: Cloud Control
      // polls every operation, while the ELBv2 calls return synchronously.
      // Not 'cc-broken': that mode would also move an unflipped record's drift
      // read to the SDK provider against its Cloud Control baseline. This one
      // flips on the next deploy that changes the listener.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the listener ARN: the schema primaryIdentifier is ' +
        'ListenerArn and ELBv2Provider.create records the CreateListener ListenerArn',
      issue: 'https://github.com/go-to-k/cdkd/issues/4679',
      integFixture: 'alb',
    },
  ],
  [
    'AWS::EFS::MountTarget',
    {
      // Pinned to cc-api: every mount target first deployed while declaring a
      // property the provider did not handle yet (go-to-k/cdkd#2762 wired
      // IpAddress, IpAddressType and Ipv6Address). Cloud Control manages it
      // correctly; this is admitted for the SDK path's speed.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare `fsmt-...` id: the schema primaryIdentifier is Id ' +
        'and EFSProvider.create records the CreateMountTarget MountTargetId (Cloud ' +
        'Control Identifier measured us-east-1, 2026-11-02)',
      issue: 'https://github.com/go-to-k/cdkd/issues/5641',
      integFixture: 'cc-to-sdk-reroute-mount-target',
    },
  ],
  [
    'AWS::Route53::HostedZone',
    {
      // Pinned to cc-api: every zone first deployed while declaring a property
      // the provider did not handle yet, DelegationSetId among them
      // (go-to-k/cdkd#2762). Cloud Control manages it correctly; this is
      // admitted for the SDK path's speed.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare `Z...` zone id, without the `/hostedzone/` prefix ' +
        'Route 53 answers with: the schema primaryIdentifier is Id, Route53Provider.create ' +
        'strips the prefix, and the Cloud Control Identifier has none (measured ' +
        'us-east-1, 2026-11-02)',
      issue: 'https://github.com/go-to-k/cdkd/issues/5641',
      integFixture: 'cc-to-sdk-reroute-hosted-zone',
    },
  ],
  [
    'AWS::ECS::Service',
    {
      // Pinned to cc-api: every service first deployed while declaring a
      // property the provider did not handle yet, GatewayConnectors the last
      // (go-to-k/cdkd#5634). Cloud Control manages it correctly; this is
      // admitted for the SDK path's speed. The first entry whose ids DIFFER,
      // hence the normalizer.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores `<serviceArn>|<cluster>` (the schema primaryIdentifier is ' +
        'ServiceArn + Cluster; measured us-east-1, 2026-11-03) while ECSProvider.create ' +
        'records the bare CreateService serviceArn; normalizeCcPhysicalId keeps the ARN ' +
        'part, which the fixture observed equal to the live service ARN',
      issue: 'https://github.com/go-to-k/cdkd/issues/5654',
      integFixture: 'cc-to-sdk-reroute-ecs-service',
      normalizeCcPhysicalId: ecsServiceSdkPhysicalId,
    },
  ],
  [
    'AWS::ApiGateway::RestApi',
    {
      // Pinned to cc-api: every REST API deployed before ApiGatewayProvider
      // took the type (go-to-k/cdkd#6139). Cloud Control manages it correctly;
      // this is admitted for the SDK path's speed (no polled update).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare REST API id: the schema primaryIdentifier is ' +
        'RestApiId and ApiGatewayProvider.create records the CreateRestApi id ' +
        '(observed equal on a live API by the fixture)',
      issue: 'https://github.com/go-to-k/cdkd/issues/6141',
      integFixture: 'cc-to-sdk-reroute-rest-api',
    },
  ],
  [
    'AWS::EC2::SecurityGroup',
    {
      // Admitted for the SDK path's speed with nine other types in one
      // change (go-to-k/cdkd#6454): Cloud Control manages each correctly,
      // and a resource auto-routed there before its provider wrote every
      // property it declares otherwise stays there. One fixture observed
      // all ten flips on live resources, each with an identity witness:
      // the AWS-minted id where AWS mints one, else the RoleId, PolicyId,
      // queue CreatedTimestamp or parameter Version.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare `sg-...` group id: the schema primaryIdentifier is Id ' +
        'and EC2Provider.create records the CreateSecurityGroup GroupId',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types',
    },
  ],
  [
    'AWS::EC2::RouteTable',
    {
      // Admitted with AWS::EC2::SecurityGroup (go-to-k/cdkd#6454).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare `rtb-...` id: the schema primaryIdentifier is ' +
        'RouteTableId and EC2Provider.create records the CreateRouteTable RouteTableId',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types',
    },
  ],
  [
    'AWS::ElasticLoadBalancingV2::TargetGroup',
    {
      // Admitted with AWS::EC2::SecurityGroup (go-to-k/cdkd#6454).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the target group ARN: the schema primaryIdentifier is ' +
        'TargetGroupArn and ELBv2Provider.create records the CreateTargetGroup TargetGroupArn',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types',
    },
  ],
  [
    'AWS::KMS::Key',
    {
      // Admitted with AWS::EC2::SecurityGroup (go-to-k/cdkd#6454).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare key id (a UUID, not the key ARN): the schema ' +
        'primaryIdentifier is KeyId and the KMS provider records the CreateKey KeyId',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types',
    },
  ],
  [
    'AWS::SecretsManager::Secret',
    {
      // Admitted with AWS::EC2::SecurityGroup (go-to-k/cdkd#6454).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the secret ARN, random suffix included: the schema ' +
        'primaryIdentifier is Id (the ARN) and SecretsManagerSecretProvider.create ' +
        'records the CreateSecret ARN',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types',
    },
  ],
  [
    'AWS::Lambda::EventSourceMapping',
    {
      // Admitted with AWS::EC2::SecurityGroup (go-to-k/cdkd#6454).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the mapping UUID: the schema primaryIdentifier is Id and ' +
        'LambdaEventSourceMappingProvider.create records the CreateEventSourceMapping UUID',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types',
    },
  ],
  [
    'AWS::IAM::Role',
    {
      // Admitted with AWS::EC2::SecurityGroup (go-to-k/cdkd#6454).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare role name: the schema primaryIdentifier is RoleName ' +
        'and IAMRoleProvider.create records the name it created the role under',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types',
    },
  ],
  [
    'AWS::IAM::ManagedPolicy',
    {
      // Admitted with AWS::EC2::SecurityGroup (go-to-k/cdkd#6454).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the policy ARN: the schema primaryIdentifier is PolicyArn and ' +
        'IAMManagedPolicyProvider.create records the CreatePolicy Arn',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types',
    },
  ],
  [
    'AWS::SQS::Queue',
    {
      // Admitted with AWS::EC2::SecurityGroup (go-to-k/cdkd#6454).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the queue URL: the schema primaryIdentifier is QueueUrl and ' +
        'SQSQueueProvider.create records the CreateQueue QueueUrl',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types',
    },
  ],
  [
    'AWS::SSM::Parameter',
    {
      // Admitted with AWS::EC2::SecurityGroup (go-to-k/cdkd#6454).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare parameter name: the schema primaryIdentifier is Name ' +
        'and SSMParameterProvider.create records the name it put the parameter under',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types',
    },
  ],
]);
