import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';

/**
 * CloudFormation template parser
 *
 * Provides utilities for parsing and extracting information from
 * CloudFormation templates
 */
export class TemplateParser {
  private logger = getLogger().child('TemplateParser');

  /**
   * Extract all resource logical IDs from template
   */
  getResourceIds(template: CloudFormationTemplate): string[] {
    return Object.keys(template.Resources);
  }

  /**
   * Get a specific resource from template
   */
  getResource(template: CloudFormationTemplate, logicalId: string): TemplateResource | undefined {
    return template.Resources[logicalId];
  }

  /**
   * Extract all dependencies for a resource
   *
   * Analyzes:
   * - DependsOn attribute
   * - Ref intrinsic functions
   * - Fn::GetAtt intrinsic functions
   */
  extractDependencies(resource: TemplateResource): Set<string> {
    const dependencies = new Set<string>();

    // 1. DependsOn attribute
    if (resource.DependsOn) {
      const dependsOn = Array.isArray(resource.DependsOn)
        ? resource.DependsOn
        : [resource.DependsOn];

      dependsOn.forEach((dep) => {
        if (typeof dep === 'string') {
          dependencies.add(dep);
        }
      });
    }

    // 2. Ref and Fn::GetAtt in Properties
    if (resource.Properties) {
      this.extractRefsFromValue(resource.Properties, dependencies);
    }

    // 3. Ref and Fn::GetAtt in other attributes (Metadata, UpdatePolicy, etc.)
    if (resource.Metadata) {
      this.extractRefsFromValue(resource.Metadata, dependencies);
    }

    return dependencies;
  }

  /**
   * Extract resource references (Ref / Fn::GetAtt / Fn::Sub / Fn::Join /
   * Fn::Select / Fn::Split) from an arbitrary template value.
   *
   * Public wrapper over the same recursive extraction `extractDependencies`
   * uses for Properties — exposed so the diff phase can compute
   * per-property reference edges (issue #807 replacement propagation)
   * without duplicating the intrinsic walk. Unlike `extractDependencies`
   * this does NOT include `DependsOn` (which is pure ordering, not a data
   * reference — a replaced dependency carries no new value to propagate).
   */
  extractReferences(value: unknown): Set<string> {
    const references = new Set<string>();
    this.extractRefsFromValue(value, references);
    return references;
  }

  /**
   * Recursively extract Ref and Fn::GetAtt from a value
   */
  private extractRefsFromValue(value: unknown, dependencies: Set<string>): void {
    if (value === null || value === undefined) {
      return;
    }

    // Check if value is an object
    if (typeof value !== 'object') {
      return;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      value.forEach((item) => this.extractRefsFromValue(item, dependencies));
      return;
    }

    // Handle objects
    const obj = value as Record<string, unknown>;

    // Check for Ref
    if ('Ref' in obj && typeof obj['Ref'] === 'string') {
      // Ignore pseudo parameters (AWS::Region, AWS::AccountId, etc.)
      if (!obj['Ref'].startsWith('AWS::')) {
        dependencies.add(obj['Ref']);
      }
      return;
    }

    // Check for Fn::GetAtt
    if ('Fn::GetAtt' in obj) {
      const getAtt = obj['Fn::GetAtt'];
      if (Array.isArray(getAtt) && getAtt.length >= 1 && typeof getAtt[0] === 'string') {
        dependencies.add(getAtt[0]);
      }
      return;
    }

    // Check for Fn::Sub
    // 1-arg form: "Fn::Sub": "string with ${X} or ${X.Attr}"
    // 2-arg form: "Fn::Sub": ["string with ${X}", { X: <value> }]
    // Per the CloudFormation spec, when ${X} appears in the body and X is NOT
    // in the explicit variable map (2-arg form), X resolves to Ref X — which
    // can point at a same-stack resource. The DAG must treat that as a real
    // dependency edge so the referenced resource is created first; otherwise
    // the resolver races and falls back to the literal placeholder, which AWS
    // rejects (see #275).
    if ('Fn::Sub' in obj) {
      const subValue = obj['Fn::Sub'];
      let body: string | undefined;
      let mapKeys: Set<string> | undefined;
      if (typeof subValue === 'string') {
        body = subValue;
      } else if (
        Array.isArray(subValue) &&
        subValue.length >= 1 &&
        typeof subValue[0] === 'string'
      ) {
        body = subValue[0];
        const variables: unknown = subValue[1];
        if (variables && typeof variables === 'object' && !Array.isArray(variables)) {
          const varMap = variables as Record<string, unknown>;
          mapKeys = new Set(Object.keys(varMap));
          // Recurse into the variable-map values — they may contain Ref / GetAtt
          // intrinsics that produce their own dependencies.
          Object.values(varMap).forEach((v) => this.extractRefsFromValue(v, dependencies));
        }
      }
      if (body !== undefined) {
        for (const match of body.matchAll(/\$\{([^}]+)\}/g)) {
          const placeholder = match[1];
          if (!placeholder) continue;
          // ${X.AttrName} is an implicit Fn::GetAtt — depend on X (the prefix).
          // ${X} is an implicit Ref to X.
          const dot = placeholder.indexOf('.');
          const name = dot >= 0 ? placeholder.slice(0, dot) : placeholder;
          if (!name) continue;
          // Skip pseudo parameters (AWS::Region, AWS::AccountId, etc.).
          if (name.startsWith('AWS::')) continue;
          // Skip names provided by the 2-arg variable map.
          if (mapKeys?.has(name)) continue;
          dependencies.add(name);
        }
      }
      return;
    }

    // Check for Fn::Join / Fn::Select / Fn::Split
    //   Fn::Join:   [<delimiter: string>, [<item1>, <item2>, ...]]
    //   Fn::Select: [<index: number-or-Ref>, <array-or-intrinsic>]
    //   Fn::Split:  [<delimiter: string>, <source-string-or-intrinsic>]
    // CDK emits these (especially Fn::Join) to construct ARNs that embed
    // sibling-resource Refs / Fn::GetAtt inside the array arguments — e.g.
    // DynamoDB `Table.tableArn` synthesizes as
    //   Fn::Join: [':', ['arn', 'aws', 'dynamodb', {Ref:'AWS::Region'},
    //                    {Ref:'AWS::AccountId'}, {Fn::Join:['/',['table',{Ref:'MyTable'}]]}]]
    // and Fn::Select+Fn::Split is the canonical "extract substring from ARN"
    // pattern (Fn::Select: [5, Fn::Split: [':', Fn::GetAtt: [..., 'Arn']]]).
    // The buried Ref / Fn::GetAtt MUST contribute a DAG edge so the consumer
    // is ordered after its dependency; otherwise the deploy races. Explicit
    // recursion through each intrinsic's array argument keeps that support
    // load-bearing instead of relying on the generic fall-through below to
    // accidentally find them (see issue #286 — same class as #275/#276).
    // We do NOT add edges for the intrinsic wrapper itself, only for inner
    // refs the recursion uncovers (Ref / Fn::GetAtt / Fn::Sub, plus any
    // further-nested Fn::Join / Fn::Select / Fn::Split chain).
    if ('Fn::Join' in obj) {
      const joinValue = obj['Fn::Join'];
      if (Array.isArray(joinValue) && joinValue.length >= 2) {
        // Skip the delimiter (joinValue[0]); recurse into the items array.
        this.extractRefsFromValue(joinValue[1], dependencies);
      }
      return;
    }
    if ('Fn::Select' in obj) {
      const selectValue = obj['Fn::Select'];
      if (Array.isArray(selectValue) && selectValue.length >= 2) {
        // Index may itself be an intrinsic (rare but valid); recurse into both.
        this.extractRefsFromValue(selectValue[0], dependencies);
        this.extractRefsFromValue(selectValue[1], dependencies);
      }
      return;
    }
    if ('Fn::Split' in obj) {
      const splitValue = obj['Fn::Split'];
      if (Array.isArray(splitValue) && splitValue.length >= 2) {
        // Skip the delimiter (splitValue[0]); recurse into the source value.
        this.extractRefsFromValue(splitValue[1], dependencies);
      }
      return;
    }

    // Recursively process all values
    Object.values(obj).forEach((v) => this.extractRefsFromValue(v, dependencies));
  }

  /**
   * Check if a resource has a specific property
   */
  hasProperty(resource: TemplateResource, propertyPath: string): boolean {
    if (!resource.Properties) {
      return false;
    }

    const parts = propertyPath.split('.');
    let current: unknown = resource.Properties;

    for (const part of parts) {
      if (typeof current !== 'object' || current === null) {
        return false;
      }

      const obj = current as Record<string, unknown>;
      if (!(part in obj)) {
        return false;
      }

      current = obj[part];
    }

    return true;
  }

  /**
   * Get a property value from a resource
   */
  getProperty(resource: TemplateResource, propertyPath: string): unknown {
    if (!resource.Properties) {
      return undefined;
    }

    const parts = propertyPath.split('.');
    let current: unknown = resource.Properties;

    for (const part of parts) {
      if (typeof current !== 'object' || current === null) {
        return undefined;
      }

      const obj = current as Record<string, unknown>;
      if (!(part in obj)) {
        return undefined;
      }

      current = obj[part];
    }

    return current;
  }

  /**
   * Validate template structure
   */
  validateTemplate(template: unknown): template is CloudFormationTemplate {
    if (typeof template !== 'object' || template === null) {
      this.logger.error('Template is not an object');
      return false;
    }

    const t = template as Record<string, unknown>;

    if (!('Resources' in t)) {
      this.logger.error('Template missing Resources section');
      return false;
    }

    if (typeof t['Resources'] !== 'object' || t['Resources'] === null) {
      this.logger.error('Template Resources is not an object');
      return false;
    }

    const resources = t['Resources'] as Record<string, unknown>;

    // Validate each resource has a Type
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (typeof resource !== 'object' || resource === null) {
        this.logger.error(`Resource ${logicalId} is not an object`);
        return false;
      }

      const r = resource as Record<string, unknown>;
      if (!('Type' in r) || typeof r['Type'] !== 'string') {
        this.logger.error(`Resource ${logicalId} missing Type or Type is not a string`);
        return false;
      }
    }

    return true;
  }

  /**
   * Get all resources of a specific type
   */
  getResourcesByType(
    template: CloudFormationTemplate,
    resourceType: string
  ): Map<string, TemplateResource> {
    const resources = new Map<string, TemplateResource>();

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type === resourceType) {
        resources.set(logicalId, resource);
      }
    }

    return resources;
  }

  /**
   * Count resources in template
   */
  countResources(template: CloudFormationTemplate): number {
    return Object.keys(template.Resources).length;
  }
}
