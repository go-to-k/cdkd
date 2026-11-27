/**
 * Does each provider wait for the asynchronous AWS changes it starts? (issue
 * [#7132](https://github.com/go-to-k/cdkd/issues/7132))
 *
 * One row per `<client>:<Operation>` (the `@aws-sdk/client-<client>` package
 * suffix and the operation name) that `scripts/gen-async-operation-waits.ts`
 * finds a provider sending and the SDK model marks asynchronous. The generator
 * and `tests/unit/scripts/async-operation-waits.test.ts` fail CI on an
 * operation with no row, on a row no provider sends any more, and on a `waits`
 * row whose helper a sending provider unit no longer calls. The rendered
 * table is `docs/_generated/async-operation-waits.md`.
 *
 * - `waits`: the provider waits after the operation on its create / update /
 *   delete path, through one of `helpers` (every sending provider unit calls at
 *   least one, and every helper is called by a sending unit; a helper named
 *   `<X>Command` is an inline poll constructed in the same function as the
 *   send), and fails on
 *   `failureStatuses` (empty when the wait only times out or warns). Where the
 *   wait is scoped (`--no-wait` defers it, it covers only the settings that
 *   changed) or a cleanup send skips it, `note` says so.
 * - `no-wait-by-design`: the operation is settled once AWS answers,
 *   CloudFormation does not wait either, or cdkd decided and documented not to
 *   wait where CloudFormation does (CloudFront `Deployed`, #1282; a Lambda
 *   function's `Active`, #5002; NAT address associations, #2762); `reason`
 *   names the evidence.
 * - `unmeasured`: no wait on at least one create / update / delete path, and
 *   whether CloudFormation waits there needs an A/B run; #7132 tracks it. The
 *   set is frozen in the test and only shrinks: a NEW operation arrives as
 *   `waits` or `no-wait-by-design`.
 *
 * A LEAF with no imports: the generator, run by Node's type stripping, reads it.
 */

export type AsyncOperationVerdict =
  | {
      readonly verdict: 'waits';
      readonly helpers: readonly string[];
      readonly failureStatuses: readonly string[];
      readonly note?: string;
    }
  | { readonly verdict: 'no-wait-by-design'; readonly reason: string }
  | { readonly verdict: 'unmeasured'; readonly reason: string };

const waits = (
  helpers: readonly string[],
  failureStatuses: readonly string[],
  note?: string
): AsyncOperationVerdict =>
  note === undefined
    ? { verdict: 'waits', helpers, failureStatuses }
    : { verdict: 'waits', helpers, failureStatuses, note };
const byDesign = (reason: string): AsyncOperationVerdict => ({
  verdict: 'no-wait-by-design',
  reason,
});
const unmeasured = (reason: string): AsyncOperationVerdict => ({ verdict: 'unmeasured', reason });

const NO_WAIT = 'returns after the call; no code comment says why; needs a CloudFormation A/B';
/** `isTerminalDbWaitStatus` (deletion-protection-compensation/final-snapshot-wait.ts). */
const DB_TERMINAL = [
  'deleting',
  'failed',
  'stopped',
  'storage-full',
  'insufficient-capacity',
  'restore-error',
  'inaccessible-*',
  'incompatible-*',
  '*-failed',
];
const DEFERRED =
  '--no-wait defers it to deferReadiness (runs only if the deploy needs the resource)';
const FLIP = 'a DeletionProtection flip or re-enable around a delete does not wait after the call';

export const ASYNC_OPERATION_CLASSIFICATION: Readonly<Record<string, AsyncOperationVerdict>> = {
  'api-gateway:CreateStage': unmeasured(`${NO_WAIT} (a cache cluster answers CREATE_IN_PROGRESS)`),
  'api-gateway:CreateRestApi': unmeasured(NO_WAIT),
  'api-gateway:ImportRestApi': unmeasured(NO_WAIT),
  'api-gateway:PutRestApi': unmeasured(NO_WAIT),
  'api-gateway:UpdateRestApi': unmeasured(NO_WAIT),
  'api-gateway:UpdateStage': unmeasured(
    `${NO_WAIT} (a CacheClusterEnabled change answers CREATE_IN_PROGRESS / DELETE_IN_PROGRESS)`
  ),
  'appconfig:CreateEnvironment': unmeasured(NO_WAIT),
  'appconfig:UpdateEnvironment': unmeasured(NO_WAIT),
  'appsync:StartSchemaCreation': unmeasured(
    'returns while the schema is PROCESSING; CloudFormation fails NotStabilized on an invalid schema (#7127, whose open fix adds the wait)'
  ),
  'auto-scaling:StartInstanceRefresh': waits(
    ['runInstanceRefresh'],
    ['Failed', 'Cancelled'],
    '--no-wait skips it (docs/cli-deploy.md); a timeout or Ctrl-C cancels the refresh and throws'
  ),
  'bedrock-agentcore-control:CreateAgentRuntime': waits(
    ['waitForRuntimeReady'],
    ['CREATE_FAILED', 'UPDATE_FAILED'],
    DEFERRED
  ),
  'bedrock-agentcore-control:CreateEvaluator': unmeasured(NO_WAIT),
  'bedrock-agentcore-control:DeleteAgentRuntime': unmeasured(
    `${NO_WAIT} (it waits only before the delete)`
  ),
  'bedrock-agentcore-control:DeleteEvaluator': unmeasured(NO_WAIT),
  'bedrock-agentcore-control:UpdateAgentRuntime': waits(
    ['waitForRuntimeReady'],
    ['CREATE_FAILED', 'UPDATE_FAILED'],
    DEFERRED
  ),
  'bedrock-agentcore-control:UpdateEvaluator': unmeasured(NO_WAIT),
  'cloudfront:CreateDistribution': byDesign(
    '`Deployed` changes only when edges serve; the default returns and --full-wait waits (#1282, docs/cli-deploy.md wait table)'
  ),
  'cloudfront:CreateDistributionWithTags': byDesign(
    '`Deployed` changes only when edges serve; the default returns and --full-wait waits (#1282, docs/cli-deploy.md wait table)'
  ),
  'cloudfront:UpdateDistribution': byDesign(
    '`Deployed` changes only when edges serve; the default returns and --full-wait waits (#1282, docs/cli-deploy.md wait table); the disable before a delete always waits'
  ),
  'cloudtrail:StartLogging': unmeasured(NO_WAIT),
  'codebuild:CreateWebhook': unmeasured(NO_WAIT),
  'codebuild:UpdateWebhook': unmeasured(NO_WAIT),
  'docdb:CreateDBCluster': waits(['waitForClusterAvailable'], DB_TERMINAL, DEFERRED),
  'docdb:CreateDBInstance': waits(['waitForInstanceAvailable'], DB_TERMINAL, DEFERRED),
  'docdb:CreateDBSubnetGroup': unmeasured(NO_WAIT),
  'docdb:DeleteDBCluster': waits(['waitForClusterDeleted'], []),
  'docdb:DeleteDBInstance': waits(['waitForInstanceDeleted'], []),
  'docdb:ModifyDBCluster': waits(
    ['waitForClusterPortApplied', 'waitForSecurityGroupsApplied', 'waitForApplied'],
    DB_TERMINAL,
    `only for a changed port, security groups or read-back setting, skipped under --no-wait; ${FLIP}`
  ),
  'docdb:ModifyDBInstance': waits(
    ['waitForApplied'],
    [],
    `only CACertificateIdentifier / EnablePerformanceInsights are read back, and it warns on its cap; ${FLIP}`
  ),
  'docdb:ModifyDBSubnetGroup': unmeasured(NO_WAIT),
  'docdb:RemoveFromGlobalCluster': waits(['detachFromGlobalCluster'], []),
  'docdb:RestoreDBClusterFromSnapshot': waits(
    ['waitForClusterAvailable'],
    DB_TERMINAL,
    `${DEFERRED}, unless a follow-up ModifyDBCluster needs it`
  ),
  'docdb:RestoreDBClusterToPointInTime': waits(
    ['waitForClusterAvailable'],
    DB_TERMINAL,
    `${DEFERRED}, unless a follow-up ModifyDBCluster needs it`
  ),
  'dynamodb:CreateTable': waits(
    ['waitForTableActive'],
    ['any status other than CREATING / UPDATING / ACTIVE']
  ),
  'dynamodb:DeleteTable': waits(
    ['waitForGoneAfterDelete', 'waitForTableGone'],
    [],
    'a cap or Ctrl-C warns and returns; a failed-create cleanup delete does not wait'
  ),
  'dynamodb:DisableKinesisStreamingDestination': waits(
    ['waitForKinesisDisableSettled'],
    [],
    'best effort: warns on its cap'
  ),
  'dynamodb:EnableKinesisStreamingDestination': unmeasured(
    `${NO_WAIT} (the destination answers ENABLING)`
  ),
  'dynamodb:UpdateContributorInsights': unmeasured(
    `${NO_WAIT}; the answer is ENABLING / DISABLING. #6778 fixed the drift baseline, not the wait`
  ),
  'dynamodb:UpdateKinesisStreamingDestination': unmeasured(
    'AWS::DynamoDB::Table waits (waitForKinesisDestinationSettled); AWS::DynamoDB::GlobalTable does not'
  ),
  'dynamodb:UpdateTable': waits(
    ['waitForTableActiveAfterUpdate', 'waitForTableAndIndexesActive', 'waitForGlobalTableSettled'],
    [],
    `waits for ACTIVE; ${FLIP}`
  ),
  'ec2:AssociateIamInstanceProfile': unmeasured(
    'the create waits (isInstanceProfileAssociated, warns on its cap); the update does not'
  ),
  'ec2:AssociateNatGatewayAddress': byDesign(
    'CloudFormation waits, cdkd deliberately does not: the gateway keeps serving its other zones (ec2/nat-gateway.ts comment, measured on #2762)'
  ),
  'ec2:AssociateRouteTable': unmeasured(NO_WAIT),
  'ec2:AttachVolume': waits(
    ['waitForVolumeAttachment'],
    [],
    'throws if the attachment goes missing'
  ),
  'ec2:AttachVpnGateway': waits(['waitForVpnGatewayAttachment'], []),
  'ec2:CreateNatGateway': waits(
    ['waitUntilNatGatewayAvailable'],
    ['failed', 'deleting', 'deleted'],
    DEFERRED
  ),
  'ec2:CreateSubnet': unmeasured(
    `${NO_WAIT} (only an IPv6 association and attribute read-back wait)`
  ),
  'ec2:CreateVpc': unmeasured(NO_WAIT),
  'ec2:CreateVpcEndpoint': waits(
    ['waitForSettled'],
    ['failed', 'rejected', 'expired', 'partial', 'deleting', 'deleted'],
    DEFERRED
  ),
  'ec2:DetachVolume': waits(['waitForVolumeAttachment'], []),
  'ec2:DisassociateIamInstanceProfile': unmeasured(NO_WAIT),
  'ec2:DisassociateNatGatewayAddress': byDesign(
    'CloudFormation waits, cdkd deliberately does not: the gateway keeps serving its other zones (ec2/nat-gateway.ts comment, measured on #2762)'
  ),
  'ec2:ModifyInstanceMetadataOptions': unmeasured(NO_WAIT),
  'ec2:ReplaceIamInstanceProfileAssociation': unmeasured(NO_WAIT),
  'ec2:StartInstances': waits(
    ['waitForInstanceState'],
    ['terminated', 'shutting-down'],
    `${DEFERRED}; the restart of an instance cdkd stopped, and the best-effort restart after a failure, do not wait`
  ),
  'ecs:CreateCluster': unmeasured(NO_WAIT),
  'ecs:CreateService': waits(
    ['settleService'],
    ['MISSING', 'DRAINING', 'INACTIVE', 'a FAILED deployment'],
    `${DEFERRED}; a non-ECS deployment controller skips it`
  ),
  'ecs:DeleteCluster': unmeasured(NO_WAIT),
  'ecs:DeleteService': waits(
    ['waitForServiceInactive'],
    [],
    'every mode; the failed-create cleanup delete does not wait (DRAINING outlives the call, #1291)'
  ),
  'ecs:PutClusterCapacityProviders': waits(['waitForOwnCapacityProviderPut'], ['UPDATE_FAILED']),
  'ecs:DeregisterTaskDefinition': byDesign(
    'settled once AWS answers: the revision is INACTIVE at once; DELETE_IN_PROGRESS belongs to DeleteTaskDefinitions, which no provider sends (ECS API reference)'
  ),
  'ecs:RegisterTaskDefinition': byDesign(
    'settled once AWS answers: the revision is ACTIVE at once; DELETE_IN_PROGRESS belongs to DeleteTaskDefinitions (ECS API reference)'
  ),
  'ecs:UpdateCluster': unmeasured(`${NO_WAIT} (it waits only before a refused write)`),
  'ecs:UpdateService': waits(
    ['settleService'],
    ['MISSING', 'DRAINING', 'INACTIVE', 'a FAILED deployment'],
    `${DEFERRED}; drift revert, a non-ECS controller and the scale-down before a delete skip it`
  ),
  'efs:CreateAccessPoint': unmeasured(`${NO_WAIT} (the provider has no access-point waiter)`),
  'efs:CreateFileSystem': waits(['waitForFileSystemAvailable'], []),
  'efs:CreateMountTarget': waits(['waitForMountTargetAvailable'], []),
  'efs:PutBackupPolicy': unmeasured(`${NO_WAIT} (the policy answers ENABLING / DISABLING)`),
  'efs:UpdateFileSystem': waits(['waitForFileSystemAvailable'], []),
  'elasticache:CreateCacheCluster': waits(
    ['waitForClusterAvailable'],
    ['restore-failed', 'incompatible-network'],
    DEFERRED
  ),
  'elasticache:DeleteCacheCluster': waits(['waitForClusterDeleted'], []),
  'elasticache:ModifyCacheCluster': waits(
    ['waitForClusterAvailable'],
    ['restore-failed', 'incompatible-network']
  ),
  'eventbridge:CreateArchive': waits(
    ['waitForSettled'],
    ['CREATE_FAILED', 'UPDATE_FAILED'],
    DEFERRED
  ),
  'eventbridge:UpdateArchive': waits(
    ['waitForSettled'],
    ['CREATE_FAILED', 'UPDATE_FAILED'],
    DEFERRED
  ),
  'firehose:StartDeliveryStreamEncryption': waits(['waitForEncryption'], ['ENABLING_FAILED']),
  'fsx:AssociateFileSystemAliases': waits(['waitForAliases'], ['CREATE_FAILED']),
  'fsx:CreateFileSystem': waits(['waitForFileSystemAvailable'], ['FAILED', 'MISCONFIGURED']),
  'fsx:CreateFileSystemFromBackup': waits(
    ['waitForFileSystemAvailable'],
    ['FAILED', 'MISCONFIGURED']
  ),
  'fsx:DeleteFileSystem': waits(
    ['waitForFileSystemDeleted'],
    ['FAILED'],
    'the failed-create cleanup delete does not wait'
  ),
  'fsx:DisassociateFileSystemAliases': waits(['waitForAliases'], ['DELETE_FAILED']),
  'fsx:UpdateFileSystem': waits(
    ['waitForUpdateActionComplete'],
    ['FAILED'],
    'STORAGE_OPTIMIZATION is not waited for'
  ),
  'glue:CreateConnection': unmeasured(NO_WAIT),
  'glue:StartCrawlerSchedule': unmeasured(NO_WAIT),
  'glue:StartTrigger': unmeasured(NO_WAIT),
  'glue:UpdateTrigger': unmeasured(`${NO_WAIT} (it waits only for the deactivation before)`),
  'kinesis:RegisterStreamConsumer': waits(
    ['waitForConsumerActive'],
    ['any status other than CREATING / ACTIVE']
  ),
  'kinesis:StartStreamEncryption': waits(
    ['waitForStreamActive'],
    ['any status other than ACTIVE / CREATING / UPDATING']
  ),
  'kms:CreateKey': unmeasured(NO_WAIT),
  'kms:ScheduleKeyDeletion': byDesign(
    'the call sets PendingDeletion, which holds for the whole 7-30 day window: nothing is in progress to wait for'
  ),
  'lambda-core:CreateNetworkConnector': waits(
    ['waitForSettled'],
    ['FAILED', 'DELETING', 'DELETE_FAILED', 'INACTIVE'],
    'every mode'
  ),
  'lambda-core:DeleteNetworkConnector': waits(['waitForGone'], ['DELETE_FAILED']),
  'lambda-core:UpdateNetworkConnector': waits(
    ['waitForSettled'],
    ['FAILED', 'DELETING', 'DELETE_FAILED', 'INACTIVE']
  ),
  'lambda-microvms:CreateMicrovmImage': waits(
    ['waitForTerminalState'],
    ['CREATE_FAILED', 'UPDATE_FAILED'],
    DEFERRED
  ),
  'lambda-microvms:DeleteMicrovmImage': waits(['waitForDeleted'], ['DELETE_FAILED']),
  'lambda-microvms:UpdateMicrovmImage': waits(
    ['waitForTerminalState'],
    ['CREATE_FAILED', 'UPDATE_FAILED'],
    DEFERRED
  ),
  'lambda-web:CreateWebFunctionEndpoint': waits(['waitForSettled'], ['Failed'], 'every mode'),
  'lambda-web:CreateWebFunctionRevision': waits(['waitForActive'], ['Failed'], 'every mode'),
  'lambda-web:UpdateWebFunctionEndpoint': waits(['waitForSettled'], ['Failed']),
  'lambda:CreateEventSourceMapping': unmeasured(
    'returns while the mapping is Creating; #5737 fixed the drift baseline, not the wait'
  ),
  'lambda:CreateFunction': byDesign(
    'Pending is accepted by every dependent except a synchronous invoke and a Lambda target group, which wait themselves; waiting for Active doubled benchmark deploys (lambda-function/create.ts comment, #5002); a capacity-provider or RuntimeManagementConfig create waits'
  ),
  'lambda:DeleteEventSourceMapping': unmeasured(
    'waits only after a ResourceInUseException refusal (#7011); an accepted delete returns while Deleting'
  ),
  'lambda:PublishVersion': waits(['waitForLatestPublishedSettled'], ['Failed']),
  'lambda:PutFunctionScalingConfig': waits(['waitForLatestPublishedSettled'], ['Failed']),
  'lambda:UpdateEventSourceMapping': unmeasured(NO_WAIT),
  'lambda:UpdateFunctionCode': waits(['waitForFunctionUpdated'], ['Failed']),
  'lambda:UpdateFunctionConfiguration': waits(
    ['waitForFunctionUpdated', 'waitForBackingFunctionUpdated'],
    ['Failed'],
    'every mode; the custom-resource recycle only logs a wait failure, and the VPC detach before a delete warns on its cap'
  ),
  'neptune:CreateDBCluster': waits(
    ['waitForClusterAvailable'],
    DB_TERMINAL,
    `${DEFERRED}, unless a follow-up ModifyDBCluster needs it`
  ),
  'neptune:CreateDBInstance': waits(['waitForInstanceAvailable'], DB_TERMINAL, DEFERRED),
  'neptune:CreateDBSubnetGroup': unmeasured(NO_WAIT),
  'neptune:DeleteDBCluster': waits(['waitForClusterDeleted'], []),
  'neptune:DeleteDBInstance': waits(['waitForInstanceDeleted'], []),
  'neptune:ModifyDBCluster': waits(
    ['waitForSecurityGroupsApplied', 'waitForApplied', 'waitForClusterRolesSettled'],
    DB_TERMINAL,
    `only for changed security groups, roles or read-back settings, skipped under --no-wait; ${FLIP}`
  ),
  'neptune:ModifyDBInstance': waits(
    ['waitForApplied'],
    [],
    `only PubliclyAccessible is read back, and it warns on its cap; ${FLIP}`
  ),
  'neptune:ModifyDBSubnetGroup': unmeasured(NO_WAIT),
  'neptune:RestoreDBClusterFromSnapshot': waits(
    ['waitForClusterAvailable'],
    DB_TERMINAL,
    `${DEFERRED}, unless a follow-up ModifyDBCluster needs it`
  ),
  'neptune:RestoreDBClusterToPointInTime': waits(
    ['waitForClusterAvailable'],
    DB_TERMINAL,
    `${DEFERRED}, unless a follow-up ModifyDBCluster needs it`
  ),
  'pipes:CreatePipe': waits(['waitForSettled'], ['*_FAILED']),
  'pipes:DeletePipe': waits(
    ['waitForGoneAfterDelete'],
    ['DELETE_FAILED', 'DELETE_ROLLBACK_FAILED'],
    'a cap or Ctrl-C warns and returns'
  ),
  'pipes:UpdatePipe': waits(['waitForSettled'], ['*_FAILED']),
  'rds:CreateDBCluster': waits(['waitForClusterAvailable'], DB_TERMINAL, DEFERRED),
  'rds:CreateDBInstance': waits(['waitForInstanceAvailable'], DB_TERMINAL, DEFERRED),
  'rds:CreateDBInstanceReadReplica': waits(
    ['waitForInstanceAvailable'],
    DB_TERMINAL,
    `${DEFERRED}, unless a follow-up ModifyDBInstance needs it`
  ),
  'rds:CreateDBProxy': waits(
    ['DescribeDBProxiesCommand'],
    ['incompatible-network', 'insufficient-resource-limits'],
    'an inline poll in create(), every mode'
  ),
  'rds:CreateDBProxyEndpoint': waits(
    ['DescribeDBProxyEndpointsCommand'],
    ['incompatible-network', 'insufficient-resource-limits'],
    'an inline poll in create(), every mode'
  ),
  'rds:CreateDBSubnetGroup': unmeasured(NO_WAIT),
  'rds:DeleteDBCluster': waits(
    ['waitForClusterDeleted'],
    [],
    'the failed-create cleanup delete does not wait'
  ),
  'rds:DeleteDBInstance': waits(
    ['waitForInstanceDeleted'],
    [],
    'the failed-create cleanup and an express-configuration writer delete do not wait'
  ),
  'rds:DeleteDBProxy': waits(
    ['waitForDBProxyDeleteGone'],
    ['a status other than deleting after deleting was read'],
    'a cap or Ctrl-C warns and returns'
  ),
  'rds:DeleteDBProxyEndpoint': waits(
    ['waitForDBProxyDeleteGone'],
    ['a status other than deleting after deleting was read'],
    'a cap or Ctrl-C warns and returns'
  ),
  'rds:ModifyDBCluster': waits(
    ['waitForClusterState', 'waitForClusterAvailable'],
    DB_TERMINAL,
    `only for the settings that changed (docs/cli-deploy.md), skipped under --no-wait; ${FLIP}`
  ),
  'rds:ModifyDBInstance': waits(
    ['waitForInstanceState', 'waitForInstanceAvailable'],
    DB_TERMINAL,
    `only for the settings that changed (docs/cli-deploy.md), skipped under --no-wait; ${FLIP}`
  ),
  'rds:ModifyDBProxy': waits(
    ['waitForAvailableAfterModify'],
    ['incompatible-network', 'insufficient-resource-limits'],
    'every mode'
  ),
  'rds:ModifyDBProxyEndpoint': waits(
    ['waitForAvailableAfterModify'],
    ['incompatible-network', 'insufficient-resource-limits'],
    'every mode'
  ),
  'rds:ModifyDBProxyTargetGroup': unmeasured(NO_WAIT),
  'rds:ModifyDBSubnetGroup': unmeasured(NO_WAIT),
  'rds:PromoteReadReplica': waits(['waitForInstanceState'], DB_TERMINAL, 'every mode'),
  'rds:RebootDBInstance': waits(['waitForInstanceState'], DB_TERMINAL, 'skipped under --no-wait'),
  'rds:RemoveFromGlobalCluster': waits(['detachFromGlobalCluster'], []),
  'rds:RestoreDBClusterFromSnapshot': waits(['waitForClusterAvailable'], DB_TERMINAL, 'every mode'),
  'rds:RestoreDBClusterToPointInTime': waits(
    ['waitForClusterAvailable'],
    DB_TERMINAL,
    'every mode'
  ),
  'rds:RestoreDBInstanceFromDBSnapshot': waits(
    ['waitForInstanceAvailable'],
    DB_TERMINAL,
    'every mode'
  ),
  'rds:RestoreDBInstanceToPointInTime': waits(
    ['waitForInstanceAvailable'],
    DB_TERMINAL,
    'every mode'
  ),
  'rds:StartDBInstanceAutomatedBackupsReplication': waits(
    ['waitForInstanceState'],
    DB_TERMINAL,
    'skipped under --no-wait'
  ),
  'rds:StopDBInstanceAutomatedBackupsReplication': waits(
    ['waitForInstanceState'],
    DB_TERMINAL,
    'skipped under --no-wait unless a start follows'
  ),
  'route-53:AssociateVPCWithHostedZone': unmeasured(
    `${NO_WAIT} (the change answers PENDING; nothing reads GetChange)`
  ),
  'route-53:ChangeResourceRecordSets': unmeasured(
    `${NO_WAIT} (the change answers PENDING; nothing reads GetChange)`
  ),
  'route-53:CreateHostedZone': unmeasured(
    `${NO_WAIT} (the change answers PENDING; nothing reads GetChange)`
  ),
  'route-53:DeleteHostedZone': unmeasured(
    `${NO_WAIT} (the change answers PENDING; nothing reads GetChange)`
  ),
  'route-53:DisassociateVPCFromHostedZone': unmeasured(
    `${NO_WAIT} (the change answers PENDING; nothing reads GetChange)`
  ),
  's3tables:PutTableBucketReplication': unmeasured(NO_WAIT),
  'secrets-manager:CreateSecret': unmeasured(`${NO_WAIT} (replica regions answer InProgress)`),
  'secrets-manager:RemoveRegionsFromReplication': unmeasured(NO_WAIT),
  'secrets-manager:ReplicateSecretToRegions': unmeasured(
    `${NO_WAIT} (replica regions answer InProgress)`
  ),
  'codebuild:CreateProject': byDesign(
    'settled once AWS answers: the flagged `project.webhook.status` belongs to the separate CreateWebhook call, its own row'
  ),
  'codebuild:UpdateProject': byDesign(
    'settled once AWS answers: the flagged `project.webhook.status` belongs to the separate CreateWebhook / UpdateWebhook calls, their own rows'
  ),
  'ec2:AssociateSubnetCidrBlock': waits(
    ['waitForSubnetIpv6Association'],
    ['failed', 'failing'],
    'every mode (docs/cli-deploy.md edge cases)'
  ),
  'ec2:AuthorizeSecurityGroupEgress': byDesign(
    "the flagged member is a referenced peering's PeeringStatus, not the rule's; the rule exists once AWS answers"
  ),
  'ec2:AuthorizeSecurityGroupIngress': byDesign(
    "the flagged member is a referenced peering's PeeringStatus, not the rule's; the rule exists once AWS answers"
  ),
  'ec2:CreateInternetGateway': byDesign(
    'a new gateway has no attachments: the flagged Attachments[].State belongs to AttachInternetGateway'
  ),
  'ec2:DisassociateSubnetCidrBlock': waits(
    ['waitForSubnetIpv6Association'],
    ['failed', 'failing'],
    'every mode (docs/cli-deploy.md edge cases)'
  ),
  'ec2:MonitorInstances': unmeasured(`${NO_WAIT} (monitoring answers pending)`),
  'ec2:RevokeSecurityGroupEgress': byDesign(
    "the flagged member is an unknown permission's peering PeeringStatus, not the rule's; the revoke is done once AWS answers"
  ),
  'ec2:RevokeSecurityGroupIngress': byDesign(
    "the flagged member is an unknown permission's peering PeeringStatus, not the rule's; the revoke is done once AWS answers"
  ),
  'ec2:RunInstances': waits(
    ['waitUntilInstanceRunning'],
    ['shutting-down', 'terminated', 'stopping'],
    `${DEFERRED}, unless Volumes or SsmAssociations need running`
  ),
  'ec2:StopInstances': waits(['waitForInstanceState'], ['terminated', 'shutting-down']),
  'ec2:TerminateInstances': waits(
    ['waitUntilInstanceTerminated'],
    [],
    'the delete waits; a failed-launch cleanup waits only when an attached volume must be freed'
  ),
  'ec2:UnmonitorInstances': unmeasured(`${NO_WAIT} (monitoring answers disabling)`),
  'elastic-load-balancing-v2:CreateLoadBalancer': waits(
    ['waitUntilLoadBalancerAvailable'],
    [],
    DEFERRED
  ),
  'elastic-load-balancing-v2:ModifyCapacityReservation': waits(
    ['waitForCapacityReservationProvisioned'],
    ['failed'],
    'skipped under --no-wait'
  ),
  'emr:PutAutoScalingPolicy': unmeasured(`${NO_WAIT} (the policy answers PENDING / ATTACHING)`),
  'rds:RegisterDBProxyTargets': unmeasured(`${NO_WAIT} (targets answer REGISTERING)`),
  'route-53:UpdateHostedZoneComment': byDesign(
    'the call changes only the comment; the flagged feature statuses belong to UpdateHostedZoneFeatures'
  ),
  'ssm:CreateAssociation': unmeasured(`${NO_WAIT} (the association answers Pending)`),
};
