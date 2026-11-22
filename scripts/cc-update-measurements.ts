/**
 * Measured Cloud Control update-path table: the single, hand-maintained input of
 * `gen-cc-update-measurements.ts` (go-to-k/cdkd#6676).
 *
 * Cloud Control applies an update patch on top of its READ MODEL, and some
 * services' update APIs refuse a read-model value of a key the patch never
 * touched (DataSync `Schedule: {}`, ELBv2 `Values` + `PathPatternConfig`).
 * cdkd fixes such a type with a per-type helper (`CcUpdateFix`); this table
 * records which Cloud Control-routed types were measured and how.
 *
 * A type joins by MEASUREMENT, never by reading its schema: a real update of
 * ONE property served by the service's main update call, plus a
 * `drift --revert`, against real AWS. A `clean` row proves only that the probed
 * property's API accepted the read model — one probe cannot prove a type clean
 * (go-to-k/cdkd#6676 10:08Z calibration), so a type whose other update APIs
 * differ may still refuse.
 *
 * Results:
 *   - clean               — the probed update and the revert both succeeded.
 *   - refuses             — an update was refused over a read-model value; MUST
 *                           carry exactly one of `fix` (a registered helper) or
 *                           `exemption` (why none is needed).
 *   - no-mutable-property — nothing but Tags is updatable, so nothing to probe.
 *   - not-measured        — recorded but not yet probed.
 */
export type CcUpdateFix =
  | 'cc-read-back-empty-keys'
  | 'cc-read-back-default-paths'
  | 'cc-read-back-exclusive-keys'
  | 'guardduty-detector-patch'
  | 'elbv2-listener-rule-patch';

/** Fix -> its module under `src/provisioning/`. */
export const CC_UPDATE_FIX_MODULES: Readonly<Record<CcUpdateFix, string>> = {
  'cc-read-back-empty-keys': 'cc-read-back-empty-keys.ts',
  'cc-read-back-default-paths': 'cc-read-back-default-paths.ts',
  'cc-read-back-exclusive-keys': 'cc-read-back-exclusive-keys.ts',
  'guardduty-detector-patch': 'guardduty-detector-patch.ts',
  'elbv2-listener-rule-patch': 'elbv2-listener-rule-patch.ts',
};

export interface CcUpdateMeasurement {
  readonly type: string;
  /** The property changed and the API that served it. */
  readonly probe: string;
  readonly result: 'clean' | 'refuses' | 'no-mutable-property' | 'not-measured';
  readonly fix?: CcUpdateFix;
  /** Why a `refuses` row needs no helper. */
  readonly exemption?: string;
  /** The issue the measurement or fix belongs to. */
  readonly issue: number;
  /** YYYY-MM-DD */
  readonly measured: string;
  readonly note?: string;
}

// Sorted by type.
export const CC_UPDATE_MEASUREMENTS: readonly CcUpdateMeasurement[] = [
  {
    type: 'AWS::ApiGateway::ApiKey',
    probe: 'Description (UpdateApiKey)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ApiGateway::ClientCertificate',
    probe: 'Description (UpdateClientCertificate)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ApiGateway::Model',
    probe: 'Description (UpdateModel)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ApiGateway::RequestValidator',
    probe: 'ValidateRequestBody false->true (UpdateRequestValidator)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ApiGateway::UsagePlanKey',
    probe: 'none: KeyId/KeyType/UsagePlanId all createOnly',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::AppConfig::Application',
    probe: 'Description (UpdateApplication)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::AppConfig::ConfigurationProfile',
    probe: 'Description (UpdateConfigurationProfile)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::AppConfig::Deployment',
    probe: 'none: every writable property createOnly',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::AppConfig::DeploymentStrategy',
    probe: 'Description (UpdateDeploymentStrategy)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::AppConfig::HostedConfigurationVersion',
    probe: 'none: all properties createOnly',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ApplicationAutoScaling::ScalableTarget',
    probe: 'MaxCapacity (RegisterScalableTarget)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ApplicationAutoScaling::ScalingPolicy',
    probe: 'TargetTrackingScalingPolicyConfiguration.TargetValue (PutScalingPolicy)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Athena::NamedQuery',
    probe: 'none: all properties createOnly',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Athena::WorkGroup',
    probe: 'Description (UpdateWorkGroup); WorkGroupConfiguration.BytesScannedCutoffPerQuery (UpdateWorkGroup ConfigurationUpdates)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::AutoScaling::ScalingPolicy',
    probe: 'TargetTrackingConfiguration.TargetValue (PutScalingPolicy)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Backup::BackupPlan',
    probe: 'Rule Lifecycle.DeleteAfterDays (UpdateBackupPlan)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Backup::BackupSelection',
    probe: 'none: BackupSelection and BackupPlanId createOnly',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Backup::BackupVault',
    probe: 'AccessPolicy statement Action (PutBackupVaultAccessPolicy)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Bedrock::Flow',
    probe: 'DefinitionString / DefinitionSubstitutions / DefinitionS3Location (UpdateFlow)',
    result: 'refuses',
    fix: 'cc-read-back-exclusive-keys',
    issue: 6819,
    measured: '2026-11-22',
    note: 'read-back Definition sent beside the declared DefinitionString or DefinitionS3Location',
  },
  {
    type: 'AWS::CloudFront::Function',
    probe: 'FunctionConfig.Comment (UpdateFunction + PublishFunction)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::CloudFront::KeyGroup',
    probe: 'KeyGroupConfig.Comment (UpdateKeyGroup)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::CloudFront::PublicKey',
    probe: 'PublicKeyConfig.Comment (UpdatePublicKey)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::CloudWatch::CompositeAlarm',
    probe: 'AlarmDescription (PutCompositeAlarm)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::CloudWatch::Dashboard',
    probe: 'DashboardBody (PutDashboard)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::CodeDeploy::Application',
    probe: 'none: ApplicationName and ComputePlatform createOnly, only Tags mutable',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::CodeDeploy::DeploymentGroup',
    probe: 'DeploymentConfigName (UpdateDeploymentGroup)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::CodePipeline::CustomActionType',
    probe: 'none: everything except Tags createOnly',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::CodePipeline::Pipeline',
    probe: 'Stages[1] ManualApproval CustomData (UpdatePipeline)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Cognito::IdentityPool',
    probe: 'AllowUnauthenticatedIdentities true->false (UpdateIdentityPool)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Cognito::UserPoolClient',
    probe: 'RefreshTokenValidity (UpdateUserPoolClient)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Cognito::UserPoolDomain',
    probe: 'ManagedLoginVersion 1->2 (UpdateUserPoolDomain)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
    note: 'Update measured only: ManagedLoginVersion is schema write-only so drift cannot see it, and the other mutable keys (CustomDomainConfig) need a custom domain plus an ACM certificate, not measured',
  },
  {
    type: 'AWS::Cognito::UserPoolGroup',
    probe: 'Description (UpdateGroup)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Cognito::UserPoolUser',
    probe: 'none: every property createOnly',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Cognito::UserPoolUserToGroupAttachment',
    probe: 'none: all properties createOnly',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Connect::User',
    probe: 'IdentityInfo.FirstName (UpdateUserIdentityInfo)',
    result: 'refuses',
    fix: 'cc-read-back-default-paths',
    issue: 6820,
    measured: '2026-11-22',
    note: 'read-back VoiceEnhancementConfigs [{ Channel: VOICE }] lacks the required VoiceEnhancementMode; Cloud Control model validation refuses it',
  },
  {
    type: 'AWS::DSQL::Cluster',
    probe: 'DeletionProtectionEnabled (UpdateCluster); PolicyDocument (PutClusterPolicy)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::DataSync::LocationS3',
    probe: 'S3StorageClass (UpdateLocationS3)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::DataSync::Task',
    probe: 'Options.VerifyMode (UpdateTask)',
    result: 'refuses',
    fix: 'cc-read-back-empty-keys',
    issue: 6676,
    measured: '2026-11-20',
    note: 'Read-back `Schedule: {}` is sent as a null schedule.scheduleExpression and refused; an unnamed task reads back `Name: ""`, refused by Cloud Control model validation (minLength 1)',
  },
  {
    type: 'AWS::DocDB::DBClusterParameterGroup',
    probe: 'Parameters.audit_logs (ModifyDBClusterParameterGroup)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::EC2::FlowLog',
    probe: 'none: every property createOnly except Tags',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::EC2::LaunchTemplate',
    probe: 'LaunchTemplateData.InstanceType (CreateLaunchTemplateVersion)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
    note: 'update only: LaunchTemplateData is write-only, so drift cannot see it',
  },
  {
    type: 'AWS::EC2::PrefixList',
    probe: 'Entries[0].Description (ModifyManagedPrefixList)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::EC2::SecurityGroupEgress',
    probe: 'Description (UpdateSecurityGroupRuleDescriptionsEgress)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::EC2::TransitGateway',
    probe: 'Description (ModifyTransitGateway)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::EC2::TransitGatewayAttachment',
    probe: 'Options.ApplianceModeSupport (ModifyTransitGatewayVpcAttachment)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::EC2::VPNGateway',
    probe: 'none: AmazonSideAsn and Type createOnly, only Tags mutable',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ECS::Gateway',
    probe: 'Configuration.HostSharedAlb.HttpDesync (UpdateGateway)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ECS::GatewayClusterAssociations',
    probe: 'none: Gateway and Cluster createOnly, the rest read-only',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::EKS::Cluster',
    probe: 'Logging.ClusterLogging.EnabledTypes (UpdateClusterConfig)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ElastiCache::ParameterGroup',
    probe: 'Properties.maxmemory-policy (ModifyCacheParameterGroup)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ElastiCache::ReplicationGroup',
    probe: 'ReplicationGroupDescription (ModifyReplicationGroup)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
    probe: 'Actions with path / host Conditions untouched (ModifyRule)',
    result: 'refuses',
    fix: 'elbv2-listener-rule-patch',
    issue: 6663,
    measured: '2026-11-20',
    note: 'Read model carries Values and PathPatternConfig for the same condition',
  },
  {
    type: 'AWS::EventSchemas::Discoverer',
    probe: 'Description (UpdateDiscoverer)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Events::ApiDestination',
    probe: 'Description (UpdateApiDestination)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::GuardDuty::Detector',
    probe: 'any change of a detector declaring Features (UpdateDetector)',
    result: 'refuses',
    fix: 'guardduty-detector-patch',
    issue: 4910,
    measured: '2026-10-14',
  },
  {
    type: 'AWS::HealthImaging::Datastore',
    probe: 'none: DatastoreName, KmsKeyArn and Tags createOnly, the rest read-only, no update handler (not deployed)',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ImageBuilder::InfrastructureConfiguration',
    probe: 'Description (UpdateInfrastructureConfiguration)',
    result: 'refuses',
    fix: 'cc-read-back-empty-keys',
    issue: 6569,
    measured: '2026-11-18',
    note: 'Read-back empty ResourceTags',
  },
  {
    type: 'AWS::IoT::TopicRule',
    probe: 'TopicRulePayload.Description (ReplaceTopicRule)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Lambda::CapacityProvider',
    probe: 'CapacityProviderScalingConfig.MaxVCpuCount (UpdateCapacityProvider)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Lambda::Runtime',
    probe: 'Description (UpdateRuntime)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Lambda::Version',
    probe: 'FunctionScalingConfig.MaxExecutionEnvironments (PutFunctionScalingConfig)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Lambda::WebFunction',
    probe: 'none: FunctionName createOnly, only Tags mutable',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Logs::SubscriptionFilter',
    probe: 'FilterPattern (PutSubscriptionFilter)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::MSK::ClusterPolicy',
    probe: 'Policy (PutClusterPolicy)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::MSK::ServerlessCluster',
    probe: 'none: every property createOnly, no update handler',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Neptune::DBClusterParameterGroup',
    probe: 'Parameters.neptune_enable_audit_log (ModifyDBClusterParameterGroup)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Neptune::DBParameterGroup',
    probe: 'Parameters.neptune_query_timeout (ModifyDBParameterGroup)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::NeptuneGraph::Graph',
    probe: 'PublicConnectivity (UpdateGraph)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::OpenSearchService::Domain',
    probe: 'AccessPolicies (UpdateDomainConfig)',
    result: 'refuses',
    fix: 'cc-read-back-default-paths',
    issue: 6676,
    measured: '2026-11-20',
    note: 'read-back AdvancedOptions.override_main_response_version "false" and AIMLOptions defaults',
  },
  {
    type: 'AWS::RDS::DBClusterParameterGroup',
    probe: 'Parameters.log_min_duration_statement (ModifyDBClusterParameterGroup)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::RDS::DBParameterGroup',
    probe: 'Parameters.log_min_duration_statement (ModifyDBParameterGroup)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Redshift::Cluster',
    probe: 'AutomatedSnapshotRetentionPeriod (ModifyCluster)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::ResourceGroups::Group',
    probe: 'Description (UpdateGroup); ResourceQuery tag value (UpdateGroupQuery)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::S3::AccessPoint',
    probe: 'Policy action list (PutAccessPointPolicy)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::SES::ConfigurationSet',
    probe: 'SendingOptions.SendingEnabled (PutConfigurationSetSendingOptions)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
    note: 'Drift revert also covered ReputationOptions (PutConfigurationSetReputationOptions)',
  },
  {
    type: 'AWS::SES::EmailIdentity',
    probe: 'MailFromAttributes (PutEmailIdentityMailFromAttributes)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::SMSVOICE::ProtectConfiguration',
    probe: 'CountryRuleSet.SMS (UpdateProtectConfigurationCountryRuleSet)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
    note: 'UpdateProtectConfiguration (DeletionProtectionEnabled) not probed',
  },
  {
    type: 'AWS::SSM::MaintenanceWindow',
    probe: 'Duration (UpdateMaintenanceWindow)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::SSM::MaintenanceWindowTarget',
    probe: 'Targets values (UpdateMaintenanceWindowTarget)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::SSM::MaintenanceWindowTask',
    probe: 'MaxConcurrency (UpdateMaintenanceWindowTask)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Scheduler::ScheduleGroup',
    probe: 'none: Name createOnly, only Tags mutable',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::Signer::SigningProfile',
    probe: 'none: PlatformId/ProfileName/SignatureValidityPeriod createOnly, only Tags mutable',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::StepFunctions::StateMachineAlias',
    probe: 'DeploymentPreference ALL_AT_ONCE and CANARY (UpdateStateMachineAlias)',
    result: 'refuses',
    fix: 'cc-read-back-exclusive-keys',
    issue: 6818,
    measured: '2026-11-22',
    note: 'read-back RoutingConfiguration sent beside the declared DeploymentPreference',
  },
  {
    type: 'AWS::VerifiedPermissions::PolicyStore',
    probe: 'Description (UpdatePolicyStore)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::WAFv2::IPSet',
    probe: 'Addresses (UpdateIPSet)',
    result: 'clean',
    issue: 6676,
    measured: '2026-11-20',
  },
  {
    type: 'AWS::WAFv2::WebACLAssociation',
    probe: 'none: both properties createOnly',
    result: 'no-mutable-property',
    issue: 6676,
    measured: '2026-11-20',
  },
];
