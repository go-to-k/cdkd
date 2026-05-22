import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  DescribeAvailabilityZonesCommand,
  DescribeLaunchTemplatesCommand,
} from '@aws-sdk/client-ec2';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client } from '@aws-sdk/client-s3';
import { getLogger } from '../utils/logger.js';
import { getAwsClients } from '../utils/aws-clients.js';
import { stringifyValue } from '../utils/stringify.js';
import { assumeRoleForCrossAccountStateRead, parseIamRoleArn } from '../utils/role-arn.js';
import { resolveCrossAccountStateBucket } from '../utils/aws-region-resolver.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceState, StateImportEntry } from '../types/state.js';
import { S3StateBackend } from '../state/s3-state-backend.js';
import type { ExportIndexStore } from '../state/export-index-store.js';

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
  /**
   * Persistent exports index for fast `Fn::ImportValue` resolution. When
   * supplied, the resolver tries an O(1) index lookup before falling back
   * to the per-stack state.json scan. Optional for backwards compat; the
   * scan-only path is still correct.
   */
  exportIndex?: ExportIndexStore;
  /**
   * Bag for the resolver to push every successful `Fn::ImportValue`
   * resolution into. The deploy engine reads this after resource
   * provisioning and persists it to the consumer's `state.imports`
   * field (schema v4) so destroy-time strong-reference checks can
   * refuse to delete a producer with active consumers.
   *
   * `Fn::GetStackOutput` does NOT push entries here by design — it is
   * a weak reference (see CLAUDE.md "Behavior vs CDK").
   */
  recordedImports?: StateImportEntry[];
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
 * - Fn::GetStackOutput (cross-stack/cross-region output reference)
 * - Fn::FindInMap (mapping lookups)
 * - Fn::Base64 (base64 encoding)
 * - Fn::GetAZs (availability zone listing)
 * - Fn::Cidr (CIDR address block calculation)
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
export async function getAccountInfo(overrideRegion?: string): Promise<AwsAccountInfo> {
  if (cachedAccountInfo) {
    // If an override region is provided, return with that region
    if (overrideRegion && overrideRegion !== cachedAccountInfo.region) {
      return { ...cachedAccountInfo, region: overrideRegion };
    }
    return cachedAccountInfo;
  }

  const logger = getLogger().child('IntrinsicFunctionResolver');
  const awsClients = getAwsClients();
  const stsClient = awsClients.sts;

  try {
    const response = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = response.Account || '123456789012';
    const region = overrideRegion || process.env['AWS_REGION'] || 'us-east-1';
    const partition = 'aws'; // Could be aws-cn, aws-us-gov, etc.

    cachedAccountInfo = { accountId, region, partition };
    logger.debug(`Retrieved AWS account info: ${accountId}, ${region}, ${partition}`);
    // Return with override if different from cached
    if (overrideRegion && overrideRegion !== region) {
      return { ...cachedAccountInfo, region: overrideRegion };
    }
    return cachedAccountInfo;
  } catch (error) {
    logger.warn(
      `Failed to get AWS account info from STS: ${error instanceof Error ? error.message : String(error)}, using defaults`
    );
    // Fallback to environment variables or defaults
    cachedAccountInfo = {
      accountId: process.env['AWS_ACCOUNT_ID'] || '123456789012',
      region: overrideRegion || process.env['AWS_REGION'] || 'us-east-1',
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
  private readonly resolverRegion: string;

  constructor(region?: string) {
    this.resolverRegion = region || process.env['AWS_REGION'] || 'us-east-1';
  }

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
          `Parameter ${name}: using default value ${stringifyValue(paramDef.Default)}`
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

    if ('Fn::GetStackOutput' in obj) {
      return await this.resolveGetStackOutput(obj['Fn::GetStackOutput'], context);
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

    if ('Fn::Cidr' in obj) {
      return await this.resolveCidr(obj['Fn::Cidr'] as [unknown, unknown, unknown], context);
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
      this.logger.debug(`Resolved Ref to parameter: ${logicalId} -> ${stringifyValue(value)}`);
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
    // For VPC Ipv6CidrBlocks, always use constructAttribute (dynamic fetch with retry)
    // because the stored value may be stale (empty array from before VPCCidrBlock association)
    const skipCachedAttribute =
      resource.resourceType === 'AWS::EC2::VPC' && attributeName === 'Ipv6CidrBlocks';

    if (!skipCachedAttribute && resource.attributes !== undefined) {
      // Flat-key lookup first (SDK providers store nested attributes as flat
      // dot-keys, e.g. `attributes['Endpoint.Port'] = '3306'`).
      const flatValue = resource.attributes[attributeName];
      if (flatValue !== undefined) {
        this.logger.debug(
          `Resolved Fn::GetAtt from attributes: ${logicalId}.${attributeName} -> ${stringifyValue(flatValue)}`
        );
        return flatValue;
      }

      // Issue #381: nested-path fallback. CC API providers store CFn nested
      // attributes as actual nested objects (`attributes.Endpoint.Port`),
      // so a flat-key lookup for `Endpoint.Port` misses and the resolver
      // would otherwise fall through to `constructAttribute`'s
      // physicalId default. Walk the dot-separated path against the
      // attributes object before that fallback. Examples covered:
      // `AWS::RDS::DBCluster.Endpoint.Port`,
      // `AWS::RDS::DBCluster.Endpoint.Address`,
      // `AWS::RDS::DBCluster.ReadEndpoint.Address`,
      // `AWS::CloudFront::Distribution.DomainName` (no nesting, still
      // hits flat-key path), `AWS::ApiGateway::Method.MethodResponses`
      // (also no nesting).
      if (attributeName.includes('.')) {
        const parts = attributeName.split('.');
        let cursor: unknown = resource.attributes;
        for (const part of parts) {
          if (cursor && typeof cursor === 'object' && part in (cursor as Record<string, unknown>)) {
            cursor = (cursor as Record<string, unknown>)[part];
          } else {
            cursor = undefined;
            break;
          }
        }
        if (cursor !== undefined) {
          this.logger.debug(
            `Resolved Fn::GetAtt from nested attributes: ${logicalId}.${attributeName} -> ${stringifyValue(cursor)}`
          );
          return cursor;
        }
      }
    }

    // Construct attribute value based on resource type
    const value = await this.constructAttribute(resource, attributeName, context);
    this.logger.debug(
      `Resolved Fn::GetAtt: ${logicalId}.${attributeName} -> ${stringifyValue(value)}`
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
    const accountInfo = await getAccountInfo(this.resolverRegion);
    const { region, accountId, partition } = accountInfo;

    // DynamoDB Table / GlobalTable (CDK TableV2 synthesizes as AWS::DynamoDB::GlobalTable; ARN format is identical)
    if (resourceType === 'AWS::DynamoDB::Table' || resourceType === 'AWS::DynamoDB::GlobalTable') {
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

    // EC2 VPC - dynamic attributes (IPv6 CIDR requires DescribeVpcs after VPCCidrBlock association)
    if (resourceType === 'AWS::EC2::VPC') {
      switch (attributeName) {
        case 'VpcId':
          return physicalId;
        case 'CidrBlock':
          return resource.attributes?.['CidrBlock'] || resource.properties?.['CidrBlock'];
        case 'Ipv6CidrBlocks': {
          // Must fetch dynamically - IPv6 CIDR is added by VPCCidrBlock resource after VPC creation.
          // After CC API reports VPCCidrBlock CREATE success, the CIDR may still be in
          // 'associating' state. Retry up to 30s waiting for 'associated'.
          try {
            const { EC2Client, DescribeVpcsCommand } = await import('@aws-sdk/client-ec2');
            const ec2 = new EC2Client({ region: this.resolverRegion });
            const maxAttempts = 15;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              const resp = await ec2.send(new DescribeVpcsCommand({ VpcIds: [physicalId] }));
              const associations = resp.Vpcs?.[0]?.Ipv6CidrBlockAssociationSet || [];
              const blocks = associations
                .filter((a) => a.Ipv6CidrBlockState?.State === 'associated')
                .map((a) => a.Ipv6CidrBlock);
              if (blocks.length > 0) {
                this.logger.debug(
                  `Resolved VPC Ipv6CidrBlocks for ${physicalId}: ${JSON.stringify(blocks)}`
                );
                return blocks;
              }
              // Check if there are any associating CIDRs — if so, wait and retry
              const associating = associations.filter(
                (a) => a.Ipv6CidrBlockState?.State === 'associating'
              );
              if (associating.length === 0) {
                // No IPv6 CIDRs at all
                this.logger.debug(`No IPv6 CIDR associations found for VPC ${physicalId}`);
                return [];
              }
              this.logger.debug(
                `VPC ${physicalId} IPv6 CIDR still associating (attempt ${attempt}/${maxAttempts}), waiting...`
              );
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
            this.logger.warn(
              `VPC ${physicalId} IPv6 CIDR did not reach 'associated' state after ${maxAttempts} attempts`
            );
            return [];
          } catch (error) {
            this.logger.warn(
              `Failed to fetch VPC Ipv6CidrBlocks for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
            return [];
          }
        }
        case 'DefaultSecurityGroup':
          return resource.attributes?.['DefaultSecurityGroup'] || physicalId;
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

    // IAM User
    if (resourceType === 'AWS::IAM::User') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:iam::${accountId}:user/${physicalId}`;
        default:
          return physicalId;
      }
    }

    // IAM Group
    if (resourceType === 'AWS::IAM::Group') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:iam::${accountId}:group/${physicalId}`;
        default:
          return physicalId;
      }
    }

    // IAM InstanceProfile
    if (resourceType === 'AWS::IAM::InstanceProfile') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:iam::${accountId}:instance-profile/${physicalId}`;
        default:
          return physicalId;
      }
    }

    // KMS Key
    if (resourceType === 'AWS::KMS::Key') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:kms:${region}:${accountId}:key/${physicalId}`;
        case 'KeyId':
          return physicalId;
        default:
          return physicalId;
      }
    }

    // Cognito UserPool
    if (resourceType === 'AWS::Cognito::UserPool') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:cognito-idp:${region}:${accountId}:userpool/${physicalId}`;
        default:
          return physicalId;
      }
    }

    // Kinesis Stream
    if (resourceType === 'AWS::Kinesis::Stream') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:kinesis:${region}:${accountId}:stream/${physicalId}`;
        default:
          return physicalId;
      }
    }

    // EventBridge Rule. Custom event bus ARN: rule/{busName}/{ruleName};
    // default bus ARN: rule/{ruleName}. By the time constructAttribute runs,
    // properties.EventBusName (if templated) has been resolved to a literal
    // string or ARN by the deploy engine. Treat 'default' / unset as default bus.
    if (resourceType === 'AWS::Events::Rule') {
      switch (attributeName) {
        case 'Arn': {
          const busRaw = resource.properties?.['EventBusName'];
          const bus = typeof busRaw === 'string' && busRaw && busRaw !== 'default' ? busRaw : '';
          // If EventBusName resolved to an ARN, extract the bus name segment
          const busName = bus.startsWith('arn:') ? bus.split('/').pop() || '' : bus;
          return busName
            ? `arn:${partition}:events:${region}:${accountId}:rule/${busName}/${physicalId}`
            : `arn:${partition}:events:${region}:${accountId}:rule/${physicalId}`;
        }
        default:
          return physicalId;
      }
    }

    // EventBridge EventBus
    if (resourceType === 'AWS::Events::EventBus') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:events:${region}:${accountId}:event-bus/${physicalId}`;
        case 'Name':
          return physicalId;
        default:
          return physicalId;
      }
    }

    // EFS FileSystem
    if (resourceType === 'AWS::EFS::FileSystem') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:elasticfilesystem:${region}:${accountId}:file-system/${physicalId}`;
        case 'FileSystemId':
          return physicalId;
        default:
          return physicalId;
      }
    }

    // Kinesis Data Firehose DeliveryStream
    if (resourceType === 'AWS::KinesisFirehose::DeliveryStream') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:firehose:${region}:${accountId}:deliverystream/${physicalId}`;
        default:
          return physicalId;
      }
    }

    // CodeBuild Project
    if (resourceType === 'AWS::CodeBuild::Project') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:codebuild:${region}:${accountId}:project/${physicalId}`;
        default:
          return physicalId;
      }
    }

    // CloudTrail Trail
    if (resourceType === 'AWS::CloudTrail::Trail') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:cloudtrail:${region}:${accountId}:trail/${physicalId}`;
        default:
          return physicalId;
      }
    }

    // AppSync GraphQLApi (physicalId is the apiId)
    if (resourceType === 'AWS::AppSync::GraphQLApi') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:appsync:${region}:${accountId}:apis/${physicalId}`;
        case 'ApiId':
          return physicalId;
        default:
          return physicalId;
      }
    }

    // ServiceDiscovery PrivateDnsNamespace (physicalId is the namespace id)
    if (resourceType === 'AWS::ServiceDiscovery::PrivateDnsNamespace') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:servicediscovery:${region}:${accountId}:namespace/${physicalId}`;
        case 'Id':
          return physicalId;
        default:
          return physicalId;
      }
    }

    // ServiceDiscovery Service (physicalId is the service id)
    if (resourceType === 'AWS::ServiceDiscovery::Service') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:servicediscovery:${region}:${accountId}:service/${physicalId}`;
        case 'Id':
          return physicalId;
        default:
          return physicalId;
      }
    }

    // CloudWatch Alarm (note: 'alarm:' separator, not '/')
    if (resourceType === 'AWS::CloudWatch::Alarm') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:cloudwatch:${region}:${accountId}:alarm:${physicalId}`;
        default:
          return physicalId;
      }
    }

    // RDS DBInstance (DocDB and Neptune share the same rds: service prefix and db: separator)
    if (
      resourceType === 'AWS::RDS::DBInstance' ||
      resourceType === 'AWS::DocDB::DBInstance' ||
      resourceType === 'AWS::Neptune::DBInstance'
    ) {
      switch (attributeName) {
        case 'DBInstanceArn':
        case 'Arn':
          return `arn:${partition}:rds:${region}:${accountId}:db:${physicalId}`;
        default:
          return physicalId;
      }
    }

    // RDS DBCluster (DocDB and Neptune share the same rds: service prefix and cluster: separator)
    if (
      resourceType === 'AWS::RDS::DBCluster' ||
      resourceType === 'AWS::DocDB::DBCluster' ||
      resourceType === 'AWS::Neptune::DBCluster'
    ) {
      switch (attributeName) {
        case 'DBClusterArn':
        case 'Arn':
          return `arn:${partition}:rds:${region}:${accountId}:cluster:${physicalId}`;
        default:
          return physicalId;
      }
    }

    // S3 Express Directory Bucket
    if (resourceType === 'AWS::S3Express::DirectoryBucket') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:s3express:${region}:${accountId}:bucket/${physicalId}`;
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

    // ECR Repository
    if (resourceType === 'AWS::ECR::Repository') {
      switch (attributeName) {
        case 'Arn':
          return `arn:${partition}:ecr:${region}:${accountId}:repository/${physicalId}`;
        case 'RepositoryUri':
          return `${accountId}.dkr.ecr.${region}.amazonaws.com/${physicalId}`;
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

    // EC2 Subnet
    if (resourceType === 'AWS::EC2::Subnet') {
      switch (attributeName) {
        case 'SubnetId':
          return physicalId;
        default:
          return physicalId;
      }
    }

    // EC2 LaunchTemplate — `LatestVersionNumber` / `DefaultVersionNumber`
    // are AWS-derived integers that cdkd does not capture in state.
    // Resolve via `DescribeLaunchTemplates`. Return as a string so
    // downstream consumers (`AWS::AutoScaling::AutoScalingGroup`'s
    // `LaunchTemplate.Version`) get the form AWS accepts. Falling back
    // to the physical ID — as the previous default did — produced
    // `Invalid launch template version: either '$Default', '$Latest',
    // or a numeric version are allowed.` on `CreateAutoScalingGroup`.
    if (resourceType === 'AWS::EC2::LaunchTemplate') {
      if (attributeName === 'LatestVersionNumber' || attributeName === 'DefaultVersionNumber') {
        try {
          const clients = getAwsClients();
          const response = await clients.ec2.send(
            new DescribeLaunchTemplatesCommand({ LaunchTemplateIds: [physicalId] })
          );
          const lt = response.LaunchTemplates?.[0];
          const value =
            attributeName === 'LatestVersionNumber'
              ? lt?.LatestVersionNumber
              : lt?.DefaultVersionNumber;
          if (value !== undefined && value !== null) {
            return String(value);
          }
        } catch (err) {
          this.logger.warn(
            `DescribeLaunchTemplates(${physicalId}) failed for ${attributeName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        // Fallback to "$Latest" / "$Default" — both are AWS-accepted
        // strings for the corresponding semantic, and let AWS pick the
        // version at API call time. Better than the resource-id
        // physicalId fallback which AWS rejects.
        return attributeName === 'LatestVersionNumber' ? '$Latest' : '$Default';
      }
      return physicalId;
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
      this.logger.warn(
        `Fn::Select: index ${index} out of bounds (array length: ${resolvedList.length})`
      );
      return `{{Fn::Select:${index}:OutOfBounds}}`;
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

    // Hot path: consult the persistent exports index for O(1) lookup.
    // Skip self-references (a stack importing its own export) so the
    // fallback scan below can apply the same exclusion.
    if (context.exportIndex) {
      try {
        const entry = await context.exportIndex.lookup(exportName);
        if (entry && (!context.stackName || entry.producerStack !== context.stackName)) {
          this.recordImport(context, exportName, entry.producerStack, entry.producerRegion);
          this.logger.info(
            `Resolved Fn::ImportValue: ${exportName} = ${JSON.stringify(entry.value)} (from index: ${entry.producerStack} / ${entry.producerRegion})`
          );
          return entry.value;
        }
      } catch (err) {
        this.logger.warn(
          `Exports index lookup failed for '${exportName}': ${err instanceof Error ? err.message : String(err)}; falling back to state.json scan`
        );
      }
    }

    // Fallback path (index miss, drift, or no index supplied): scan every
    // stack's state.json. Same as the pre-index behavior.
    const allStacks = await context.stateBackend.listStacks();
    this.logger.debug(
      `Found ${allStacks.length} state record(s) to search for export: ${exportName}`
    );

    for (const ref of allStacks) {
      const { stackName: refStack, region: refRegion } = ref;
      if (context.stackName && refStack === context.stackName) {
        this.logger.debug(`Skipping current stack: ${refStack}`);
        continue;
      }

      try {
        const lookupRegion = refRegion ?? this.resolverRegion ?? '';
        if (!lookupRegion) {
          this.logger.debug(
            `No region available for stack '${refStack}' — skipping (cdkd cannot read state without a region)`
          );
          continue;
        }
        const stateData = await context.stateBackend.getState(refStack, lookupRegion);
        if (!stateData) {
          this.logger.debug(`No state found for stack: ${refStack} (${lookupRegion})`);
          continue;
        }

        const { state } = stateData;

        if (state.outputs && exportName in state.outputs) {
          const value = state.outputs[exportName];
          this.logger.info(
            `Resolved Fn::ImportValue: ${exportName} = ${JSON.stringify(value)} (from stack: ${refStack} / ${lookupRegion})`
          );
          // Patch the index with the just-discovered entry so subsequent
          // resolves hit the O(1) path. Best-effort — index write failures
          // are logged and don't fail the resolve.
          if (context.exportIndex) {
            context.exportIndex
              .patchEntry(exportName, {
                value,
                producerStack: refStack,
                producerRegion: lookupRegion,
              })
              .catch((err) => {
                this.logger.debug(
                  `Failed to patch exports index for '${exportName}': ${err instanceof Error ? err.message : String(err)}`
                );
              });
          }
          this.recordImport(context, exportName, refStack, lookupRegion);
          return value;
        }
      } catch (error) {
        this.logger.warn(
          `Failed to read state for stack ${refStack}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
    }

    throw new Error(
      `Fn::ImportValue: export '${exportName}' not found in any stack. ` +
        `Searched ${allStacks.length} state record(s). ` +
        `Make sure the exporting stack has been deployed and the Output has an Export.Name property.`
    );
  }

  /**
   * Push a resolved `Fn::ImportValue` into the consumer's recorded-imports
   * bag (when supplied by the caller). Skips duplicates within the
   * SAME bag — multiple references to the same `(exportName,
   * sourceStack, sourceRegion)` triple emit one entry.
   *
   * Concurrency: the check + push pair is purely synchronous (no
   * `await` between `some()` and `push()`), so the JS event loop
   * cannot interleave a competing `recordImport` call between the
   * dedup check and the append. The bag's lifetime is per-deploy
   * (DeployEngine resets `this.recordedImports = []` at the top of
   * each `deploy()` call), so the bag identity already serves as
   * the dedup scope.
   *
   * Cross-context dedup: when callers share the same bag instance
   * across multiple ResolverContext objects (the typical pattern —
   * DeployEngine passes `this.recordedImports` into every resolver
   * context it constructs), the dedup naturally extends across
   * contexts because the `some()` reads the shared bag. Stashing
   * the dedup Set on `context.recordedImports` directly via a
   * property would break under `verbatimModuleSyntax`-style strict
   * typing; the array scan stays O(N) where N is the per-deploy
   * import count (typically < 20), which is fine.
   */
  private recordImport(
    context: ResolverContext,
    exportName: string,
    producerStack: string,
    producerRegion: string
  ): void {
    if (!context.recordedImports) return;
    const dup = context.recordedImports.some(
      (e) =>
        e.exportName === exportName &&
        e.sourceStack === producerStack &&
        e.sourceRegion === producerRegion
    );
    if (dup) return;
    context.recordedImports.push({
      exportName,
      sourceStack: producerStack,
      sourceRegion: producerRegion,
    });
  }

  /**
   * Resolve Fn::GetStackOutput (cross-stack / cross-region / cross-account
   * output reference).
   *
   * Shape: { "Fn::GetStackOutput": { "StackName": "...", "OutputName": "...",
   *                                   "Region": "...", "RoleArn": "..." } }
   *
   * Unlike Fn::ImportValue, the producer stack is named explicitly and no
   * Export is required. cdkd reads the producer's `outputs` from the
   * region-scoped state record at
   * `s3://{bucket}/cdkd/{StackName}/{Region}/state.json`. When `Region` is
   * omitted, the consumer's deploy region is used.
   *
   * **RoleArn (cross-account)**: when set, cdkd issues `sts:AssumeRole`
   * against the supplied role and reads the PRODUCER ACCOUNT's separate
   * cdkd state bucket (`cdkd-state-{producerAccountId}`) — bucket name
   * derived from the role ARN's account ID and the canonical
   * region-free bucket convention. The assumed credentials are cached
   * per-RoleArn for the deploy lifetime so a stack that references the
   * same producer multiple times only pays one STS hop. **The inline
   * `RoleArn` argument is constrained to literal strings only** — no
   * `Ref` / `Fn::GetAtt` / `Fn::Sub` chains — because the resolver
   * context isn't guaranteed to have the producer-account info available
   * at intrinsic-resolution time and a typo'd role lookup is far worse
   * than a clear "literal-string required" error at template-author
   * time. Same-account references (no RoleArn) take the original
   * shared-state-backend path.
   */
  private async resolveGetStackOutput(arg: unknown, context: ResolverContext): Promise<unknown> {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
      throw new Error(
        `Fn::GetStackOutput: argument must be an object with StackName/OutputName/Region/RoleArn, got ${
          arg === null ? 'null' : Array.isArray(arg) ? 'array' : typeof arg
        }`
      );
    }
    const args = arg as Record<string, unknown>;

    if (!('StackName' in args)) {
      throw new Error('Fn::GetStackOutput: StackName is required');
    }
    if (!('OutputName' in args)) {
      throw new Error('Fn::GetStackOutput: OutputName is required');
    }

    const stackName = await this.resolveValue(args['StackName'], context);
    if (typeof stackName !== 'string' || stackName === '') {
      throw new Error(
        `Fn::GetStackOutput: StackName must resolve to a non-empty string, got ${typeof stackName}`
      );
    }

    const outputName = await this.resolveValue(args['OutputName'], context);
    if (typeof outputName !== 'string' || outputName === '') {
      throw new Error(
        `Fn::GetStackOutput: OutputName must resolve to a non-empty string, got ${typeof outputName}`
      );
    }

    let region = this.resolverRegion;
    if ('Region' in args && args['Region'] !== undefined && args['Region'] !== null) {
      const resolvedRegion = await this.resolveValue(args['Region'], context);
      if (typeof resolvedRegion !== 'string' || resolvedRegion === '') {
        throw new Error(
          `Fn::GetStackOutput: Region must resolve to a non-empty string, got ${typeof resolvedRegion}`
        );
      }
      region = resolvedRegion;
    }

    // RoleArn must be a LITERAL string in the template — we check the raw
    // value rather than running it through resolveValue, because a Ref /
    // Fn::GetAtt / Fn::Sub chain would either silently resolve to the
    // wrong principal or quietly fail in a way that masks the
    // cross-account intent. The error message is specific so template
    // authors know to inline the ARN.
    let roleArn: string | undefined;
    if ('RoleArn' in args && args['RoleArn'] !== undefined && args['RoleArn'] !== null) {
      const raw = args['RoleArn'];
      if (typeof raw !== 'string' || raw === '') {
        throw new Error(
          `Fn::GetStackOutput: RoleArn must be a literal string in the template ` +
            `(no Ref / Fn::GetAtt / Fn::Sub allowed for cross-account references). ` +
            `Got ${
              raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw
            }${typeof raw === 'object' ? ` (intrinsic shape: ${JSON.stringify(raw).slice(0, 80)})` : ''}.`
        );
      }
      roleArn = raw;
    }

    // Reject obvious self-reference (same stack AND same region AND
    // same account — we cannot detect the account-id mismatch without
    // STS, so we only enforce same-region same-stack here; the
    // cross-account RoleArn case is by definition NOT self-reference).
    if (
      !roleArn &&
      context.stackName &&
      context.stackName === stackName &&
      region === this.resolverRegion
    ) {
      throw new Error(
        `Fn::GetStackOutput: cannot reference own stack '${stackName}' in the same region '${region}'`
      );
    }

    this.logger.debug(
      `Resolving Fn::GetStackOutput: StackName=${stackName}, Region=${region}, OutputName=${outputName}${
        roleArn ? `, RoleArn=${roleArn}` : ''
      }`
    );

    // Cross-account branch: assume the role, derive the producer's
    // state bucket from the role ARN's account ID, build an ephemeral
    // S3StateBackend pointed at it with the assumed credentials, then
    // read the producer's state.
    const stateData = roleArn
      ? await this.getCrossAccountStackState(roleArn, stackName, region, context)
      : await this.getSameAccountStackState(stackName, region, context);
    if (!stateData) {
      throw new Error(
        `Fn::GetStackOutput: stack '${stackName}' not found in region '${region}'${
          roleArn ? ` (cross-account via ${roleArn})` : ''
        }. Make sure the producer stack has been deployed via cdkd.`
      );
    }

    const outputs = stateData.state.outputs ?? {};
    if (!(outputName in outputs)) {
      const available = Object.keys(outputs).join(', ') || '(none)';
      throw new Error(
        `Fn::GetStackOutput: output '${outputName}' not found in stack '${stackName}' (${region}). ` +
          `Available outputs: ${available}`
      );
    }

    const value = outputs[outputName];
    this.logger.info(
      `Resolved Fn::GetStackOutput: StackName=${stackName}, Region=${region}, OutputName=${outputName}${
        roleArn ? `, RoleArn=${roleArn}` : ''
      } -> ${JSON.stringify(value)}`
    );
    return value;
  }

  /**
   * Read the producer's state from the SAME AWS account (no RoleArn).
   *
   * Uses the consumer's shared `context.stateBackend` — the same backend
   * the consumer used to read / write its own state. The same-account
   * path covers cross-region cleanly because the bucket name is
   * account-scoped (not region-scoped).
   */
  private async getSameAccountStackState(
    stackName: string,
    region: string,
    context: ResolverContext
  ): ReturnType<S3StateBackend['getState']> {
    if (!context.stateBackend) {
      throw new Error('Fn::GetStackOutput: state backend is required for cross-stack references');
    }
    return context.stateBackend.getState(stackName, region);
  }

  /**
   * Read the producer's state from a DIFFERENT AWS account (RoleArn set).
   *
   * Pipeline:
   *   1. Parse `roleArn` for the producer's account id (rejects malformed
   *      ARNs up front with a clear message — no opaque STS error later).
   *   2. `sts:AssumeRole` against `roleArn`, cached per role for the
   *      deploy lifetime (typical: 1 STS hop covering many `Fn::GetStackOutput`
   *      sites in the same deploy).
   *   3. Derive the producer's canonical state bucket
   *      (`cdkd-state-{producerAccountId}`) and auto-detect its region
   *      via `GetBucketLocation` with the assumed credentials.
   *   4. Build a fresh, narrowly-scoped `S3StateBackend` against that
   *      bucket with the assumed credentials and call `getState` —
   *      reuses the entire state-parsing + schema-version-tolerance
   *      machinery (legacy `version: 1` keys, migration warnings, etc.).
   *
   * The constructed `S3Client` and backend live only for the duration of
   * this call. cdkd does NOT mutate the process's `AWS_*` env vars (that
   * would leak the assumed credentials into every subsequent provisioning
   * client — opposite of what we want; provisioning still runs under the
   * consumer's normal credentials).
   */
  private async getCrossAccountStackState(
    roleArn: string,
    stackName: string,
    region: string,
    context: ResolverContext
  ): ReturnType<S3StateBackend['getState']> {
    const parsed = parseIamRoleArn(roleArn);
    if (!parsed) {
      throw new Error(
        `Fn::GetStackOutput: RoleArn '${roleArn}' is not a valid IAM role ARN. ` +
          `Expected shape: arn:<partition>:iam::<12-digit-account-id>:role/<role-name>` +
          ` (e.g. arn:aws:iam::123456789012:role/MyRole, arn:aws-us-gov:iam::...).`
      );
    }

    const credentials = await assumeRoleForCrossAccountStateRead(roleArn);
    const { bucket, region: bucketRegion } = await resolveCrossAccountStateBucket(
      parsed.accountId,
      credentials
    );

    // Reuse the consumer-side state prefix (the cdkd convention is `cdkd`
    // and is the same on both sides — the producer's own `cdkd deploy`
    // wrote under the same prefix). Pulling the live value off the
    // consumer's backend keeps us in sync with `--state-prefix`
    // overrides at the consumer side; in practice both sides almost
    // always default to `cdkd`.
    const prefix = context.stateBackend?.prefix ?? 'cdkd';

    const s3 = new S3Client({
      region: bucketRegion,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
      // Suppress the SDK's noisy "unknown Body length" warning; matches
      // the suppression in `AwsClients` and the consumer-side state
      // backend's region-rebuild path.
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });

    const crossAccountBackend = new S3StateBackend(
      s3,
      { bucket, prefix },
      {
        region: bucketRegion,
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
        },
      }
    );

    return crossAccountBackend.getState(stackName, region);
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
      const accountInfo = await getAccountInfo(this.resolverRegion);
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
        const accountInfo = await getAccountInfo(this.resolverRegion);
        return accountInfo.region;
      }

      case 'AWS::AccountId': {
        const accountInfo = await getAccountInfo(this.resolverRegion);
        return accountInfo.accountId;
      }

      case 'AWS::Partition': {
        const accountInfo = await getAccountInfo(this.resolverRegion);
        return accountInfo.partition;
      }

      case 'AWS::StackName':
        return context?.stackName ?? 'UnknownStack';

      case 'AWS::StackId': {
        // cdkd doesn't use CloudFormation stacks, generate a synthetic ID
        const info = await getAccountInfo(this.resolverRegion);
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
        return stringifyValue(keyValue);
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
  /**
   * Resolve Fn::Cidr intrinsic function
   *
   * Fn::Cidr returns an array of CIDR address blocks.
   * Syntax: { "Fn::Cidr": [ ipBlock, count, cidrBits ] }
   * - ipBlock: The user-specified CIDR address block to be split
   * - count: The number of CIDRs to generate
   * - cidrBits: The number of subnet bits for the CIDR (e.g., "64" for /64 in IPv6)
   */
  private async resolveCidr(
    args: [unknown, unknown, unknown],
    context: ResolverContext
  ): Promise<string[]> {
    const [rawIpBlock, rawCount, rawCidrBits] = args;
    const ipBlock = (await this.resolveValue(rawIpBlock, context)) as string;
    const count = Number(await this.resolveValue(rawCount, context));
    const cidrBits = Number(await this.resolveValue(rawCidrBits, context));

    if (!ipBlock || typeof ipBlock !== 'string') {
      throw new Error(
        `Fn::Cidr: ipBlock must be a string, got ${typeof ipBlock}: ${JSON.stringify(ipBlock)}`
      );
    }

    this.logger.debug(
      `Resolving Fn::Cidr: ipBlock=${ipBlock}, count=${count}, cidrBits=${cidrBits}`
    );

    const isIpv6 = ipBlock.includes(':');
    const results: string[] = [];

    if (isIpv6) {
      // IPv6 CIDR calculation
      // Parse the base IPv6 address and prefix
      const [baseAddr, prefixStr] = ipBlock.split('/');
      const basePrefix = parseInt(prefixStr!, 10);
      const subnetPrefix = 128 - cidrBits; // cidrBits = host bits, so subnet prefix = 128 - cidrBits

      // Expand IPv6 address to full form
      const expanded = this.expandIPv6(baseAddr!);
      const addrBigInt = this.ipv6ToBigInt(expanded);

      // Calculate subnet size
      const subnetSize = BigInt(1) << BigInt(128 - subnetPrefix);

      // Mask the base address to the network prefix
      const prefixMask =
        (BigInt(1) << BigInt(128)) -
        BigInt(1) -
        ((BigInt(1) << BigInt(128 - basePrefix)) - BigInt(1));
      const networkBase = addrBigInt & prefixMask;

      for (let i = 0; i < count; i++) {
        const subnetAddr = networkBase + subnetSize * BigInt(i);
        results.push(`${this.bigIntToIPv6(subnetAddr)}/${subnetPrefix}`);
      }
    } else {
      // IPv4 CIDR calculation
      const [baseAddr, prefixStr] = ipBlock.split('/');
      const basePrefix = parseInt(prefixStr!, 10);
      const subnetPrefix = 32 - cidrBits;

      const parts = baseAddr!.split('.').map(Number);
      const baseInt = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
      const subnetSize = 1 << (32 - subnetPrefix);
      const prefixMask = (0xffffffff << (32 - basePrefix)) >>> 0;
      const networkBase = (baseInt & prefixMask) >>> 0;

      for (let i = 0; i < count; i++) {
        const subnetAddr = (networkBase + subnetSize * i) >>> 0;
        const a = (subnetAddr >>> 24) & 0xff;
        const b = (subnetAddr >>> 16) & 0xff;
        const c = (subnetAddr >>> 8) & 0xff;
        const d = subnetAddr & 0xff;
        results.push(`${a}.${b}.${c}.${d}/${subnetPrefix}`);
      }
    }

    this.logger.debug(`Fn::Cidr result: ${JSON.stringify(results)}`);
    return results;
  }

  /** Expand IPv6 address to full 8-group form */
  private expandIPv6(addr: string): string {
    // Handle :: expansion
    if (addr.includes('::')) {
      const [left, right] = addr.split('::');
      const leftParts = left ? left.split(':') : [];
      const rightParts = right ? right.split(':') : [];
      const missing = 8 - leftParts.length - rightParts.length;
      const middle = Array.from({ length: missing }, () => '0000');
      const all = [...leftParts, ...middle, ...rightParts];
      return all.map((p: string) => p.padStart(4, '0')).join(':');
    }
    return addr
      .split(':')
      .map((p) => p.padStart(4, '0'))
      .join(':');
  }

  /** Convert expanded IPv6 string to BigInt */
  private ipv6ToBigInt(expanded: string): bigint {
    const parts = expanded.split(':');
    let result = BigInt(0);
    for (const part of parts) {
      result = (result << BigInt(16)) | BigInt(parseInt(part, 16));
    }
    return result;
  }

  /** Convert BigInt to compressed IPv6 string */
  private bigIntToIPv6(n: bigint): string {
    const parts: string[] = [];
    for (let i = 7; i >= 0; i--) {
      parts.push(((n >> BigInt(i * 16)) & BigInt(0xffff)).toString(16));
    }
    // Simple format — don't compress with :: for clarity
    return parts.join(':');
  }

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
