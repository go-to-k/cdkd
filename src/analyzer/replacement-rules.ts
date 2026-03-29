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

    // DynamoDB Table
    this.rules.set('AWS::DynamoDB::Table', {
      replacementProperties: new Set([
        'TableName', // Changing table name requires replacement
        'KeySchema', // Changing key schema requires replacement
        'AttributeDefinitions', // Changing attributes (in key) requires replacement
      ]),
      updateableProperties: new Set([
        'BillingMode',
        'ProvisionedThroughput',
        'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes',
        'StreamSpecification',
        'SSESpecification',
        'Tags',
        'TimeToLiveSpecification',
        'PointInTimeRecoverySpecification',
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
