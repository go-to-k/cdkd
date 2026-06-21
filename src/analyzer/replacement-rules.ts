/**
 * Replacement rules for AWS resource types
 *
 * Defines which property changes require resource replacement (delete + recreate)
 * vs. in-place updates.
 *
 * Based on CloudFormation update behaviors:
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-update-behaviors.html
 */

import { getLogger } from '../utils/logger.js';

/**
 * Resource replacement rule
 */
interface ReplacementRule {
  /** Properties that always require replacement when changed */
  replacementProperties: Set<string>;
  /** Properties that never require replacement */
  updateableProperties?: Set<string>;
  /** Custom logic for conditional replacement */
  conditionalReplacements?: Map<string, (oldValue: unknown, newValue: unknown) => boolean>;
}

/**
 * Conditional-replacement predicate for `AWS::DynamoDB::Table.AttributeDefinitions`.
 *
 * Returns true only when an attribute present in BOTH the old and new definition
 * lists changed its `AttributeType` (e.g. `S` -> `N`). Adding a brand-new attribute
 * (to back a new GSI) or removing one (when a GSI is dropped) returns false — those
 * are in-place `UpdateTable` operations, matching CloudFormation's "No interruption"
 * update behavior for this property.
 */
export function attributeTypeChangedForSharedAttribute(
  oldValue: unknown,
  newValue: unknown
): boolean {
  const toTypeMap = (value: unknown): Map<string, string> => {
    const map = new Map<string, string>();
    if (Array.isArray(value)) {
      for (const def of value) {
        if (def && typeof def === 'object') {
          const name = (def as Record<string, unknown>)['AttributeName'];
          const type = (def as Record<string, unknown>)['AttributeType'];
          if (typeof name === 'string' && typeof type === 'string') {
            map.set(name, type);
          }
        }
      }
    }
    return map;
  };

  const oldTypes = toTypeMap(oldValue);
  const newTypes = toTypeMap(newValue);
  for (const [name, oldType] of oldTypes) {
    const newType = newTypes.get(name);
    if (newType !== undefined && newType !== oldType) {
      return true;
    }
  }
  return false;
}

/**
 * Replacement rules registry
 *
 * Maps resource types to their replacement rules
 */
export class ReplacementRulesRegistry {
  private logger = getLogger().child('ReplacementRulesRegistry');
  private rules = new Map<string, ReplacementRule>();

  constructor() {
    this.initializeRules();
  }

  /**
   * Check if a property change requires replacement
   */
  requiresReplacement(
    resourceType: string,
    propertyPath: string,
    oldValue: unknown,
    newValue: unknown
  ): boolean {
    const rule = this.rules.get(resourceType);

    if (!rule) {
      // No specific rule for this resource type
      // Conservative approach: assume replacement may be required
      this.logger.debug(
        `No replacement rule for ${resourceType}, conservatively assuming replacement may be required for ${propertyPath}`
      );
      return false; // Default to updateable for unknown types
    }

    // Check if property always requires replacement
    if (rule.replacementProperties.has(propertyPath)) {
      this.logger.debug(`Property ${propertyPath} of ${resourceType} requires replacement`);
      return true;
    }

    // Check if property is explicitly updateable
    if (rule.updateableProperties?.has(propertyPath)) {
      return false;
    }

    // Check conditional replacements
    if (rule.conditionalReplacements?.has(propertyPath)) {
      const condition = rule.conditionalReplacements.get(propertyPath);
      if (condition) {
        const requires = condition(oldValue, newValue);
        this.logger.debug(
          `Conditional replacement for ${propertyPath} of ${resourceType}: ${requires}`
        );
        return requires;
      }
    }

    // If not explicitly defined, assume it's updateable
    return false;
  }

  /**
   * Initialize replacement rules for common AWS resource types
   */
  private initializeRules(): void {
    // S3 Bucket
    this.rules.set('AWS::S3::Bucket', {
      replacementProperties: new Set([
        'BucketName', // Changing bucket name requires replacement
      ]),
      updateableProperties: new Set([
        'Tags',
        'VersioningConfiguration',
        'LifecycleConfiguration',
        'PublicAccessBlockConfiguration',
        'BucketEncryption',
        'LoggingConfiguration',
        'WebsiteConfiguration',
        'CorsConfiguration',
        'NotificationConfiguration',
      ]),
    });

    // Lambda Function
    this.rules.set('AWS::Lambda::Function', {
      replacementProperties: new Set([
        'FunctionName', // Changing function name requires replacement
      ]),
      updateableProperties: new Set([
        'Code',
        'Handler',
        'Runtime',
        'Description',
        'Timeout',
        'MemorySize',
        'Role',
        'Environment',
        'Tags',
        'VpcConfig',
        'DeadLetterConfig',
        'TracingConfig',
        'Layers',
        'FileSystemConfigs',
      ]),
    });

    // Lambda LayerVersion — fully immutable on AWS. There is no
    // UpdateLayerVersion API; every property change requires a fresh
    // PublishLayerVersion (a new version with a new LayerVersionArn). In
    // CloudFormation EVERY property of AWS::Lambda::LayerVersion is
    // "Update requires: Replacement", so a content/runtime/name change
    // must drive a replacement (and `promoteReplacementDependents` then
    // re-points any consuming function at the new version ARN), matching
    // `cdk deploy`'s transparent layer-version bump. Without this rule the
    // change is misclassified as an in-place update and the provider's
    // update() hard-fails with an "immutable" error (issue surfaced by a
    // LayerVersion content change being undeployable).
    this.rules.set('AWS::Lambda::LayerVersion', {
      replacementProperties: new Set([
        'Content',
        'LayerName',
        'Description',
        'CompatibleRuntimes',
        'CompatibleArchitectures',
        'LicenseInfo',
      ]),
    });

    // Lambda Version — a published version is a point-in-time snapshot, so
    // all five of its CREATE-ONLY properties (`FunctionName` / `Description` /
    // `CodeSha256` / `ProvisionedConcurrencyConfig` / `RuntimePolicy`) are
    // "Update requires: Replacement" in CloudFormation; a change to any of
    // them publishes a new version. (The registry schema also exposes one
    // in-place-mutable property, `FunctionScalingConfig` — deliberately left
    // OUT of this set so a change to it is NOT misclassified as a
    // replacement.) CDK normally bumps the Version's logical id on code change
    // (create-new + delete-old) so this rule rarely fires, but a hand-authored
    // template that edits a create-only Version property in place would
    // otherwise be misclassified as an updateable change.
    this.rules.set('AWS::Lambda::Version', {
      replacementProperties: new Set([
        'CodeSha256',
        'Description',
        'FunctionName',
        'ProvisionedConcurrencyConfig',
        'RuntimePolicy',
      ]),
    });

    // DynamoDB Table
    this.rules.set('AWS::DynamoDB::Table', {
      replacementProperties: new Set([
        'TableName', // Changing table name requires replacement
        'KeySchema', // Changing the table's primary key requires replacement
      ]),
      updateableProperties: new Set([
        'BillingMode',
        'ProvisionedThroughput',
        // Adding / removing a Global Secondary Index is an in-place UpdateTable
        // (one GSI per call, async) — NOT a replacement. The provider's update()
        // applies these via GlobalSecondaryIndexUpdates.
        'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes',
        'StreamSpecification',
        'SSESpecification',
        'Tags',
        'TimeToLiveSpecification',
        'PointInTimeRecoverySpecification',
      ]),
      conditionalReplacements: new Map([
        // AttributeDefinitions is NOT a blanket replacement trigger. CloudFormation's
        // update behavior for it is "No interruption": adding an attribute (to back a
        // new GSI) or removing one (when a GSI is dropped) is an in-place update. The
        // ONLY case needing replacement is changing the TYPE of an attribute that
        // exists on both sides — DynamoDB rejects an in-place type change on an
        // attribute that participates in the table key or an index. A key attribute
        // NAME change instead surfaces as a KeySchema diff (handled above).
        ['AttributeDefinitions', attributeTypeChangedForSharedAttribute],
      ]),
    });

    // SQS Queue
    this.rules.set('AWS::SQS::Queue', {
      replacementProperties: new Set([
        'QueueName', // Changing queue name requires replacement
        'FifoQueue', // Changing FIFO attribute requires replacement
        'ContentBasedDeduplication', // Only for FIFO queues
      ]),
      updateableProperties: new Set([
        'DelaySeconds',
        'MaximumMessageSize',
        'MessageRetentionPeriod',
        'ReceiveMessageWaitTimeSeconds',
        'VisibilityTimeout',
        'RedrivePolicy',
        'Tags',
      ]),
    });

    // IAM Role
    this.rules.set('AWS::IAM::Role', {
      replacementProperties: new Set([
        'RoleName', // Changing role name requires replacement
      ]),
      updateableProperties: new Set([
        'AssumeRolePolicyDocument',
        'Description',
        'ManagedPolicyArns',
        'MaxSessionDuration',
        'Path',
        'PermissionsBoundary',
        'Policies',
        'Tags',
      ]),
    });

    // SNS Topic
    this.rules.set('AWS::SNS::Topic', {
      replacementProperties: new Set([
        'TopicName', // Changing topic name requires replacement
      ]),
      updateableProperties: new Set(['DisplayName', 'Subscription', 'KmsMasterKeyId', 'Tags']),
    });

    // ECR Repository
    this.rules.set('AWS::ECR::Repository', {
      replacementProperties: new Set([
        'RepositoryName', // Changing repository name requires replacement
      ]),
      updateableProperties: new Set([
        'ImageScanningConfiguration',
        'ImageTagMutability',
        'LifecyclePolicy',
        'RepositoryPolicyText',
        'Tags',
      ]),
    });

    // CloudWatch Log Group
    this.rules.set('AWS::Logs::LogGroup', {
      replacementProperties: new Set([
        'LogGroupName', // Changing log group name requires replacement
      ]),
      updateableProperties: new Set(['RetentionInDays', 'KmsKeyId']),
    });

    // API Gateway RestApi
    this.rules.set('AWS::ApiGateway::RestApi', {
      replacementProperties: new Set([
        'Name', // Changing API name can require replacement in some cases
      ]),
      updateableProperties: new Set([
        'Description',
        'Policy',
        'EndpointConfiguration',
        'BinaryMediaTypes',
        'MinimumCompressionSize',
        'Tags',
      ]),
    });

    // RDS DBProxy — EngineFamily + VpcSubnetIds + DBProxyName are immutable on
    // AWS. ModifyDBProxy only accepts Auth / RequireTLS / IdleClientTimeout /
    // DebugLogging / RoleArn / SecurityGroups (+ NewDBProxyName rename, which
    // cdkd does not implement). A diff in any other field needs replacement.
    this.rules.set('AWS::RDS::DBProxy', {
      replacementProperties: new Set(['DBProxyName', 'EngineFamily', 'VpcSubnetIds']),
    });

    // RDS DBProxyEndpoint — DBProxyName + DBProxyEndpointName + VpcSubnetIds +
    // TargetRole are immutable. ModifyDBProxyEndpoint only accepts
    // VpcSecurityGroupIds (+ rename, not implemented).
    this.rules.set('AWS::RDS::DBProxyEndpoint', {
      replacementProperties: new Set([
        'DBProxyName',
        'DBProxyEndpointName',
        'VpcSubnetIds',
        'TargetRole',
      ]),
    });

    // RDS DBProxyTargetGroup — DBProxyName + TargetGroupName are identity
    // fields. AWS rejects modifications to them; only ConnectionPoolConfig +
    // registered targets (Cluster/Instance Identifiers) are mutable.
    this.rules.set('AWS::RDS::DBProxyTargetGroup', {
      replacementProperties: new Set(['DBProxyName', 'TargetGroupName']),
    });

    // EC2 Instance — EbsOptimized can only be changed on a STOPPED instance
    // (a running instance returns IncorrectInstanceState), and cdkd does not
    // stop/start instances, so an EbsOptimized change is routed to replacement
    // (the create path sets it on the new instance). The other four #609
    // security-backfill props (DisableApiTermination / Monitoring /
    // MetadataOptions / CreditSpecification) ARE mutable in-place on a running
    // instance and are handled by EC2Provider.updateInstanceSecurityProps.
    this.rules.set('AWS::EC2::Instance', {
      replacementProperties: new Set(['EbsOptimized']),
    });

    // ECS Task Definition
    this.rules.set('AWS::ECS::TaskDefinition', {
      replacementProperties: new Set([
        // Task definitions are immutable - any change requires replacement
        'Family',
        'ContainerDefinitions',
        'Cpu',
        'Memory',
        'NetworkMode',
        'RequiresCompatibilities',
        'ExecutionRoleArn',
        'TaskRoleArn',
        'Volumes',
      ]),
    });

    // Add more resource types as needed
    this.logger.debug(`Initialized replacement rules for ${this.rules.size} resource types`);
  }
}
