import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../utils/logger.js';
import { getAwsClients } from '../utils/aws-clients.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceState } from '../types/state.js';

/**
 * Resolver context for intrinsic functions
 */
export interface ResolverContext {
  /** Template being processed */
  template: CloudFormationTemplate;
  /** Current resource states (for Ref/GetAtt) */
  resources: Record<string, ResourceState>;
  /** Parameter values (for Ref to parameters) */
  parameters?: Record<string, unknown>;
}

/**
 * CloudFormation Intrinsic Function Resolver
 *
 * Resolves CloudFormation intrinsic functions in template values before
 * sending them to Cloud Control API or SDK providers.
 *
 * Supported functions:
 * - Ref (resources and parameters)
 * - Fn::GetAtt
 * - Fn::Join
 * - Fn::Sub
 * - Fn::Select
 * - Fn::Split
 *
 * Not yet supported:
 * - Fn::If, Fn::Equals (Conditions)
 * - Fn::ImportValue
 * - Fn::FindInMap, Fn::GetAZs, Fn::Base64
 */
/**
 * AWS Account information cache
 */
interface AwsAccountInfo {
  accountId: string;
  region: string;
  partition: string;
}

let cachedAccountInfo: AwsAccountInfo | null = null;

/**
 * Get AWS account information from STS
 */
async function getAccountInfo(): Promise<AwsAccountInfo> {
  if (cachedAccountInfo) {
    return cachedAccountInfo;
  }

  const logger = getLogger().child('IntrinsicFunctionResolver');
  const awsClients = getAwsClients();
  const stsClient = awsClients.sts;

  try {
    const response = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = response.Account || '123456789012';
    const region = process.env['AWS_REGION'] || 'us-east-1';
    const partition = 'aws'; // Could be aws-cn, aws-us-gov, etc.

    cachedAccountInfo = { accountId, region, partition };
    logger.debug(`Retrieved AWS account info: ${accountId}, ${region}, ${partition}`);
    return cachedAccountInfo;
  } catch (error) {
    logger.warn(
      `Failed to get AWS account info from STS: ${error instanceof Error ? error.message : String(error)}, using defaults`
    );
    // Fallback to environment variables or defaults
    cachedAccountInfo = {
      accountId: process.env['AWS_ACCOUNT_ID'] || '123456789012',
      region: process.env['AWS_REGION'] || 'us-east-1',
      partition: 'aws',
    };
    return cachedAccountInfo;
  }
}

/**
 * Reset cached account info (useful for testing)
 */
export function resetAccountInfoCache(): void {
  cachedAccountInfo = null;
}

export class IntrinsicFunctionResolver {
  private logger = getLogger().child('IntrinsicFunctionResolver');

  /**
   * Resolve all intrinsic functions in a value
   */
  async resolve(value: unknown, context: ResolverContext): Promise<unknown> {
    return await this.resolveValue(value, context);
  }

  /**
   * Recursively resolve a value
   */
  private async resolveValue(value: unknown, context: ResolverContext): Promise<unknown> {
    // Primitives: return as-is
    if (typeof value !== 'object' || value === null) {
      return value;
    }

    // Arrays: resolve each element
    if (Array.isArray(value)) {
      return await Promise.all(value.map((v) => this.resolveValue(v, context)));
    }

    const obj = value as Record<string, unknown>;

    // Check for intrinsic functions
    if ('Ref' in obj) {
      return await this.resolveRef(obj['Ref'] as string, context);
    }

    if ('Fn::GetAtt' in obj) {
      return await this.resolveGetAtt(obj['Fn::GetAtt'] as [string, string] | string, context);
    }

    if ('Fn::Join' in obj) {
      return await this.resolveJoin(obj['Fn::Join'] as [string, unknown[]], context);
    }

    if ('Fn::Sub' in obj) {
      return await this.resolveSub(
        obj['Fn::Sub'] as string | [string, Record<string, unknown>],
        context
      );
    }

    if ('Fn::Select' in obj) {
      return await this.resolveSelect(obj['Fn::Select'] as [number, unknown[]], context);
    }

    if ('Fn::Split' in obj) {
      return await this.resolveSplit(obj['Fn::Split'] as [string, unknown], context);
    }

    // Not an intrinsic function: recursively resolve object properties
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      resolved[key] = await this.resolveValue(val, context);
    }
    return resolved;
  }

  /**
   * Resolve Ref intrinsic function
   *
   * Ref can reference:
   * 1. Resources (returns physical ID)
   * 2. Parameters (returns parameter value)
   * 3. Pseudo parameters (AWS::Region, AWS::AccountId, etc.)
   */
  private async resolveRef(logicalId: string, context: ResolverContext): Promise<unknown> {
    // Check if it's a resource
    const resource = context.resources[logicalId];
    if (resource) {
      this.logger.debug(`Resolved Ref to resource: ${logicalId} -> ${resource.physicalId}`);
      return resource.physicalId;
    }

    // Check if it's a parameter
    if (context.parameters && logicalId in context.parameters) {
      const value = context.parameters[logicalId];
      this.logger.debug(
        `Resolved Ref to parameter: ${logicalId} -> ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
      );
      return value;
    }

    // Check if it's a pseudo parameter
    const pseudoValue = await this.resolvePseudoParameter(logicalId);
    if (pseudoValue !== undefined) {
      this.logger.debug(`Resolved Ref to pseudo parameter: ${logicalId} -> ${pseudoValue}`);
      return pseudoValue;
    }

    // Not found
    this.logger.warn(`Ref ${logicalId} not found (not a resource, parameter, or pseudo parameter)`);
    throw new Error(`Ref ${logicalId} not found`);
  }

  /**
   * Resolve Fn::GetAtt intrinsic function
   */
  private async resolveGetAtt(
    getAtt: [string, string] | string,
    context: ResolverContext
  ): Promise<unknown> {
    // Fn::GetAtt can be either [LogicalId, AttributeName] or "LogicalId.AttributeName"
    let logicalId: string;
    let attributeName: string;

    if (Array.isArray(getAtt)) {
      [logicalId, attributeName] = getAtt;
    } else {
      const parts = getAtt.split('.');
      if (parts.length !== 2) {
        throw new Error(`Invalid Fn::GetAtt format: ${getAtt}`);
      }
      [logicalId, attributeName] = parts as [string, string];
    }

    const resource = context.resources[logicalId];
    if (!resource) {
      throw new Error(`Resource ${logicalId} not found for Fn::GetAtt`);
    }

    // Check if attribute exists in resource.attributes
    if (resource.attributes?.[attributeName] !== undefined) {
      const value = resource.attributes[attributeName];
      this.logger.debug(
        `Resolved Fn::GetAtt from attributes: ${logicalId}.${attributeName} -> ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
      );
      return value;
    }

    // Construct attribute value based on resource type
    const value = await this.constructAttribute(resource, attributeName, context);
    this.logger.debug(
      `Resolved Fn::GetAtt: ${logicalId}.${attributeName} -> ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    );
    return value;
  }

  /**
   * Construct resource attribute value based on resource type
   *
   * Many CloudFormation attributes are not returned by Cloud Control API,
   * so we need to construct them manually.
   */
  private async constructAttribute(
    resource: ResourceState,
    attributeName: string,
    context: ResolverContext
  ): Promise<unknown> {
    const { resourceType, physicalId } = resource;
    const accountInfo = await getAccountInfo();
    const { region, accountId, partition } = accountInfo;

    // DynamoDB Table
    if (resourceType === 'AWS::DynamoDB::Table') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:dynamodb:${region}:${accountId}:table/${physicalId}`;
        case 'StreamArn':
          // Stream ARN would need to be fetched from API
          return undefined;
        default:
          return physicalId;
      }
    }

    // S3 Bucket
    if (resourceType === 'AWS::S3::Bucket') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:s3:::${physicalId}`;
        case 'DomainName':
          return `${physicalId}.s3.amazonaws.com`;
        case 'RegionalDomainName':
          return `${physicalId}.s3.${region}.amazonaws.com`;
        case 'WebsiteURL':
          return `http://${physicalId}.s3-website-${region}.amazonaws.com`;
        default:
          return physicalId;
      }
    }

    // IAM Role
    if (resourceType === 'AWS::IAM::Role') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:iam::${accountId}:role/${physicalId}`;
        case 'RoleId':
          // Role ID would need to be fetched from API
          return undefined;
        default:
          return physicalId;
      }
    }

    // IAM Policy
    if (resourceType === 'AWS::IAM::Policy') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:iam::${accountId}:policy/${physicalId}`;
        case 'PolicyId':
          // Policy ID would need to be fetched from API
          return undefined;
        default:
          return physicalId;
      }
    }

    // Lambda Function
    if (resourceType === 'AWS::Lambda::Function') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:lambda:${region}:${accountId}:function:${physicalId}`;
        default:
          return physicalId;
      }
    }

    // SQS Queue
    if (resourceType === 'AWS::SQS::Queue') {
      // Physical ID for SQS Queue is the queue URL
      // Extract queue name from URL: https://sqs.region.amazonaws.com/accountId/queueName
      let queueName = physicalId;
      if (physicalId.startsWith('https://')) {
        const parts = physicalId.split('/');
        queueName = parts[parts.length - 1] || physicalId;
      }

      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:sqs:${region}:${accountId}:${queueName}`;
        case 'QueueUrl':
          return physicalId; // Physical ID is already the queue URL
        case 'QueueName':
          return queueName;
        default:
          return physicalId;
      }
    }

    // SNS Topic
    if (resourceType === 'AWS::SNS::Topic') {
      switch (attributeName) {
        case 'TopicArn':
          return `arn:${partition}:sns:${region}:${accountId}:${physicalId}`;
        default:
          return physicalId;
      }
    }

    // Default: return physical ID
    this.logger.warn(
      `Unknown attribute ${attributeName} for resource type ${resourceType}, returning physical ID`
    );
    return physicalId;
  }

  /**
   * Resolve Fn::Join intrinsic function
   *
   * Fn::Join: [delimiter, [value1, value2, ...]]
   */
  private async resolveJoin(
    joinArgs: [string, unknown[]],
    context: ResolverContext
  ): Promise<string> {
    const [delimiter, values] = joinArgs;

    // Resolve each value first
    const resolvedValues = await Promise.all(
      values.map(async (v) => {
        const resolved = await this.resolveValue(v, context);
        return String(resolved);
      })
    );

    const result = resolvedValues.join(delimiter);
    this.logger.debug(`Resolved Fn::Join: ${result}`);
    return result;
  }

  /**
   * Resolve Fn::Sub intrinsic function
   *
   * Fn::Sub supports two forms:
   * 1. String with ${VarName} placeholders
   * 2. [String, {VarName: value, ...}] with explicit variable mapping
   *
   * Note: This is a simplified implementation that doesn't handle async properly
   * inside replace(). For full async support, we'd need to collect all replacements
   * first, then do them synchronously.
   */
  private async resolveSub(
    subArgs: string | [string, Record<string, unknown>],
    context: ResolverContext
  ): Promise<string> {
    let template: string;
    let variables: Record<string, unknown> = {};

    if (Array.isArray(subArgs)) {
      [template, variables] = subArgs;
      // Resolve variable values
      for (const [key, val] of Object.entries(variables)) {
        variables[key] = await this.resolveValue(val, context);
      }
    } else {
      template = subArgs;
    }

    // Collect all replacements
    const replacements: Array<{ match: string; replacement: string }> = [];
    const matches = template.matchAll(/\$\{([^}]+)\}/g);

    for (const match of matches) {
      const varNameStr = match[1];
      let replacement: string;

      // Check explicit variables first
      if (varNameStr in variables) {
        replacement = String(variables[varNameStr]);
      } else {
        // Check if it's a pseudo parameter
        const pseudoValue = await this.resolvePseudoParameter(varNameStr);
        if (pseudoValue !== undefined) {
          replacement = String(pseudoValue);
        } else {
          // Try to resolve as Ref
          try {
            const value = await this.resolveRef(varNameStr, context);
            replacement = String(value);
          } catch {
            // If not found, try to resolve as GetAtt (e.g., "Resource.Attribute")
            if (varNameStr.includes('.')) {
              try {
                const value = await this.resolveGetAtt(varNameStr, context);
                replacement = String(value);
              } catch {
                this.logger.warn(`Fn::Sub variable ${varNameStr} not found, keeping placeholder`);
                replacement = match[0]; // Keep original placeholder
              }
            } else {
              this.logger.warn(`Fn::Sub variable ${varNameStr} not found, keeping placeholder`);
              replacement = match[0]; // Keep original placeholder
            }
          }
        }
      }

      replacements.push({ match: match[0], replacement });
    }

    // Apply all replacements
    let result = template;
    for (const { match, replacement } of replacements) {
      result = result.replace(match, replacement);
    }

    this.logger.debug(`Resolved Fn::Sub: ${result}`);
    return result;
  }

  /**
   * Resolve Fn::Select intrinsic function
   *
   * Fn::Select: [index, [value1, value2, ...]]
   * Returns the value at the specified index in the list
   */
  private async resolveSelect(
    selectArgs: [number, unknown[]],
    context: ResolverContext
  ): Promise<unknown> {
    const [index, list] = selectArgs;

    // Resolve the list first
    const resolvedList = await this.resolveValue(list, context);

    if (!Array.isArray(resolvedList)) {
      throw new Error(`Fn::Select: list must be an array, got ${typeof resolvedList}`);
    }

    if (index < 0 || index >= resolvedList.length) {
      throw new Error(
        `Fn::Select: index ${index} out of bounds (array length: ${resolvedList.length})`
      );
    }

    const result = resolvedList[index];
    this.logger.debug(`Resolved Fn::Select: index ${index} -> ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * Resolve Fn::Split intrinsic function
   *
   * Fn::Split: [delimiter, string]
   * Splits a string into a list of strings using the specified delimiter
   */
  private async resolveSplit(
    splitArgs: [string, unknown],
    context: ResolverContext
  ): Promise<string[]> {
    const [delimiter, value] = splitArgs;

    // Resolve the value first
    const resolvedValue = await this.resolveValue(value, context);

    if (typeof resolvedValue !== 'string') {
      throw new Error(`Fn::Split: value must be a string, got ${typeof resolvedValue}`);
    }

    const result = resolvedValue.split(delimiter);
    this.logger.debug(`Resolved Fn::Split: split by "${delimiter}" -> ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * Resolve pseudo parameters
   *
   * Pseudo parameters are built-in CloudFormation references like AWS::Region
   */
  private async resolvePseudoParameter(name: string): Promise<string | undefined> {
    switch (name) {
      case 'AWS::Region': {
        const accountInfo = await getAccountInfo();
        return accountInfo.region;
      }

      case 'AWS::AccountId': {
        const accountInfo = await getAccountInfo();
        return accountInfo.accountId;
      }

      case 'AWS::Partition': {
        const accountInfo = await getAccountInfo();
        return accountInfo.partition;
      }

      case 'AWS::StackName':
        // Stack name should be passed in context if needed
        return undefined;

      case 'AWS::StackId':
        // We don't use CloudFormation, so no stack ID
        return undefined;

      case 'AWS::URLSuffix':
        return 'amazonaws.com';

      case 'AWS::NotificationARNs':
        return undefined;

      case 'AWS::NoValue':
        return undefined;

      default:
        return undefined;
    }
  }
}
