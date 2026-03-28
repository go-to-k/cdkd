import type { CloudAssembly, CloudFormationStackArtifact } from '@aws-cdk/cloud-assembly-api';
import type { CloudFormationTemplate } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';
import { SynthesisError } from '../utils/error-handler.js';

/**
 * Stack information extracted from CloudAssembly
 */
export interface StackInfo {
  /** Stack name */
  stackName: string;

  /** CloudFormation template */
  template: CloudFormationTemplate;

  /** Stack artifact */
  artifact: CloudFormationStackArtifact;

  /** Asset manifest path (if exists) */
  assetManifestPath?: string;

  /** Stack dependency names (other stacks this stack depends on) */
  dependencyNames: string[];
}

/**
 * CloudAssembly loader and parser
 */
export class AssemblyLoader {
  private logger = getLogger().child('AssemblyLoader');

  /**
   * Get stack by name from cloud assembly
   */
  getStack(assembly: CloudAssembly, stackName: string): StackInfo {
    try {
      const artifact = assembly.getStackByName(stackName);

      return this.extractStackInfo(artifact);
    } catch (error) {
      throw new SynthesisError(
        `Stack '${stackName}' not found in assembly`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get all stacks from cloud assembly
   */
  getAllStacks(assembly: CloudAssembly): StackInfo[] {
    const stacks = assembly.stacks;
    if (!stacks || stacks.length === 0) {
      this.logger.warn('No stacks found in assembly');
      return [];
    }

    return stacks.map((artifact) => this.extractStackInfo(artifact));
  }

  /**
   * Extract stack information from artifact
   */
  private extractStackInfo(artifact: CloudFormationStackArtifact): StackInfo {
    const stackName = artifact.stackName;
    const template = artifact.template as CloudFormationTemplate;

    this.logger.debug(`Extracted stack: ${stackName}`);
    this.logger.debug(`Resources in stack: ${Object.keys(template.Resources ?? {}).length}`);

    // Find asset manifest artifact if exists
    // Asset manifests typically have IDs ending with '.assets' or '.assets.json'
    const assetDependency = artifact.dependencies.find((dep) => {
      const id = dep.id;
      return id.endsWith('.assets') || id.includes('.assets.json');
    });

    // Extract stack dependency names (other stacks this stack depends on)
    // artifact.dependencies returns CloudArtifact instances.
    // For stack-to-stack dependencies, the dependency is a CloudFormationStackArtifact
    // which has a `stackName` property. We check via 'in' operator since the base
    // CloudArtifact type doesn't declare it.
    const dependencyNames = artifact.dependencies
      .filter((dep) => {
        // Exclude asset manifest dependencies
        const id = dep.id;
        return !id.endsWith('.assets') && !id.includes('.assets.json');
      })
      .filter((dep) => {
        // Only include dependencies that are actually stack artifacts
        // CloudFormationStackArtifact has stackName and template properties
        return (
          'stackName' in dep &&
          typeof (dep as unknown as Record<string, unknown>)['stackName'] === 'string'
        );
      })
      .map((dep) => {
        return (dep as unknown as Record<string, unknown>)['stackName'] as string;
      })
      .filter((name) => name !== stackName); // Exclude self-references

    if (dependencyNames.length > 0) {
      this.logger.debug(`Stack '${stackName}' depends on: [${dependencyNames.join(', ')}]`);
    }

    const result: StackInfo = {
      stackName,
      template,
      artifact,
      dependencyNames,
    };

    if (assetDependency) {
      // For asset manifest artifacts, we need the manifest file path
      // The manifest is typically at: assembly.directory + '/' + assetDependency.id + '.json'
      result.assetManifestPath = assetDependency.id;
      this.logger.debug(`Found asset manifest: ${assetDependency.id}`);
    }

    return result;
  }

  /**
   * Get template for a specific stack
   */
  getTemplate(assembly: CloudAssembly, stackName: string): CloudFormationTemplate {
    const stack = this.getStack(assembly, stackName);
    return stack.template;
  }

  /**
   * Check if stack has assets
   */
  hasAssets(stackInfo: StackInfo): boolean {
    return stackInfo.assetManifestPath !== undefined;
  }
}
