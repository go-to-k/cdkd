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
  'api-gateway:CreateStage': byDesign(
    'CloudFormation does not wait for the cache cluster either: its stage CREATE_COMPLETE came in 3.7 s while GetStage read cacheClusterStatus CREATE_IN_PROGRESS (AVAILABLE ~256 s later); a stage without a cache stays NOT_AVAILABLE (#7132)'
  ),
  'api-gateway:CreateRestApi': byDesign(
    'settled when AWS answers: GetRestApi read apiStatus AVAILABLE on the first read, REGIONAL and EDGE (#7132)'
  ),
  'api-gateway:ImportRestApi': byDesign(
    'settled when AWS answers: GetRestApi read apiStatus AVAILABLE on the first read after an OpenAPI import (2 of 2) (#7132)'
  ),
  'api-gateway:PutRestApi': byDesign(
    'settled when AWS answers: GetRestApi read apiStatus AVAILABLE on the first read after an OpenAPI put (#7132)'
  ),
  'api-gateway:UpdateRestApi': byDesign(
    'settled when AWS answers: GetRestApi read apiStatus AVAILABLE on the first read, an EDGE to REGIONAL endpoint change included (#7132)'
  ),
  'api-gateway:UpdateStage': byDesign(
    'CloudFormation does not wait for a cache-size change either (cacheClusterStatus CREATE_IN_PROGRESS ~196 s after the call); AWS refuses a second cache change meanwhile, and CloudFormation fails the same way (#7132)'
  ),
  'appconfig:CreateEnvironment': byDesign(
    'settled when AWS answers: GetEnvironment read State ReadyForDeployment on the first read, with and without Monitors (3 of 3); DEPLOYING follows only StartDeployment (#7132)'
  ),
  'appconfig:UpdateEnvironment': byDesign(
    'settled when AWS answers: GetEnvironment read State ReadyForDeployment on the first read, with and without Monitors (3 of 3) (#7132)'
  ),
  'appsync:StartSchemaCreation': waits(
    ['waitForSchemaCreation'],
    ['FAILED', 'NOT_APPLICABLE', 'DELETING'],
    'every outcome is decided by a GetSchemaCreationStatus poll, as CloudFormation waits (#7127)'
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
  'cloudtrail:StartLogging': byDesign(
    'settled when AWS answers: GetTrailStatus read IsLogging true on the first read after the call (3 of 3, ~0.2 s); CloudFormation completes with it true (#7132)'
  ),
  'codebuild:CreateWebhook': unmeasured(NO_WAIT),
  'codebuild:UpdateWebhook': unmeasured(NO_WAIT),
  'docdb:CreateDBCluster': waits(['waitForClusterAvailable'], DB_TERMINAL, DEFERRED),
  'docdb:CreateDBInstance': waits(['waitForInstanceAvailable'], DB_TERMINAL, DEFERRED),
  'docdb:CreateDBSubnetGroup': byDesign(
    'settled when AWS answers: the create response and the first DescribeDBSubnetGroups read SubnetGroupStatus Complete (3 of 3); there is no transitional state (#7132)'
  ),
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
  'docdb:ModifyDBSubnetGroup': byDesign(
    'settled when AWS answers: the response and the first DescribeDBSubnetGroups read SubnetGroupStatus Complete with the new subnets (3 of 3) (#7132)'
  ),
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
  'dynamodb:EnableKinesisStreamingDestination': waits(
    ['waitForKinesisEnableActive'],
    ['ENABLE_FAILED', 'DISABLED / absent after the stale-read grace'],
    '--no-wait skips it (docs/cli-deploy.md); CloudFormation completes only once the destination reads ACTIVE (#7132)'
  ),
  'dynamodb:UpdateContributorInsights': waits(
    ['waitForContributorInsightsSettled'],
    ['FAILED', 'the opposite status after the stale-read grace'],
    'table and index; --no-wait skips it (docs/cli-deploy.md); CloudFormation completes only once it reads ENABLED / DISABLED (#7132)'
  ),
  'dynamodb:UpdateKinesisStreamingDestination': waits(
    ['waitForKinesisDestinationSettled', 'waitForKinesisPrecisionSettled'],
    ['ENABLE_FAILED / DISABLED / absent, or the old precision, after the stale-read grace'],
    'AWS::DynamoDB::Table and GlobalTable; UPDATING for ~3 min; the GlobalTable wait --no-wait skips it (docs/cli-deploy.md), and its pre-send wait for ACTIVE (waitForKinesisUpdatable) runs in every mode; CloudFormation\'s update completed with the new precision ACTIVE (#7132)'
  ),
  'dynamodb:UpdateTable': waits(
    ['waitForTableActiveAfterUpdate', 'waitForTableAndIndexesActive', 'waitForGlobalTableSettled'],
    [],
    `waits for ACTIVE; ${FLIP}`
  ),
  'ec2:AssociateIamInstanceProfile': waits(
    ['isInstanceProfileAssociated', 'waitForInstanceProfileAssociationSettled'],
    ['the new association reads disassociated'],
    'the create polls isInstanceProfileAssociated (warns on its cap); the update waits for associated, --no-wait skips it (docs/cli-deploy.md); CloudFormation\'s update step read the new profile associated (#7132)'
  ),
  'ec2:AssociateNatGatewayAddress': byDesign(
    'CloudFormation waits, cdkd deliberately does not: the gateway keeps serving its other zones (ec2/nat-gateway.ts comment, measured on #2762)'
  ),
  'ec2:AssociateRouteTable': byDesign(
    'settled when AWS answers: AssociationState associated in the response and on the first DescribeRouteTables read (7 of 7) (#7132)'
  ),
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
  'ec2:CreateSubnet': byDesign(
    'settled when AWS answers: available in the response and on the first DescribeSubnets read (7 of 7); the IPv6 association and attribute read-back waits stay (#7132)'
  ),
  'ec2:CreateVpc': byDesign(
    'settled when AWS answers: the response says pending, but DescribeVpcs read right after the call returns available (7 of 7, ~0.4 s read latency) (#7132)'
  ),
  'ec2:CreateVpcEndpoint': waits(
    ['waitForSettled'],
    ['failed', 'rejected', 'expired', 'partial', 'deleting', 'deleted'],
    DEFERRED
  ),
  'ec2:DetachVolume': waits(['waitForVolumeAttachment'], []),
  'ec2:DisassociateIamInstanceProfile': waits(
    ['waitForInstanceProfileAssociationSettled'],
    [],
    'waits until the association is gone (~0.8 s); --no-wait skips it (docs/cli-deploy.md) (#7132)'
  ),
  'ec2:DisassociateNatGatewayAddress': byDesign(
    'CloudFormation waits, cdkd deliberately does not: the gateway keeps serving its other zones (ec2/nat-gateway.ts comment, measured on #2762)'
  ),
  'ec2:ModifyInstanceMetadataOptions': waits(
    ['waitForInstanceMetadataOptionsSettled'],
    [],
    'waits for State applied (pending ~0.8 s in 1 of 8 trials); --no-wait skips it (docs/cli-deploy.md); CloudFormation\'s update step read applied (#7132)'
  ),
  'ec2:ReplaceIamInstanceProfileAssociation': waits(
    ['waitForInstanceProfileAssociationSettled'],
    ['the new association reads disassociated'],
    'the new association reads associating ~0.8 s; --no-wait skips it (docs/cli-deploy.md); CloudFormation\'s update step read it associated (#7132)'
  ),
  'ec2:StartInstances': waits(
    ['waitForInstanceState'],
    ['terminated', 'shutting-down'],
    `${DEFERRED}; the restart of an instance cdkd stopped, and the best-effort restart after a failure, do not wait`
  ),
  'ecs:CreateCluster': waits(
    ['waitForClusterSettled'],
    ['FAILED', 'UPDATE_FAILED', 'INACTIVE / DEPROVISIONING'],
    'only a ServiceConnectDefaults create (PROVISIONING / attachments UPDATE_IN_PROGRESS ~20 s) or an in-progress answer; --no-wait skips it (docs/cli-deploy.md); CloudFormation\'s create completed ACTIVE / UPDATE_COMPLETE (#7132)'
  ),
  'ecs:CreateService': waits(
    ['settleService'],
    ['MISSING', 'DRAINING', 'INACTIVE', 'a FAILED deployment'],
    `${DEFERRED}; a non-ECS deployment controller skips it`
  ),
  'ecs:DeleteCluster': byDesign(
    'settled when AWS answers: DescribeClusters reads INACTIVE on the first read and a same-named cluster can be created at once (3 of 3) (#7132)'
  ),
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
  'ecs:UpdateCluster': waits(
    ['sendWhenAttachmentsSettle', 'waitForClusterSettled'],
    ['FAILED', 'UPDATE_FAILED after an in-progress read', 'INACTIVE / DEPROVISIONING'],
    'waits before the send for an earlier attachment change, and after it only for a ServiceConnectDefaults change (~14 s) or an in-progress answer; settings-only updates read ACTIVE at once; --no-wait skips it (docs/cli-deploy.md) (#7132)'
  ),
  'ecs:UpdateService': waits(
    ['settleService'],
    ['MISSING', 'DRAINING', 'INACTIVE', 'a FAILED deployment'],
    `${DEFERRED}; drift revert, a non-ECS controller and the scale-down before a delete skip it`
  ),
  'efs:CreateAccessPoint': waits(
    ['waitForAccessPointAvailable'],
    ['error', 'deleting', 'deleted'],
    'creating ~1-2 s; --no-wait skips it (docs/cli-deploy.md); CloudFormation\'s create completed with the access point available (#7132)'
  ),
  'efs:CreateFileSystem': waits(['waitForFileSystemAvailable'], []),
  'efs:CreateMountTarget': waits(['waitForMountTargetAvailable'], []),
  'efs:PutBackupPolicy': waits(
    ['waitForBackupPolicySettled'],
    ['the opposite status after the stale-read grace'],
    'ENABLING / DISABLING ~2 s, create and update; --no-wait skips it (docs/cli-deploy.md); CloudFormation\'s update read the new status right after (#7132)'
  ),
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
  'glue:CreateConnection': byDesign(
    'settled when AWS answers: GetConnection reads a JDBC or NETWORK connection with no Status on the first read (3 of 3 each); only managed connector types carry one (#7132)'
  ),
  'glue:StartCrawlerSchedule': byDesign(
    'sent by no create / update / delete (only the exported startSchedule()); settled when AWS answers: GetCrawler read SCHEDULED on the first read after the call (3 of 3) (#7132)'
  ),
  'glue:StartTrigger': byDesign(
    'settled when AWS answers: GetTrigger read ACTIVATED on the first read after the call (3 of 3, ~0.2 s); CloudFormation completes an update with the trigger ACTIVATED (#7132)'
  ),
  'glue:UpdateTrigger': byDesign(
    'settled when AWS answers: GetTrigger reads the new definition on the first read, and the StartTrigger after it reads ACTIVATED at once (#7132)'
  ),
  'kinesis:RegisterStreamConsumer': waits(
    ['waitForConsumerActive'],
    ['any status other than CREATING / ACTIVE']
  ),
  'kinesis:StartStreamEncryption': waits(
    ['waitForStreamActive'],
    ['any status other than ACTIVE / CREATING / UPDATING']
  ),
  'kms:CreateKey': byDesign(
    'settled when AWS answers: DescribeKey reads KeyState Enabled on the first read, symmetric and RSA_2048 (3 of 3) (#7132)'
  ),
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
  'lambda:CreateEventSourceMapping': waits(
    ['waitForMappingSettled'],
    ['Deleting / an unknown state'],
    '--no-wait skips it (docs/cli-deploy.md); CloudFormation completes only once the mapping leaves Creating (#7132); Disabled where Enabled was asked: warns, unmeasured'
  ),
  'lambda:CreateFunction': byDesign(
    'Pending is accepted by every dependent except a synchronous invoke and a Lambda target group, which wait themselves; waiting for Active doubled benchmark deploys (lambda-function/create.ts comment, #5002); a capacity-provider or RuntimeManagementConfig create waits'
  ),
  'lambda:DeleteEventSourceMapping': byDesign(
    'CloudFormation does not wait either: DELETE_COMPLETE after 1.75 s while the mapping read Deleting for ~5-9 s; only a same function + source re-create is refused meanwhile, which create retries (#7011) (#7132)'
  ),
  'lambda:PublishVersion': waits(['waitForLatestPublishedSettled'], ['Failed']),
  'lambda:PutFunctionScalingConfig': waits(['waitForLatestPublishedSettled'], ['Failed']),
  'lambda:UpdateEventSourceMapping': waits(
    ['waitForMappingSettled'],
    ['Deleting / an unknown state'],
    '--no-wait skips it (docs/cli-deploy.md); CloudFormation completes only once the mapping leaves Updating (#7132); the opposite of a sent Enabled: warns, unmeasured'
  ),
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
  'neptune:CreateDBSubnetGroup': byDesign(
    'settled when AWS answers: the create response and the first DescribeDBSubnetGroups read SubnetGroupStatus Complete (3 of 3); there is no transitional state (#7132)'
  ),
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
  'neptune:ModifyDBSubnetGroup': byDesign(
    'settled when AWS answers: the response and the first DescribeDBSubnetGroups read SubnetGroupStatus Complete with the new subnets (3 of 3) (#7132)'
  ),
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
  'rds:CreateDBSubnetGroup': byDesign(
    'settled when AWS answers: the create response and the first DescribeDBSubnetGroups read SubnetGroupStatus Complete (3 of 3); there is no transitional state (#7132)'
  ),
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
  'rds:ModifyDBSubnetGroup': byDesign(
    'settled when AWS answers: the response and the first DescribeDBSubnetGroups read SubnetGroupStatus Complete with the new subnets (3 of 3) (#7132)'
  ),
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
  'route-53:AssociateVPCWithHostedZone': waits(
    ['waitForRoute53ChangeInsync'],
    [],
    '--full-wait only, by maintainer decision on #7132: the default and --no-wait return while PENDING, as for CloudFront Deployed (#1282) — drift reads the change at once, PENDING has no failure state, and dependent Route 53 calls are accepted meanwhile; a cap or deadline warns; PENDING ~80 s; CloudFormation\'s VPCs update waited ~103 s'
  ),
  'route-53:ChangeResourceRecordSets': waits(
    ['waitForRoute53ChangeInsync', 'waitForCertificateIssued'],
    [],
    '--full-wait only, by maintainer decision on #7132: the default and --no-wait return while PENDING, as for CloudFront Deployed (#1282) — drift reads the change at once, PENDING has no failure state, and dependent Route 53 calls are accepted meanwhile; a cap or deadline warns; PENDING ~25-37 s; CloudFormation waits for INSYNC (~32-43 s); an ACM DNS-validation record waits for ISSUED instead, which covers it'
  ),
  'route-53:CreateHostedZone': waits(
    ['waitForRoute53ChangeInsync'],
    [],
    '--full-wait only, by maintainer decision on #7132: the default and --no-wait return while PENDING, as for CloudFront Deployed (#1282) — drift reads the change at once, PENDING has no failure state, and dependent Route 53 calls are accepted meanwhile; a cap or deadline warns; PENDING ~25-30 s; CloudFormation waits for INSYNC (~42 s)'
  ),
  'route-53:DeleteHostedZone': waits(
    ['waitForRoute53ChangeInsync'],
    [],
    '--full-wait only, by maintainer decision on #7132: the default and --no-wait return while PENDING, as for CloudFront Deployed (#1282) — drift reads the change at once, PENDING has no failure state, and dependent Route 53 calls are accepted meanwhile; a cap or deadline warns; CloudFormation waits for INSYNC (~42 s); the failed-create cleanup delete does not wait'
  ),
  'route-53:DisassociateVPCFromHostedZone': waits(
    ['waitForRoute53ChangeInsync'],
    [],
    '--full-wait only, by maintainer decision on #7132: the default and --no-wait return while PENDING, as for CloudFront Deployed (#1282) — drift reads the change at once, PENDING has no failure state, and dependent Route 53 calls are accepted meanwhile; a cap or deadline warns; PENDING ~80 s'
  ),
  's3tables:PutTableBucketReplication': byDesign(
    'settled when AWS answers: the call returns status success and GetTableBucketReplication reads the new configuration on the next call, with no status field (3 of 3) (#7132)'
  ),
  'secrets-manager:CreateSecret': byDesign(
    'CloudFormation does not wait for replication either: its create completed in 0.5 s while ReplicationStatus read InProgress (InSync ~2 s later); without ReplicaRegions there is no status (#7132)'
  ),
  'secrets-manager:RemoveRegionsFromReplication': byDesign(
    'settled when AWS answers: DescribeSecret reads no ReplicationStatus on the first read, and a force delete of the primary right after succeeds (3 of 3) (#7132)'
  ),
  'secrets-manager:ReplicateSecretToRegions': byDesign(
    'CloudFormation does not wait for replication either: adding a replica completed in 1.3 s while ReplicationStatus read InProgress (InSync ~2 s later) (#7132)'
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
  'ec2:MonitorInstances': waits(
    ['waitForInstanceMonitoringSettled'],
    [],
    'DescribeInstances read disabled right after the call (4 of 4), enabled ~0.8 s later; --no-wait skips it (docs/cli-deploy.md); CloudFormation\'s update step read enabled (#7132)'
  ),
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
  'ec2:UnmonitorInstances': waits(
    ['waitForInstanceMonitoringSettled'],
    [],
    'DescribeInstances read enabled right after the call (3 of 4), disabled ~0.8 s later; --no-wait skips it (docs/cli-deploy.md) (#7132)'
  ),
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
  'emr:PutAutoScalingPolicy': waits(
    ['waitForAutoScalingPolicySettled'],
    ['FAILED', 'DETACHING / DETACHED / no policy after the stale-read grace'],
    'create and update; PENDING / ATTACHING for ~10-15 s; --no-wait skips it (docs/cli-deploy.md); CloudFormation\'s update completed with the policy ATTACHED (#7132)'
  ),
  'rds:RegisterDBProxyTargets': unmeasured(`${NO_WAIT} (targets answer REGISTERING)`),
  'route-53:UpdateHostedZoneComment': byDesign(
    'the call changes only the comment; the flagged feature statuses belong to UpdateHostedZoneFeatures'
  ),
  'ssm:CreateAssociation': byDesign(
    'CloudFormation does not wait for the first execution either: the association read Pending right after UPDATE_COMPLETE and Success 67-81 s later (3 of 3) (#7132)'
  ),
};
