import {
  describeLocalAwsFailureForWarn,
  redactedAwsCause,
} from '../../../utils/local-aws-failure.js';
import { realAwsException } from '../../../local/local-aws-wiring.js';
import {
  displayIdent,
  plainIdentOr,
  ROLE_ARN_MAX_CODE_POINTS,
} from '../../../utils/display-safe.js';
import { VALUE_NOT_SHOWN } from '../../../provisioning/import-helpers.js';
import { assertSendableRoleArn, sendableAssumeRoleCommand } from '../../../utils/role-arn.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { TASK_ROLE_ACCOUNT_PLACEHOLDER } from '../../../local/ecs-task-resolver.js';
import { awsClientDefaults } from '../../../utils/aws-client-defaults.js';

/**
 * Where `${AWS::AccountId}` is asked: it follows WHERE THE STACK WAS READ
 * (issue go-to-k/cdkd#5001). `--from-cfn-stack` reads it as the CALLER, and
 * CloudFormation sees only the caller's own account, so that is the caller's.
 * `--from-state` and no state source give the DEPLOY account: the `--role-arn`
 * role's when one is published, the `--profile` identity's otherwise.
 */
interface StackAccountSource {
  region?: string | undefined;
  profile?: string | undefined;
  fromState?: boolean | undefined;
  fromCfnStack?: string | boolean | undefined;
}

/** True when the stack was read through `--from-cfn-stack` (and not `--from-state`). */
function readFromCfnStack(source: StackAccountSource): boolean {
  return (
    source.fromState !== true && source.fromCfnStack !== undefined && source.fromCfnStack !== false
  );
}

/**
 * If `arn` contains the `${AWS::AccountId}` placeholder emitted by the
 * resolver for inline same-stack IAM Roles, substitute the account the stack
 * lives in via STS `GetCallerIdentity`. Otherwise pass through unchanged.
 * Lazy: callers should only invoke this when the resolved ARN is actually
 * going to be used (i.e. on the bare `--assume-task-role` path).
 *
 * The account follows where the stack was read (issue go-to-k/cdkd#5001): under
 * `--from-cfn-stack` the caller's own; under `--from-state` or with no state
 * source the DEPLOY account (the `--role-arn` role's when one is published,
 * where the task role lives). The resulting ARN is then assumed AS THE CALLER
 * (`assumeTaskRole` opts out), so only the account ID is taken here.
 *
 * @internal exported for unit tests.
 */
export async function resolvePlaceholderAccount(
  arn: string,
  source: StackAccountSource,
  /**
   * Which STS answers (go-to-k/cdkd#6147): the one the role is then assumed
   * in, since the emulator's account and the real one differ. Required, so a
   * call site cannot fall back to another route by omission.
   */
  route: { realAws: boolean }
): Promise<string> {
  const { region, profile } = source;
  if (!arn.includes(TASK_ROLE_ACCOUNT_PLACEHOLDER)) return arn;
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  let sts: InstanceType<typeof STSClient>;
  if (readFromCfnStack(source)) {
    // `ignoreAssumedRole` -- under `--from-cfn-stack` the stack is read as the CALLER and
    // CloudFormation sees only the caller's own account, so the account filled into a task-role ARN is the
    // caller's, never a `--role-arn` assumed for cdkd's own calls (go-to-k/cdkd#5001).
    sts = new STSClient({
      // Mixed mode: the account lookup follows the STS route the role is assumed through (#6150, #6147).
      ...awsClientDefaults({ profile, ignoreAssumedRole: true, realAws: route.realAws }),
      ...(region && { region }),
      ...(profile && { profile }),
    });
  } else {
    // cdkd-local-role-identity: `--from-state` read the state record as the `--role-arn` role
    // when one is published (go-to-k/cdkd#3230), and with no state source the stack is the
    // one deployed there, so the account filled into the task-role ARN is the DEPLOY account: asked through
    // `awsClientDefaults` as that role (go-to-k/cdkd#5001). Only the account ID is taken; the ARN it completes is assumed as the caller.
    sts = new STSClient({
      // Mixed mode: the account lookup follows the STS route the role is assumed through (#6150, #6147).
      ...awsClientDefaults({ profile, realAws: route.realAws }),
      ...(region && { region }),
      // `--profile` is the identity both state sources read through when no role
      // is published, so the account must be asked as it too.
      ...(profile && { profile }),
    });
  }
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const account = identity.Account;
    if (!account) {
      throw new CdkdError(
        // cdkd-arn-display: the template ARN is shown only when plain (`plainIdentOr` at the role-ARN cap) and described otherwise, since this line names `--assume-task-role` (go-to-k/cdkd#4295).
        `--assume-task-role: GetCallerIdentity returned no Account; cannot resolve placeholder ARN ${plainIdentOr(arn, VALUE_NOT_SHOWN, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}. ` +
          `Pass the ARN explicitly: --assume-task-role '<arn>'`,
        'LOCAL_RUN_TASK_PLACEHOLDER_NO_ACCOUNT'
      );
    }
    return arn.split(TASK_ROLE_ACCOUNT_PLACEHOLDER).join(account);
  } catch (err) {
    if (err instanceof CdkdError) throw err;
    // The raw SDK error would reach `formatError` unsanitized, and a
    // credential-chain failure carries a `credential_process` command line
    // (go-to-k/cdkd#4857).
    const rendered = describeLocalAwsFailureForWarn(err, 'STS GetCallerIdentity');
    throw new CdkdError(
      `--assume-task-role: STS GetCallerIdentity failed while resolving the task role's account: ${rendered}.`,
      'LOCAL_RUN_TASK_GET_CALLER_IDENTITY_FAILED',
      redactedAwsCause(err, 'STS GetCallerIdentity failed')
    );
  } finally {
    sts.destroy();
  }
}

/**
 * The warning the bare `--assume-task-role` prints when the task role's ARN is
 * the placeholder built from its LOGICAL id (go-to-k/cdkd#6189): that names
 * the deployed role only when its name is the logical id, and a role CDK
 * names itself is deployed as `<Stack>-<LogicalId>-<suffix>`.
 * `stateSourceGiven` picks the remedy: without a state source, pass one; with
 * one, its record lacks the role.
 *
 * @internal exported for unit tests.
 */
export function taskRoleNameIsLogicalIdWarning(
  logicalId: string,
  stateSourceGiven: boolean
): string {
  const id = displayIdent(logicalId);
  if (!stateSourceGiven) {
    return (
      `--assume-task-role: TaskRoleArn references the same-stack role ${id}, and without --from-state (cdkd-deployed) ` +
      `or --from-cfn-stack (cdk-deployed) cdkd cannot read the name it was deployed under, so it assumes a role named ${id}. ` +
      `A role CDK names for you is deployed as '<Stack>-<LogicalId>-<suffix>', where AssumeRole fails: ` +
      `pass --from-state / --from-cfn-stack, or the ARN explicitly: --assume-task-role '<arn>'.`
    );
  }
  return (
    `--assume-task-role: the state source has no record of the task role ${id}, so cdkd assumes a role named ${id}. ` +
    `Deploy the stack first, or pass the ARN explicitly: --assume-task-role '<arn>'.`
  );
}

/**
 * Assume `roleArn` and return temp credentials. Mirrors the same flow
 * `cdkd local invoke --assume-role` uses.
 *
 * `route.realAws` picks the STS (go-to-k/cdkd#6147): `false` sends the call to
 * AWS Emulator whenever `--aws-emulator` is active (the role deployed there,
 * signed with the emulator's keys), `true` to real AWS. Without
 * `--aws-emulator` there is no override and both mean real AWS.
 *
 * @internal exported for unit tests (go-to-k/cdkd#4857).
 */
export async function assumeTaskRole(
  roleArn: string,
  region: string | undefined,
  route: { realAws: boolean }
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  // Both `--assume-task-role <arn>` and the task definition's `TaskRoleArn`
  // (a template literal, passed through verbatim) arrive here unchecked, so the
  // shape bound is enforced at the send (issue #2348).
  assertSendableRoleArn(roleArn);
  const { STSClient } = await import('@aws-sdk/client-sts');
  // `ignoreAssumedRole` -- this resolves the task role's credentials, served to the container by the metadata sidecar,
  // so it must be the caller's own identity, never a `--role-arn` assumed
  // for cdkd's own calls. See that option's JSDoc.
  const sts = new STSClient({
    // `--aws-emulator`: the emulator's STS unless the caller asks for the real one (#6147).
    ...awsClientDefaults({ ignoreAssumedRole: true, realAws: route.realAws }),
    ...(region && { region }),
  });
  try {
    const response = await sts.send(
      sendableAssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkd-local-run-task-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new CdkdError(
        `AssumeRole(${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) returned no usable credentials.`,
        'LOCAL_RUN_TASK_ASSUMEROLE_NO_CREDS'
      );
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } catch (err) {
    if (err instanceof CdkdError) throw err;
    // See `resolvePlaceholderAccount` (go-to-k/cdkd#4857).
    const rendered = describeLocalAwsFailureForWarn(err, 'STS AssumeRole');
    throw new CdkdError(
      `--assume-task-role: STS AssumeRole(${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) failed: ${rendered}.`,
      'LOCAL_RUN_TASK_ASSUMEROLE_FAILED',
      redactedAwsCause(err, 'STS AssumeRole failed')
    );
  } finally {
    sts.destroy();
  }
}

/**
 * STS `GetCallerIdentity` for the `${AWS::AccountId}` pseudo parameter. It
 * follows where the stack was read (issue go-to-k/cdkd#5001): the caller's own
 * under `--from-cfn-stack`, the DEPLOY account (the `--role-arn` role's) under
 * `--from-state` or with no state source.
 */
export async function resolveStackAccountId(
  source: StackAccountSource
): Promise<string | undefined> {
  const { region, profile } = source;
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  let sts: InstanceType<typeof STSClient>;
  if (readFromCfnStack(source)) {
    // `ignoreAssumedRole` -- under `--from-cfn-stack` the stack is read as the CALLER and
    // CloudFormation sees only the caller's own account, so `${AWS::AccountId}` is the
    // caller's, never a `--role-arn` assumed for cdkd's own calls (go-to-k/cdkd#5001).
    sts = new STSClient({
      // Mixed mode: the account lookup follows the STS route — the emulator unless `Parameters` excepts STS (#6150).
      ...awsClientDefaults({ profile, ignoreAssumedRole: true, realAws: realAwsException('STS') }),
      ...(region && { region }),
      ...(profile && { profile }),
    });
  } else {
    // cdkd-local-role-identity: `--from-state` read the state record as the `--role-arn` role
    // when one is published (go-to-k/cdkd#3230), and with no state source the stack is the
    // one deployed there, so `${AWS::AccountId}` is the DEPLOY account: asked through
    // `awsClientDefaults` as that role (go-to-k/cdkd#5001). Only the account ID is taken; no credential reaches the emulated task.
    sts = new STSClient({
      // Mixed mode: the account lookup follows the STS route — the emulator unless `Parameters` excepts STS (#6150).
      ...awsClientDefaults({ profile, realAws: realAwsException('STS') }),
      ...(region && { region }),
      // `--profile` is the identity both state sources read through when no role
      // is published, so the account must be asked as it too.
      ...(profile && { profile }),
    });
  }
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return identity.Account;
  } finally {
    sts.destroy();
  }
}
