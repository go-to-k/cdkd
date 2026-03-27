import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { getLogger } from '../utils/logger.js';
import { getAwsClients } from '../utils/aws-clients.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceState } from '../types/state.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';

/**
 * Special symbol to represent AWS::NoValue
 *
 * When a property resolves to this symbol, it should be removed from the object.
 * This is used for conditional property omission in CloudFormation templates.
 */
export const AWS_NO_VALUE = Symbol('AWS::NoValue');

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
  /** Evaluated condition values (for Fn::If) */
  conditions?: Record<string, boolean>;
  /** State backend for cross-stack references (Fn::ImportValue) */
  stateBackend?: S3StateBackend;
  /** Current stack name (for Fn::ImportValue to avoid self-reference) */
  stackName?: string;
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
 * - Fn::If (Conditions)
 * - Fn::Equals
 * - Fn::And (logical AND)
 * - Fn::Or (logical OR)
 * - Fn::Not (logical NOT)
 * - Fn::ImportValue (cross-stack references)
 * - Fn::FindInMap (mapping lookups)
 * - Fn::Base64 (base64 encoding)
 * - Fn::GetAZs (availability zone listing)
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
 * Cache for availability zones per region
 */
const cachedAvailabilityZones: Record<string, string[]> = {};

/**
 * Cache for resolved dynamic references (secretsmanager, ssm)
 */
const cachedDynamicReferences: Record<string, string> = {};

/**
 * Get AWS account information from STS
 */
export async function getAccountInfo(): Promise<AwsAccountInfo> {
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
  // Also reset AZ cache
  for (const key of Object.keys(cachedAvailabilityZones)) {
    delete cachedAvailabilityZones[key];
  }
  // Also reset dynamic reference cache
  for (const key of Object.keys(cachedDynamicReferences)) {
    delete cachedDynamicReferences[key];
  }
}

/**
 * CloudFormation Parameter definition
 */
export interface ParameterDefinition {
  Type: string;
  Default?: unknown;
  AllowedValues?: unknown[];
  AllowedPattern?: string;
  MinLength?: number;
  MaxLength?: number;
  MinValue?: number;
  MaxValue?: number;
  Description?: string;
  ConstraintDescription?: string;
  NoEcho?: boolean;
}

export class IntrinsicFunctionResolver {
  private logger = getLogger().child('IntrinsicFunctionResolver');

  /**
   * Resolve parameter values from template Parameters section
   *
   * Merges default values from template with user-provided parameter values.
   * User-provided values take precedence over defaults.
   *
   * @param template CloudFormation template containing Parameters section
   * @param userParameters User-provided parameter values (e.g., from CLI)
   * @returns Record of parameter names to resolved values
   */
  async resolveParameters(
    template: CloudFormationTemplate,
    userParameters?: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const parameters: Record<string, unknown> = {};
    const templateParameters = template.Parameters;

    if (!templateParameters || typeof templateParameters !== 'object') {
      return parameters;
    }

    for (const [name, definition] of Object.entries(templateParameters)) {
      const paramDef = definition as ParameterDefinition;

      // User-provided value takes precedence
      if (userParameters && name in userParameters) {
        const userValue = userParameters[name];
        if (userValue !== undefined) {
          parameters[name] = this.coerceParameterValue(userValue, paramDef.Type);
          this.logger.debug(`Parameter ${name}: using user-provided value ${userValue}`);
          continue;
        }
      }

      // Use default value if available
      if ('Default' in paramDef) {
        // SSM Parameter type: resolve the default value (SSM parameter path) via SSM API
        if (paramDef.Type.startsWith('AWS::SSM::Parameter::Value')) {
          const ssmPath = String(paramDef.Default);
          this.logger.debug(`Parameter ${name}: resolving SSM parameter path ${ssmPath}`);
          const resolved = await this.resolveSSMParameter(ssmPath);
          parameters[name] = resolved;
          this.logger.debug(`Parameter ${name}: resolved SSM value ${resolved}`);
          continue;
        }

        parameters[name] = paramDef.Default;
        this.logger.debug(
          `Parameter ${name}: using default value ${typeof paramDef.Default === 'object' ? JSON.stringify(paramDef.Default) : String(paramDef.Default)}`
        );
        continue;
      }

      // No value provided and no default - this is an error
      throw new Error(
        `Parameter ${name} is required but no value was provided and no default exists`
      );
    }

    return parameters;
  }

  /**
   * Resolve an SSM Parameter Store path to its actual value.
   * Used for parameters with type AWS::SSM::Parameter::Value<...>.
   */
  private async resolveSSMParameter(parameterName: string): Promise<string> {
    const client = getAwsClients().ssm;
    const response = await client.send(new GetParameterCommand({ Name: parameterName }));
    return response.Parameter?.Value ?? '';
  }

  /**
   * Coerce parameter value to the correct type based on parameter definition
   */
  private coerceParameterValue(value: string, type: string): unknown {
    switch (type) {
      case 'Number':
        return Number(value);
      case 'List<Number>':
        return value.split(',').map((v) => Number(v.trim()));
      case 'CommaDelimitedList':
        return value.split(',').map((v) => v.trim());
      case 'String':
      default:
        return value;
    }
  }

  /**
   * Resolve all intrinsic functions in a value
   */
  async resolve(value: unknown, context: ResolverContext): Promise<unknown> {
    return await this.resolveValue(value, context);
  }

  /**
   * Evaluate all conditions in the template
   *
   * Conditions are defined in the Conditions section of the CloudFormation template
   * and can reference parameters and pseudo parameters
   */
  async evaluateConditions(context: ResolverContext): Promise<Record<string, boolean>> {
    const conditions: Record<string, boolean> = {};
    const templateConditions = context.template.Conditions;

    if (!templateConditions || typeof templateConditions !== 'object') {
      return conditions;
    }

    // Evaluate each condition
    for (const [name, definition] of Object.entries(templateConditions)) {
      try {
        const result = await this.resolveValue(definition, context);
        conditions[name] = Boolean(result);
        this.logger.debug(`Evaluated condition ${name} = ${conditions[name]}`);
      } catch (error) {
        this.logger.warn(
          `Failed to evaluate condition ${name}: ${error instanceof Error ? error.message : String(error)}, assuming false`
        );
        conditions[name] = false;
      }
    }

    return conditions;
  }

  /**
   * Recursively resolve a value
   */
  private async resolveValue(value: unknown, context: ResolverContext): Promise<unknown> {
    // Primitives: return as-is (but check strings for dynamic references)
    if (typeof value !== 'object' || value === null) {
      if (typeof value === 'string' && value.includes('{{resolve:')) {
        return await this.resolveDynamicReferences(value);
      }
      return value;
    }

    // Arrays: resolve each element, filtering out AWS::NoValue
    if (Array.isArray(value)) {
      const resolved = await Promise.all(value.map((v) => this.resolveValue(v, context)));
      return resolved.filter((v) => v !== AWS_NO_VALUE);
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

    if ('Fn::If' in obj) {
      return await this.resolveIf(obj['Fn::If'] as [string, unknown, unknown], context);
    }

    if ('Fn::Equals' in obj) {
      return await this.resolveEquals(obj['Fn::Equals'] as [unknown, unknown], context);
    }

    if ('Fn::And' in obj) {
      return await this.resolveAnd(obj['Fn::And'] as unknown[], context);
    }

    if ('Fn::Or' in obj) {
      return await this.resolveOr(obj['Fn::Or'] as unknown[], context);
    }

    if ('Fn::Not' in obj) {
      return await this.resolveNot(obj['Fn::Not'] as [unknown], context);
    }

    if ('Fn::ImportValue' in obj) {
      return await this.resolveImportValue(obj['Fn::ImportValue'], context);
    }

    if ('Fn::FindInMap' in obj) {
      return await this.resolveFindInMap(
        obj['Fn::FindInMap'] as [unknown, unknown, unknown],
        context
      );
    }

    if ('Fn::Base64' in obj) {
      return await this.resolveBase64(obj['Fn::Base64'], context);
    }

    if ('Fn::GetAZs' in obj) {
      return await this.resolveGetAZs(obj['Fn::GetAZs'], context);
    }

    // Not an intrinsic function: recursively resolve object properties
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const resolvedVal = await this.resolveValue(val, context);
      // Skip properties that resolve to AWS::NoValue
      if (resolvedVal !== AWS_NO_VALUE) {
        resolved[key] = resolvedVal;
      } else {
        this.logger.debug(`Property ${key} resolved to AWS::NoValue, omitting from object`);
      }
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
    const pseudoValue = await this.resolvePseudoParameter(logicalId, context);
    if (pseudoValue !== undefined) {
      const valueStr =
        typeof pseudoValue === 'symbol' ? pseudoValue.toString() : String(pseudoValue);
      this.logger.debug(`Resolved Ref to pseudo parameter: ${logicalId} -> ${valueStr}`);
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
    _context: ResolverContext
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

    // CloudWatch Logs Log Group
    if (resourceType === 'AWS::Logs::LogGroup') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:logs:${region}:${accountId}:log-group:${physicalId}:*`;
        default:
          return physicalId;
      }
    }

    // ECS Cluster
    if (resourceType === 'AWS::ECS::Cluster') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:ecs:${region}:${accountId}:cluster/${physicalId}`;
        default:
          return physicalId;
      }
    }

    // EC2 Security Group
    if (resourceType === 'AWS::EC2::SecurityGroup') {
      switch (attributeName) {
        case 'GroupId':
          return physicalId; // Physical ID is already the group ID (sg-xxx)
        case 'VpcId':
          return undefined; // Would need API call
        default:
          return physicalId;
      }
    }

    // EC2 VPC
    if (resourceType === 'AWS::EC2::VPC') {
      switch (attributeName) {
        case 'VpcId':
          return physicalId;
        default:
          return physicalId;
      }
    }

    // EC2 Subnet
    if (resourceType === 'AWS::EC2::Subnet') {
      switch (attributeName) {
        case 'SubnetId':
          return physicalId;
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

    let result = resolvedValues.join(delimiter);
    // Resolve any dynamic references in the joined result
    if (result.includes('{{resolve:')) {
      result = await this.resolveDynamicReferences(result);
    }
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
      if (!varNameStr) {
        continue; // Skip if no capture group
      }

      let replacement: string;

      // Check explicit variables first
      if (varNameStr in variables) {
        replacement = String(variables[varNameStr]);
      } else {
        // Check if it's a pseudo parameter
        const pseudoValue = await this.resolvePseudoParameter(varNameStr, context);
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

    // Resolve any dynamic references in the substituted result
    if (result.includes('{{resolve:')) {
      result = await this.resolveDynamicReferences(result);
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

    const result: unknown = resolvedList[index];
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
   * Resolve Fn::If intrinsic function
   *
   * Fn::If: [conditionName, valueIfTrue, valueIfFalse]
   * Returns valueIfTrue if condition evaluates to true, otherwise valueIfFalse
   */
  private async resolveIf(
    ifArgs: [string, unknown, unknown],
    context: ResolverContext
  ): Promise<unknown> {
    const [conditionName, valueIfTrue, valueIfFalse] = ifArgs;

    // Check if condition is evaluated in context
    if (!context.conditions || !(conditionName in context.conditions)) {
      this.logger.warn(`Condition ${conditionName} not found in context, assuming false`);
      return await this.resolveValue(valueIfFalse, context);
    }

    const conditionValue = context.conditions[conditionName];
    const selectedValue = conditionValue ? valueIfTrue : valueIfFalse;

    this.logger.debug(
      `Resolved Fn::If: condition ${conditionName} = ${conditionValue}, selected ${conditionValue ? 'true' : 'false'} branch`
    );

    return await this.resolveValue(selectedValue, context);
  }

  /**
   * Resolve Fn::Equals intrinsic function
   *
   * Fn::Equals: [value1, value2]
   * Returns true if both values are equal after resolution
   */
  private async resolveEquals(
    equalsArgs: [unknown, unknown],
    context: ResolverContext
  ): Promise<boolean> {
    const [value1, value2] = equalsArgs;

    // Resolve both values
    const resolved1 = await this.resolveValue(value1, context);
    const resolved2 = await this.resolveValue(value2, context);

    // Deep equality check
    const result = JSON.stringify(resolved1) === JSON.stringify(resolved2);

    this.logger.debug(
      `Resolved Fn::Equals: ${JSON.stringify(resolved1)} === ${JSON.stringify(resolved2)} -> ${result}`
    );

    return result;
  }

  /**
   * Resolve Fn::And intrinsic function
   *
   * Returns true if all conditions evaluate to true
   * Syntax: { "Fn::And": [ condition1, condition2, ... ] }
   */
  private async resolveAnd(conditions: unknown[], context: ResolverContext): Promise<boolean> {
    if (!Array.isArray(conditions) || conditions.length < 2 || conditions.length > 10) {
      throw new Error(`Fn::And requires between 2 and 10 conditions, got ${conditions.length}`);
    }

    // Resolve all conditions
    const results: boolean[] = [];
    for (const condition of conditions) {
      const resolved = await this.resolveValue(condition, context);
      results.push(Boolean(resolved));
    }

    // Return true if all are true
    const result = results.every((r) => r === true);

    this.logger.debug(`Resolved Fn::And: [${results.join(', ')}] -> ${result}`);

    return result;
  }

  /**
   * Resolve Fn::Or intrinsic function
   *
   * Returns true if at least one condition evaluates to true
   * Syntax: { "Fn::Or": [ condition1, condition2, ... ] }
   */
  private async resolveOr(conditions: unknown[], context: ResolverContext): Promise<boolean> {
    if (!Array.isArray(conditions) || conditions.length < 2 || conditions.length > 10) {
      throw new Error(`Fn::Or requires between 2 and 10 conditions, got ${conditions.length}`);
    }

    // Resolve all conditions
    const results: boolean[] = [];
    for (const condition of conditions) {
      const resolved = await this.resolveValue(condition, context);
      results.push(Boolean(resolved));
    }

    // Return true if at least one is true
    const result = results.some((r) => r === true);

    this.logger.debug(`Resolved Fn::Or: [${results.join(', ')}] -> ${result}`);

    return result;
  }

  /**
   * Resolve Fn::Not intrinsic function
   *
   * Returns the inverse of the condition
   * Syntax: { "Fn::Not": [ condition ] }
   */
  private async resolveNot(notArgs: [unknown], context: ResolverContext): Promise<boolean> {
    if (!Array.isArray(notArgs) || notArgs.length !== 1) {
      throw new Error(
        `Fn::Not requires exactly one condition, got ${Array.isArray(notArgs) ? notArgs.length : 0}`
      );
    }

    const [condition] = notArgs;

    // Resolve the condition
    const resolved = await this.resolveValue(condition, context);
    const result = !resolved;

    this.logger.debug(`Resolved Fn::Not: ${Boolean(resolved)} -> ${result}`);

    return result;
  }

  /**
   * Resolve Fn::ImportValue (cross-stack references)
   *
   * Searches all other stacks for an exported output with the given name.
   */
  private async resolveImportValue(
    importValueArg: unknown,
    context: ResolverContext
  ): Promise<unknown> {
    // First, resolve the export name (it might contain intrinsic functions)
    const exportName = await this.resolveValue(importValueArg, context);

    if (typeof exportName !== 'string') {
      throw new Error(
        `Fn::ImportValue: export name must resolve to a string, got ${typeof exportName}`
      );
    }

    // Check if we have a state backend
    if (!context.stateBackend) {
      throw new Error('Fn::ImportValue: state backend is required for cross-stack references');
    }

    this.logger.debug(`Resolving Fn::ImportValue: ${exportName}`);

    // List all stacks
    const allStacks = await context.stateBackend.listStacks();
    this.logger.debug(`Found ${allStacks.length} stacks to search for export: ${exportName}`);

    // Search through all stacks for the export
    for (const stackName of allStacks) {
      // Skip the current stack (avoid self-reference)
      if (context.stackName && stackName === context.stackName) {
        this.logger.debug(`Skipping current stack: ${stackName}`);
        continue;
      }

      try {
        const stateData = await context.stateBackend.getState(stackName);
        if (!stateData) {
          this.logger.debug(`No state found for stack: ${stackName}`);
          continue;
        }

        const { state } = stateData;

        // Check if this stack has the export in its outputs
        if (state.outputs && exportName in state.outputs) {
          const value = state.outputs[exportName];
          this.logger.info(
            `Resolved Fn::ImportValue: ${exportName} = ${JSON.stringify(value)} (from stack: ${stackName})`
          );
          return value;
        }
      } catch (error) {
        this.logger.warn(
          `Failed to read state for stack ${stackName}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
    }

    // Export not found in any stack
    throw new Error(
      `Fn::ImportValue: export '${exportName}' not found in any stack. ` +
        `Searched ${allStacks.length} stacks. ` +
        `Make sure the exporting stack has been deployed and the Output has an Export.Name property.`
    );
  }

  /**
   * Resolve Fn::FindInMap intrinsic function
   *
   * Fn::FindInMap: [MapName, TopLevelKey, SecondLevelKey]
   * Looks up a value in the Mappings section of the template
   */
  private async resolveFindInMap(
    findInMapArgs: [unknown, unknown, unknown],
    context: ResolverContext
  ): Promise<unknown> {
    const [rawMapName, rawTopLevelKey, rawSecondLevelKey] = findInMapArgs;

    // Recursively resolve each argument (they could be Refs or other intrinsic functions)
    const mapName = String(await this.resolveValue(rawMapName, context));
    const topLevelKey = String(await this.resolveValue(rawTopLevelKey, context));
    const secondLevelKey = String(await this.resolveValue(rawSecondLevelKey, context));

    // Access the Mappings section of the template
    const mappings = context.template.Mappings;
    if (!mappings) {
      throw new Error(`Fn::FindInMap: no Mappings section found in template`);
    }

    const map = mappings[mapName] as Record<string, Record<string, unknown>> | undefined;
    if (!map) {
      throw new Error(`Fn::FindInMap: mapping '${mapName}' not found in Mappings section`);
    }

    const topLevel = map[topLevelKey];
    if (!topLevel || typeof topLevel !== 'object') {
      throw new Error(
        `Fn::FindInMap: top-level key '${topLevelKey}' not found in mapping '${mapName}'`
      );
    }

    if (!(secondLevelKey in topLevel)) {
      throw new Error(
        `Fn::FindInMap: second-level key '${secondLevelKey}' not found in mapping '${mapName}' -> '${topLevelKey}'`
      );
    }

    const result = topLevel[secondLevelKey];
    this.logger.debug(
      `Resolved Fn::FindInMap: ${mapName}.${topLevelKey}.${secondLevelKey} -> ${JSON.stringify(result)}`
    );
    return result;
  }

  /**
   * Resolve Fn::Base64 intrinsic function
   *
   * Fn::Base64: valueToEncode
   * Returns the Base64 representation of the input string
   */
  private async resolveBase64(value: unknown, context: ResolverContext): Promise<string> {
    // Recursively resolve the value first (it could be another intrinsic function)
    const resolvedValue = await this.resolveValue(value, context);

    if (typeof resolvedValue !== 'string') {
      throw new Error(`Fn::Base64: value must resolve to a string, got ${typeof resolvedValue}`);
    }

    const result = Buffer.from(resolvedValue).toString('base64');
    this.logger.debug(`Resolved Fn::Base64: ${resolvedValue} -> ${result}`);
    return result;
  }

  /**
   * Resolve Fn::GetAZs intrinsic function
   *
   * Fn::GetAZs: region
   * Returns a list of availability zones for the specified region.
   * If region is empty string or {"Ref": "AWS::Region"}, uses the current region.
   * Results are cached per region to avoid repeated API calls.
   */
  private async resolveGetAZs(value: unknown, context: ResolverContext): Promise<string[]> {
    // Recursively resolve the value first (it could be a Ref or other intrinsic function)
    const resolvedValue = await this.resolveValue(value, context);

    let region: string;
    if (typeof resolvedValue === 'string' && resolvedValue !== '') {
      region = resolvedValue;
    } else {
      // Empty string or non-string: use current region
      const accountInfo = await getAccountInfo();
      region = accountInfo.region;
    }

    // Check cache
    const cached = cachedAvailabilityZones[region];
    if (cached) {
      this.logger.debug(`Resolved Fn::GetAZs from cache: ${region} -> ${JSON.stringify(cached)}`);
      return cached;
    }

    // Call EC2 DescribeAvailabilityZones
    const awsClients = getAwsClients();
    const ec2Client = awsClients.ec2;

    try {
      const response = await ec2Client.send(
        new DescribeAvailabilityZonesCommand({
          Filters: [
            {
              Name: 'region-name',
              Values: [region],
            },
            {
              Name: 'state',
              Values: ['available'],
            },
          ],
        })
      );

      const azNames = (response.AvailabilityZones || [])
        .map((az) => az.ZoneName)
        .filter((name): name is string => name !== undefined)
        .sort();

      cachedAvailabilityZones[region] = azNames;
      this.logger.debug(`Resolved Fn::GetAZs: ${region} -> ${JSON.stringify(azNames)}`);
      return azNames;
    } catch (error) {
      throw new Error(
        `Fn::GetAZs: failed to describe availability zones for region '${region}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Resolve pseudo parameters
   *
   * Pseudo parameters are built-in CloudFormation references like AWS::Region
   */
  private async resolvePseudoParameter(
    name: string,
    context?: ResolverContext
  ): Promise<string | symbol | undefined> {
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
        return context?.stackName ?? 'UnknownStack';

      case 'AWS::StackId': {
        // cdkd doesn't use CloudFormation stacks, generate a synthetic ID
        const info = await getAccountInfo();
        return `arn:aws:cloudformation:${info.region}:${info.accountId}:stack/${context?.stackName ?? 'UnknownStack'}/cdkd`;
      }

      case 'AWS::URLSuffix':
        return 'amazonaws.com';

      case 'AWS::NotificationARNs':
        return undefined;

      case 'AWS::NoValue':
        // Return special symbol to indicate property should be omitted
        return AWS_NO_VALUE;

      default:
        return undefined;
    }
  }

  /**
   * Resolve CloudFormation Dynamic References in a string value
   *
   * Supports:
   * - {{resolve:secretsmanager:SECRET_ID:SecretString:JSON_KEY:VERSION_STAGE:VERSION_ID}}
   * - {{resolve:ssm:PARAMETER_NAME}}
   *
   * Results are cached to avoid repeated API calls.
   */
  async resolveDynamicReferences(value: string): Promise<string> {
    // Match all {{resolve:...}} patterns
    const pattern = /\{\{resolve:([^}]+)\}\}/g;
    let result = value;
    let match: RegExpExecArray | null;

    // Collect all matches first (to avoid issues with modifying string during iteration)
    const matches: Array<{ fullMatch: string; inner: string }> = [];
    while ((match = pattern.exec(value)) !== null) {
      matches.push({ fullMatch: match[0], inner: match[1]! });
    }

    for (const { fullMatch, inner } of matches) {
      // Check cache first
      if (fullMatch in cachedDynamicReferences) {
        result = result.replace(fullMatch, cachedDynamicReferences[fullMatch]!);
        continue;
      }

      const parts = inner.split(':');
      const service = parts[0];

      let resolved: string;

      if (service === 'secretsmanager') {
        resolved = await this.resolveSecretsManagerReference(inner);
      } else if (service === 'ssm') {
        resolved = await this.resolveSSMReference(parts);
      } else {
        this.logger.warn(`Unsupported dynamic reference service: ${service}`);
        continue;
      }

      cachedDynamicReferences[fullMatch] = resolved;
      result = result.replace(fullMatch, resolved);
    }

    return result;
  }

  /**
   * Resolve a Secrets Manager dynamic reference
   *
   * Format: secretsmanager:SECRET_ID:SecretString:JSON_KEY:VERSION_STAGE:VERSION_ID
   * SECRET_ID can be a simple name or an ARN (arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME)
   * which contains colons, so we cannot simply split on ':'.
   * Instead, we find ':SecretString:' or ':SecretBinary:' as the delimiter.
   */
  private async resolveSecretsManagerReference(inner: string): Promise<string> {
    // inner = "secretsmanager:SECRET_ID:SecretString:JSON_KEY:VERSION_STAGE:VERSION_ID"
    // Remove the "secretsmanager:" prefix
    const afterService = inner.substring('secretsmanager:'.length);

    // Find :SecretString: or :SecretBinary: as the delimiter between SECRET_ID and the rest
    let secretId: string;
    let jsonKey = '';
    let versionStage = '';
    let versionId = '';

    const secretStringIdx = afterService.indexOf(':SecretString:');
    const secretBinaryIdx = afterService.indexOf(':SecretBinary:');
    const delimiterIdx =
      secretStringIdx >= 0 && secretBinaryIdx >= 0
        ? Math.min(secretStringIdx, secretBinaryIdx)
        : secretStringIdx >= 0
          ? secretStringIdx
          : secretBinaryIdx;
    const delimiterLen =
      delimiterIdx >= 0 && delimiterIdx === secretBinaryIdx
        ? ':SecretBinary:'.length
        : ':SecretString:'.length;

    if (delimiterIdx >= 0) {
      secretId = afterService.substring(0, delimiterIdx);
      // remaining = "JSON_KEY:VERSION_STAGE:VERSION_ID"
      const remaining = afterService.substring(delimiterIdx + delimiterLen);
      const remainingParts = remaining.split(':');
      jsonKey = remainingParts[0] || '';
      versionStage = remainingParts[1] || '';
      versionId = remainingParts[2] || '';
    } else {
      // No :SecretString: or :SecretBinary: found, treat entire afterService as SECRET_ID
      secretId = afterService;
    }

    // Empty strings should be treated as undefined (handles trailing :: in references)
    if (!versionStage) {
      versionStage = 'AWSCURRENT';
    }

    if (!secretId) {
      throw new Error('Dynamic reference: secretsmanager SECRET_ID is required');
    }

    this.logger.debug(
      `Resolving dynamic reference: secretsmanager:${secretId}:SecretString:${jsonKey}:${versionStage}:${versionId}`
    );

    const awsClients = getAwsClients();
    const client = awsClients.secretsManager;

    const command = new GetSecretValueCommand({
      SecretId: secretId,
      ...(versionStage && versionStage !== '' && { VersionStage: versionStage }),
      ...(versionId && versionId !== '' && { VersionId: versionId }),
    });

    const response = await client.send(command);
    const secretString = response.SecretString;

    if (!secretString) {
      throw new Error(
        `Dynamic reference: secret '${secretId}' does not contain a SecretString value`
      );
    }

    // If JSON_KEY is specified, parse JSON and extract the key
    if (jsonKey) {
      try {
        const parsed = JSON.parse(secretString) as Record<string, unknown>;
        const keyValue = parsed[jsonKey];
        if (keyValue === undefined) {
          throw new Error(`Dynamic reference: key '${jsonKey}' not found in secret '${secretId}'`);
        }
        return String(keyValue);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(
            `Dynamic reference: secret '${secretId}' is not valid JSON but JSON_KEY '${jsonKey}' was specified`
          );
        }
        throw error;
      }
    }

    // No JSON_KEY: return full secret string
    return secretString;
  }

  /**
   * Resolve an SSM Parameter Store dynamic reference
   *
   * Format: ssm:PARAMETER_NAME
   * Parts[0] = 'ssm'
   * Parts[1] = PARAMETER_NAME
   */
  private async resolveSSMReference(parts: string[]): Promise<string> {
    const parameterName = parts.slice(1).join(':');

    if (!parameterName) {
      throw new Error('Dynamic reference: ssm PARAMETER_NAME is required');
    }

    this.logger.debug(`Resolving dynamic reference: ssm:${parameterName}`);

    const awsClients = getAwsClients();
    const client = awsClients.ssm;

    const command = new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    });

    const response = await client.send(command);
    const paramValue = response.Parameter?.Value;

    if (paramValue === undefined || paramValue === null) {
      throw new Error(
        `Dynamic reference: SSM parameter '${parameterName}' not found or has no value`
      );
    }

    return paramValue;
  }
}
