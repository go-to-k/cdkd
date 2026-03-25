import { getLogger } from '../utils/logger.js';
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
 *
 * Not yet supported:
 * - Fn::Select, Fn::Split, Fn::ImportValue
 * - Fn::If, Fn::Equals (Conditions)
 * - Fn::FindInMap, Fn::GetAZs, Fn::Base64
 */
export class IntrinsicFunctionResolver {
  private logger = getLogger().child('IntrinsicFunctionResolver');

  /**
   * Resolve all intrinsic functions in a value
   */
  resolve(value: unknown, context: ResolverContext): unknown {
    return this.resolveValue(value, context);
  }

  /**
   * Recursively resolve a value
   */
  private resolveValue(value: unknown, context: ResolverContext): unknown {
    // Primitives: return as-is
    if (typeof value !== 'object' || value === null) {
      return value;
    }

    // Arrays: resolve each element
    if (Array.isArray(value)) {
      return value.map((v) => this.resolveValue(v, context));
    }

    const obj = value as Record<string, unknown>;

    // Check for intrinsic functions
    if ('Ref' in obj) {
      return this.resolveRef(obj['Ref'] as string, context);
    }

    if ('Fn::GetAtt' in obj) {
      return this.resolveGetAtt(obj['Fn::GetAtt'] as [string, string] | string, context);
    }

    if ('Fn::Join' in obj) {
      return this.resolveJoin(obj['Fn::Join'] as [string, unknown[]], context);
    }

    if ('Fn::Sub' in obj) {
      return this.resolveSub(obj['Fn::Sub'] as string | [string, Record<string, unknown>], context);
    }

    // Not an intrinsic function: recursively resolve object properties
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      resolved[key] = this.resolveValue(val, context);
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
  private resolveRef(logicalId: string, context: ResolverContext): unknown {
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
    const pseudoValue = this.resolvePseudoParameter(logicalId);
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
  private resolveGetAtt(getAtt: [string, string] | string, context: ResolverContext): unknown {
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

    // Try to get attribute from resource attributes
    const value = resource.attributes?.[attributeName] ?? resource.physicalId;
    this.logger.debug(
      `Resolved Fn::GetAtt: ${logicalId}.${attributeName} -> ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    );
    return value;
  }

  /**
   * Resolve Fn::Join intrinsic function
   *
   * Fn::Join: [delimiter, [value1, value2, ...]]
   */
  private resolveJoin(joinArgs: [string, unknown[]], context: ResolverContext): string {
    const [delimiter, values] = joinArgs;

    // Resolve each value first
    const resolvedValues = values.map((v) => {
      const resolved = this.resolveValue(v, context);
      return String(resolved);
    });

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
   */
  private resolveSub(
    subArgs: string | [string, Record<string, unknown>],
    context: ResolverContext
  ): string {
    let template: string;
    let variables: Record<string, unknown> = {};

    if (Array.isArray(subArgs)) {
      [template, variables] = subArgs;
      // Resolve variable values
      for (const [key, val] of Object.entries(variables)) {
        variables[key] = this.resolveValue(val, context);
      }
    } else {
      template = subArgs;
    }

    // Replace ${VarName} placeholders
    const result = template.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
      // Type guard: varName is always a string due to regex capture group
      const varNameStr = String(varName);

      // Check explicit variables first
      if (varNameStr in variables) {
        return String(variables[varNameStr]);
      }

      // Check if it's a pseudo parameter
      const pseudoValue = this.resolvePseudoParameter(varNameStr);
      if (pseudoValue !== undefined) {
        return String(pseudoValue);
      }

      // Try to resolve as Ref
      try {
        const value = this.resolveRef(varNameStr, context);
        return String(value);
      } catch {
        // If not found, try to resolve as GetAtt (e.g., "Resource.Attribute")
        if (varNameStr.includes('.')) {
          try {
            const value = this.resolveGetAtt(varNameStr, context);
            return String(value);
          } catch {
            // Fall through
          }
        }
      }

      this.logger.warn(`Fn::Sub variable ${varNameStr} not found, keeping placeholder`);
      return match; // Keep original placeholder if not found
    });

    this.logger.debug(`Resolved Fn::Sub: ${result}`);
    return result;
  }

  /**
   * Resolve pseudo parameters
   *
   * Pseudo parameters are built-in CloudFormation references like AWS::Region
   */
  private resolvePseudoParameter(name: string): string | undefined {
    // TODO: Get actual values from AWS SDK/config
    // For now, return placeholders or environment variables

    switch (name) {
      case 'AWS::Region':
        // TODO: Get from AWS SDK config
        return process.env['AWS_REGION'] || 'us-east-1';

      case 'AWS::AccountId':
        // TODO: Get from STS GetCallerIdentity
        return process.env['AWS_ACCOUNT_ID'] || '123456789012';

      case 'AWS::StackName':
        // Stack name should be passed in context if needed
        return undefined;

      case 'AWS::StackId':
        // We don't use CloudFormation, so no stack ID
        return undefined;

      case 'AWS::Partition':
        return 'aws';

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
