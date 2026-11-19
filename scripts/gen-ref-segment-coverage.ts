/**
 * Codegen + CI critic: every compound-id type has a decided CloudFormation `Ref`.
 *
 * THE GAP THIS CLOSES (issue #6612)
 * ---------------------------------
 * A Cloud-Control-routed type whose schema `primaryIdentifier` has several
 * fields is recorded by cdkd under the field VALUES joined with `|`
 * (`<group>|<stream>`). CloudFormation's `Ref` often returns ONE of them, and
 * `cfnRefValueFromPhysicalId` (`src/deployment/intrinsic-resolver/ref-values.ts`)
 * maps those by hand: the `REF_RETURNS_SEGMENT_*` sets plus a few per-type
 * cases. A type missing from them makes `Ref` return the whole joined id
 * SILENTLY — AWS often accepts it, and the consumer points at nothing (#6293:
 * an SSM maintenance window task ran against no target). Nothing checked for a
 * type that SHOULD be mapped and is not; this critic does.
 *
 * THE UNIVERSE
 * ------------
 * - Every Tier 1 (SDK provider) or Tier 2 (Cloud Control) type of
 *   `docs/_generated/provider-coverage.json` whose `primaryIdentifier` has more
 *   than one field. Tier 2 always routes through Cloud Control; a Tier 1 type
 *   does when its template sets an SDK-unwired property (the #614 rule), and
 *   then stores the same joined id. Tier 3 is refused pre-flight.
 * - Plus {@link SDK_COMPOUND_ID_TYPES}: SDK providers that pack a `|`-joined
 *   physical id of their OWN (`packCompositeId`) for a type whose schema
 *   identifier is a single field, so the schema alone cannot name them.
 *
 * The identifiers come from `tests/fixtures/cfn-primary-identifiers.json`, an
 * ORDERED snapshot (segment order is the whole point) captured from AWS's
 * public schema bundle by `--refresh-identifiers`. The per-type
 * `tests/fixtures/cfn-schemas/` fixtures cannot serve: they exist for SDK types
 * only, and they store the identifier SORTED.
 *
 * CLASSIFICATION (per type in the universe)
 * -----------------------------------------
 * - mapped        — `ref-values.ts` names the type in a `REF_RETURNS_*` table,
 *                   `ref-values/type-refs.ts` in `REF_FROM_PHYSICAL_ID_HELPERS`,
 *                   or a `resourceType === '<type>'` case of
 *                   `cfnRefValueFromPhysicalId`.
 * - compound      — CloudFormation's `Ref` IS the joined id too (docs give the
 *                   `a|b` format, or it was measured).
 * - no-ref        — the type's docs page documents no `Ref` at all.
 * - not-a-segment — `Ref` returns a value no segment holds (a generated id, an
 *                   ARN outside the identifier), so no segment table can fix it.
 * - unverified    — the docs are unclear or wrong-looking and the value was not
 *                   measured (account-closed service, quota, cost). `Ref` keeps
 *                   returning the joined id, which is what measured Cloud
 *                   Control-native types return (#6612 probes).
 * - gap           — none of the above. FAILS `--check`.
 *
 * A disposition is a CLAIM about CloudFormation and carries its source. A
 * mapping is added only after verification: a wrong segment is as silent as a
 * missing one.
 *
 * `--check` also fails on a disposition for a type that is mapped or outside
 * the universe (stale), and on a Tier 1 / Tier 2 type the identifier snapshot
 * does not cover (refresh it).
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-ref-segment-coverage.ts                        # write the matrix
 *   node --experimental-strip-types scripts/gen-ref-segment-coverage.ts --check                # fail on a gap
 *   node --experimental-strip-types scripts/gen-ref-segment-coverage.ts --refresh-identifiers  # re-capture the snapshot (network)
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeCell } from './markdown-table.ts';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
const REF_VALUES_FILE = resolve(repoRoot, 'src/deployment/intrinsic-resolver/ref-values.ts');
const TYPE_REFS_FILE = resolve(repoRoot, 'src/deployment/intrinsic-resolver/ref-values/type-refs.ts');
const PROVIDER_COVERAGE_FILE = resolve(repoRoot, 'docs/_generated/provider-coverage.json');
export const IDENTIFIERS_FILE = resolve(repoRoot, 'tests/fixtures/cfn-primary-identifiers.json');
const OUT_JSON = resolve(repoRoot, 'docs/_generated/ref-segment-coverage.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/ref-segment-coverage.md');
const PUBLIC_SCHEMA_ZIP_URL =
  'https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip';

/**
 * SDK providers that store a `|`-joined physical id of their own for a type
 * whose schema `primaryIdentifier` is ONE field (the `packCompositeId` writers
 * and `Route53Provider`'s record-set group). Multi-field types need no entry:
 * the schema already brings them in.
 */
export const SDK_COMPOUND_ID_TYPES: readonly string[] = [
  'AWS::AppSync::DataSource', // `<apiId>|<name>`
  'AWS::AppSync::Resolver', // `<apiId>|<typeName>|<fieldName>`
  'AWS::EC2::NetworkAclEntry', // `<aclId>|<ruleNumber>|<egress>`
  'AWS::EC2::SecurityGroupIngress', // `<groupId>|<protocol>|<from>|<to>`
  'AWS::Route53::RecordSetGroup', // `<hostedZoneId>|<groupName>`
  'AWS::S3Tables::Table', // `<tableBucketARN>|<namespace>|<name>`
];

export type DispositionKind = 'compound' | 'no-ref' | 'not-a-segment' | 'unverified';

export interface Disposition {
  readonly kind: DispositionKind;
  /** Where the claim comes from: the docs' wording, or a measurement. */
  readonly source: string;
}

const PROBE = 'measured, CloudFormation stack cdkd-probe-6612 (us-east-1, 2026-11-19)';
const docs = (quote: string): string => `docs Return values: Ref returns ${quote}`;
const NO_RETURN_VALUES = 'docs: the page has no Return values section';
const NO_REF_ENTRY = 'docs: Return values documents Fn::GetAtt only, no Ref';
const EMPTY_REF = 'docs: Return values has a Ref heading with no text';

const d = (kind: DispositionKind, source: string): Disposition => ({ kind, source });
const compound = (source: string): Disposition => d('compound', source);
const noRef = (source: string): Disposition => d('no-ref', source);
const notASegment = (source: string): Disposition => d('not-a-segment', source);
const unverified = (source: string): Disposition => d('unverified', source);

/**
 * The recorded `Ref` of every compound-id type cdkd does NOT map. Checked
 * against the docs page of each type ("Return values"), measured where the
 * docs were unclear (issue #6612). A docs claim of a single segment for a type
 * Cloud Control serves natively was NOT trusted on its own: three such claims
 * measured as the joined id (S3Tables::Namespace #6243,
 * EC2::TransitGatewayMulticastDomainAssociation and Cognito::ManagedLoginBranding
 * #6612), so an unmeasured one stays `unverified`.
 */
export const REF_SEGMENT_DISPOSITIONS: ReadonlyMap<string, Disposition> = new Map<
  string,
  Disposition
>([
  // ---- compound: CloudFormation's Ref is the joined id ----
  ['AWS::ApiGateway::Method', compound('measured, issue #6243')],
  ['AWS::AppStream::ApplicationEntitlementAssociation', compound(docs('`StackName|EntitlementName|ApplicationIdentifier`'))],
  ['AWS::AppStream::ApplicationFleetAssociation', compound(docs('`FleetName|ApplicationArn`'))],
  ['AWS::AppStream::Entitlement', compound(docs('`StackName|Name`'))],
  ['AWS::ApplicationAutoScaling::ScalableTarget', compound(`${PROBE}: \`<ResourceId>|<ScalableDimension>|<ServiceNamespace>\``)],
  ['AWS::Athena::PreparedStatement', compound(`${PROBE}: \`<StatementName>|<WorkGroup>\` (the docs say the statement name)`)],
  ['AWS::EC2::SubnetCidrReservation', compound(`${PROBE}: \`<SubnetId>|<SubnetCidrReservationId>\``)],
  ['AWS::EC2::VPCDHCPOptionsAssociation', compound(`${PROBE}: \`<DhcpOptionsId>|<VpcId>\``)],
  ['AWS::Events::EventBusPolicy', compound(`${PROBE}: \`<EventBusName>|<StatementId>\` (the docs show a generated id)`)],
  ['AWS::IAM::GroupPolicy', compound(`${PROBE}: \`<PolicyName>|<GroupName>\``)],
  ['AWS::IAM::RolePolicy', compound(`${PROBE}: \`<PolicyName>|<RoleName>\``)],
  ['AWS::IAM::UserPolicy', compound(`${PROBE}: \`<PolicyName>|<UserName>\``)],
  ['AWS::OpenSearchServerless::AccessPolicy', compound(`${PROBE}: \`<Type>|<Name>\` (the docs say the policy name)`)],
  ['AWS::OpenSearchServerless::SecurityPolicy', compound(`${PROBE}: \`<Type>|<Name>\` (the docs say the policy name)`)],
  ['AWS::ServiceCatalog::PortfolioPrincipalAssociation', compound(`${PROBE}: \`<PortfolioId>|<PrincipalARN>\``)],
  ['AWS::ServiceCatalog::TagOptionAssociation', compound(`${PROBE}: \`<TagOptionId>|<ResourceId>\``)],
  ['AWS::VerifiedPermissions::IdentitySource', compound(`${PROBE}: \`<IdentitySourceId>|<PolicyStoreId>\` (the docs say the identity source id)`)],
  ['AWS::VerifiedPermissions::Policy', compound(`${PROBE}: \`<PolicyId>|<PolicyStoreId>\` (the docs say the policy id)`)],
  ['AWS::Bedrock::AgentAlias', compound(docs('`AGENT12345|ALIAS12345`'))],
  ['AWS::Bedrock::DataSource', compound(docs('`KB12345678|DS12345678`'))],
  ['AWS::Bedrock::FlowAlias', compound(docs('`<flowArn>|<aliasArn>`'))],
  ['AWS::Bedrock::FlowVersion', compound(docs('`<flowArn>|<version>`'))],
  ['AWS::Bedrock::GuardrailVersion', compound(docs('`guardrail-id|guardrail-version`'))],
  ['AWS::BedrockAgentCore::GatewayTarget', compound(docs('`my-gateway-a1b2c3d4e5|a1B2c3D4e5`'))],
  ['AWS::Cassandra::Table', compound(docs('`myKeyspace|myTable`'))],
  ['AWS::Cassandra::Type', compound(docs('`myKeyspace|myType`'))],
  ['AWS::CleanRooms::ConfiguredTableAssociation', compound(docs('`<associationId>|<membershipId>`'))],
  ['AWS::Cognito::IdentityPoolPrincipalTag', compound(docs('`<identityPoolId>|graph.facebook.com`'))],
  ['AWS::Cognito::ManagedLoginBranding', compound(`${PROBE}: \`<UserPoolId>|<ManagedLoginBrandingId>\` (the docs say the style id)`)],
  ['AWS::Connect::DataLakeAssociation', compound(docs('`InstanceId|DataSetId|TargetAccountId`'))],
  ['AWS::ControlTower::EnabledControl', compound(docs('`target|control`'))],
  ['AWS::CustomerProfiles::Integration', compound(docs('"the DomainName and the Uri of the integration"'))],
  ['AWS::CustomerProfiles::ObjectType', compound(docs('"the DomainName and the ObjectTypeName of the object type"'))],
  ['AWS::DataZone::Connection', compound(docs('`DomainId|ConnectionId`'))],
  ['AWS::DataZone::DataSource', compound(docs('`DomainId|DataSourceId`'))],
  ['AWS::DataZone::DomainUnit', compound(docs('`DomainId|DomainUnitId`'))],
  ['AWS::DataZone::Environment', compound(docs('`DomainId|EnvironmentId`'))],
  ['AWS::DataZone::EnvironmentBlueprintConfiguration', compound(docs('`DomainId|EnvironmentBlueprintId`'))],
  ['AWS::DataZone::EnvironmentProfile', compound(docs('`DomainId|EnvironmentProfileId`'))],
  ['AWS::DataZone::FormType', compound(docs('`DomainIdentifier|FormTypeIdentifier`'))],
  ['AWS::DataZone::GroupProfile', compound(docs('`DomainId|GroupProfileId`'))],
  ['AWS::DataZone::Owner', compound(docs('`DomainId|EntityType|EntityId|OwnerType|OwnerId`'))],
  ['AWS::DataZone::Project', compound(docs('`DomainId|ProjectId`'))],
  ['AWS::DataZone::ProjectMembership', compound(docs('`DomainId|MemberId|MemberType|ProjectId`'))],
  ['AWS::DataZone::ProjectProfile', compound(docs('a pipe-separated domain id and identifier (text copied from DomainUnit)'))],
  ['AWS::DataZone::SubscriptionTarget', compound(docs('`DomainId|EnvironmentId|SubscriptionTargetId`'))],
  ['AWS::DataZone::UserProfile', compound(docs('`DomainId|UserProfileId`'))],
  ['AWS::Detective::MemberInvitation', compound(docs('"the ARN of the behavior graph and the member account identifier, separated by a pipe"'))],
  ['AWS::DevOpsAgent::Asset', compound(docs('`as-1234567890abcdef0|asset-0987654321fedcba0`'))],
  ['AWS::EC2::IPAMAllocation', compound(docs('"the pool ID, allocation ID, and CIDR joined with |"'))],
  ['AWS::EC2::IPAMPoolCidr', compound(docs('`ipam-pool-01123456|ipam-pool-cidr-0123456`'))],
  ['AWS::EC2::NetworkPerformanceMetricSubscription', compound(docs('`source|destination|metric|statistic`'))],
  ['AWS::EC2::Route', compound('measured, issue #6243')],
  ['AWS::EC2::RouteServerAssociation', compound(docs('"the route server ID and VPC ID separated by the pipe symbol"'))],
  ['AWS::EC2::RouteServerPropagation', compound(docs('"the route server ID and route table ID separated by the pipe symbol"'))],
  ['AWS::EC2::SecurityGroupVpcAssociation', compound(docs('`sg-id|vpc-id`'))],
  ['AWS::EC2::TransitGatewayMulticastDomainAssociation', compound(`${PROBE}: \`<DomainId>|<AttachmentId>|<SubnetId>\` (the docs say the domain id)`)],
  ['AWS::EC2::TransitGatewayMulticastGroupMember', compound(`${PROBE}: \`<DomainId>|<GroupIpAddress>|<NetworkInterfaceId>\``)],
  ['AWS::EC2::TransitGatewayMulticastGroupSource', compound(`${PROBE}: \`<DomainId>|<GroupIpAddress>|<NetworkInterfaceId>\``)],
  ['AWS::EC2::TransitGatewayRoute', compound(`${PROBE}: \`<RouteTableId>|<DestinationCidrBlock>\``)],
  ['AWS::EC2::TransitGatewayRouteTableAssociation', compound(`${PROBE}: \`<RouteTableId>|<AttachmentId>\``)],
  ['AWS::EKS::Addon', compound(docs('`cluster-name|vpc-cni`'))],
  ['AWS::IdentityStore::Group', compound(docs('`GroupID|IdentityStoreId`'))],
  ['AWS::IdentityStore::GroupMembership', compound(docs('`GroupMembershipID|IdentityStoreId`'))],
  ['AWS::IoT::SoftwarePackageVersion', compound(docs('`package-name|version-name`'))],
  ['AWS::IoTTwinMaker::ComponentType', compound(docs('"the workspace Id and the ComponentType Id"'))],
  ['AWS::IoTTwinMaker::Entity', compound(docs('"the workspace Id and the entity Id"'))],
  ['AWS::IoTTwinMaker::Scene', compound(docs('"the workspace ID and the scene ID"'))],
  ['AWS::IoTTwinMaker::SyncJob', compound(docs('"the workspace Id and the entity Id"'))],
  ['AWS::Kendra::DataSource', compound(docs('`<data source ID>|<index ID>`'))],
  ['AWS::Kendra::Faq', compound(docs('`<faq-id>|<index-id>`'))],
  ['AWS::LakeFormation::DataCellsFilter', compound(docs('`123456789012|ExampleDbName|ExampleTableName|ExampleFilter`'))],
  ['AWS::LakeFormation::PrincipalPermissions', compound(docs('`<principal>|<resource>`'))],
  ['AWS::LakeFormation::TagAssociation', compound(docs('"a combination of the ResourceIdentifier and TagsIdentifier seperated with a pipe"'))],
  ['AWS::Lambda::EventInvokeConfig', compound('measured, issue #6243')],
  ['AWS::MediaConnect::BridgeOutput', compound(docs('`<bridgeArn>|<name>`'))],
  ['AWS::MediaConnect::BridgeSource', compound(docs('`<bridgeArn>|<name>`'))],
  ['AWS::MediaConnect::FlowVpcInterface', compound(docs('`<flowArn>|<name>`'))],
  ['AWS::NetworkManager::CustomerGatewayAssociation', compound(docs('`global-network-…|<customerGatewayArn>`'))],
  ['AWS::NetworkManager::Device', compound(docs('`global-network-…|device-…`'))],
  ['AWS::NetworkManager::Link', compound(docs('`global-network-…|link-…`'))],
  ['AWS::NetworkManager::LinkAssociation', compound(docs('`global-network-…|device-…|link-…`'))],
  ['AWS::NetworkManager::Site', compound(docs('`global-network-…|site-…`'))],
  ['AWS::NetworkManager::TransitGatewayRegistration', compound(docs('`global-network-…|<transitGatewayArn>`'))],
  ['AWS::OpenSearchServerless::Index', compound(docs('`index name|endpoint`'))],
  ['AWS::OpenSearchServerless::LifecyclePolicy', compound(`${PROBE}: \`<Type>|<Name>\``)],
  ['AWS::QBusiness::DataAccessor', compound(docs('`ApplicationId|DataAccessorId`'))],
  ['AWS::QBusiness::DataSource', compound(docs('`ApplicationId|DataSourceId|IndexId`'))],
  ['AWS::QBusiness::Index', compound(docs('`ApplicationId|IndexId`'))],
  ['AWS::QBusiness::Permission', compound(docs('`ApplicationId|StatementId`'))],
  ['AWS::QBusiness::Plugin', compound(docs('`ApplicationId|PluginId`'))],
  ['AWS::QBusiness::Retriever', compound(docs('`ApplicationId|RetrieverId`'))],
  ['AWS::QBusiness::WebExperience', compound(docs('`ApplicationId|WebExperienceId`'))],
  ['AWS::RAM::PermissionAssociation', compound(docs('`resource-share-arn|permission-arn`'))],
  ['AWS::RAM::PrincipalAssociation', compound(docs('`resource-share-arn|principal`'))],
  ['AWS::RAM::ResourceAssociation', compound(docs('`resource-share-arn|resource-arn`'))],
  ['AWS::RAM::SourceAssociation', compound(docs('`resource-share-arn|source-id`'))],
  ['AWS::RefactorSpaces::Application', compound(docs('`<EnvironmentId>|<ApplicationId>`'))],
  ['AWS::RefactorSpaces::Route', compound(docs('`<EnvironmentId>|<ApplicationId>|<RouteId>`'))],
  ['AWS::RefactorSpaces::Service', compound(docs('`<EnvironmentId>|<ApplicationId>|<ServiceId>`'))],
  ['AWS::Route53::KeySigningKey', compound(docs('`Z00001111A1ABCaaABC11|KSK1`'))],
  ['AWS::Route53::RecordSetProtection', compound(docs('"the HostedZoneId, RecordName, and RecordType values, separated by a pipe"'))],
  ['AWS::SMSVOICE::SenderId', compound(docs('`IsoCountryCode|SenderId`'))],
  ['AWS::SSO::ApplicationAssignment', compound(docs('"a generated ID, combined by all fields with the delimiter |"'))],
  ['AWS::SSO::Assignment', compound(docs('"a generated ID, combined by all fields with the delimiter |"'))],
  ['AWS::SageMaker::App', compound(docs('"the app type, app name, Domain ID, and user profile name"'))],
  ['AWS::SageMaker::Space', compound(docs('"the ID of the domain that the space is associated with and the name of the space"'))],
  ['AWS::SageMaker::UserProfile', compound(docs('"the Domain ID and the user profile name"'))],
  ['AWS::SecurityAgent::Pentest', compound(docs('`pt-…|<agentSpaceId>`'))],
  ['AWS::Signer::ProfilePermission', compound(docs('`StatementId|ProfileName`'))],
  ['AWS::Timestream::Table', compound(docs('`DATABASE_NAME|TABLE_NAME`'))],
  ['AWS::VerifiedPermissions::PolicyTemplate', compound(docs('`POLICYSTOREabcde111111|POLICYTEMPLAT…`'))],
  ['AWS::WAFv2::IPSet', compound(docs('`name|id|scope`'))],
  ['AWS::WAFv2::RegexPatternSet', compound(docs('`name|id|scope`'))],
  ['AWS::WAFv2::RuleGroup', compound(docs('`name|id|scope`'))],

  // ---- no-ref: the docs document no Ref value ----
  ['AWS::ACMPCA::Certificate', noRef(docs('nothing usable: "This reference should not be used in CloudFormation templates"'))],
  ['AWS::ACMPCA::Permission', noRef(NO_RETURN_VALUES)],
  ['AWS::AmplifyUIBuilder::Component', noRef(NO_REF_ENTRY)],
  ['AWS::AmplifyUIBuilder::Form', noRef(NO_REF_ENTRY)],
  ['AWS::AmplifyUIBuilder::Theme', noRef(NO_REF_ENTRY)],
  ['AWS::ApiGateway::BasePathMapping', noRef(NO_RETURN_VALUES)],
  ['AWS::ApiGateway::DocumentationVersion', noRef(NO_RETURN_VALUES)],
  ['AWS::AppStream::StackFleetAssociation', noRef(NO_RETURN_VALUES)],
  ['AWS::AppStream::StackUserAssociation', noRef(NO_RETURN_VALUES)],
  ['AWS::AppStream::User', noRef(NO_RETURN_VALUES)],
  ['AWS::Budgets::BudgetsAction', noRef(NO_REF_ENTRY)],
  ['AWS::Chime::Channel', noRef(NO_RETURN_VALUES)],
  ['AWS::EC2::SecurityGroupIngress', noRef('docs: no Ref (2026-08-12 audit, issue #1667)')],
  ['AWS::EC2::VolumeAttachment', noRef(NO_RETURN_VALUES)],
  ['AWS::EMR::StudioSessionMapping', noRef(NO_RETURN_VALUES)],
  ['AWS::EntityResolution::PolicyStatement', noRef(NO_RETURN_VALUES)],
  ['AWS::IoT::PolicyPrincipalAttachment', noRef(NO_RETURN_VALUES)],
  ['AWS::IoT::ThingPrincipalAttachment', noRef(NO_RETURN_VALUES)],
  ['AWS::Lambda::Permission', noRef(NO_RETURN_VALUES)],
  ['AWS::Lex::BotAlias', noRef(NO_REF_ENTRY)],
  ['AWS::Lex::BotVersion', noRef(NO_REF_ENTRY)],
  ['AWS::LicenseManagerUserSubscriptions::LicenseServerEndpoint', noRef(NO_RETURN_VALUES)],
  ['AWS::Logs::AccountPolicy', noRef(NO_REF_ENTRY)],
  ['AWS::Logs::MetricFilter', noRef(NO_RETURN_VALUES)],
  ['AWS::NetworkMonitor::Probe', noRef(NO_RETURN_VALUES)],
  ['AWS::PCAConnectorAD::ServicePrincipalName', noRef(NO_RETURN_VALUES)],
  ['AWS::PCAConnectorAD::TemplateGroupAccessControlEntry', noRef(NO_RETURN_VALUES)],
  ['AWS::Panorama::PackageVersion', noRef(NO_RETURN_VALUES)],
  ['AWS::QLDB::Stream', noRef(NO_RETURN_VALUES)],
  ['AWS::QuickSight::Analysis', noRef(NO_REF_ENTRY)],
  ['AWS::QuickSight::Dashboard', noRef(NO_REF_ENTRY)],
  ['AWS::QuickSight::DataSet', noRef(NO_REF_ENTRY)],
  ['AWS::QuickSight::DataSource', noRef(NO_REF_ENTRY)],
  ['AWS::QuickSight::Template', noRef(NO_REF_ENTRY)],
  ['AWS::QuickSight::Theme', noRef(NO_REF_ENTRY)],
  ['AWS::QuickSight::VPCConnection', noRef(NO_REF_ENTRY)],
  ['AWS::Redshift::EndpointAuthorization', noRef(NO_REF_ENTRY)],
  ['AWS::SES::ConfigurationSetEventDestination', noRef(NO_REF_ENTRY)],
  ['AWS::SupportApp::SlackChannelConfiguration', noRef(NO_RETURN_VALUES)],
  ['AWS::WorkspacesInstances::VolumeAssociation', noRef(NO_RETURN_VALUES)],

  // ---- not-a-segment: Ref returns a value no segment of the id holds ----
  ['AWS::AutoScalingPlans::ScalingPlan', notASegment(docs('the scaling plan ARN'))],
  ['AWS::CodePipeline::CustomActionType', notASegment(docs('a generated name such as `custo-MyCus-A1BCDEFGHIJ2`'))],
  ['AWS::Cognito::UserPoolRiskConfigurationAttachment', notASegment(docs('`UserPoolRiskConfigurationAttachment-<UserPoolId>-<ClientId>`'))],
  ['AWS::Cognito::UserPoolUICustomizationAttachment', notASegment(docs('`UserPoolUICustomizationAttachment-<UserPoolId>-<ClientId>`'))],
  ['AWS::Cognito::UserPoolUserToGroupAttachment', notASegment(docs('a generated id such as `UserToGroupAttachment-YejJvzrEXAMPLE`'))],
  ['AWS::Config::AggregationAuthorization', notASegment(docs('the aggregation authorization ARN'))],

  // ---- unverified: docs unclear, value not measured ----
  ['AWS::ARCZonalShift::AutoshiftObserverNotificationStatus', unverified(EMPTY_REF)],
  ['AWS::AccountAccess::Entitlement', unverified(docs('"the unique identifier of the entitlement"'))],
  ['AWS::AppConfig::ExperimentDefinition', unverified(EMPTY_REF)],
  ['AWS::AppConfig::ExperimentRun', unverified(EMPTY_REF)],
  ['AWS::ApplicationSignals::InstrumentationConfig', unverified(EMPTY_REF)],
  ['AWS::Backup::RestoreTestingSelection', unverified(EMPTY_REF)],
  ['AWS::Bedrock::AutomatedReasoningPolicyVersion', unverified(docs('"the policy version ID"'))],
  ['AWS::BedrockAgentCore::GatewayRateLimit', unverified(EMPTY_REF)],
  ['AWS::BedrockAgentCore::GatewayRule', unverified(EMPTY_REF)],
  ['AWS::CleanRooms::AnalysisTemplate', unverified(docs('the AnalysisTemplateIdentifier (a Cloud Control-native type; not measured)'))],
  ['AWS::CleanRooms::IdMappingTable', unverified(docs('"the resource name"'))],
  ['AWS::CleanRooms::IdNamespaceAssociation', unverified(docs('"the resource name"'))],
  ['AWS::CleanRooms::IntermediateTable', unverified(EMPTY_REF)],
  ['AWS::CleanRooms::PrivacyBudgetTemplate', unverified(docs('the ARN (no segment holds it; not measured)'))],
  ['AWS::CloudWatch::AccessProfile', unverified(docs('"a unique identifier for this resource"'))],
  ['AWS::CloudWatch::Alert', unverified(docs('"a unique identifier for this resource"'))],
  ['AWS::CloudWatch::OmniDashboard', unverified(docs('"a unique identifier for this resource"'))],
  ['AWS::CodeStarConnections::SyncConfiguration', unverified(docs('the ARN (no segment holds it; not measured)'))],
  ['AWS::Cognito::Terms', unverified(EMPTY_REF)],
  ['AWS::Cognito::UserPoolClientSessionConfigurationAttachment', unverified(EMPTY_REF)],
  ['AWS::Cognito::UserPoolReplica', unverified(EMPTY_REF)],
  ['AWS::Connect::ApprovedOrigin', unverified(EMPTY_REF)],
  ['AWS::Connect::DataTable', unverified(EMPTY_REF)],
  ['AWS::Connect::DataTableAttribute', unverified(EMPTY_REF)],
  ['AWS::Connect::DataTableRecord', unverified(EMPTY_REF)],
  ['AWS::Connect::InstanceStorageConfig', unverified(docs('"the name of the instance storage configuration"'))],
  ['AWS::Connect::IntegrationAssociation', unverified(EMPTY_REF)],
  ['AWS::Connect::PredefinedAttribute', unverified(docs('"the predefined attribute"'))],
  ['AWS::Connect::SecurityKey', unverified(EMPTY_REF)],
  ['AWS::Connect::UseCase', unverified(EMPTY_REF)],
  ['AWS::CustomerProfiles::CalculatedAttributeDefinition', unverified(EMPTY_REF)],
  ['AWS::CustomerProfiles::DomainObjectType', unverified(EMPTY_REF)],
  ['AWS::CustomerProfiles::EventStream', unverified(EMPTY_REF)],
  ['AWS::CustomerProfiles::EventTrigger', unverified(EMPTY_REF)],
  ['AWS::CustomerProfiles::Recommender', unverified(EMPTY_REF)],
  ['AWS::CustomerProfiles::SegmentDefinition', unverified(EMPTY_REF)],
  ['AWS::DataZone::EnvironmentActions', unverified(docs('a two-part `DomainId|EnvironmentActionId` for a three-part identifier'))],
  ['AWS::DataZone::PolicyGrant', unverified(EMPTY_REF)],
  ['AWS::Deadline::Limit', unverified(docs('"the unique identifier of the limit"'))],
  ['AWS::Deadline::QueueEnvironment', unverified(docs('"a reference to a queue environment object"'))],
  ['AWS::Deadline::QueueFleetAssociation', unverified(docs('an ARN, which the type does not have'))],
  ['AWS::Deadline::QueueLimitAssociation', unverified(docs('"the unique identifier for the queue-limit association"'))],
  ['AWS::Deadline::StorageProfile', unverified(docs('an ARN, which the type does not have'))],
  ['AWS::DevOpsAgent::Association', unverified(docs('"the association ID" (a Cloud Control-native type; not measured)'))],
  ['AWS::DevOpsAgent::Trigger', unverified(docs('"the TriggerId" (a Cloud Control-native type; not measured)'))],
  ['AWS::EC2::ClientVpnTargetNetworkAssociation', unverified(docs('the association id `cvpn-assoc-…`; not measured (needs an imported ACM certificate)'))],
  ['AWS::EC2::EnclaveCertificateIamRoleAssociation', unverified(docs('"the IAM role and ACM certificate association"'))],
  ['AWS::EC2::LocalGatewayRoute', unverified(docs('`lgw-rtb-…|10.0.0.0/24`, the REVERSE of the identifier order; needs an Outpost'))],
  ['AWS::EC2::NetworkAclEntry', unverified(docs('"the ID of the network ACL entry" (2026-08-12 audit, issue #1667; not measured)'))],
  ['AWS::EC2::TransitGatewayMeteringPolicyEntry', unverified(EMPTY_REF)],
  ['AWS::EC2::TransitGatewayPolicyTableAssociation', unverified(EMPTY_REF)],
  ['AWS::EC2::TransitGatewayPolicyTableEntry', unverified(EMPTY_REF)],
  ['AWS::EC2::VPNConnectionRoute', unverified(docs('"the ID of the VPN connection route"'))],
  ['AWS::ECS::GatewayClusterAssociations', unverified(EMPTY_REF)],
  ['AWS::ECS::PrimaryTaskSet', unverified(docs('"the resource name"'))],
  ['AWS::ECS::TaskSet', unverified(docs('"the resource name"'))],
  ['AWS::EKS::AccessEntry', unverified(docs('"the resource name", with the principal ARN as the example'))],
  ['AWS::EKS::CertificateAuthority', unverified(EMPTY_REF)],
  ['AWS::EKS::FargateProfile', unverified(docs('`<cluster-name>/<Fargate_profile_name>`, slash-joined; not measured'))],
  ['AWS::EKS::IdentityProviderConfig', unverified(docs('`cluster-name/oidc/identity-provider-config-name`, slash-joined; not measured'))],
  ['AWS::ElasticLoadBalancingV2::TrustStoreRevocation', unverified(docs('"the ARN of the trust store"; not measured (needs CA bundle objects)'))],
  ['AWS::FIS::TargetAccountConfiguration', unverified(EMPTY_REF)],
  ['AWS::Glue::Integration', unverified(EMPTY_REF)],
  ['AWS::Glue::IntegrationResourceProperty', unverified(docs('"The resource property arn" (a Cloud Control-native type; not measured)'))],
  ['AWS::Glue::Partition', unverified(docs('"the partition name", which no identifier field holds'))],
  ['AWS::Glue::SchemaVersionMetadata', unverified(EMPTY_REF)],
  ['AWS::Glue::TableOptimizer', unverified(EMPTY_REF)],
  ['AWS::GroundStation::MissionProfile', unverified(docs('the mission profile ARN (a Cloud Control-native type; not measured)'))],
  ['AWS::GuardDuty::CustomDetectionRuleAssociation', unverified(EMPTY_REF)],
  ['AWS::GuardDuty::PublishingDestination', unverified(docs('"the resource publishing destination ID"; not measured (needs a bucket and key policy)'))],
  ['AWS::GuardDuty::ThreatEntitySet', unverified(docs('"the unique ID associated with the newly created threat entity set"; not measured'))],
  ['AWS::GuardDuty::TrustedEntitySet', unverified(docs('"the unique ID of the TrustedEntitySet"; not measured'))],
  ['AWS::Lightsail::LoadBalancerTlsCertificate', unverified(docs('"a unique identifier for this resource"'))],
  ['AWS::Location::TrackerConsumer', unverified(docs('"the TrackerConsumer name"'))],
  ['AWS::MediaLive::ChannelPlacementGroup', unverified(EMPTY_REF)],
  ['AWS::MediaLive::Multiplexprogram', unverified(EMPTY_REF)],
  ['AWS::MediaPackageV2::ChannelPolicy', unverified(docs('`ChannelGroupName / ChannelName`; the probe was refused by the service'))],
  ['AWS::MediaPackageV2::OriginEndpointPolicy', unverified(docs('`ChannelGroupName / ChannelName / OriginEndpointName`; not measured'))],
  ['AWS::MediaTailor::LiveSource', unverified(EMPTY_REF)],
  ['AWS::MediaTailor::VodSource', unverified(EMPTY_REF)],
  ['AWS::NetworkManager::ContextStoreAssociation', unverified(EMPTY_REF)],
  ['AWS::NetworkManager::CoreNetworkPrefixListAssociation', unverified(EMPTY_REF)],
  ['AWS::Notifications::ChannelAssociation', unverified(docs('"the ARN of the configuration created"'))],
  ['AWS::Notifications::ManagedNotificationAccountContactAssociation', unverified(docs('"the ARN of the configuration created"'))],
  ['AWS::Notifications::ManagedNotificationAdditionalChannelAssociation', unverified(docs('"the ARN of the configuration created"'))],
  ['AWS::Notifications::OrganizationalUnitAssociation', unverified(EMPTY_REF)],
  ['AWS::OpenSearchServerless::CollectionIndex', unverified(EMPTY_REF)],
  ['AWS::QuickSight::ActionConnector', unverified(EMPTY_REF)],
  ['AWS::QuickSight::Agent', unverified(EMPTY_REF)],
  ['AWS::QuickSight::CustomPermissions', unverified(EMPTY_REF)],
  ['AWS::QuickSight::DLPSetting', unverified(EMPTY_REF)],
  ['AWS::QuickSight::Folder', unverified(EMPTY_REF)],
  ['AWS::QuickSight::KnowledgeBase', unverified(EMPTY_REF)],
  ['AWS::QuickSight::LimitsProfile', unverified(EMPTY_REF)],
  ['AWS::QuickSight::RefreshSchedule', unverified(EMPTY_REF)],
  ['AWS::QuickSight::Space', unverified(EMPTY_REF)],
  ['AWS::QuickSight::Topic', unverified(EMPTY_REF)],
  ['AWS::QuickSight::TopicV2', unverified(EMPTY_REF)],
  ['AWS::RDS::CustomDBEngineVersion', unverified(docs('"the resource name, such as mystack-abc1d2efg3h4"'))],
  ['AWS::ResilienceHubV2::ServiceFunction', unverified(EMPTY_REF)],
  ['AWS::ResilienceHubV2::UserJourney', unverified(EMPTY_REF)],
  ['AWS::SES::EmailIdentityCertificate', unverified(EMPTY_REF)],
  ['AWS::SSM::ResourcePolicy', unverified(EMPTY_REF)],
  ['AWS::SSO::PermissionSet', unverified(docs('`permission-arn|sso-instance-arn`, the REVERSE of the identifier order; needs an Identity Center instance'))],
  ['AWS::SecurityLake::AwsLogSource', unverified(docs('the source name such as `VPC_FLOW`; not measured (needs a data lake)'))],
  ['AWS::ServiceCatalog::PortfolioProductAssociation', unverified(docs('"a unique identifier for the association"'))],
  ['AWS::ServiceCatalog::PortfolioShare', unverified(docs('"the identifier of the portfolio share"; needs a second account'))],
  ['AWS::ServiceCatalog::ServiceActionAssociation', unverified(EMPTY_REF)],
  ['AWS::ServiceCatalogAppRegistry::AttributeGroupAssociation', unverified(docs('"the application Id"; the probe was refused: closed to new customers'))],
  ['AWS::ServiceCatalogAppRegistry::ResourceAssociation', unverified(docs('"the application Id"; closed to new customers'))],
  ['AWS::Transfer::Agreement', unverified(EMPTY_REF)],
  ['AWS::WAFv2::WebACLAssociation', unverified(docs('text copied from WebACL (`name|id|scope`), which the type does not have'))],
  ['AWS::Wisdom::AIAgent', unverified(EMPTY_REF)],
  ['AWS::Wisdom::AIAgentVersion', unverified(EMPTY_REF)],
  ['AWS::Wisdom::AIGuardrail', unverified(EMPTY_REF)],
  ['AWS::Wisdom::AIGuardrailVersion', unverified(EMPTY_REF)],
  ['AWS::Wisdom::AIPrompt', unverified(EMPTY_REF)],
  ['AWS::Wisdom::AIPromptVersion', unverified(EMPTY_REF)],
  ['AWS::Wisdom::AssistantAssociation', unverified(docs('"the association ID" (a Cloud Control-native type; not measured)'))],
]);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface IdentifierSnapshot {
  readonly source: string;
  readonly generatedAt: string;
  /** Every Tier 1 / Tier 2 type the bundle carries, its identifier in SCHEMA order. */
  readonly primaryIdentifiers: Readonly<Record<string, readonly string[]>>;
  /** Tier 1 / Tier 2 types the bundle lacks at capture time. */
  readonly absentFromBundle: readonly string[];
}

export interface TierLists {
  readonly tier1: readonly string[];
  readonly tier2: readonly string[];
}

/** The `'AWS::…'` literals of a `const <name> = new Set|Map…([ … ]);` declaration. */
export function tableEntriesOf(source: string, name: string): string[] {
  // A type annotation may sit between the name and `=` (`: ReadonlyMap<…>`).
  const start = source.search(new RegExp(`const ${name}\\b(?::[^;]*?)? = new (Set|Map)<`));
  if (start === -1) return [];
  const end = source.indexOf(']);', start);
  if (end === -1) return [];
  return [...source.slice(start, end).matchAll(/'(AWS::[^']+)'/g)].map((m) => m[1]!);
}

/** The `REF_RETURNS_*` tables `cfnRefValueFromPhysicalId` consults. */
export const MAPPING_TABLES: readonly string[] = [
  'REF_RETURNS_SEGMENT_AFTER_PIPE',
  'REF_RETURNS_SEGMENT_BEFORE_FIRST_PIPE',
  'REF_RETURNS_SEGMENT_AT_INDEX',
  'REF_RETURNS_ARN_FROM_STATE',
  'REF_RETURNS_NAME_FROM_ARN',
  'REF_FROM_PHYSICAL_ID_HELPERS',
];

/**
 * Every type `ref-values.ts` maps, with the mechanism: a table name, or
 * `case` for a `resourceType === '<type>'` arm of `cfnRefValueFromPhysicalId`.
 */
export function parseMappedTypes(source: string): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const table of MAPPING_TABLES) {
    for (const t of tableEntriesOf(source, table)) mapped.set(t, table);
  }
  const fn = source.indexOf('export function cfnRefValueFromPhysicalId(');
  if (fn !== -1) {
    const end = source.indexOf('\n}\n', fn);
    const body = source.slice(fn, end === -1 ? undefined : end);
    // Only an `if (` condition's comparison counts: a comment or a non-returning
    // mention is no mapping. A `||` continuation line inside one is matched too.
    for (const m of body.matchAll(/^\s*(?:if \(|\|\| |\(?)\s*resourceType === '(AWS::[^']+)'/gm)) {
      if (!mapped.has(m[1]!)) mapped.set(m[1]!, 'case');
    }
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Status = 'mapped' | DispositionKind | 'gap';

export interface TypeRow {
  readonly resourceType: string;
  readonly tier: 1 | 2;
  readonly primaryIdentifier: readonly string[];
  readonly status: Status;
  /** `mapped`: the table or `case`; otherwise the disposition's source. */
  readonly detail?: string;
}

export interface RefSegmentCoverageReport {
  readonly schemaVersion: 1;
  readonly summary: Readonly<Record<Status, number>> & { readonly types: number };
  readonly types: readonly TypeRow[];
  /** Dispositions for a type that is mapped or outside the universe. */
  readonly staleDispositions: readonly string[];
  /** Tier 1 / Tier 2 types the identifier snapshot does not cover. */
  readonly missingFromSnapshot: readonly string[];
}

export interface BuildInput {
  readonly tiers: TierLists;
  readonly snapshot: IdentifierSnapshot;
  readonly mapped: ReadonlyMap<string, string>;
  readonly dispositions?: ReadonlyMap<string, Disposition>;
  readonly sdkCompoundIdTypes?: readonly string[];
}

export function buildReport(input: BuildInput): RefSegmentCoverageReport {
  const dispositions = input.dispositions ?? REF_SEGMENT_DISPOSITIONS;
  const sdkTypes = new Set(input.sdkCompoundIdTypes ?? SDK_COMPOUND_ID_TYPES);
  const tierOf = new Map<string, 1 | 2>();
  for (const t of input.tiers.tier1) tierOf.set(t, 1);
  for (const t of input.tiers.tier2) tierOf.set(t, 2);
  const absent = new Set(input.snapshot.absentFromBundle);
  const missingFromSnapshot = [...tierOf.keys()]
    .filter((t) => !(t in input.snapshot.primaryIdentifiers) && !absent.has(t))
    .sort();

  const rows: TypeRow[] = [];
  for (const [resourceType, tier] of [...tierOf].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const pi = input.snapshot.primaryIdentifiers[resourceType] ?? [];
    if (pi.length < 2 && !sdkTypes.has(resourceType)) continue;
    const mechanism = input.mapped.get(resourceType);
    const disposition = dispositions.get(resourceType);
    const status: Status = mechanism ? 'mapped' : (disposition?.kind ?? 'gap');
    const detail = mechanism ?? disposition?.source;
    rows.push({ resourceType, tier, primaryIdentifier: pi, status, ...(detail ? { detail } : {}) });
  }
  const universe = new Set(rows.map((r) => r.resourceType));
  const staleDispositions = [...dispositions.keys()]
    .filter((t) => !universe.has(t) || input.mapped.has(t))
    .sort();
  const count = (s: Status): number => rows.filter((r) => r.status === s).length;
  return {
    schemaVersion: 1,
    summary: {
      types: rows.length,
      mapped: count('mapped'),
      compound: count('compound'),
      'no-ref': count('no-ref'),
      'not-a-segment': count('not-a-segment'),
      unverified: count('unverified'),
      gap: count('gap'),
    },
    types: rows,
    staleDispositions,
    missingFromSnapshot,
  };
}

export function findGaps(report: RefSegmentCoverageReport): string[] {
  return report.types
    .filter((r) => r.status === 'gap')
    .map((r) => `${r.resourceType} [${r.primaryIdentifier.join(', ')}]`);
}

export function loadReport(): RefSegmentCoverageReport {
  const coverage = JSON.parse(readFileSync(PROVIDER_COVERAGE_FILE, 'utf8')) as TierLists;
  const snapshot = JSON.parse(readFileSync(IDENTIFIERS_FILE, 'utf8')) as IdentifierSnapshot;
  const mapped = parseMappedTypes(
    readFileSync(REF_VALUES_FILE, 'utf8') + '\n' + readFileSync(TYPE_REFS_FILE, 'utf8')
  );
  return buildReport({ tiers: coverage, snapshot, mapped });
}

// ---------------------------------------------------------------------------
// Snapshot refresh (network; never in CI)
// ---------------------------------------------------------------------------

/** The `primaryIdentifier` of a schema document, in schema order. */
export function orderedPrimaryIdentifier(schemaJson: string): string[] {
  const schema = JSON.parse(schemaJson) as { primaryIdentifier?: unknown };
  if (!Array.isArray(schema.primaryIdentifier)) return [];
  return schema.primaryIdentifier
    .filter((p): p is string => typeof p === 'string' && p.startsWith('/properties/'))
    .map((p) => p.slice('/properties/'.length));
}

export function buildSnapshot(
  tiers: TierLists,
  entries: ReadonlyMap<string, string>,
  entryName: (type: string) => string,
  generatedAt: string
): IdentifierSnapshot {
  const primaryIdentifiers: Record<string, string[]> = {};
  const absentFromBundle: string[] = [];
  for (const t of [...new Set([...tiers.tier1, ...tiers.tier2])].sort()) {
    const schema = entries.get(entryName(t));
    if (schema === undefined) absentFromBundle.push(t);
    else primaryIdentifiers[t] = orderedPrimaryIdentifier(schema);
  }
  return { source: PUBLIC_SCHEMA_ZIP_URL, generatedAt, primaryIdentifiers, absentFromBundle };
}

/** One type per line, so a refresh diffs per type. */
export function serializeSnapshot(s: IdentifierSnapshot): string {
  const ids = Object.entries(s.primaryIdentifiers)
    .map(([t, pi]) => `    ${JSON.stringify(t)}: ${JSON.stringify(pi)}`)
    .join(',\n');
  return (
    '{\n' +
    `  "source": ${JSON.stringify(s.source)},\n` +
    `  "generatedAt": ${JSON.stringify(s.generatedAt)},\n` +
    `  "primaryIdentifiers": {\n${ids}\n  },\n` +
    `  "absentFromBundle": ${JSON.stringify(s.absentFromBundle)}\n` +
    '}\n'
  );
}

async function refreshIdentifiers(): Promise<void> {
  // The schema refresh's bounded download + zip reader (redirects refused,
  // size-capped), so this path inherits its hardening rather than copying it.
  const { downloadSchemaBundle, readSchemaBundle, zipEntryName } = (await import(
    './refresh-cfn-schemas.mjs'
  )) as {
    downloadSchemaBundle: (url: string) => Promise<Buffer>;
    readSchemaBundle: (zip: Buffer) => Map<string, string>;
    zipEntryName: (type: string) => string;
  };
  const tiers = JSON.parse(readFileSync(PROVIDER_COVERAGE_FILE, 'utf8')) as TierLists;
  const entries = readSchemaBundle(await downloadSchemaBundle(PUBLIC_SCHEMA_ZIP_URL));
  const snapshot = buildSnapshot(tiers, entries, zipEntryName, new Date().toISOString().slice(0, 10));
  atomicWrite(IDENTIFIERS_FILE, serializeSnapshot(snapshot));
  process.stderr.write(
    `ref-segment-coverage: wrote ${Object.keys(snapshot.primaryIdentifiers).length} identifiers ` +
      `(${snapshot.absentFromBundle.length} type(s) absent from the bundle).\n`
  );
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function renderMarkdown(report: RefSegmentCoverageReport): string {
  const s = report.summary;
  const lines: string[] = [
    '---',
    'title: "Ref segment coverage matrix"',
    'unlisted: true',
    '---',
    '',
    '# Compound-id `Ref` coverage matrix',
    '',
    '<!-- AUTO-GENERATED by scripts/gen-ref-segment-coverage.ts — DO NOT EDIT BY HAND. -->',
    '<!-- Regenerate: `vp run gen:ref-segment-coverage`. -->',
    '',
    'Every Cloud Control-routable type whose `primaryIdentifier` has more than one field ' +
      '(cdkd records its physical id as the fields joined with `|`), plus the SDK providers ' +
      'that pack such an id themselves, and what CloudFormation `Ref` returns for it. A type ' +
      'with no decision would resolve `Ref` to the whole joined id unnoticed (issue #6612).',
    '',
    '## Summary',
    '',
    `- Compound-id types: **${s.types}**`,
    `- Mapped by \`cfnRefValueFromPhysicalId\`: **${s.mapped}**`,
    `- \`Ref\` is the joined id too: **${s.compound}**`,
    `- No \`Ref\` documented: **${s['no-ref']}**`,
    `- \`Ref\` is no segment of the id: **${s['not-a-segment']}**`,
    `- Unverified (does NOT block CI): **${s.unverified}**`,
    `- **Gaps (blocks CI): ${s.gap}**`,
    '',
    '| Type | Tier | primaryIdentifier | Status | Mechanism / source |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of report.types) {
    lines.push(
      `| \`${r.resourceType}\` | ${r.tier} | ${escapeCell(r.primaryIdentifier.join(', '))} | ${r.status} | ${escapeCell(r.detail ?? '')} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

async function main(): Promise<void> {
  if (process.argv.includes('--refresh-identifiers')) {
    await refreshIdentifiers();
    return;
  }
  const report = loadReport();
  if (process.argv.includes('--check')) {
    const gaps = findGaps(report);
    const { staleDispositions: stale, missingFromSnapshot: missing } = report;
    if (gaps.length > 0 || stale.length > 0 || missing.length > 0) {
      process.stderr.write(
        'ref-segment-coverage: FAIL\n' +
          (gaps.length > 0
            ? 'A compound-id type with no Ref decision resolves Ref to the whole `|`-joined id\n' +
              '(#6612). Read its docs page ("Return values"), measure it if they are unclear,\n' +
              'then map it in src/deployment/intrinsic-resolver/ref-values.ts OR add a\n' +
              'REF_SEGMENT_DISPOSITIONS entry with its source in scripts/gen-ref-segment-coverage.ts.\n' +
              gaps.map((g) => `  gap: ${g}\n`).join('')
            : '') +
          (stale.length > 0
            ? 'REF_SEGMENT_DISPOSITIONS entries for a mapped type or one outside the universe — delete them:\n' +
              stale.map((t) => `  stale: ${t}\n`).join('')
            : '') +
          (missing.length > 0
            ? 'Types the identifier snapshot does not cover — run `vp run gen:ref-segment-identifiers`:\n' +
              missing.map((t) => `  missing: ${t}\n`).join('')
            : '')
      );
      process.exit(1);
    }
    process.stderr.write(
      `ref-segment-coverage: OK — ${report.summary.types} compound-id types, 0 gaps ` +
        `(${report.summary.unverified} unverified).\n`
    );
    return;
  }
  atomicWrite(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(OUT_MD, renderMarkdown(report) + '\n');
  process.stderr.write(
    `ref-segment-coverage: wrote ref-segment-coverage.{json,md} — ${report.summary.types} types, ` +
      `${report.summary.mapped} mapped, ${report.summary.gap} gap(s).\n`
  );
}

const isMainModule = (): boolean =>
  Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename;

if (isMainModule()) {
  main().catch((err: unknown) => {
    process.stderr.write(`ref-segment-coverage: failed — ${(err as Error).message}\n`);
    process.exit(1);
  });
}
