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
  waitUntilStackUpdateComplete,
  type ResourceToImport,
  type Parameter,
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
  /**
   * Allow proceeding when the user passed CLI `-c key=value` overrides
   * that are not persisted to cdk.json / cdk.context.json. The default
   * is to refuse, because those CLI values are visible to cdkd's synth
   * but invisible to subsequent `cdk deploy` invocations — a different
   * template gets synthesized post-migration, which causes spurious
   * drift or replacement on the first `cdk deploy`.
   */
  acceptTransientContext: boolean;
  /**
   * When true and the stack contains resources that cannot be CFn-imported
   * (currently only `Custom::*` qualifies), run a 2-phase migration:
   *   Phase 1: IMPORT changeset for importable resources.
   *   Phase 2: UPDATE changeset for the full template — CFn CREATEs the
   *            non-importable resources fresh, invoking each
   *            `Custom::*`'s backing Lambda's onCreate handler.
   *
   * Default false: the command aborts with a clear error if any
   * non-importable resource is present, so users opt in to the
   * potential side effects (CR onCreate is re-run, which may not be
   * idempotent).
   */
  includeNonImportable: boolean;
  /**
   * `Key=Value` overrides for CFn template Parameters, repeatable. Used
   * when the synthesized template's Parameters section has entries
   * without `Default` values, or when the user wants to override a
   * default for the export.
   */
  parameter?: string[];
  /**
   * Refuse to export when another cdkd stack in the same CDK app
   * references the exporting stack via `Fn::GetStackOutput`. The default
   * is to warn but proceed (the user might be migrating consumer stacks
   * in a follow-up). With this flag set, any such reference aborts.
   */
  strictCrossStack: boolean;
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

/**
 * Per-type splitter for composite primary identifiers — CloudFormation
 * resource types whose `primaryIdentifier` has more than one field.
 *
 * Input: cdkd state's `physicalId` for the resource (the value
 * `provider.create()` returned and cdkd persisted).
 *
 * Output: the `ResourceIdentifier` object CFn IMPORT expects, keyed by
 * the field names CFn defines in the schema.
 *
 * cdkd's own per-type physicalId format is provider-defined (see
 * `src/provisioning/providers/*.ts` — most composites use `|` as the
 * separator). When the per-type format does NOT match the order CFn
 * expects (e.g. `AWS::EC2::VPCGatewayAttachment` stores `IGW|VpcId` but
 * CFn primaryIdentifier is `[VpcId, InternetGatewayId]`), the splitter
 * reorders explicitly.
 *
 * Adding a new composite type: identify cdkd's physicalId format in the
 * matching `src/provisioning/providers/*.ts`, look up the CFn primary
 * identifier via `aws cloudformation describe-type` or the resource
 * schema docs, and add an entry below.
 */
type CompositeIdSplitter = (physicalId: string) => Record<string, string>;

const COMPOSITE_ID_SPLITTERS: Record<string, CompositeIdSplitter> = {
  // cdkd stores `restApiId|resourceId|httpMethod` (apigateway-provider.ts);
  // CFn primary identifier is [RestApiId, ResourceId, HttpMethod] — same order.
  'AWS::ApiGateway::Method': (id) => {
    const parts = id.split('|');
    if (parts.length !== 3) {
      throw new Error(
        `expected 3 parts (restApiId|resourceId|httpMethod), got ${parts.length}: '${id}'`
      );
    }
    return { RestApiId: parts[0]!, ResourceId: parts[1]!, HttpMethod: parts[2]! };
  },
  // cdkd stores `restApiId|resourceId` (apigateway-provider.ts);
  // CFn primary identifier is [RestApiId, ResourceId].
  'AWS::ApiGateway::Resource': (id) => {
    const parts = id.split('|');
    if (parts.length !== 2) {
      throw new Error(`expected 2 parts (restApiId|resourceId), got ${parts.length}: '${id}'`);
    }
    return { RestApiId: parts[0]!, ResourceId: parts[1]! };
  },
  // cdkd stores `IGW|VpcId` (ec2-provider.ts);
  // CFn primary identifier is [VpcId, InternetGatewayId] — DIFFERENT order
  // from cdkd. Splitter reorders explicitly.
  'AWS::EC2::VPCGatewayAttachment': (id) => {
    const parts = id.split('|');
    if (parts.length !== 2) {
      throw new Error(`expected 2 parts (IGW|VpcId), got ${parts.length}: '${id}'`);
    }
    return { VpcId: parts[1]!, InternetGatewayId: parts[0]! };
  },
};

/**
 * Returns true if cdkd has a registered splitter for the given type. Used
 * by `resolveResourceIdentifier` to decide between the single-key and
 * composite paths, and by tests to assert coverage.
 */
export function hasCompositeIdSplitter(resourceType: string): boolean {
  return Object.prototype.hasOwnProperty.call(COMPOSITE_ID_SPLITTERS, resourceType);
}

/**
 * Exported for unit tests — apply the registered splitter for `resourceType`
 * to `physicalId` and return the resulting `ResourceIdentifier` object.
 * Throws when no splitter is registered (same shape as
 * `resolveResourceIdentifier`'s composite path).
 */
export function splitCompositePhysicalId(
  resourceType: string,
  physicalId: string
): Record<string, string> {
  const splitter = COMPOSITE_ID_SPLITTERS[resourceType];
  if (!splitter) {
    throw new Error(`no composite-id splitter registered for ${resourceType}`);
  }
  return splitter(physicalId);
}

interface ImportPlanEntry {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  /**
   * The `ResourceIdentifier` map CFn IMPORT expects in `ResourcesToImport[].ResourceIdentifier`.
   * Single-key types have a one-entry object (`{ BucketName: 'my-bucket' }`); composite types
   * have one entry per `primaryIdentifier` field (`{ RestApiId: '...', ResourceId: '...' }`).
   */
  resourceIdentifier: Record<string, string>;
}

async function exportCommand(stackArg: string | undefined, options: ExportOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }

  warnIfDeprecatedRegion(options);

  // Gate transient context overrides. CLI `-c key=value` flags are
  // visible to cdkd's synth but NOT persisted to cdk.json /
  // cdk.context.json, so a subsequent `cdk deploy` would synthesize a
  // different template and CFn would replace or update resources.
  // Default-refuse forces the user to either move the overrides into
  // cdk.json (durable) or explicitly accept the risk with
  // `--accept-transient-context`. Done up front, before synth, so the
  // error message is the very first thing the user sees.
  refuseTransientContextIfUnsafe(options);

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
    // Set when synth runs (not when --template is used). Captures all
    // stacks in the user's CDK app, used by the cross-stack consumer
    // scan to detect Fn::GetStackOutput references to the exporting
    // stack from sibling stacks.
    let allSynthStacks: Array<{ stackName: string; template: unknown }> = [];

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
      allSynthStacks = result.stacks.map((s) => ({
        stackName: s.stackName,
        template: s.template,
      }));
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
    //
    // `acquireLock` returns `false` (rather than throwing) when another
    // live, non-expired lock holder exists. Most cdkd commands discard
    // this return value, but export is uniquely irreversible — once the
    // CFn IMPORT changeset executes and cdkd state is deleted, we cannot
    // back out — so we refuse the operation rather than racing a
    // concurrent `cdkd deploy` / `cdkd destroy` on the same stack.
    const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
    if (!options.dryRun) {
      const acquired = await lockManager.acquireLock(
        resolvedStackName,
        targetRegion,
        owner,
        'export'
      );
      if (!acquired) {
        throw new Error(
          `Could not acquire lock for stack '${resolvedStackName}' (${targetRegion}) — ` +
            `another cdkd process holds it. Wait for it to finish, or run ` +
            `'cdkd force-unlock ${resolvedStackName}' if you are certain no other process is active.`
        );
      }
    }

    try {
      // Build the import plan: cdkd state × template resources, classified
      // into phase1 (importable) / phase2 (Custom::* CFn will CREATE) /
      // blocked (anything else — aborts the run).
      const { phase1Imports, phase2Creates, blocked } = await buildImportPlan(
        state,
        template,
        awsClients.cloudFormation
      );

      if (blocked.length > 0) {
        logger.error('The following resources block migration:');
        for (const b of blocked) {
          logger.error(`  - ${b.logicalId} (${b.resourceType}): ${b.reason}`);
        }
        throw new Error(
          `${blocked.length} resource(s) block migration. Either destroy them first ` +
            `(cdkd destroy / cdkd state destroy cherry-picked), or remove them from the ` +
            `CDK app and re-synthesize.`
        );
      }

      if (phase2Creates.length > 0 && !options.includeNonImportable) {
        logger.error('The following resources cannot be imported into CloudFormation:');
        for (const p of phase2Creates) {
          logger.error(`  - ${p.logicalId} (${p.resourceType}): CFn cannot import this type`);
        }
        throw new Error(
          `${phase2Creates.length} non-importable resource(s) detected (Custom::*). ` +
            `Pass --include-non-importable to run a 2-phase migration: phase 1 imports ` +
            `the importable resources; phase 2 CFn-CREATEs the non-importable ones ` +
            `(re-invoking each Custom Resource's backing Lambda onCreate handler — ` +
            `make sure those are idempotent). Or destroy these resources first.`
        );
      }

      if (phase1Imports.length === 0 && phase2Creates.length === 0) {
        logger.warn('No resources to migrate — cdkd state is empty.');
        return;
      }
      if (phase1Imports.length === 0) {
        throw new Error(
          'No importable resources in the template. CloudFormation IMPORT changeset ' +
            'requires at least one importable resource for phase 1.'
        );
      }

      printPlan(phase1Imports, cfnStackName);
      if (phase2Creates.length > 0) {
        logger.info(`Phase 2 will CREATE ${phase2Creates.length} non-importable resource(s):`);
        for (const p of phase2Creates) {
          logger.info(`  ${p.logicalId} (${p.resourceType})`);
        }
        logger.info('');
      }

      if (options.dryRun) {
        logger.info('--dry-run: no CloudFormation changeset will be created.');
        return;
      }

      if (!options.yes) {
        const phase2Note =
          phase2Creates.length > 0
            ? ` Phase 2 will then CREATE ${phase2Creates.length} non-importable resource(s) ` +
              `(invoking each Custom Resource's onCreate handler).`
            : '';
        const ok = await confirmPrompt(
          `Create CloudFormation stack '${cfnStackName}' by importing ${phase1Imports.length} ` +
            `resource(s) from cdkd state '${resolvedStackName}' (${targetRegion})?` +
            phase2Note +
            ` AWS resources are unchanged on import. cdkd state for '${resolvedStackName}' ` +
            `will be deleted on success.`
        );
        if (!ok) {
          logger.info('Migration cancelled. cdkd state and CloudFormation are unchanged.');
          return;
        }
      }

      // Drift baseline pre-flight. cdkd state schema v3 carries
      // `observedProperties` (the AWS-current snapshot at last
      // deploy / import), which is the baseline `cdkd drift` compares
      // against. If the baseline is missing — older state schemas or
      // resources written by providers without `readCurrentState` —
      // the user has no reliable way to verify the CDK template matches
      // AWS reality before the migration. Surface that as a warning so
      // they can re-run `cdkd state refresh-observed` first if drift
      // matters.
      reportDriftBaselineGaps(state, logger);

      // Cross-stack consumer scan. After this stack moves to CFn, its
      // outputs live in CFn (not cdkd state), so cdkd's
      // `Fn::GetStackOutput` resolver — which reads cdkd state — can no
      // longer find them. Warn (or refuse with --strict-cross-stack) when
      // any sibling stack in the same CDK app references this one. The
      // scan only sees stacks in `allSynthStacks` — when the user passes
      // --template, we skip the scan because we have no sibling templates.
      if (allSynthStacks.length > 0) {
        const crossRefs = scanCrossStackReferences(allSynthStacks, resolvedStackName);
        if (crossRefs.length > 0) {
          const lines = crossRefs.map(
            (r) =>
              `  ${r.consumerStackName} → ${resolvedStackName}.${r.outputName} at ${r.location}`
          );
          if (options.strictCrossStack) {
            throw new Error(
              `Refusing to export: ${crossRefs.length} cross-stack reference(s) to ` +
                `${resolvedStackName} found in sibling stacks. After migration, those ` +
                `references will break (cdkd's Fn::GetStackOutput reads cdkd state; the ` +
                `migrated stack's outputs live in CFn). Migrate consumers first, or remove ` +
                `the references, or drop --strict-cross-stack to proceed with a warning:\n` +
                lines.join('\n')
            );
          }
          logger.warn(
            `${crossRefs.length} cross-stack reference(s) to '${resolvedStackName}' from ` +
              `sibling stacks. These will break the next time those stacks deploy via cdkd ` +
              `(cdkd's Fn::GetStackOutput resolver reads cdkd state; the migrated stack's ` +
              `outputs are now in CFn). Plan multi-stack migrations from the leaves up.`
          );
          for (const line of lines) logger.warn(line);
        }
      }

      // Resolve template Parameters once (used by both phase 1 and phase 2).
      // Aborts here if the template has required parameters without
      // defaults that the user did not supply via --parameter.
      const userParameters = parseParameterOverrides(options.parameter);
      const { parameters: cfnParameters, missing } = resolveTemplateParameters(
        template,
        userParameters
      );
      if (missing.length > 0) {
        throw new Error(
          `Template requires parameter(s) without defaults: ${missing.join(', ')}. ` +
            `Pass each one as --parameter Key=Value (or set a Default in the CDK code).`
        );
      }

      // Phase 1: IMPORT changeset.
      const phase1Template = filterTemplateForImport(template, phase1Imports);
      await executeImportChangeSet(
        awsClients.cloudFormation,
        cfnStackName,
        phase1Template,
        phase1Imports,
        cfnParameters
      );

      logger.info(
        `✓ Phase 1: CloudFormation stack '${cfnStackName}' created via IMPORT. ` +
          `${phase1Imports.length} resource(s) imported.`
      );

      // Phase 2: UPDATE changeset to add the non-importable resources via
      // CREATE. Skipped when there are none. A phase-2 failure leaves the
      // CFn stack in a partial state (phase 1 resources imported, phase 2
      // missing) and cdkd state intact so the user can recover manually
      // via `aws cloudformation update-stack` + `cdkd state orphan`.
      if (phase2Creates.length > 0) {
        try {
          await executeUpdateChangeSet(
            awsClients.cloudFormation,
            cfnStackName,
            template,
            cfnParameters
          );
          logger.info(`✓ Phase 2: ${phase2Creates.length} non-importable resource(s) CREATEd.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Phase 1 (IMPORT) succeeded; phase 2 (UPDATE) failed: ${msg}\n\n` +
              `The CloudFormation stack '${cfnStackName}' now contains the imported ` +
              `resources but is missing the ${phase2Creates.length} non-importable ` +
              `resource(s). cdkd state is UNCHANGED so you can inspect what's in it, ` +
              `but DO NOT run \`cdkd deploy\` against this stack (the imported resources ` +
              `are now CFn-managed). To recover:\n` +
              `  1. Fix the failure cause (typically an onCreate Lambda error).\n` +
              `  2. Re-run the phase 2 UPDATE manually with the full synth template:\n` +
              `       aws cloudformation create-change-set --stack-name ${cfnStackName} \\\n` +
              `         --change-set-name cdkd-phase2-retry --change-set-type UPDATE \\\n` +
              `         --template-body file://<full-template.json>\n` +
              `  3. Once phase 2 succeeds, run: cdkd state orphan ${resolvedStackName}\n` +
              `     to clean up cdkd's stale state record.`
          );
        }
      }

      // Delete cdkd state for the migrated stack. Done AFTER phase 2 so a
      // phase-2 failure leaves state intact for recovery (see catch above).
      // The lock is still held; we release it inside the outer `finally`.
      await stateBackend.deleteState(resolvedStackName, targetRegion);
      logger.info(
        `cdkd state for '${resolvedStackName}' (${targetRegion}) removed. ` +
          `Manage the stack with 'cdk deploy' or 'aws cloudformation' from here on.`
      );

      // Print the load-bearing handoff message: the exact cdk diff / cdk
      // deploy commands the user should run next, including any -c
      // overrides captured from this export run.
      printNextSteps({
        cfnStackName,
        cdkStackName: resolvedStackName,
        contextOverrides: options.context ?? [],
      });

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

interface BlockedResource {
  logicalId: string;
  resourceType: string;
  reason: string;
}

/**
 * A resource that the 2-phase flow will CREATE in phase 2 (not import in
 * phase 1). Currently only `Custom::*` qualifies — CFn cannot adopt
 * custom-resource state, so the only way to make CFn aware of them is to
 * have it CREATE the resource fresh (which re-invokes the backing Lambda's
 * onCreate handler).
 */
interface Phase2CreateEntry {
  logicalId: string;
  resourceType: string;
}

/**
 * Returns true when a resource type is non-importable BUT can be handled
 * by the phase-2 CREATE path. Today this is exactly `Custom::*` (Lambda-
 * backed Custom Resources whose backing Lambda is itself in the same
 * stack and gets imported in phase 1).
 *
 * `AWS::CloudFormation::Stack` (nested stacks) is intentionally NOT in
 * this set: CFn would CREATE a duplicate nested stack rather than adopt
 * the existing one, which would conflict with whatever the cdkd state
 * thought it owned. cdkd doesn't deploy nested stacks anyway.
 *
 * Exported for unit testing.
 */
export function isPhase2CreatableType(resourceType: string): boolean {
  return resourceType.startsWith('Custom::');
}

/**
 * Build the import plan from cdkd state + the synthesized template.
 *
 * Classifies every template resource into one of:
 *   - `phase1Imports`: importable into the new CFn stack via the IMPORT
 *     changeset. Must have an entry in cdkd state with a non-empty
 *     `physicalId` and a resolvable primary identifier.
 *   - `phase2Creates`: non-importable but `isPhase2CreatableType` — CFn
 *     will CREATE these in the phase-2 UPDATE changeset. Currently only
 *     `Custom::*`.
 *   - `blocked`: anything else. A non-empty `blocked` aborts the run.
 */
async function buildImportPlan(
  state: StackState,
  template: Record<string, unknown>,
  cfnClient: AwsClients['cloudFormation']
): Promise<{
  phase1Imports: ImportPlanEntry[];
  phase2Creates: Phase2CreateEntry[];
  blocked: BlockedResource[];
}> {
  const templateResources = template['Resources'];
  if (
    !templateResources ||
    typeof templateResources !== 'object' ||
    Array.isArray(templateResources)
  ) {
    throw new Error('Template has no Resources section.');
  }

  const phase1Imports: ImportPlanEntry[] = [];
  const phase2Creates: Phase2CreateEntry[] = [];
  const blocked: BlockedResource[] = [];
  const identifierCache = new Map<string, PrimaryIdentifierCacheEntry>();

  for (const [logicalId, raw] of Object.entries(templateResources as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const resource = raw as { Type?: string };
    const resourceType = resource.Type ?? '';
    if (!resourceType) continue;

    if (resourceType === 'AWS::CDK::Metadata') {
      // CDK sentinel — silently dropped. Not a real AWS resource.
      continue;
    }

    if (isNeverImportableType(resourceType)) {
      if (isPhase2CreatableType(resourceType)) {
        // Custom::* — CFn will CREATE fresh in phase 2.
        phase2Creates.push({ logicalId, resourceType });
      } else {
        // Nested stacks etc. — hard block.
        blocked.push({
          logicalId,
          resourceType,
          reason: 'CloudFormation cannot import or recreate this resource type',
        });
      }
      continue;
    }

    const stateEntry: ResourceState | undefined = state.resources[logicalId];
    if (!stateEntry || !stateEntry.physicalId) {
      blocked.push({
        logicalId,
        resourceType,
        reason: 'no entry in cdkd state (resource is in template but was not deployed by cdkd)',
      });
      continue;
    }

    let resourceIdentifier: Record<string, string>;
    try {
      resourceIdentifier = await resolveResourceIdentifier(
        resourceType,
        stateEntry.physicalId,
        cfnClient,
        identifierCache
      );
    } catch (err) {
      blocked.push({
        logicalId,
        resourceType,
        reason:
          'could not resolve resource identifier: ' +
          (err instanceof Error ? err.message : String(err)),
      });
      continue;
    }

    phase1Imports.push({
      logicalId,
      resourceType,
      physicalId: stateEntry.physicalId,
      resourceIdentifier,
    });
  }

  return { phase1Imports, phase2Creates, blocked };
}

/**
 * Per-type cached `primaryIdentifier` field names from
 * `cloudformation:DescribeType`. The cache key is the resource type;
 * the value is the field-name list (length 1 for single-key types,
 * length > 1 for composites).
 */
type PrimaryIdentifierCacheEntry = { fields: string[] };

/**
 * Build the `ResourceIdentifier` map CloudFormation IMPORT expects in
 * `ResourcesToImport[].ResourceIdentifier` for the given resource type
 * and cdkd state's physical ID.
 *
 * Single-key types: the map has a single entry keyed by the schema's
 * primaryIdentifier field name (e.g. `{ BucketName: 'my-bucket' }`).
 *
 * Composite types (`primaryIdentifier.length > 1`): a per-type splitter
 * registered in `COMPOSITE_ID_SPLITTERS` parses cdkd's physicalId — whose
 * format is provider-defined, see `src/provisioning/providers/*.ts` —
 * into one entry per field. Composite types without a registered
 * splitter surface a clear error pointing at where to add one.
 *
 * Prefers `DescribeType` (the authoritative AWS-internal registry) and
 * falls back to a hardcoded single-key table when DescribeType fails
 * (insufficient permissions, throttling, obscure type without a registry
 * entry).
 */
async function resolveResourceIdentifier(
  resourceType: string,
  physicalId: string,
  cfnClient: AwsClients['cloudFormation'],
  cache: Map<string, PrimaryIdentifierCacheEntry>
): Promise<Record<string, string>> {
  let entry = cache.get(resourceType);
  if (entry === undefined) {
    entry = await fetchPrimaryIdentifier(resourceType, cfnClient);
    cache.set(resourceType, entry);
  }

  if (entry.fields.length === 1) {
    // Single-key path: the physicalId IS the identifier value.
    return { [entry.fields[0]!]: physicalId };
  }

  // Composite path: consult the per-type splitter.
  const splitter = COMPOSITE_ID_SPLITTERS[resourceType];
  if (!splitter) {
    throw new Error(
      `resource type uses a composite primary identifier ` +
        `(${entry.fields.length} fields: ${entry.fields.join(', ')}); ` +
        `add an entry to COMPOSITE_ID_SPLITTERS in src/cli/commands/export.ts ` +
        `that parses cdkd's physicalId for this type, or destroy the resource ` +
        `first and let CFn create it fresh`
    );
  }

  let split: Record<string, string>;
  try {
    split = splitter(physicalId);
  } catch (err) {
    throw new Error(
      `composite-id splitter for ${resourceType} failed: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
  // Sanity check: splitter must produce one entry per declared field.
  for (const f of entry.fields) {
    if (!(f in split)) {
      throw new Error(
        `composite-id splitter for ${resourceType} did not produce field '${f}' ` +
          `(produced: ${Object.keys(split).join(', ')})`
      );
    }
  }
  return split;
}

/**
 * Fetch the primary identifier field names for a resource type, with a
 * hardcoded single-key fallback when DescribeType is unavailable.
 */
async function fetchPrimaryIdentifier(
  resourceType: string,
  cfnClient: AwsClients['cloudFormation']
): Promise<PrimaryIdentifierCacheEntry> {
  try {
    const resp = await cfnClient.send(
      new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType })
    );
    if (resp.Schema) {
      const parsed = JSON.parse(resp.Schema) as { primaryIdentifier?: unknown };
      const primary = parsed.primaryIdentifier;
      if (
        Array.isArray(primary) &&
        primary.length > 0 &&
        primary.every((p) => typeof p === 'string')
      ) {
        // Schema entries look like "/properties/BucketName" — strip the
        // JSON-pointer prefix to get the property name.
        const fields = primary.map((p) => p.replace(/^\/properties\//, ''));
        return { fields };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().debug(`DescribeType failed for ${resourceType}: ${msg} — using fallback`);
  }

  const fallback = PRIMARY_IDENTIFIER_FALLBACK[resourceType];
  if (fallback) {
    return { fields: [fallback] };
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
/**
 * Parse `--parameter Key=Value` CLI tokens into a `{Key: Value}` map.
 * Exported for unit testing.
 */
export function parseParameterOverrides(tokens: string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!tokens) return map;
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq < 1) {
      throw new Error(
        `Invalid --parameter '${t}': expected 'Key=Value' (e.g. --parameter Env=prod)`
      );
    }
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1);
    if (!key) {
      throw new Error(`Invalid --parameter '${t}': key is empty`);
    }
    map[key] = value;
  }
  return map;
}

/**
 * Build the `Parameters` array CFn `CreateChangeSetCommand` expects from
 * the synthesized template's `Parameters` section, applying user
 * `--parameter Key=Value` overrides.
 *
 * Resolution order per parameter:
 *   1. User-supplied override (`--parameter Key=Value`)
 *   2. Template `Default`
 *   3. Abort: missing required parameter
 *
 * SSM-typed parameters (`AWS::SSM::Parameter::Value<...>`) are passed
 * through verbatim — CFn resolves the SSM path at changeset execution
 * time, so cdkd does not need to make an extra SSM API call.
 *
 * Exported for unit testing.
 */
export function resolveTemplateParameters(
  template: Record<string, unknown>,
  userOverrides: Record<string, string>
): { parameters: Parameter[]; missing: string[] } {
  const tplParams = template['Parameters'];
  if (!tplParams || typeof tplParams !== 'object' || Array.isArray(tplParams)) {
    // Template has no Parameters section — nothing to forward.
    const stray = Object.keys(userOverrides);
    if (stray.length > 0) {
      throw new Error(
        `--parameter override(s) supplied (${stray.join(', ')}) but template has no Parameters section.`
      );
    }
    return { parameters: [], missing: [] };
  }

  const parameters: Parameter[] = [];
  const missing: string[] = [];
  const known = new Set<string>();

  for (const [name, raw] of Object.entries(tplParams as Record<string, unknown>)) {
    known.add(name);
    const def = (raw ?? {}) as { Default?: unknown };
    const override = userOverrides[name];
    if (override !== undefined) {
      parameters.push({ ParameterKey: name, ParameterValue: override });
      continue;
    }
    if ('Default' in def) {
      // Coerce non-string defaults (numbers, lists) to the string form CFn expects.
      const value = typeof def.Default === 'string' ? def.Default : String(def.Default);
      parameters.push({ ParameterKey: name, ParameterValue: value });
      continue;
    }
    missing.push(name);
  }

  // Catch typos: a --parameter override for a parameter the template does NOT declare.
  for (const name of Object.keys(userOverrides)) {
    if (!known.has(name)) {
      throw new Error(
        `--parameter override '${name}' does not match any parameter in the synthesized template ` +
          `(template declares: ${[...known].join(', ') || '(none)'})`
      );
    }
  }

  return { parameters, missing };
}

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
/**
 * Pre-flight check for missing drift baselines (`observedProperties`)
 * in the exporting stack's state. cdkd state schema v3 captures
 * `observedProperties` on every successful create / update / import so
 * `cdkd drift` has a reliable AWS-current baseline. Resources written
 * by an older binary OR by providers that do not implement
 * `readCurrentState` lack the field, and `cdkd drift` falls back to
 * comparing against the user's template intent (weaker signal).
 *
 * If we are about to migrate to CFn, the user has no way to roll back
 * post-migration — any drift between cdkd state and AWS reality would
 * surface as spurious changes on the first post-export `cdk deploy`.
 * Warn loudly so the user can run `cdkd state refresh-observed` and
 * `cdkd drift` first if they care. Non-blocking by design — exit is the
 * user's call, not the tool's.
 *
 * Exported for unit testing.
 */
export function reportDriftBaselineGaps(
  state: StackState,
  logger: ReturnType<typeof getLogger>
): void {
  const entries = Object.entries(state.resources ?? {});
  if (entries.length === 0) return;
  const missing = entries.filter(([, r]) => r.observedProperties === undefined);
  if (missing.length === 0) return;
  if (state.version !== undefined && state.version < 3) {
    logger.warn(
      `cdkd state schema is v${state.version} (pre-observedProperties). cdkd drift ` +
        `cannot reliably compare against AWS for this stack; the next \`cdk deploy\` ` +
        `after migration may surface spurious changes if AWS has drifted from the ` +
        `template. Run \`cdkd state refresh-observed ${state.stackName}\` (or any ` +
        `redeploy) before export to capture an AWS-current baseline.`
    );
    return;
  }
  logger.warn(
    `${missing.length} of ${entries.length} resource(s) in cdkd state lack an ` +
      `AWS-current baseline (observedProperties). cdkd drift may produce false positives ` +
      `for them; the next \`cdk deploy\` after migration may surface unexpected changes. ` +
      `Run \`cdkd state refresh-observed ${state.stackName}\` to capture a baseline before ` +
      `export, then \`cdkd drift\` to verify the stack matches AWS.`
  );
  for (const [logicalId] of missing.slice(0, 10)) {
    logger.warn(`  ${logicalId}`);
  }
  if (missing.length > 10) {
    logger.warn(`  ... and ${missing.length - 10} more`);
  }
}

/**
 * A `Fn::GetStackOutput` reference found in another stack's template,
 * pointing at the stack being exported. Produced by `scanCrossStackReferences`.
 */
export interface CrossStackReference {
  /** Logical ID of the stack that contains the reference. */
  consumerStackName: string;
  /** OutputName from the `Fn::GetStackOutput` call. */
  outputName: string;
  /** Where in the consumer template the reference appears (Resources / Outputs path). */
  location: string;
}

/**
 * Walk every stack other than `exportingStackName` looking for
 * `Fn::GetStackOutput` calls that target the exporting stack. Used as a
 * safety pre-flight before `cdkd export`: after the exporting stack
 * moves to CloudFormation, its outputs live in CFn (not cdkd state), so
 * cdkd's `Fn::GetStackOutput` resolver — which reads cdkd state — can
 * no longer find them.
 *
 * Implementation: recursive walk of each non-exporting stack's template,
 * collecting every `{"Fn::GetStackOutput": {StackName: <exporting>, OutputName: <name>}}`
 * entry. The intrinsic accepts either an object form
 * (`{StackName: ..., OutputName: ...}`) or — historically — an array
 * form (`[stackName, outputName]`); we accept both.
 *
 * Exported for unit testing.
 */
export function scanCrossStackReferences(
  stacks: Array<{ stackName: string; template: unknown }>,
  exportingStackName: string
): CrossStackReference[] {
  const refs: CrossStackReference[] = [];
  for (const stack of stacks) {
    if (stack.stackName === exportingStackName) continue;
    walkForGetStackOutput(stack.template, '', (ref) => {
      if (ref.stackName === exportingStackName) {
        refs.push({
          consumerStackName: stack.stackName,
          outputName: ref.outputName,
          location: ref.location,
        });
      }
    });
  }
  return refs;
}

function walkForGetStackOutput(
  node: unknown,
  path: string,
  emit: (ref: { stackName: string; outputName: string; location: string }) => void
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkForGetStackOutput(item, `${path}[${i}]`, emit));
    return;
  }
  const obj = node as Record<string, unknown>;
  const intrinsic = obj['Fn::GetStackOutput'];
  if (intrinsic !== undefined) {
    // Object form (current, documented): { StackName: "...", OutputName: "..." }.
    if (intrinsic && typeof intrinsic === 'object' && !Array.isArray(intrinsic)) {
      const i = intrinsic as Record<string, unknown>;
      const stackName = typeof i['StackName'] === 'string' ? i['StackName'] : undefined;
      const outputName = typeof i['OutputName'] === 'string' ? i['OutputName'] : undefined;
      if (stackName && outputName) {
        emit({ stackName, outputName, location: path });
      }
    } else if (Array.isArray(intrinsic) && intrinsic.length === 2) {
      // Defensive: legacy array form [stackName, outputName].
      const arr = intrinsic as unknown[];
      const stackName = arr[0];
      const outputName = arr[1];
      if (typeof stackName === 'string' && typeof outputName === 'string') {
        emit({ stackName, outputName, location: path });
      }
    }
    // Fall through: the intrinsic's value may contain other intrinsics
    // (e.g. Fn::Sub'd StackName). Walk into it so nested calls still surface.
  }
  for (const [key, value] of Object.entries(obj)) {
    walkForGetStackOutput(value, path ? `${path}.${key}` : key, emit);
  }
}

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
    const idStr = Object.entries(entry.resourceIdentifier)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    logger.info(`  ${entry.logicalId} (${entry.resourceType}) ← ${idStr}`);
  }
  logger.info('');
}

async function executeImportChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  plan: ImportPlanEntry[],
  parameters: Parameter[]
): Promise<void> {
  const logger = getLogger();
  const changeSetName = `cdkd-migrate-${Date.now()}`;
  const templateBody = JSON.stringify(template, null, 2);

  const resourcesToImport: ResourceToImport[] = plan.map((entry) => ({
    ResourceType: entry.resourceType,
    LogicalResourceId: entry.logicalId,
    ResourceIdentifier: entry.resourceIdentifier,
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
        ...(parameters.length > 0 && { Parameters: parameters }),
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

  // Execute + wait must clean up the changeset on failure too: if the
  // import errors after CreateChangeSet succeeded, the changeset sticks
  // around and a subsequent run hits `assertCfnStackAbsent`'s "stack
  // already exists" path (CFn parks the stack in REVIEW_IN_PROGRESS).
  // We delete the changeset best-effort and let the original error
  // propagate.
  logger.info(`Executing IMPORT changeset...`);
  try {
    await cfnClient.send(
      new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
    );
    await waitUntilStackImportComplete(
      { client: cfnClient, maxWaitTime: 3600 },
      { StackName: stackName }
    );
  } catch (err) {
    await cfnClient
      .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
      .catch(() => {});
    throw err;
  }
}

/**
 * Phase 2 of the 2-phase migration: a CFn UPDATE changeset that ADDs the
 * non-importable resources (`Custom::*`) to the just-created stack. CFn
 * diffs against the phase-1 stack state, sees the new resources, and
 * CREATEs them — which invokes each Custom Resource's backing Lambda
 * onCreate handler.
 *
 * Failure semantics: caller catches and surfaces a clear recovery path
 * (cdkd state is intentionally NOT deleted between phases, so a phase-2
 * failure leaves a recoverable state).
 */
async function executeUpdateChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  parameters: Parameter[]
): Promise<void> {
  const logger = getLogger();
  const changeSetName = `cdkd-phase2-${Date.now()}`;
  const templateBody = JSON.stringify(template, null, 2);

  if (templateBody.length > 51200) {
    throw new Error(
      `Full template is ${templateBody.length} bytes, over the 51,200-byte inline ` +
        `TemplateBody limit for phase-2 UPDATE. TemplateURL upload is not yet implemented.`
    );
  }

  logger.info(
    `Creating UPDATE changeset '${changeSetName}' for phase 2 ` +
      `(${templateBody.length} bytes)...`
  );

  try {
    await cfnClient.send(
      new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ChangeSetType: 'UPDATE',
        TemplateBody: templateBody,
        ...(parameters.length > 0 && { Parameters: parameters }),
        Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create UPDATE changeset: ${msg}`);
  }

  try {
    await waitUntilChangeSetCreateComplete(
      { client: cfnClient, maxWaitTime: 600 },
      { StackName: stackName, ChangeSetName: changeSetName }
    );
  } catch (err) {
    try {
      const desc = await cfnClient.send(
        new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
      );
      const reason = desc.StatusReason ?? 'unknown';
      await cfnClient
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
        .catch(() => {});
      throw new Error(`UPDATE changeset FAILED: ${reason}`);
    } catch (innerErr) {
      if (innerErr instanceof Error && innerErr.message.startsWith('UPDATE changeset FAILED')) {
        throw innerErr;
      }
      throw err;
    }
  }

  logger.info(`Executing UPDATE changeset...`);
  try {
    await cfnClient.send(
      new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
    );
    await waitUntilStackUpdateComplete(
      { client: cfnClient, maxWaitTime: 3600 },
      { StackName: stackName }
    );
  } catch (err) {
    await cfnClient
      .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
      .catch(() => {});
    throw err;
  }
}

/**
 * Refuse to proceed when the user passed CLI `-c key=value` overrides
 * without `--accept-transient-context`. The CLI form is not persisted
 * to `cdk.json` / `cdk.context.json`, so a subsequent `cdk deploy`
 * invoked without the same `-c` flags will synthesize a different
 * template — and CFn will see drift / replace resources on first
 * post-migration deploy.
 *
 * The escape hatch (`--accept-transient-context`) is intentionally
 * loud at runtime: a warn is emitted that names every override and
 * tells the user to keep them around for future `cdk deploy` runs.
 *
 * Exported for unit testing.
 */
export function refuseTransientContextIfUnsafe(options: {
  context?: string[];
  acceptTransientContext: boolean;
}): void {
  const overrides = options.context ?? [];
  if (overrides.length === 0) return;

  if (!options.acceptTransientContext) {
    const indented = overrides.map((v) => `    -c ${v}`).join('\n');
    throw new Error(
      `Refusing to export: ${overrides.length} CLI context override(s) supplied via -c are ` +
        `not persisted to cdk.json / cdk.context.json, so subsequent \`cdk deploy\` ` +
        `invocations will synthesize a different template and CFn will see drift or ` +
        `replace resources.\n\n` +
        `Supplied:\n${indented}\n\n` +
        `Choose one:\n` +
        `  (recommended) Move these values into cdk.json's "context": { ... } field, then re-run\n` +
        `                cdkd export without -c. CDK CLI reads cdk.json on every synth, so they\n` +
        `                will be picked up automatically.\n` +
        `  (escape)      Pass --accept-transient-context to proceed. You will then need to\n` +
        `                pass the SAME -c flags to every future \`cdk deploy\` for this stack.`
    );
  }

  const logger = getLogger();
  logger.warn(
    `--accept-transient-context: ${overrides.length} CLI context override(s) will not be ` +
      `persisted to cdk.json / cdk.context.json. Remember to pass the same -c flags to every ` +
      `future \`cdk deploy\` for this stack, or move them to cdk.json before then.`
  );
  for (const v of overrides) {
    logger.warn(`  -c ${v}`);
  }
}

/**
 * Print a final "next steps" block listing the exact `cdk deploy` /
 * `cdk diff` commands the user should run to verify the migration and
 * to manage the stack going forward. Always emitted on successful
 * export — this is the load-bearing "handoff" message that lets a user
 * who runs `cdkd export` once a year find their way without consulting
 * the docs.
 *
 * When CLI `-c` overrides were used (with `--accept-transient-context`),
 * the printed `cdk deploy` and `cdk diff` commands include them, so a
 * copy-paste keeps the synth deterministic.
 */
function printNextSteps(args: {
  cfnStackName: string;
  cdkStackName: string;
  contextOverrides: string[];
}): void {
  const logger = getLogger();
  const ctxArgs = args.contextOverrides.map((v) => ` -c ${v}`).join('');
  const stackId = args.cdkStackName;
  logger.info('');
  logger.info('Next steps — manage the stack with CDK CLI from now on:');
  logger.info(`  cdk diff ${stackId}${ctxArgs}    # verify synth matches what CFn now holds`);
  logger.info(`  cdk deploy ${stackId}${ctxArgs}  # subsequent updates`);
  if (args.contextOverrides.length > 0) {
    logger.info('');
    logger.info(
      '  NOTE: the -c flags above were captured from this export run. They MUST be ' +
        'passed on every future cdk invocation, or moved into cdk.json\'s "context" field.'
    );
  }
  logger.info('');
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
    .option(
      '--accept-transient-context',
      'Allow CLI -c key=value overrides at export time even though they are not ' +
        'persisted to cdk.json / cdk.context.json (default: refuse). When set, the ' +
        'user is responsible for passing the same -c flags to every future cdk deploy.',
      false
    )
    .option(
      '--include-non-importable',
      'Run a 2-phase migration when the stack contains non-importable resources ' +
        '(Custom::*). Phase 1 imports the importable resources; phase 2 CFn-CREATEs ' +
        "the non-importable ones, which re-invokes each Custom Resource's onCreate " +
        'handler. Make sure onCreate is idempotent before enabling.',
      false
    )
    .option(
      '--parameter <key=value...>',
      'CFn template Parameter override, repeatable. Required when the synthesized ' +
        'template has Parameters without Default values; otherwise overrides the ' +
        "template's default value. Format: --parameter Key=Value."
    )
    .option(
      '--strict-cross-stack',
      'Refuse to export when sibling cdkd stacks in the same CDK app reference the ' +
        'exporting stack via Fn::GetStackOutput. Without the flag, cdkd warns but ' +
        'proceeds — the user is expected to migrate the consumer stacks in a follow-up.',
      false
    )
    .action(withErrorHandling(exportCommand));

  [...commonOptions, ...appOptions, ...stateOptions, ...contextOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
