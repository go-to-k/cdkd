import { Command } from 'commander';
import {
  appOptions,
  commonOptions,
  stateOptions,
  stackOptions,
  destroyOptions,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { DagBuilder } from '../../analyzer/dag-builder.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { IAMRoleProvider } from '../../provisioning/providers/iam-role-provider.js';
import { IAMPolicyProvider } from '../../provisioning/providers/iam-policy-provider.js';
import { S3BucketPolicyProvider } from '../../provisioning/providers/s3-bucket-policy-provider.js';
import { SQSQueuePolicyProvider } from '../../provisioning/providers/sqs-queue-policy-provider.js';
import { ApiGatewayProvider } from '../../provisioning/providers/apigateway-provider.js';
import { EventBridgeRuleProvider } from '../../provisioning/providers/eventbridge-rule-provider.js';
import { EventBridgeBusProvider } from '../../provisioning/providers/eventbridge-bus-provider.js';
import { AgentCoreRuntimeProvider } from '../../provisioning/providers/agentcore-runtime-provider.js';
import { CloudFrontOAIProvider } from '../../provisioning/providers/cloudfront-oai-provider.js';
import { S3BucketProvider } from '../../provisioning/providers/s3-bucket-provider.js';
import { LambdaFunctionProvider } from '../../provisioning/providers/lambda-function-provider.js';
import { SQSQueueProvider } from '../../provisioning/providers/sqs-queue-provider.js';
import { SNSTopicProvider } from '../../provisioning/providers/sns-topic-provider.js';
import { DynamoDBTableProvider } from '../../provisioning/providers/dynamodb-table-provider.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import * as readline from 'node:readline/promises';
import { resolveStateBucketWithDefault } from '../config-loader.js';

/**
 * Destroy command implementation
 */
async function destroyCommand(
  stackArgs: string[],
  options: {
    stateBucket?: string;
    statePrefix: string;
    stack?: string;
    all?: boolean;
    region?: string;
    profile?: string;
    force: boolean;
    verbose: boolean;
  }
): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  // Resolve --state-bucket from CLI, env, cdk.json, or default
  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  logger.info('Starting stack destruction...');
  logger.debug('Options:', options);

  // Initialize AWS clients with region/profile
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    // 1. Initialize components
    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig);
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    const dagBuilder = new DagBuilder();
    const providerRegistry = new ProviderRegistry();

    // Register SDK providers for unsupported resource types
    providerRegistry.register('AWS::S3::Bucket', new S3BucketProvider());
    providerRegistry.register('AWS::IAM::Role', new IAMRoleProvider());
    providerRegistry.register('AWS::IAM::Policy', new IAMPolicyProvider());
    providerRegistry.register('AWS::S3::BucketPolicy', new S3BucketPolicyProvider());
    providerRegistry.register('AWS::SQS::QueuePolicy', new SQSQueuePolicyProvider());
    providerRegistry.register('AWS::Lambda::Function', new LambdaFunctionProvider());
    providerRegistry.register('AWS::SQS::Queue', new SQSQueueProvider());
    providerRegistry.register('AWS::SNS::Topic', new SNSTopicProvider());
    providerRegistry.register('AWS::DynamoDB::Table', new DynamoDBTableProvider());
    const apigwProvider = new ApiGatewayProvider();
    providerRegistry.register('AWS::ApiGateway::Account', apigwProvider);
    providerRegistry.register('AWS::ApiGateway::Resource', apigwProvider);
    providerRegistry.register('AWS::ApiGateway::Deployment', apigwProvider);
    providerRegistry.register('AWS::ApiGateway::Stage', apigwProvider);
    providerRegistry.register('AWS::ApiGateway::Method', apigwProvider);
    providerRegistry.register('AWS::Events::Rule', new EventBridgeRuleProvider());
    providerRegistry.register('AWS::Events::EventBus', new EventBridgeBusProvider());
    providerRegistry.register('AWS::BedrockAgentCore::Runtime', new AgentCoreRuntimeProvider());
    providerRegistry.register(
      'AWS::CloudFront::CloudFrontOriginAccessIdentity',
      new CloudFrontOAIProvider()
    );

    // Configure custom resource response handling via S3
    providerRegistry.setCustomResourceResponseBucket(stateBucket);

    // 2. Get list of stacks to destroy
    const stackPatterns = stackArgs.length > 0 ? stackArgs : options.stack ? [options.stack] : [];
    const allStateStacks = await stateBackend.listStacks();

    let stackNames: string[];
    if (options.all) {
      stackNames = allStateStacks;
    } else if (stackPatterns.length > 0) {
      stackNames = allStateStacks.filter((name) =>
        stackPatterns.some((pattern) =>
          pattern.includes('*')
            ? new RegExp('^' + pattern.replace(/\*/g, '.*') + '$').test(name)
            : name === pattern
        )
      );
    } else if (allStateStacks.length === 1) {
      stackNames = allStateStacks;
    } else if (allStateStacks.length === 0) {
      logger.info('No stacks found in state');
      return;
    } else {
      throw new Error(
        `Multiple stacks found: ${allStateStacks.join(', ')}. ` +
          `Specify stack name(s) or use --all`
      );
    }

    if (stackNames.length === 0) {
      logger.info('No matching stacks found in state');
      return;
    }

    logger.info(`Found ${stackNames.length} stack(s) to destroy: ${stackNames.join(', ')}`);

    // 3. Process each stack
    for (const stackName of stackNames) {
      logger.info(`\nPreparing to destroy stack: ${stackName}`);

      // Load current state
      const stateResult = await stateBackend.getState(stackName);
      if (!stateResult) {
        logger.warn(`No state found for stack ${stackName}, skipping`);
        continue;
      }
      const currentState = stateResult.state;

      const resourceCount = Object.keys(currentState.resources).length;
      if (resourceCount === 0) {
        logger.info(`Stack ${stackName} has no resources, cleaning up state...`);
        await stateBackend.deleteState(stackName);
        logger.info('✓ State deleted');
        continue;
      }

      // Show resources to be deleted
      logger.info(`\nResources to be deleted (${resourceCount}):`);
      for (const [logicalId, resource] of Object.entries(currentState.resources)) {
        logger.info(`  - ${logicalId} (${resource.resourceType})`);
      }

      // 4. Confirm (unless --force)
      if (!options.force) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await rl.question(
          `\nAre you sure you want to destroy stack "${stackName}" and delete all ${resourceCount} resources? (Y/n): `
        );
        rl.close();

        const trimmed = answer.trim().toLowerCase();
        if (trimmed === 'n' || trimmed === 'no') {
          logger.info('Destroy cancelled');
          continue;
        }
      }

      // 5. Acquire lock
      logger.info(`\nAcquiring lock for stack ${stackName}...`);
      await lockManager.acquireLock(stackName, 'destroy');

      try {
        // 6. Build dependency graph from current state
        logger.info('Building dependency graph...');

        // Create a minimal template from current state for DAG building
        const template = {
          AWSTemplateFormatVersion: '2010-09-09',
          Resources: {} as Record<
            string,
            { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] }
          >,
        };

        for (const [logicalId, resource] of Object.entries(currentState.resources)) {
          template.Resources[logicalId] = {
            Type: resource.resourceType,
            Properties: resource.properties || {},
            ...(resource.dependencies &&
              resource.dependencies.length > 0 && {
                DependsOn: resource.dependencies,
              }),
          };
        }

        // Add implicit dependencies for correct deletion order.
        // Some AWS resources have ordering constraints not expressed via Ref/GetAtt.
        const implicitDeleteDeps: Record<string, string[]> = {
          'AWS::EC2::InternetGateway': ['AWS::EC2::VPCGatewayAttachment'],
          'AWS::Events::EventBus': ['AWS::Events::Rule'],
          'AWS::EC2::VPC': [
            'AWS::EC2::Subnet',
            'AWS::EC2::SecurityGroup',
            'AWS::EC2::InternetGateway',
            'AWS::EC2::VPCGatewayAttachment',
            'AWS::EC2::RouteTable',
          ],
          'AWS::EC2::Subnet': ['AWS::EC2::SubnetRouteTableAssociation'],
          'AWS::EC2::RouteTable': ['AWS::EC2::Route', 'AWS::EC2::SubnetRouteTableAssociation'],
          'AWS::EC2::SecurityGroup': [
            'AWS::EC2::SecurityGroupIngress',
            'AWS::EC2::SecurityGroupEgress',
          ],
        };

        // Build type → logicalId index
        const typeToLogicalIds = new Map<string, string[]>();
        for (const [logicalId, resource] of Object.entries(currentState.resources)) {
          const ids = typeToLogicalIds.get(resource.resourceType) ?? [];
          ids.push(logicalId);
          typeToLogicalIds.set(resource.resourceType, ids);
        }

        // For each resource whose type has implicit deps, add DependsOn edges.
        // If type X must be deleted AFTER type Y, then Y.DependsOn should include X
        // in the creation-order DAG. When the DAG levels are reversed for deletion,
        // Y (at a later creation level) is deleted first, then X.
        for (const [logicalId, resource] of Object.entries(currentState.resources)) {
          const mustDeleteAfter = implicitDeleteDeps[resource.resourceType];
          if (!mustDeleteAfter) continue;

          for (const depType of mustDeleteAfter) {
            const depIds = typeToLogicalIds.get(depType);
            if (!depIds) continue;
            for (const depId of depIds) {
              // depId (depType) must be deleted BEFORE logicalId (resource.resourceType).
              // In creation DAG: depId depends on logicalId → depId is at a later level.
              // Reversed for deletion: depId is processed first → deleted first.
              const existing = template.Resources[depId]?.DependsOn ?? [];
              const depsArray = Array.isArray(existing) ? existing : [existing];
              if (!depsArray.includes(logicalId)) {
                template.Resources[depId] = {
                  ...template.Resources[depId]!,
                  DependsOn: [...depsArray, logicalId],
                };
                logger.debug(
                  `Implicit delete dependency: ${depId} (${depType}) must be deleted before ${logicalId} (${resource.resourceType})`
                );
              }
            }
          }
        }

        const graph = dagBuilder.buildGraph(template);
        const executionLevels = dagBuilder.getExecutionLevels(graph);

        logger.debug(`Dependency graph: ${executionLevels.length} level(s)`);

        let deletedCount = 0;
        let errorCount = 0;

        // Process levels in reverse order for deletion
        for (let levelIndex = executionLevels.length - 1; levelIndex >= 0; levelIndex--) {
          const level = executionLevels[levelIndex];
          if (!level) {
            continue;
          }

          logger.debug(
            `Deletion level ${executionLevels.length - levelIndex}/${executionLevels.length} (${level.length} resources)`
          );

          // Delete resources in parallel within each level
          const deletePromises = level.map(async (logicalId) => {
            const resource = currentState.resources[logicalId];
            if (!resource) {
              logger.warn(`Resource ${logicalId} not found in state, skipping`);
              return;
            }

            try {
              const provider = providerRegistry.getProvider(resource.resourceType);
              // Retry DELETE for transient errors (throttle, dependency race)
              let lastDeleteError: unknown;
              for (let attempt = 0; attempt <= 3; attempt++) {
                try {
                  await provider.delete(
                    logicalId,
                    resource.physicalId,
                    resource.resourceType,
                    resource.properties
                  );
                  lastDeleteError = null;
                  break;
                } catch (retryError) {
                  lastDeleteError = retryError;
                  const msg = retryError instanceof Error ? retryError.message : String(retryError);
                  const isRetryable =
                    msg.includes('Too Many Requests') ||
                    msg.includes('has dependencies') ||
                    msg.includes("can't be deleted since") ||
                    msg.includes('DependencyViolation');
                  if (!isRetryable || attempt >= 3) break;
                  const delay = 5000 * Math.pow(2, attempt);
                  logger.debug(
                    `  ⏳ Retrying delete ${logicalId} in ${delay / 1000}s (attempt ${attempt + 1}/3)`
                  );
                  await new Promise((resolve) => setTimeout(resolve, delay));
                }
              }
              if (lastDeleteError) throw lastDeleteError;

              logger.info(`  ✅ ${logicalId} (${resource.resourceType}) deleted`);
              deletedCount++;
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              // Treat "not found" as already deleted
              if (
                msg.includes('does not exist') ||
                msg.includes('not found') ||
                msg.includes('No policy found') ||
                msg.includes('NoSuchEntity') ||
                msg.includes('NotFoundException')
              ) {
                logger.debug(`  ${logicalId} already deleted, removing from state`);
                deletedCount++;
              } else {
                logger.error(`  ✗ Failed to delete ${logicalId}:`, String(error));
                errorCount++;
              }
            }
          });

          await Promise.all(deletePromises);
        }

        // 8. Delete state
        if (errorCount === 0) {
          await stateBackend.deleteState(stackName);
          logger.debug('State deleted');
        } else {
          logger.warn(`${errorCount} resource(s) failed to delete. State preserved.`);
        }

        logger.info(
          `\n✓ Stack ${stackName} destroyed (${deletedCount} deleted, ${errorCount} errors)`
        );
      } finally {
        // 9. Release lock
        logger.debug('Releasing lock...');
        await lockManager.releaseLock(stackName);
      }
    }
  } finally {
    // Cleanup AWS clients
    awsClients.destroy();
  }
}

/**
 * Create destroy command
 */
export function createDestroyCommand(): Command {
  const cmd = new Command('destroy')
    .description('Destroy all resources in the stack')
    .argument('[stacks...]', 'Stack name(s) to destroy (supports wildcards)')
    .option('--all', 'Destroy all stacks', false)
    .action(withErrorHandling(destroyCommand));

  // Add options (appOptions accepted for CDK CLI compatibility, but not used)
  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions, ...destroyOptions].forEach(
    (opt) => cmd.addOption(opt)
  );

  return cmd;
}
