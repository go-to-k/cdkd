import { resolve } from 'node:path';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { LocalMigrateError } from '../../../utils/error-handler.js';
import { getLogger } from '../../../utils/logger.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import { verifyCdkCliAvailable } from './cdk-cli-check.js';
import {
  prefetchCfnStack,
  validatePrefetchResult,
  type PrefetchedResource,
} from './cfn-stack-prefetch.js';
import { assertOutputDirAvailable } from './output-dir-guard.js';
import { spawnCdkMigrate } from './cdk-migrate-spawn.js';
import { installGeneratedAppDeps, synthGeneratedApp } from './synth-after-migrate.js';

/**
 * Build an extra-env bag for subprocesses (`npm install`, `cdk synth`)
 * so they inherit the AWS profile the caller selected via `--profile`.
 *
 * Without this, `cdk synth` falls back to the SDK default credential
 * chain (or no credentials at all) when the user runs cdkd under a
 * non-default profile — which silently produces a template synthesized
 * against the wrong account / region context.
 */
function buildAwsEnv(opts: RunMigrateLibraryOptions): NodeJS.ProcessEnv {
  return opts.profile ? { AWS_PROFILE: opts.profile } : {};
}

/**
 * Options for {@link runMigrateLibrary} — the PR A library entry point.
 *
 * Mirrors the eventual `cdkd migrate` CLI flag set (PR B registers the
 * command + parses the same options into this shape). Kept narrow so
 * the library is callable from tests without spinning up Commander.
 */
export interface RunMigrateLibraryOptions {
  /** Source CloudFormation stack name to adopt. Required. */
  fromCfnStack: string;
  /** Parent directory under which the generated CDK app is written. Default `<cwd>/<fromCfnStack>`. */
  outputDir?: string;
  /** Generated-app language. v1 ships with TypeScript only. */
  language?: 'typescript';
  /** AWS region for the source CFn stack. */
  region?: string;
  /** AWS account id (forwarded to `cdk migrate`). Optional — auto-detected. */
  account?: string;
  /** `--filter Key=Value` entries (repeatable). */
  filters?: string[];
  /** AWS profile name. */
  profile?: string;
  /** Override the `cdk` binary location. Default `'cdk'` (PATH lookup). */
  cdkBinPath?: string;
  /** Skip `npm install` after codegen (CI with a pre-populated cache). */
  skipInstall?: boolean;
  /** Skip `cdk synth` after codegen — returns assemblyDir without the synth template. */
  skipSynth?: boolean;
}

/**
 * Result of {@link runMigrateLibrary}.
 *
 * Surfaces every artifact PR B's orchestrator will need to drive the
 * subsequent import + retire flow:
 *
 *  - `outputDir`         — `<outputPath>/<stackName>` (where `cdk migrate`
 *    wrote the generated CDK app).
 *  - `assemblyDir`       — `<outputDir>/cdk.out` (the cloud assembly
 *    `cdk synth` produced, even when `skipSynth: true` for shape
 *    stability).
 *  - `templateBody`      — parsed root-stack template the generated app
 *    emits AFTER synth. `null` when `skipSynth: true`.
 *  - `sourceCfnTemplate` — the SOURCE CFn template the migration is
 *    adopting (`GetTemplate(Stage=Original)`); kept here so PR B's
 *    mapping layer doesn't have to re-fetch it.
 *  - `sourceResources`   — `DescribeStackResources` output filtered to
 *    `(LogicalResourceId, PhysicalResourceId, ResourceType)` triples
 *    PR B's mapping layer consumes.
 */
export interface RunMigrateLibraryResult {
  outputDir: string;
  assemblyDir: string;
  templateBody: unknown;
  sourceCfnTemplate: unknown;
  sourceResources: PrefetchedResource[];
}

/**
 * PR A library entry point — orchestrates the codegen + synth half of
 * `cdkd migrate --from-cfn-stack` without writing cdkd state, running
 * import, or touching the source CFn stack.
 *
 * Flow:
 *   1. `verifyCdkCliAvailable` — hard-fail if `cdk` is missing.
 *   2. `prefetchCfnStack` — read source stack state + resources +
 *      transform info.
 *   3. `validatePrefetchResult` — reject CR / nested-stack / non-
 *      terminal state; INFO log SAM / Include transforms.
 *   4. `assertOutputDirAvailable` — refuse pre-existing non-empty
 *      output dir.
 *   5. `spawnCdkMigrate` — run `cdk migrate --from-stack` subprocess.
 *   6. `installGeneratedAppDeps` (gated by `skipInstall`).
 *   7. `synthGeneratedApp` (gated by `skipSynth`).
 *   8. Return every artifact PR B will consume.
 *
 * Per #465 Q4 (parent-session decision): PR A is library-only. The CLI
 * command (`cdkd migrate`), state writes, retire flow, and resource-
 * mapping algorithm all live in PR B.
 */
export async function runMigrateLibrary(
  opts: RunMigrateLibraryOptions
): Promise<RunMigrateLibraryResult> {
  const logger = getLogger();
  const stackName = opts.fromCfnStack;
  const outputPath = opts.outputDir ?? resolve(process.cwd(), stackName);

  // ---- 1. cdk CLI pre-flight ----
  logger.info(`[migrate] Verifying upstream 'cdk' CLI...`);
  const cliCheck = await verifyCdkCliAvailable(opts.cdkBinPath);
  logger.info(`[migrate] Using cdk CLI v${cliCheck.version}`);
  if (cliCheck.warn) {
    logger.warn(`[migrate] ${cliCheck.warn}`);
  }

  // ---- 2-3. CFn stack pre-fetch + reject ----
  logger.info(`[migrate] Pre-fetching CloudFormation stack '${stackName}'...`);
  const cfnClient = buildCfnClient(opts);
  let prefetch;
  try {
    prefetch = await prefetchCfnStack(stackName, cfnClient);
  } finally {
    // Best-effort: SDK clients hold sockets open; destroy releases them.
    cfnClient.destroy?.();
  }
  validatePrefetchResult(prefetch);

  // Surface SAM / Include transform info as a non-blocking INFO log per
  // the parent-session spec (Q2): SAM and Include are EXPANDED by `cdk
  // migrate` client-side, so the generated CDK code uses plain L1
  // constructs (not SAM constructs). Users should know up front.
  if (prefetch.transformInfo.hasSamTransform) {
    logger.info(
      `[migrate] INFO: source CFn stack uses 'AWS::Serverless' transform; cdk migrate ` +
        `will expand it client-side and the generated CDK code will use plain Lambda + ` +
        `API Gateway L1 constructs (not SAM).`
    );
  }
  if (prefetch.transformInfo.hasIncludeTransform) {
    logger.info(
      `[migrate] INFO: source CFn stack uses 'AWS::Include' transform; cdk migrate ` +
        `will expand it client-side and the generated CDK code will inline the included ` +
        `template content.`
    );
  }

  // ---- 4. output dir guard ----
  assertOutputDirAvailable(outputPath, stackName);

  // ---- 5. cdk migrate subprocess ----
  // The same `--stack-name` flag serves as both source stack name (when
  // `--from-stack` is set) AND output stack name. v1 re-uses the
  // source name for both — PR B may surface an override.
  const spawnResult = await spawnCdkMigrate({
    stackName,
    fromStackName: stackName,
    outputPath,
    ...(opts.language && { language: opts.language }),
    ...(opts.region && { region: opts.region }),
    ...(opts.account && { account: opts.account }),
    ...(opts.filters && { filters: opts.filters }),
    ...(opts.profile && { profile: opts.profile }),
    ...(opts.cdkBinPath && { cdkBinPath: opts.cdkBinPath }),
  });

  // ---- 6. npm install (skippable) ----
  // Thread AWS_PROFILE through so any postinstall hook that hits AWS
  // resolves under the same identity as the rest of the migration.
  await installGeneratedAppDeps(spawnResult.outputDir, {
    skipInstall: opts.skipInstall ?? false,
    extraEnv: buildAwsEnv(opts),
  });

  // ---- 7. cdk synth (skippable) ----
  // `cdk synth` invokes the generated CDK app, which can use context
  // providers that hit AWS — so the AWS profile must thread through.
  const synthResult = await synthGeneratedApp(spawnResult.outputDir, {
    skipSynth: opts.skipSynth ?? false,
    ...(opts.cdkBinPath && { cdkBinPath: opts.cdkBinPath }),
    extraEnv: buildAwsEnv(opts),
  });

  // ---- 8. Surface source CFn template for PR B's mapping layer ----
  // The prefetch already parsed the source template (single
  // `GetTemplate` call serves both transform detection AND the
  // mapping layer). Hard-fail if prefetch could not fetch the body —
  // by this point we already verified the stack exists and is stable,
  // so a missing template means AWS denied the read or surfaced
  // another error worth aborting on.
  if (prefetch.sourceCfnTemplate === null) {
    throw new LocalMigrateError(
      `Could not read the source CloudFormation template for '${stackName}' ` +
        `(GetTemplate failed during pre-flight). Re-run after granting ` +
        `cloudformation:GetTemplate on the stack, or check the earlier warning for details.`
    );
  }

  return {
    outputDir: spawnResult.outputDir,
    assemblyDir: synthResult.assemblyDir,
    templateBody: synthResult.templateBody,
    sourceCfnTemplate: prefetch.sourceCfnTemplate,
    sourceResources: prefetch.resources,
  };
}

/**
 * Build a CloudFormation client using cdkd's shared {@link AwsClients}
 * factory so the credential chain matches every other cdkd command.
 *
 * Keeping the construction in one place makes the per-command CFn-
 * client recipe a single readable hook for future plumbing (e.g.
 * threading PR B's `--role-arn` STS-assume).
 */
function buildCfnClient(opts: RunMigrateLibraryOptions): CloudFormationClient {
  const config: {
    region?: string;
    profile?: string;
  } = {};
  if (opts.region) config.region = opts.region;
  if (opts.profile) config.profile = opts.profile;
  const clients = new AwsClients(config);
  return clients.getCloudFormationClient();
}
