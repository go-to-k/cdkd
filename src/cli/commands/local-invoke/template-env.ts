import { containsCrossStackIntrinsic, readEnvVarsFileText } from 'cdk-local/internal';
import { realAwsException } from '../../../local/local-aws-wiring.js';
import { getLogger } from '../../../utils/logger.js';
import { describeLocalAwsFailureForWarn } from '../../../utils/local-aws-failure.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  describeJsonParseFailure,
  parseFailureDebugDetail,
  utf8ByteLength,
} from '../../../utils/json-parse-failure.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { type EnvOverrideFile } from '../../../local/env-resolver.js';
import { derivePartitionAndUrlSuffix } from '../../../local/ecs-task-resolver.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import {
  emulatorDefaultRegion,
  namedEnvAwsRegion,
} from '../../../utils/emulator-default-region.js';
import { awsClientDefaults } from '../../../utils/aws-client-defaults.js';
import { type LocalInvokeOptions } from './types.js';

/**
 * Returns true when any value in the function's template env map is a
 * CFn intrinsic (non-primitive). Used to gate the `sts:GetCallerIdentity`
 * call inside the `--from-state` flow: literal-only env maps don't need
 * the pseudo-parameter bag and shouldn't pay for an STS hop. Mirrors the
 * ECS `containerHasIntrinsicEnvOrSecret` gating in `ecs-task-resolver/needs.ts`.
 */
export function envHasIntrinsicValue(templateEnv: Record<string, unknown> | undefined): boolean {
  if (!templateEnv) return false;
  for (const v of Object.values(templateEnv)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') continue;
    return true;
  }
  return false;
}

/**
 * Returns true when any value in the function's template env map carries
 * an `Fn::ImportValue` / `Fn::GetStackOutput` intrinsic, at any depth. Used
 * to gate the cross-stack resolver construction inside the `--from-state`
 * flow: literal + same-stack-intrinsic env maps shouldn't pay for the
 * extra S3 client / index-load cost (issue #454).
 *
 * A cross-stack intrinsic nested inside `Fn::Join` / `Fn::Sub` /
 * `Fn::Select` counts too: cdk-local's `substituteAgainstStateAsync`
 * resolves it (go-to-k/cdk-local#965), but only when the resolver was built.
 */
export function envHasCrossStackIntrinsic(
  templateEnv: Record<string, unknown> | undefined
): boolean {
  if (!templateEnv) return false;
  return Object.values(templateEnv).some(containsCrossStackIntrinsic);
}

/**
 * Build the AWS pseudo-parameter bag for `--from-state` env-var
 * substitution. Issues a single `sts:GetCallerIdentity` for the account
 * id and derives `partition` / `urlSuffix` from the resolved region. Any
 * failure is reduced to a warn — the bag is best-effort and an empty
 * bag still works for env vars that only reference real logical IDs.
 *
 * Region precedence (mirrors `local-run-task`): `--region` > `AWS_REGION`
 * > `AWS_DEFAULT_REGION` > the synth-derived stack region > the `--aws-emulator`
 * run's default region (go-to-k/cdkd#6270: that default is not a region the
 * user named, so a stack's own region outranks it).
 *
 * The resolved region is CANONICALIZED (issue #1795) before anything consumes
 * it. That covers all four sources — `--region`, both env vars, and the
 * synth-derived stack region — and all three consumers: the STS client built
 * for `${AWS::AccountId}`, the `${AWS::URLSuffix}` / `${AWS::Partition}`
 * derivation, and the `${AWS::Region}` value itself.
 *
 * `${AWS::AccountId}` follows where the stack was read (issue
 * go-to-k/cdkd#5001): under `--from-state` it is the DEPLOY account (the
 * `--role-arn` role's when one is published); under `--from-cfn-stack`, which
 * reads as the caller and sees only the caller's account, it is the caller's.
 *
 * @internal exported for unit tests.
 */
export async function resolvePseudoParametersForInvoke(
  stackRegion: string | undefined,
  options: LocalInvokeOptions
): Promise<
  { accountId?: string; region?: string; partition?: string; urlSuffix?: string } | undefined
> {
  const logger = getLogger();
  const region = canonicalizeRegion(
    options.region ??
      namedEnvAwsRegion() ??
      process.env['AWS_DEFAULT_REGION'] ??
      stackRegion ??
      emulatorDefaultRegion()
  );
  // Both state sources reach this resolver, so its warnings name the one in use.
  const sourceFlag = options.fromState ? '--from-state' : '--from-cfn-stack';
  if (!region) {
    logger.warn(
      `${sourceFlag}: resolver references \${AWS::Region} but cdkd could not determine the target region. ` +
        'Pass --region, set AWS_REGION, or declare env.region on the CDK stack.'
    );
  }
  let accountId: string | undefined;
  try {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    let sts: InstanceType<typeof STSClient>;
    if (!options.fromState) {
      // `ignoreAssumedRole` -- `${AWS::AccountId}` follows WHERE THE STACK WAS READ
      // (go-to-k/cdkd#5001): `--from-cfn-stack` reads it as the CALLER (#3240) and
      // CloudFormation sees only the caller's own account, so the account is the
      // caller's, never a `--role-arn` assumed for cdkd's own calls.
      const realAws = realAwsException('STS');
      sts = new STSClient({
        // Mixed mode: the account lookup follows the STS route — the emulator unless `Parameters` excepts STS (#6150).
        ...awsClientDefaults({
          profile: options.profile,
          ignoreAssumedRole: true,
          realAws,
        }),
        ...(region && { region }),
        ...(options.profile && { profile: options.profile }),
      });
    } else {
      // cdkd-local-role-identity: `--from-state` read the state record as the `--role-arn`
      // role when one is published (go-to-k/cdkd#3230), so `${AWS::AccountId}` is the DEPLOY
      // account, asked through `awsClientDefaults` as that role (go-to-k/cdkd#5001). Only the
      // account ID is taken; no credential reaches the emulated function.
      sts = new STSClient({
        // Mixed mode: the account lookup follows the STS route — the emulator unless `Parameters` excepts STS (#6150).
        ...awsClientDefaults({ profile: options.profile, realAws: realAwsException('STS') }),
        ...(region && { region }),
        // `--profile` is the identity both state sources read through when no
        // role is published, so the account must be asked as it too.
        ...(options.profile && { profile: options.profile }),
      });
    }
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      accountId = identity.Account;
    } finally {
      sts.destroy();
    }
  } catch (err) {
    // cdkd-raw-beside-safe: `sourceFlag` is one of two caller literals
    // ('--from-state' / '--from-cfn-stack'), so it cannot carry anything.
    logger.warn(
      `${sourceFlag}: resolver needs \${AWS::AccountId} but STS GetCallerIdentity failed: ${describeLocalAwsFailureForWarn(err, 'STS GetCallerIdentity')}. ` +
        'Substitution will be skipped; affected env entries will be dropped with per-key warnings.'
    );
  }
  const partitionAndSuffix = region ? derivePartitionAndUrlSuffix(region) : undefined;
  const bag: {
    accountId?: string;
    region?: string;
    partition?: string;
    urlSuffix?: string;
  } = {
    ...(accountId !== undefined && { accountId }),
    ...(region !== undefined && { region }),
    ...(partitionAndSuffix && {
      partition: partitionAndSuffix.partition,
      urlSuffix: partitionAndSuffix.urlSuffix,
    }),
  };
  return Object.keys(bag).length === 0 ? undefined : bag;
}

/**
 * Pull the function's `Properties.Environment.Variables` map (when
 * present). Type-narrowed at the boundary so the env-resolver can stay
 * pure and accept `Record<string, unknown>`.
 */
export function getTemplateEnv(resource: {
  Properties?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const props = resource.Properties ?? {};
  const env = props['Environment'];
  if (!env || typeof env !== 'object') return undefined;
  const vars = (env as Record<string, unknown>)['Variables'];
  if (!vars || typeof vars !== 'object') return undefined;
  return vars as Record<string, unknown>;
}

/**
 * Read the `--env-vars` JSON file. Returns `undefined` when the flag
 * was not passed; throws on parse failure with a clear pointer at the
 * file. SAM's accepted shape is loose; we only require it to be an
 * object at the top level.
 */
export function readEnvOverridesFile(filePath: string | undefined): EnvOverrideFile | undefined {
  if (!filePath) return undefined;
  let raw: string;
  try {
    // Through cdk-local's reader: a pipe-backed path (`<(jq ...)`,
    // `/dev/stdin`) is read once, so the mixed-mode "real-aws" scan and this
    // read see the same text (go-to-k/cdkd#6150).
    raw = readEnvVarsFileText(filePath);
  } catch (err) {
    throw new Error(
      `Failed to read --env-vars file '${filePath}': ${describeAwsFailure(err).detail}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // V8's `SyntaxError` quotes a window of the file, which holds env values
    // (often secrets), so the message names only the failure's offset and
    // size; V8's text goes to `debug` only (issue #5254).
    getLogger().debug(safeMsg`--env-vars file failed to parse: ${parseFailureDebugDetail(err)}`);
    throw new Error(
      `Failed to parse --env-vars file '${filePath}' as JSON: ${describeJsonParseFailure(err, utf8ByteLength(raw))}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--env-vars file '${filePath}' must contain a JSON object at the top level.`);
  }
  return parsed as EnvOverrideFile;
}
