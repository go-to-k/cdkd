import {
  apiGatewayAuthorizerSdkPhysicalId,
  apiGatewayStageSdkPhysicalId,
  apiGatewayV2AuthorizerSdkPhysicalId,
  apiGatewayV2IntegrationSdkPhysicalId,
  apiGatewayV2RouteSdkPhysicalId,
  apiGatewayV2StageSdkPhysicalId,
  appSyncGraphQLApiSdkPhysicalId,
  codeCommitRepositorySdkPhysicalId,
  ecsServiceSdkPhysicalId,
  s3VectorsVectorBucketSdkPhysicalId,
  wafv2WebAclSdkPhysicalId,
} from '../sticky-exempt-physical-id.js';

import type { StickyExemptEntry } from './sticky-exempt-entry.js';

export type { StickyExemptEntry, StickyExemptMode } from './sticky-exempt-entry.js';

/**
 * Batch 12 (go-to-k/cdkd#6588): types that were Cloud Control only until their
 * SDK provider shipped in 0.357.0, so every resource deployed before then is
 * recorded `cc-api`. The fixture's identity witnesses: the archive CreationTime,
 * an out-of-band tag on the source and the destination, the AWS-minted delivery
 * id. Admission also fixes the delivery's update: Cloud Control refuses every
 * update of a delivery to a log group (measured us-east-1, 2026-11-19).
 */
const batch12 = (physicalIdForm: string): StickyExemptEntry => ({
  mode: 'sdk-coverage',
  physicalIdForm,
  issue: 'https://github.com/go-to-k/cdkd/issues/6588',
  integFixture: 'cc-to-sdk-reroute-common-types-12',
});

/**
 * Batch 2 of go-to-k/cdkd#6454: the types admitted with AWS::EC2::VPC, whose
 * entry carries the batch's rationale. Its fixture observed every flip.
 */
const batch2 = (physicalIdForm: string): StickyExemptEntry => ({
  mode: 'sdk-coverage',
  physicalIdForm,
  issue: 'https://github.com/go-to-k/cdkd/issues/6454',
  integFixture: 'cc-to-sdk-reroute-common-types-2',
});

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
        'both layers store the bare key id, not the key ARN (observed as a UUID; a ' +
        'multi-region `mrk-...` id was not exercised): the schema ' +
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
  [
    'AWS::EC2::VPC',
    {
      // Batch 2 of go-to-k/cdkd#6454, admitted with ten other types for the
      // SDK path's speed. Its fixture observed all eleven flips on live
      // resources, each with an identity witness: the AWS-minted id where
      // AWS mints one, else the UserId, GroupId, InstanceProfileId, or the
      // state machine's, function URL's or alias's creation time.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare `vpc-...` id: the schema primaryIdentifier is VpcId ' +
        'and EC2Provider.create records the CreateVpc VpcId',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-2',
    },
  ],
  [
    'AWS::EC2::InternetGateway',
    batch2(
      'both layers store the bare `igw-...` id: the schema primaryIdentifier is ' +
        'InternetGatewayId and EC2Provider.create records the CreateInternetGateway id'
    ),
  ],
  [
    'AWS::EC2::NetworkAcl',
    batch2(
      'both layers store the bare `acl-...` id: the schema primaryIdentifier is Id ' +
        'and EC2Provider.create records the CreateNetworkAcl NetworkAclId'
    ),
  ],
  [
    'AWS::IAM::User',
    batch2(
      'both layers store the bare user name: the schema primaryIdentifier is UserName ' +
        'and the IAM user provider records the name it created the user under'
    ),
  ],
  [
    'AWS::IAM::Group',
    batch2(
      'both layers store the bare group name: the schema primaryIdentifier is ' +
        'GroupName and the IAM group provider records the name it created the group under'
    ),
  ],
  [
    'AWS::IAM::InstanceProfile',
    batch2(
      'both layers store the bare instance profile name: the schema primaryIdentifier ' +
        'is InstanceProfileName and IAMInstanceProfileProvider.create records that name'
    ),
  ],
  [
    'AWS::StepFunctions::StateMachine',
    batch2(
      'both layers store the state machine ARN: the schema primaryIdentifier is Arn ' +
        'and StepFunctionsProvider.create records the CreateStateMachine stateMachineArn'
    ),
  ],
  [
    'AWS::Lambda::Url',
    batch2(
      'both layers store the function ARN the URL is on, alias-qualified when ' +
        'Qualifier is set: the schema primaryIdentifier is FunctionArn and ' +
        'LambdaUrlProvider.create records the CreateFunctionUrlConfig FunctionArn ' +
        '(the fixture observed both the unqualified and the qualified form)'
    ),
  ],
  [
    'AWS::Cognito::UserPool',
    batch2(
      'both layers store the bare `<region>_...` pool id: the schema primaryIdentifier ' +
        'is UserPoolId and CognitoUserPoolProvider.create records the CreateUserPool Id'
    ),
  ],
  [
    'AWS::CloudFront::OriginAccessControl',
    batch2(
      'both layers store the bare origin access control id: the schema ' +
        'primaryIdentifier is Id and CloudFrontOACProvider.create records the ' +
        'CreateOriginAccessControl Id'
    ),
  ],
  [
    'AWS::KMS::Alias',
    batch2(
      'both layers store the `alias/...` name: the schema primaryIdentifier is ' +
        'AliasName and the KMS alias provider records the name it created the alias under'
    ),
  ],
  [
    'AWS::CloudFront::CloudFrontOriginAccessIdentity',
    {
      // Batch 3 of go-to-k/cdkd#6454, admitted with four other types for the
      // SDK path's speed. Its fixture observed all five flips on live
      // resources, each with an identity witness: the AWS-minted id where
      // AWS mints one, else the resource's creation time (an HttpNamespace's
      // too: Cloud Map re-mints the same `ns-...` id for a recreated name).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare `E...` identity id: the schema primaryIdentifier is ' +
        'Id and CloudFrontOAIProvider.create records the CreateCloudFrontOriginAccessIdentity Id',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-3',
    },
  ],
  [
    'AWS::ServiceDiscovery::HttpNamespace',
    {
      // Admitted with AWS::CloudFront::CloudFrontOriginAccessIdentity (go-to-k/cdkd#6454, batch 3).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare `ns-...` namespace id: the schema primaryIdentifier ' +
        'is Id and the Service Discovery provider records the Id of the namespace it created',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-3',
    },
  ],
  [
    'AWS::Glue::Database',
    {
      // Admitted with AWS::CloudFront::CloudFrontOriginAccessIdentity (go-to-k/cdkd#6454, batch 3).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare database name: the schema primaryIdentifier is ' +
        'DatabaseName and the Glue provider records DatabaseInput.Name, else DatabaseName',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-3',
    },
  ],
  [
    'AWS::Glue::Job',
    {
      // Admitted with AWS::CloudFront::CloudFrontOriginAccessIdentity (go-to-k/cdkd#6454, batch 3).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare job name: the schema primaryIdentifier is Name ' +
        'and GlueJobProvider.create records the CreateJob Name',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-3',
    },
  ],
  [
    'AWS::ECR::Repository',
    {
      // Admitted with AWS::CloudFront::CloudFrontOriginAccessIdentity (go-to-k/cdkd#6454, batch 3).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare repository name: the schema primaryIdentifier is ' +
        'RepositoryName and ECRProvider.create records the CreateRepository repositoryName',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-3',
    },
  ],
  [
    'AWS::Events::EventBus',
    {
      // Batch 4 of go-to-k/cdkd#6454, admitted with four other types for the
      // SDK path's speed once its delete stopped deleting rules from outside
      // the stack (go-to-k/cdkd#6479). Its fixture observed all five flips on
      // live resources, each with an identity witness: the AWS-minted ARN,
      // or the resource's creation time (Cloud Map re-mints its ids).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare bus name, not the ARN: the schema primaryIdentifier ' +
        'is Name and EventBridgeBusProvider.create records the bus name',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-4',
    },
  ],
  [
    'AWS::ServiceDiscovery::PrivateDnsNamespace',
    {
      // Admitted with AWS::Events::EventBus (go-to-k/cdkd#6454, batch 4).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare `ns-...` namespace id: the schema primaryIdentifier ' +
        'is Id and the Service Discovery provider records the Id of the namespace it created',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-4',
    },
  ],
  [
    'AWS::Glue::Workflow',
    {
      // Admitted with AWS::Events::EventBus (go-to-k/cdkd#6454, batch 4).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare workflow name: the schema primaryIdentifier is Name ' +
        'and the Glue provider records the CreateWorkflow Name',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-4',
    },
  ],
  [
    'AWS::Glue::Crawler',
    {
      // Admitted with AWS::Events::EventBus (go-to-k/cdkd#6454, batch 4).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare crawler name: the schema primaryIdentifier is Name ' +
        'and GlueCrawlerProvider.create records the crawler name',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-4',
    },
  ],
  [
    'AWS::ElasticLoadBalancingV2::LoadBalancer',
    {
      // Admitted with AWS::Events::EventBus (go-to-k/cdkd#6454, batch 4).
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the load balancer ARN: the schema primaryIdentifier is ' +
        'LoadBalancerArn and the ELBv2 provider records the CreateLoadBalancer LoadBalancerArn',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-4',
    },
  ],
  [
    'AWS::ServiceDiscovery::Service',
    {
      // Batch 5 of go-to-k/cdkd#6454, admitted for the SDK path's speed once
      // its update stopped failing every deploy of a service in an HTTP
      // namespace (go-to-k/cdkd#6484). Its fixture flipped one service in a DNS
      // namespace and one in an HTTP namespace, each witnessed by CreateDate:
      // Cloud Map handed a namespace re-created under the same name its old
      // `ns-...` id (measured in batch 3), so its ids are not used as witnesses.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare `srv-...` service id: the schema primaryIdentifier ' +
        'is Id and the Service Discovery provider records the CreateService Id',
      issue: 'https://github.com/go-to-k/cdkd/issues/6454',
      integFixture: 'cc-to-sdk-reroute-common-types-5',
    },
  ],
  [
    'AWS::S3Tables::TableBucket',
    {
      // Batch 6 of go-to-k/cdkd#6454 (the follow-up go-to-k/cdkd#6490),
      // admitted with the two AgentCore types below for the SDK path's speed.
      // The bucket ARN is built from its name, so a re-created bucket keeps
      // it: the fixture witnesses the bucket by its tableBucketId and
      // createdAt instead.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the table bucket ARN: the schema primaryIdentifier is ' +
        'TableBucketARN and the S3 Tables provider records the CreateTableBucket arn',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-6',
    },
  ],
  [
    'AWS::BedrockAgentCore::Runtime',
    {
      // Admitted with AWS::S3Tables::TableBucket (go-to-k/cdkd#6490, batch 6).
      // AgentCore mints the id (the name plus a random suffix), and the
      // fixture also witnesses the runtime by its createdAt.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare agentRuntimeId, not the ARN: the schema ' +
        'primaryIdentifier is AgentRuntimeId and the AgentCore Runtime provider records ' +
        'the CreateAgentRuntime agentRuntimeId',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-6',
    },
  ],
  [
    'AWS::BedrockAgentCore::Evaluator',
    {
      // Admitted with AWS::S3Tables::TableBucket (go-to-k/cdkd#6490, batch 6).
      // The ARN carries the AgentCore-minted evaluatorId, and the fixture also
      // witnesses the evaluator by its createdAt.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the evaluator ARN, not the bare id: the schema primaryIdentifier ' +
        'is EvaluatorArn and the AgentCore Evaluator provider records the CreateEvaluator evaluatorArn',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-6',
    },
  ],
  [
    'AWS::ApiGateway::Authorizer',
    {
      // Batch 7 (go-to-k/cdkd#6490), admitted with the Stage and Method below
      // for the SDK path's speed. The ids differ, hence the normalizer. The
      // authorizer id is AWS-minted, so a recreate changes it and the flip
      // keeps it: the fixture's identity witness.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores `<restApiId>|<authorizerId>` (measured us-east-1, 2026-11-17; ' +
        'the live schema primaryIdentifier is RestApiId + AuthorizerId) while the API ' +
        'Gateway provider records the bare CreateAuthorizer id and reads RestApiId from the ' +
        'properties; normalizeCcPhysicalId keeps the authorizer id, which the fixture ' +
        'observed equal to the live authorizer',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-7',
      normalizeCcPhysicalId: apiGatewayAuthorizerSdkPhysicalId,
    },
  ],
  [
    'AWS::ApiGateway::Stage',
    {
      // Admitted with AWS::ApiGateway::Authorizer (go-to-k/cdkd#6490, batch
      // 7). A stage keeps its name across a recreate, so the fixture
      // witnesses it by its createdDate.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores `<restApiId>|<stageName>` (the schema primaryIdentifier is ' +
        'RestApiId + StageName; measured us-east-1, 2026-11-17) while the API Gateway ' +
        'provider records the bare stage name and reads RestApiId from the properties; ' +
        'normalizeCcPhysicalId keeps the stage name, which the fixture observed equal to ' +
        'the live stage',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-7',
      normalizeCcPhysicalId: apiGatewayStageSdkPhysicalId,
    },
  ],
  [
    'AWS::ApiGateway::Method',
    {
      // Admitted with AWS::ApiGateway::Authorizer (go-to-k/cdkd#6490, batch
      // 7). A method has no AWS-minted id or creation time, so the fixture
      // witnesses it by a method response it adds out of band, which a
      // recreate deletes and an in-place update keeps.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store `<restApiId>|<resourceId>|<httpMethod>`: the Cloud Control ' +
        'Identifier takes that order (measured us-east-1, 2026-11-17; the committed schema ' +
        'fixture lists HttpMethod first) and the API Gateway provider packs the same three ' +
        'segments on PutMethod',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-7',
    },
  ],
  [
    'AWS::ApiGatewayV2::Stage',
    {
      // Batch 8 (go-to-k/cdkd#6490), admitted with the three API Gateway v2
      // children and the AppSync and S3 Vectors types below for the SDK path's
      // speed. A stage keeps its name across a recreate, so the fixture
      // witnesses it by its createdDate.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores `<apiId>|<stageName>` (measured us-east-1, 2026-11-17, for a ' +
        'named stage and `$default`) while the API Gateway v2 provider records the bare ' +
        'stage name and reads ApiId from the properties; normalizeCcPhysicalId keeps the ' +
        'stage name, which the fixture observed equal to the live stage',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-8',
      normalizeCcPhysicalId: apiGatewayV2StageSdkPhysicalId,
    },
  ],
  [
    'AWS::ApiGatewayV2::Integration',
    {
      // Batch 8 (go-to-k/cdkd#6490). The integration id is AWS-minted, so a
      // recreate changes it and the flip keeps it: the identity witness.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores `<apiId>|<integrationId>` (measured us-east-1, 2026-11-17) ' +
        'while the API Gateway v2 provider records the bare CreateIntegration id and reads ' +
        'ApiId from the properties; normalizeCcPhysicalId keeps the integration id, which ' +
        'the fixture observed equal to the live integration',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-8',
      normalizeCcPhysicalId: apiGatewayV2IntegrationSdkPhysicalId,
    },
  ],
  [
    'AWS::ApiGatewayV2::Route',
    {
      // Batch 8 (go-to-k/cdkd#6490). The route id is AWS-minted: the witness.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores `<apiId>|<routeId>` (measured us-east-1, 2026-11-17) while ' +
        'the API Gateway v2 provider records the bare CreateRoute id and reads ApiId from ' +
        'the properties; normalizeCcPhysicalId keeps the route id, which the fixture ' +
        'observed equal to the live route',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-8',
      normalizeCcPhysicalId: apiGatewayV2RouteSdkPhysicalId,
    },
  ],
  [
    'AWS::ApiGatewayV2::Authorizer',
    {
      // Batch 8 (go-to-k/cdkd#6490). The authorizer id is AWS-minted: the
      // witness. Its Cloud Control id puts the API id LAST, unlike its siblings.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores `<authorizerId>|<apiId>` (measured us-east-1, 2026-11-17; the ' +
        'live schema primaryIdentifier is AuthorizerId + ApiId, the reverse of the committed ' +
        'schema fixture) while the API Gateway v2 provider records the bare CreateAuthorizer ' +
        'id and reads ApiId from the properties; normalizeCcPhysicalId keeps the authorizer ' +
        'id, which the fixture observed equal to the live authorizer',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-8',
      normalizeCcPhysicalId: apiGatewayV2AuthorizerSdkPhysicalId,
    },
  ],
  [
    'AWS::AppSync::GraphQLApi',
    {
      // Batch 8 (go-to-k/cdkd#6490). The API id is AWS-minted: the witness.
      // `Ref` is the API ARN on both layers: the Cloud Control id itself, then
      // the recorded `Arn` attribute the flip carries over.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores the API ARN `arn:<partition>:appsync:<region>:<account>:apis/<apiId>` ' +
        '(schema primaryIdentifier Arn; measured us-east-1, 2026-11-17) while the AppSync ' +
        'provider records the bare CreateGraphqlApi apiId; normalizeCcPhysicalId keeps the ' +
        'apiId, which the fixture observed equal to the live API',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-8',
      normalizeCcPhysicalId: appSyncGraphQLApiSdkPhysicalId,
    },
  ],
  [
    'AWS::S3Vectors::VectorBucket',
    {
      // Batch 8 (go-to-k/cdkd#6490). A vector bucket keeps its name across a
      // recreate, so the fixture witnesses it by its creationTime. `Ref` is the
      // bucket ARN on both layers, as for the GraphQL API above.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores the bucket ARN `arn:<partition>:s3vectors:<region>:<account>:bucket/<name>` ' +
        '(schema primaryIdentifier VectorBucketArn; measured us-east-1, 2026-11-17) while the ' +
        'S3 Vectors provider records the bare bucket name; normalizeCcPhysicalId keeps the ' +
        'name, which the fixture observed equal to the live bucket',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-8',
      normalizeCcPhysicalId: s3VectorsVectorBucketSdkPhysicalId,
    },
  ],
  [
    'AWS::WAFv2::WebACL',
    {
      // Batch 10 (go-to-k/cdkd#6490), admitted with the CodeCommit repository
      // below for the SDK path's speed. The web ACL id is AWS-minted, so a
      // recreate changes it and the flip keeps it: the identity witness. The
      // SDK id is an ARN the Cloud Control id does not contain, so the
      // normalizer builds it from the record's region, account and partition.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores `<Name>|<Id>|<Scope>` (schema primaryIdentifier Name + Id + ' +
        'Scope, in that order; measured us-east-1, 2026-11-17, for REGIONAL and CLOUDFRONT) ' +
        'while the WAFv2 provider records the web ACL ARN; normalizeCcPhysicalId builds ' +
        '`arn:<partition>:wafv2:<region>:<account>:<regional|global>/webacl/<Name>/<Id>`, ' +
        'which the fixture observed equal to the live ARN',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-10',
      normalizeCcPhysicalId: wafv2WebAclSdkPhysicalId,
      normalizerReadsAccountId: true,
    },
  ],
  [
    'AWS::CodeCommit::Repository',
    {
      // Batch 10 (go-to-k/cdkd#6490). The repository id is AWS-minted: the
      // witness. The SDK id is the repository name, which the Cloud Control id
      // does not contain, so the normalizer reads the record's RepositoryName.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'Cloud Control stores the RepositoryId UUID (schema primaryIdentifier RepositoryId; ' +
        'measured us-east-1, 2026-11-17) while the CodeCommit provider records the ' +
        'repository name; normalizeCcPhysicalId takes the RepositoryName the record holds, ' +
        'which the fixture observed naming the repository of that id',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-10',
      normalizeCcPhysicalId: codeCommitRepositorySdkPhysicalId,
      // The name comes from the record, so a read checks it reaches this id.
      ccIdentityAttribute: 'RepositoryId',
    },
  ],
  [
    'AWS::CloudFront::Distribution',
    {
      // Batch 11 (go-to-k/cdkd#6490), admitted with the two RDS proxy types
      // below for the SDK path's speed. CloudFront mints the Id, so a recreate
      // changes it and the flip keeps it: the identity witness.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        "both layers store the bare distribution Id: Cloud Control's Identifier is the Id " +
        '(measured us-east-1, 2026-11-18; the schema primaryIdentifier) and the CloudFront ' +
        'Distribution provider records the CreateDistribution Id',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-cloudfront-distribution',
    },
  ],
  [
    'AWS::RDS::DBProxy',
    {
      // Batch 11 (go-to-k/cdkd#6490). A proxy keeps its name across a
      // recreate, so the fixture witnesses it by the `prx-...` resource id RDS
      // mints into its ARN.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        "both layers store the proxy name: Cloud Control's Identifier is the DBProxyName " +
        '(measured us-east-1, 2026-11-18; the schema primaryIdentifier) and the RDS DBProxy ' +
        'provider records the CreateDBProxy DBProxyName',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-11',
    },
  ],
  [
    'AWS::RDS::DBProxyEndpoint',
    {
      // Batch 11 (go-to-k/cdkd#6490). Witnessed like the proxy, by the
      // `prx-endpoint-...` resource id in its ARN.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        "both layers store the endpoint name: Cloud Control's Identifier is the " +
        'DBProxyEndpointName (measured us-east-1, 2026-11-18; the schema primaryIdentifier) ' +
        'and the RDS DBProxyEndpoint provider records the CreateDBProxyEndpoint DBProxyEndpointName',
      issue: 'https://github.com/go-to-k/cdkd/issues/6490',
      integFixture: 'cc-to-sdk-reroute-common-types-11',
    },
  ],
  [
    'AWS::Events::Archive',
    batch12('both layers store the ArchiveName (primaryIdentifier) CreateArchive takes'),
  ],
  [
    'AWS::Logs::DeliverySource',
    batch12('both layers store the Name (primaryIdentifier) PutDeliverySource takes'),
  ],
  [
    'AWS::Logs::DeliveryDestination',
    batch12('both layers store the Name (primaryIdentifier) PutDeliveryDestination takes'),
  ],
  [
    'AWS::Logs::Delivery',
    batch12('both layers store the DeliveryId (primaryIdentifier) CreateDelivery mints'),
  ],
  [
    'AWS::EC2::VPCEndpoint',
    {
      // Cloud Control only until its SDK provider (go-to-k/cdkd#6939), so an
      // endpoint deployed before then is recorded `cc-api`. The fixture's
      // witness is the endpoint's AWS-minted network interface id.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the bare `vpce-...` id: the schema primaryIdentifier is Id and ' +
        'EC2VPCEndpointProvider.create records the CreateVpcEndpoint VpcEndpointId',
      issue: 'https://github.com/go-to-k/cdkd/issues/6943',
      integFixture: 'cc-to-sdk-reroute-vpc-endpoint',
    },
  ],
]);
