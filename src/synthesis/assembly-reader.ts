import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AssemblyManifest,
  ArtifactManifest,
  StackArtifactProperties,
  AssetManifestArtifactProperties,
  ArtifactEnvironment,
} from '../types/assembly.js';
import { parseEnvironment } from '../types/assembly.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';
import { SynthesisError } from '../utils/error-handler.js';

/**
 * Stack information extracted from cloud assembly
 */
export interface StackInfo {
  /** Physical CloudFormation stack name (e.g., "MyStage-MyStack") */
  stackName: string;

  /**
   * Hierarchical display name from CDK synth (e.g., "MyStage/MyStack" for stacks
   * under a Stage, or "MyStack" at the top level). Falls back to `stackName` when
   * the assembly does not carry one.
   */
  displayName: string;

  /** Artifact ID in manifest */
  artifactId: string;

  /** CloudFormation template */
  template: CloudFormationTemplate;

  /** Asset manifest file path (absolute) */
  assetManifestPath?: string | undefined;

  /** Stack dependency names (other stacks this stack depends on) */
  dependencyNames: string[];

  /** Target region from CDK environment */
  region?: string | undefined;

  /** Target account from CDK environment */
  account?: string | undefined;
}

/**
 * Reads and parses Cloud Assembly from cdk.out directory
 */
export class AssemblyReader {
  private logger = getLogger().child('AssemblyReader');

  /**
   * Read manifest.json from assembly directory
   */
  readManifest(assemblyDir: string): AssemblyManifest {
    const manifestPath = join(assemblyDir, 'manifest.json');

    try {
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as AssemblyManifest;
      this.logger.debug(`Loaded manifest: version=${manifest.version}`);
      return manifest;
    } catch (error) {
      throw new SynthesisError(
        `Failed to read cloud assembly manifest from ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get all stacks from assembly (recursively traverses nested assemblies / Stages)
   */
  getAllStacks(assemblyDir: string, manifest: AssemblyManifest): StackInfo[] {
    if (!manifest.artifacts) {
      this.logger.warn('No artifacts found in manifest');
      return [];
    }

    // Build map of artifact ID → asset manifest path
    const assetManifestMap = this.buildAssetManifestMap(assemblyDir, manifest);

    const stacks: StackInfo[] = [];

    for (const [artifactId, artifact] of Object.entries(manifest.artifacts)) {
      if (artifact.type === 'aws:cloudformation:stack') {
        const stackInfo = this.extractStackInfo(
          assemblyDir,
          artifactId,
          artifact,
          manifest,
          assetManifestMap
        );
        stacks.push(stackInfo);
      } else if (artifact.type === 'cdk:cloud-assembly') {
        // Nested assembly (Stage) — recurse into subdirectory
        const props = artifact.properties as { directoryName?: string } | undefined;
        if (props?.directoryName) {
          const nestedDir = join(assemblyDir, props.directoryName);
          try {
            const nestedManifest = this.readManifest(nestedDir);
            const nestedStacks = this.getAllStacks(nestedDir, nestedManifest);
            stacks.push(...nestedStacks);
          } catch (error) {
            this.logger.warn(
              `Failed to read nested assembly '${props.directoryName}': ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
    }

    this.logger.debug(`Found ${stacks.length} stack(s) in assembly`);
    return stacks;
  }

  /**
   * Get a specific stack by name
   */
  getStack(assemblyDir: string, manifest: AssemblyManifest, stackName: string): StackInfo {
    const stacks = this.getAllStacks(assemblyDir, manifest);
    const stack = stacks.find((s) => s.stackName === stackName);

    if (!stack) {
      throw new SynthesisError(
        `Stack '${stackName}' not found in assembly. Available: ${stacks.map((s) => s.stackName).join(', ')}`
      );
    }

    return stack;
  }

  /**
   * Get template for a specific stack
   */
  getTemplate(
    assemblyDir: string,
    manifest: AssemblyManifest,
    stackName: string
  ): CloudFormationTemplate {
    return this.getStack(assemblyDir, manifest, stackName).template;
  }

  /**
   * Build map: stack artifact ID → asset manifest absolute path
   */
  private buildAssetManifestMap(
    assemblyDir: string,
    manifest: AssemblyManifest
  ): Map<string, string> {
    const map = new Map<string, string>();

    if (!manifest.artifacts) return map;

    for (const [artifactId, artifact] of Object.entries(manifest.artifacts)) {
      if (artifact.type !== 'cdk:asset-manifest') continue;

      const props = artifact.properties as AssetManifestArtifactProperties | undefined;
      if (props?.file) {
        map.set(artifactId, join(assemblyDir, props.file));
      }
    }

    return map;
  }

  /**
   * Extract stack info from artifact
   */
  private extractStackInfo(
    assemblyDir: string,
    artifactId: string,
    artifact: ArtifactManifest,
    manifest: AssemblyManifest,
    assetManifestMap: Map<string, string>
  ): StackInfo {
    const props = artifact.properties as StackArtifactProperties | undefined;
    const stackName = props?.stackName || artifactId;

    // Load template
    const templateFile = props?.templateFile;
    if (!templateFile) {
      throw new SynthesisError(`Stack '${stackName}' has no templateFile property`);
    }

    const templatePath = join(assemblyDir, templateFile);
    let template: CloudFormationTemplate;
    try {
      const content = readFileSync(templatePath, 'utf-8');
      template = JSON.parse(content) as CloudFormationTemplate;
    } catch (error) {
      throw new SynthesisError(
        `Failed to read template for stack '${stackName}': ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }

    this.logger.debug(
      `Stack: ${stackName}, Resources: ${Object.keys(template.Resources ?? {}).length}`
    );

    // Find asset manifest for this stack
    let assetManifestPath: string | undefined;
    if (artifact.dependencies) {
      for (const depId of artifact.dependencies) {
        if (assetManifestMap.has(depId)) {
          assetManifestPath = assetManifestMap.get(depId);
          this.logger.debug(`Found asset manifest for ${stackName}: ${depId}`);
          break;
        }
      }
    }

    // Extract stack dependencies (other stacks, not asset manifests)
    const dependencyNames: string[] = [];
    if (artifact.dependencies && manifest.artifacts) {
      for (const depId of artifact.dependencies) {
        const depArtifact = manifest.artifacts[depId];
        if (depArtifact?.type === 'aws:cloudformation:stack') {
          const depProps = depArtifact.properties as StackArtifactProperties | undefined;
          const depName = depProps?.stackName || depId;
          if (depName !== stackName) {
            dependencyNames.push(depName);
          }
        }
      }
    }

    if (dependencyNames.length > 0) {
      this.logger.debug(`Stack '${stackName}' depends on: [${dependencyNames.join(', ')}]`);
    }

    // Parse environment
    let env: ArtifactEnvironment | undefined;
    if (artifact.environment) {
      env = parseEnvironment(artifact.environment);
    }

    return {
      stackName,
      displayName: artifact.displayName ?? stackName,
      artifactId,
      template,
      assetManifestPath,
      dependencyNames,
      region: env?.region !== 'unknown-region' ? env?.region : undefined,
      account: env?.account !== 'unknown-account' ? env?.account : undefined,
    };
  }

  /**
   * Check if stack has assets
   */
  hasAssets(stackInfo: StackInfo): boolean {
    return stackInfo.assetManifestPath !== undefined;
  }
}
