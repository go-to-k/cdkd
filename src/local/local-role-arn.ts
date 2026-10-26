/**
 * `--role-arn` for the four `cdkd local` commands cdkd implements itself
 * (`invoke` / `start-api` / `run-task` / `invoke-agentcore`).
 *
 * cdkd's own {@link applyRoleArnIfSet} performs the assume on these commands,
 * so cdk-local never sees it. cdk-local's workload sites (a literal layer ARN
 * fetch via `--layer-role-arn`, the `--from-cfn-stack` provider) resolve as
 * the caller only once the assume is RECORDED with cdk-local, which is what
 * this adds: the caller's pre-assume snapshot, taken by `applyRoleArnIfSet`
 * before it overwrote `AWS_*`, is published through cdk-local's
 * `recordAssumedRole` (go-to-k/cdkd#3240, go-to-k/cdk-local#783). The assumed
 * role's own credentials go as the second argument, so cdk-local's
 * `${AWS::AccountId}` / account lookups resolve as the role, i.e. the DEPLOY
 * account (go-to-k/cdkd#5001, cdk-local 0.153.0+).
 *
 * The six engine commands (`start-service` / `start-alb` / `start-cloudfront`
 * / `start-agentcore` / `start-web-function` / `start-microvm`) do not come here: cdk-local's own `applyRoleArnIfSet`
 * runs inside them and records the assume itself. Kept out of
 * `src/utils/role-arn.ts` because of dependency direction: `src/utils` must not
 * depend on `cdk-local/internal`. (cdkd's own `--assume-role` hop already opts
 * out of the role itself.)
 */

import { recordAssumedRole } from 'cdk-local/internal';
import {
  getAssumedRoleCredentials,
  getPreAssumeEnvCredentials,
} from '../utils/aws-client-defaults.js';
import { applyRoleArnIfSet } from '../utils/role-arn.js';

export async function applyRoleArnForLocal(
  opts: Parameters<typeof applyRoleArnIfSet>[0]
): Promise<void> {
  await applyRoleArnIfSet(opts);
  const role = getAssumedRoleCredentials();
  if (role === undefined) return;
  recordAssumedRole(getPreAssumeEnvCredentials(), {
    accessKeyId: role.accessKeyId,
    secretAccessKey: role.secretAccessKey,
    sessionToken: role.sessionToken,
  });
}
