import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  ExecuteChangeSetCommand,
  DescribeStacksCommand,
  DescribeTypeCommand,
  DeleteChangeSetCommand,
  waitUntilChangeSetCreateComplete,
  waitUntilStackImportComplete,
  type ResourceToImport,
} from '@aws-sdk/client-cloudformation';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  stateOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import type { ResourceState, StackState } from '../../types/state.js';

interface ExportOptions {
  app?: string;
  output?: string;
  template?: string;
  cfnStackName?: string;
  stateBucket?: string;
  statePrefix: string;
  stackRegion?: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  dryRun: boolean;
  yes: boolean;
  verbose: boolean;
  context?: string[];
}

/**
 * Resource types that are known to be incompatible with CloudFormation
 * `ChangeSetType=IMPORT`:
 *
 *   - `AWS::CDK::Metadata` is a CDK sentinel; not a real AWS resource and
 *     CFn refuses to import it.
 *   - `AWS::CloudFormation::Stack` is a nested stack reference; importing
 *     means re-creating the child stack, not adopting AWS resources.
 *   - `Custom::*` are Lambda-backed Custom Resources. CFn cannot adopt the
 *     custom-resource state — invocation history lives in the provider
 *     Lambda, not in AWS resource state, so there is nothing to import.
 *
 * The list is intentionally narrow. Other resource types CFn may not yet
 * support for import are surfaced as errors by the CreateChangeSet call
 * itself; we do not try to maintain a closed allowlist here.
 */
const NEVER_IMPORTABLE_TYPES = new Set<string>([
  'AWS::CDK::Metadata',
  'AWS::CloudFormation::Stack',
]);

export function isNeverImportableType(resourceType: string): boolean {
  if (NEVER_IMPORTABLE_TYPES.has(resourceType)) return true;
  if (resourceType.startsWith('Custom::')) return true;
  return false;
}

/**
 * Hardcoded fallback map for the per-resource-type primary identifier
 * property name. Used only when `DescribeType` fails (e.g. permissions
 * gap, throttling, or an obscure type that has no public registry entry).
 *
 * The string value is the SINGLE property name CFn expects in
 * `ResourcesToImport[].ResourceIdentifier`. For composite-identifier
 * types (`primaryIdentifier` length > 1) we do not have a fallback —
 * the call must succeed against `DescribeType` for those.
 *
 * Source: the `primaryIdentifier` field of each type's published
 * CloudFormation resource schema.
 */
const PRIMARY_IDENTIFIER_FALLBACK: Record<string, string> = {
  'AWS::S3::Bucket': 'BucketName',
  'AWS::IAM::Role': 'RoleName',
  'AWS::IAM::ManagedPolicy': 'PolicyArn',
  'AWS::IAM::User': 'UserName',
  'AWS::IAM::Group': 'GroupName',
  'AWS::IAM::InstanceProfile': 'InstanceProfileName',
  'AWS::Lambda::Function': 'FunctionName',
  'AWS::DynamoDB::Table': 'TableName',
  'AWS::SQS::Queue': 'QueueUrl',
  'AWS::SNS::Topic': 'TopicArn',
  'AWS::Logs::LogGroup': 'LogGroupName',
  'AWS::EC2::VPC': 'VpcId',
  'AWS::EC2::Subnet': 'SubnetId',
  'AWS::EC2::SecurityGroup': 'GroupId',
  'AWS::EC2::InternetGateway': 'InternetGatewayId',
  'AWS::EC2::RouteTable': 'RouteTableId',
  'AWS::EC2::NatGateway': 'NatGatewayId',
  'AWS::CloudFront::Distribution': 'Id',
  'AWS::CloudFront::CloudFrontOriginAccessIdentity': 'Id',
  'AWS::Route53::HostedZone': 'Id',
  'AWS::SecretsManager::Secret': 'Id',
  'AWS::Events::Rule': 'Arn',
  'AWS::Events::EventBus': 'Name',
  'AWS::ApiGateway::RestApi': 'RestApiId',
  'AWS::ApiGatewayV2::Api': 'ApiId',
  'AWS::CloudWatch::Alarm': 'AlarmName',
  'AWS::Kinesis::Stream': 'Name',
  'AWS::SSM::Parameter': 'Name',
  'AWS::StepFunctions::StateMachine': 'Arn',
  'AWS::Cognito::UserPool': 'UserPoolId',
  'AWS::ECR::Repository': 'RepositoryName',
};

interface ImportPlanEntry {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  identifierKey: string;
}

async function exportCommand(stackArg: string | undefined, options: ExportOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }

  warnIfDeprecatedRegion(options);

  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  if (options.region) {
    process.env['AWS_REGION'] = options.region;
    process.env['AWS_DEFAULT_REGION'] = options.region;
  }
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = { bucket: stateBucket, prefix: options.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);

    // Synthesize the CDK app to get the template (or read a user-supplied
    // template file). cdkd state does not persist the original template
    // body, so synth is required even though we only inspect the cdkd
    // state for physical IDs.
    let template: Record<string, unknown>;
    let resolvedStackName: string;
    let synthedRegion: string | undefined;

    if (options.template) {
      // User-supplied template path: still need a stack name to load state.
      if (!stackArg) {
        throw new Error(
          '--template requires a stack name as a positional argument to identify the cdkd state record.'
        );
      }
      template = parseTemplateFile(options.template);
      resolvedStackName = stackArg;
    } else {
      const appCmd = options.app || resolveApp();
      if (!appCmd) {
        throw new Error(
          "'cdkd export' requires a CDK app (pass --app or set it in cdk.json) " +
            'OR a pre-rendered CFn template (--template <path>).'
        );
      }
      logger.info('Synthesizing CDK app to read template...');
      const synthesizer = new Synthesizer();
      const context = parseContextOptions(options.context);
      const result = await synthesizer.synthesize({
        app: appCmd,
        output: options.output || 'cdk.out',
        ...(Object.keys(context).length > 0 && { context }),
      });

      let stackInfo;
      if (stackArg) {
        stackInfo = result.stacks.find(
          (s) => s.stackName === stackArg || s.displayName === stackArg
        );
        if (!stackInfo) {
          throw new Error(
            `Stack '${stackArg}' not found in synthesized app. ` +
              `Available: ${result.stacks.map((s) => s.stackName).join(', ')}`
          );
        }
      } else if (result.stacks.length === 1) {
        stackInfo = result.stacks[0]!;
      } else {
        throw new Error(
          `Multiple stacks found: ${result.stacks.map((s) => s.stackName).join(', ')}. ` +
            `Specify the stack name as a positional argument.`
        );
      }
      template = stackInfo.template as unknown as Record<string, unknown>;
      resolvedStackName = stackInfo.stackName;
      synthedRegion = stackInfo.region;
    }

    const cfnStackName = options.cfnStackName ?? resolvedStackName;
    const targetRegion = await pickStackRegion(
      stateBackend,
      resolvedStackName,
      synthedRegion,
      options.stackRegion
    );

    logger.info(
      `Migrating cdkd stack '${resolvedStackName}' (${targetRegion}) → CloudFormation stack '${cfnStackName}'`
    );

    // Refuse if a CFn stack with that name already exists. CFn IMPORT's
    // CreateChangeSet either creates a new stack (CHANGE_SET_TYPE=IMPORT
    // against a non-existent stack) or attaches imports to an existing
    // one; mixing the two cases silently would surprise users.
    await assertCfnStackAbsent(awsClients.cloudFormation, cfnStackName);

    // Load cdkd state for the target stack.
    const stateData = await stateBackend.getState(resolvedStackName, targetRegion);
    if (!stateData) {
      throw new Error(
        `No cdkd state found for stack '${resolvedStackName}' (${targetRegion}). ` +
          `Nothing to migrate.`
      );
    }
    const { state, etag, migrationPending } = stateData;

    // Acquire the lock before any AWS write. Dry-run skips the lock so it
    // is a pure read.
    const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
    if (!options.dryRun) {
      await lockManager.acquireLock(resolvedStackName, targetRegion, owner, 'export');
    }

    try {
      // Build the import plan: cdkd state × template resources, filtered
      // by importability.
      const { plan, skipped } = await buildImportPlan(state, template, awsClients.cloudFormation);

      if (skipped.length > 0) {
        logger.error('The following resources cannot be imported into CloudFormation:');
        for (const s of skipped) {
          logger.error(`  - ${s.logicalId} (${s.resourceType}): ${s.reason}`);
        }
        throw new Error(
          `${skipped.length} resource(s) cannot be imported. CloudFormation IMPORT ` +
            `requires every template resource to map to an importable AWS resource. ` +
            `Either destroy these resources first (cdkd destroy / cdkd state destroy ` +
            `cherry-picked), or accept abandoning them by removing them from the CDK app ` +
            `and re-synthesizing.`
        );
      }

      if (plan.length === 0) {
        logger.warn('No resources to import — cdkd state is empty.');
        return;
      }

      printPlan(plan, cfnStackName);

      if (options.dryRun) {
        logger.info('--dry-run: no CloudFormation changeset will be created.');
        return;
      }

      if (!options.yes) {
        const ok = await confirmPrompt(
          `Create CloudFormation stack '${cfnStackName}' by importing ${plan.length} ` +
            `resource(s) from cdkd state '${resolvedStackName}' (${targetRegion})? ` +
            `AWS resources are unchanged. cdkd state for '${resolvedStackName}' ` +
            `will be deleted on success.`
        );
        if (!ok) {
          logger.info('Migration cancelled. cdkd state and CloudFormation are unchanged.');
          return;
        }
      }

      // Build and execute the IMPORT changeset.
      const filteredTemplate = filterTemplateForImport(template, plan);
      await executeImportChangeSet(awsClients.cloudFormation, cfnStackName, filteredTemplate, plan);

      logger.info(
        `✓ CloudFormation stack '${cfnStackName}' created via IMPORT. ` +
          `${plan.length} resource(s) are now managed by CloudFormation.`
      );

      // Delete cdkd state for the migrated stack. The lock is still held;
      // we release it inside the outer `finally`.
      await stateBackend.deleteState(resolvedStackName, targetRegion);
      logger.info(
        `cdkd state for '${resolvedStackName}' (${targetRegion}) removed. ` +
          `Manage the stack with 'cdk deploy' or 'aws cloudformation' from here on.`
      );

      // observedProperties / etag / legacy migration are no longer
      // relevant since the state record is gone. The local references
      // are kept just to make it explicit that we deliberately discarded
      // them.
      void etag;
      void migrationPending;
    } finally {
      if (!options.dryRun) {
        await lockManager.releaseLock(resolvedStackName, targetRegion).catch((err) => {
          logger.warn(
            `Failed to release lock: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Decide which region's state to operate on. Mirrors the disambiguation
 * logic shared with `state resources` / `state show` / `orphan`.
 */
async function pickStackRegion(
  stateBackend: S3StateBackend,
  stackName: string,
  synthRegion: string | undefined,
  flag: string | undefined
): Promise<string> {
  const refs = (await stateBackend.listStacks()).filter((r) => r.stackName === stackName);
  if (refs.length === 0) {
    if (flag) return flag;
    if (synthRegion) return synthRegion;
    throw new Error(
      `No state found for stack '${stackName}'. Run 'cdkd state list' to see available stacks.`
    );
  }
  if (flag) {
    const found = refs.find((r) => r.region === flag);
    if (!found) {
      const seen = refs.map((r) => r.region ?? '(legacy)').join(', ');
      throw new Error(
        `No state found for stack '${stackName}' in region '${flag}'. Available regions: ${seen}.`
      );
    }
    return flag;
  }
  if (synthRegion) {
    const found = refs.find((r) => r.region === synthRegion);
    if (found) return synthRegion;
  }
  if (refs.length === 1) {
    return refs[0]!.region ?? synthRegion ?? '';
  }
  const regions = refs.map((r) => r.region ?? '(legacy)').join(', ');
  throw new Error(
    `Stack '${stackName}' has state in multiple regions: ${regions}. ` +
      `Re-run with --stack-region <region> to disambiguate.`
  );
}

function parseTemplateFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read template file '${path}': ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Template file '${path}' is not valid JSON. cdkd export only supports ` +
        `JSON templates (CDK-generated). Cause: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Template file '${path}' is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function assertCfnStackAbsent(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string
): Promise<void> {
  try {
    const resp = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = resp.Stacks?.[0];
    if (!stack) return;
    // REVIEW_IN_PROGRESS comes from a failed CreateChangeSet IMPORT that
    // was never deleted; surfacing it lets the user clean up before retry.
    throw new Error(
      `CloudFormation stack '${stackName}' already exists ` +
        `(status: ${stack.StackStatus ?? 'unknown'}). cdkd export ` +
        `only creates new stacks via IMPORT — delete or rename the existing stack first, ` +
        `or pass --cfn-stack-name to choose a different name.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/does not exist/i.test(msg)) {
      // Expected: stack does not exist, we can proceed.
      return;
    }
    throw err;
  }
}

interface SkippedResource {
  logicalId: string;
  resourceType: string;
  reason: string;
}

/**
 * Build the import plan from cdkd state + the synthesized template.
 *
 * Both sources must agree: every logical ID in the template (except
 * `NEVER_IMPORTABLE_TYPES`) must have a matching entry in cdkd state with
 * a non-empty `physicalId`. Mismatches abort the migration via `skipped`.
 */
async function buildImportPlan(
  state: StackState,
  template: Record<string, unknown>,
  cfnClient: AwsClients['cloudFormation']
): Promise<{ plan: ImportPlanEntry[]; skipped: SkippedResource[] }> {
  const templateResources = template['Resources'];
  if (
    !templateResources ||
    typeof templateResources !== 'object' ||
    Array.isArray(templateResources)
  ) {
    throw new Error('Template has no Resources section.');
  }

  const plan: ImportPlanEntry[] = [];
  const skipped: SkippedResource[] = [];
  const identifierCache = new Map<string, string>();

  for (const [logicalId, raw] of Object.entries(templateResources as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const resource = raw as { Type?: string };
    const resourceType = resource.Type ?? '';
    if (!resourceType) continue;

    if (isNeverImportableType(resourceType)) {
      // CDK sentinels are silently dropped; user-facing Custom::* / nested
      // stacks are reported as skipped so the user makes a conscious
      // decision before migrating.
      if (resourceType === 'AWS::CDK::Metadata') continue;
      skipped.push({
        logicalId,
        resourceType,
        reason: 'CloudFormation IMPORT does not support this resource type',
      });
      continue;
    }

    const stateEntry: ResourceState | undefined = state.resources[logicalId];
    if (!stateEntry || !stateEntry.physicalId) {
      skipped.push({
        logicalId,
        resourceType,
        reason: 'no entry in cdkd state (resource is in template but was not deployed by cdkd)',
      });
      continue;
    }

    let identifierKey: string;
    try {
      identifierKey = await resolvePrimaryIdentifier(resourceType, cfnClient, identifierCache);
    } catch (err) {
      skipped.push({
        logicalId,
        resourceType,
        reason:
          'could not resolve primary identifier: ' +
          (err instanceof Error ? err.message : String(err)),
      });
      continue;
    }

    plan.push({
      logicalId,
      resourceType,
      physicalId: stateEntry.physicalId,
      identifierKey,
    });
  }

  return { plan, skipped };
}

/**
 * Resolve the single property name CloudFormation expects in
 * `ResourcesToImport[].ResourceIdentifier` for the given resource type.
 *
 * Prefers `DescribeType` (the authoritative source — the same registry
 * AWS uses internally) and falls back to a hardcoded table for common
 * types when DescribeType fails (insufficient permissions, throttling,
 * obscure type without a registry entry).
 *
 * Composite primary identifiers (length > 1) are not yet supported — the
 * caller surfaces them as skipped. Known affected types are sub-resources
 * like `AWS::ApiGateway::Resource` (RestApiId + ResourceId), which are
 * better created fresh than imported anyway.
 */
async function resolvePrimaryIdentifier(
  resourceType: string,
  cfnClient: AwsClients['cloudFormation'],
  cache: Map<string, string>
): Promise<string> {
  const cached = cache.get(resourceType);
  if (cached !== undefined) return cached;

  try {
    const resp = await cfnClient.send(
      new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType })
    );
    if (resp.Schema) {
      const parsed = JSON.parse(resp.Schema) as { primaryIdentifier?: unknown };
      const primary = parsed.primaryIdentifier;
      if (Array.isArray(primary) && primary.length === 1 && typeof primary[0] === 'string') {
        // Schema entries look like "/properties/BucketName" — strip the
        // JSON-pointer prefix to get the property name.
        const propName = primary[0].replace(/^\/properties\//, '');
        cache.set(resourceType, propName);
        return propName;
      }
      if (Array.isArray(primary) && primary.length > 1) {
        throw new Error(
          `resource type uses a composite primary identifier ` +
            `(${primary.length} fields); cdkd does not yet support composite ` +
            `identifiers for cdkd export`
        );
      }
    }
  } catch (err) {
    // Fall through to fallback table.
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().debug(`DescribeType failed for ${resourceType}: ${msg} — using fallback`);
  }

  const fallback = PRIMARY_IDENTIFIER_FALLBACK[resourceType];
  if (fallback) {
    cache.set(resourceType, fallback);
    return fallback;
  }
  throw new Error(
    `primary identifier unknown (DescribeType returned no usable schema and no fallback ` +
      `is registered). Add ${resourceType} to PRIMARY_IDENTIFIER_FALLBACK in ` +
      `export.ts, or open an issue.`
  );
}

/**
 * Strip the template down to only the resources we intend to import.
 *
 * CloudFormation `ChangeSetType=IMPORT` requires every resource in the
 * template to appear in `ResourcesToImport`; anything extra causes the
 * changeset to fail. Outputs that reference a removed resource are also
 * stripped to avoid Ref-to-nonexistent errors.
 */
export function filterTemplateForImport(
  template: Record<string, unknown>,
  plan: ImportPlanEntry[]
): Record<string, unknown> {
  const allow = new Set(plan.map((p) => p.logicalId));
  const original = template['Resources'] as Record<string, unknown>;
  const filteredResources: Record<string, unknown> = {};
  for (const [logicalId, resource] of Object.entries(original)) {
    if (allow.has(logicalId)) {
      filteredResources[logicalId] = resource;
    }
  }

  const result: Record<string, unknown> = { ...template, Resources: filteredResources };

  // Filter outputs that reference resources we excluded.
  const outputs = template['Outputs'];
  if (outputs && typeof outputs === 'object' && !Array.isArray(outputs)) {
    const filteredOutputs: Record<string, unknown> = {};
    for (const [name, output] of Object.entries(outputs as Record<string, unknown>)) {
      if (referencesOnly(output, allow)) {
        filteredOutputs[name] = output;
      }
    }
    if (Object.keys(filteredOutputs).length > 0) {
      result['Outputs'] = filteredOutputs;
    } else {
      delete result['Outputs'];
    }
  }

  return result;
}

/**
 * Returns true if every `Ref` / `Fn::GetAtt` inside `node` points at a
 * logical ID in `allow`. Used to keep Outputs entries that only reference
 * imported resources and drop the ones that referenced excluded ones.
 */
function referencesOnly(node: unknown, allow: Set<string>): boolean {
  if (!node || typeof node !== 'object') return true;
  if (Array.isArray(node)) {
    return node.every((item) => referencesOnly(item, allow));
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'Ref' && typeof value === 'string') {
      if (!allow.has(value)) return false;
      continue;
    }
    if (key === 'Fn::GetAtt') {
      const target =
        Array.isArray(value) && typeof value[0] === 'string'
          ? value[0]
          : typeof value === 'string'
            ? value.split('.')[0]
            : undefined;
      if (target && !allow.has(target)) return false;
      continue;
    }
    if (!referencesOnly(value, allow)) return false;
  }
  return true;
}

function printPlan(plan: ImportPlanEntry[], cfnStackName: string): void {
  const logger = getLogger();
  logger.info('');
  logger.info(`Import plan for CloudFormation stack '${cfnStackName}':`);
  for (const entry of plan) {
    logger.info(
      `  ${entry.logicalId} (${entry.resourceType}) ← ${entry.identifierKey}=${entry.physicalId}`
    );
  }
  logger.info('');
}

async function executeImportChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  plan: ImportPlanEntry[]
): Promise<void> {
  const logger = getLogger();
  const changeSetName = `cdkd-migrate-${Date.now()}`;
  const templateBody = JSON.stringify(template, null, 2);

  const resourcesToImport: ResourceToImport[] = plan.map((entry) => ({
    ResourceType: entry.resourceType,
    LogicalResourceId: entry.logicalId,
    ResourceIdentifier: { [entry.identifierKey]: entry.physicalId },
  }));

  logger.info(
    `Creating IMPORT changeset '${changeSetName}' for stack '${stackName}' ` +
      `(${plan.length} resource(s), ${templateBody.length} bytes)...`
  );

  // CFn IMPORT changesets accept TemplateBody up to 51,200 bytes inline.
  // Larger templates require S3 upload via TemplateURL. For MVP we only
  // support inline; larger payloads are deferred to a follow-up PR.
  if (templateBody.length > 51200) {
    throw new Error(
      `Filtered template is ${templateBody.length} bytes, over the 51,200-byte inline ` +
        `TemplateBody limit. Templates that large require TemplateURL upload (not yet ` +
        `implemented for cdkd export; please file an issue if you hit this).`
    );
  }

  try {
    await cfnClient.send(
      new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ChangeSetType: 'IMPORT',
        TemplateBody: templateBody,
        ResourcesToImport: resourcesToImport,
        // CDK templates routinely require CAPABILITY_IAM /
        // CAPABILITY_NAMED_IAM. Forward both so the user does not have to
        // re-discover and re-pass them.
        Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create IMPORT changeset: ${msg}`);
  }

  try {
    await waitUntilChangeSetCreateComplete(
      { client: cfnClient, maxWaitTime: 600 },
      { StackName: stackName, ChangeSetName: changeSetName }
    );
  } catch (err) {
    // CreateChangeSet returns FAILED with a StatusReason on validation
    // problems (template error, identifier mismatch, etc.). Fetch the
    // reason and surface it before re-throwing.
    try {
      const desc = await cfnClient.send(
        new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
      );
      const reason = desc.StatusReason ?? 'unknown';
      // Clean up the failed changeset so the next attempt is not blocked
      // by a REVIEW_IN_PROGRESS phantom stack.
      await cfnClient
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
        .catch(() => {});
      throw new Error(`IMPORT changeset FAILED: ${reason}`);
    } catch (innerErr) {
      if (innerErr instanceof Error && innerErr.message.startsWith('IMPORT changeset FAILED')) {
        throw innerErr;
      }
      throw err;
    }
  }

  logger.info(`Executing IMPORT changeset...`);
  await cfnClient.send(
    new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
  );

  await waitUntilStackImportComplete(
    { client: cfnClient, maxWaitTime: 3600 },
    { StackName: stackName }
  );
}

async function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [y/N] `);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

export function createExportCommand(): Command {
  const cmd = new Command('export')
    .description(
      'Hand a cdkd-managed stack over to CloudFormation via CFn IMPORT (changeset). ' +
        'AWS resources are unchanged; cdkd state for the stack is deleted on success. ' +
        'Mirror of `cdkd import` (AWS → cdkd) in the reverse direction (cdkd → CFn). ' +
        'JSON templates only. Aborts if any resource is not CFn-importable.'
    )
    .argument('[stack]', 'Stack name to export (auto-detected for single-stack apps)')
    .option(
      '--cfn-stack-name <name>',
      'Name of the destination CloudFormation stack. Defaults to the cdkd stack name.'
    )
    .option(
      '--template <path>',
      'Path to a pre-rendered CloudFormation template (JSON). Skips synth.'
    )
    .option(
      '--stack-region <region>',
      'Region of the cdkd state record to operate on. Required when the same stack name has state in multiple regions.'
    )
    .option('--dry-run', 'Print the import plan without creating a changeset.', false)
    .action(withErrorHandling(exportCommand));

  [...commonOptions, ...appOptions, ...stateOptions, ...contextOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
