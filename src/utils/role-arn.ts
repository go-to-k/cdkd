import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getLogger } from './logger.js';

/**
 * Resolve the role-arn argument (CLI flag or `CDKD_ROLE_ARN` env var) and,
 * when set, assume the role and write the resulting temporary credentials
 * into `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`
 * for the rest of the process.
 *
 * **Why env vars, not threaded credentials.** cdkd constructs ~13
 * independent `AwsClients` instances across deploy / destroy / state /
 * import / etc. paths (each with its own region, sometimes — e.g. the
 * state-bucket client lives in a different region from the provisioning
 * clients). Threading a `credentials` object through every site is high
 * churn for an opt-in flag. AWS SDK v3 reads the standard `AWS_*` env
 * vars at the top of its default credentials chain, so writing into them
 * once at the command's entry makes every later `new XxxClient()` pick
 * up the assumed-role credentials automatically without touching the
 * client construction sites.
 *
 * **Why cdkd needs admin-equivalent on the assumed role.** Unlike `cdk
 * deploy`, cdkd does NOT route through CloudFormation. There is no
 * cfn-exec-role to delegate to. Every IAM / EC2 / Lambda / etc. API
 * call is issued from the cdkd process directly. The role you pass to
 * `--role-arn` (or set in `CDKD_ROLE_ARN`) MUST therefore have
 * admin-equivalent permissions on the resources being deployed; CDK
 * CLI's `cdk-hnb659fds-deploy-role-*` is NOT sufficient — that role
 * only carries CFn + asset-publish permissions.
 *
 * Default session duration is 1 hour. For longer-running deploys, the
 * caller should re-issue the cdkd command (the in-flight credentials
 * stay valid until expiry, but a re-run is the simplest recovery for
 * the rare case where a deploy outlives them).
 */
export async function applyRoleArnIfSet(opts: {
  roleArn: string | undefined;
  region: string | undefined;
}): Promise<void> {
  const roleArn = opts.roleArn || process.env['CDKD_ROLE_ARN'];
  if (!roleArn) return;

  const logger = getLogger().child('role-arn');
  logger.debug(`Assuming role ${roleArn}...`);

  const sts = new STSClient({ ...(opts.region && { region: opts.region }) });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkd-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    if (!response.Credentials) {
      throw new Error(`AssumeRole returned no credentials for role ${roleArn}`);
    }
    const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = response.Credentials;
    if (!AccessKeyId || !SecretAccessKey || !SessionToken) {
      throw new Error(`AssumeRole response missing credentials fields for role ${roleArn}`);
    }
    process.env['AWS_ACCESS_KEY_ID'] = AccessKeyId;
    process.env['AWS_SECRET_ACCESS_KEY'] = SecretAccessKey;
    process.env['AWS_SESSION_TOKEN'] = SessionToken;
    logger.info(
      `Assumed role ${roleArn} (session expires ${Expiration?.toISOString() ?? 'unknown'})`
    );
  } finally {
    sts.destroy();
  }
}
