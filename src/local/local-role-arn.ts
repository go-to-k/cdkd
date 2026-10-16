/**
 * `--role-arn` for the four `cdkd local` commands cdkd implements itself
 * (`invoke` / `start-api` / `run-task` / `invoke-agentcore`).
 *
 * cdkd's own {@link applyRoleArnIfSet} performs the assume on these commands,
 * so cdk-local never sees it. cdk-local's workload sites (a literal layer ARN
 * fetch, the `--from-cfn-stack` provider, the `--assume-role` hop) resolve as
 * the caller only once the assume is RECORDED with cdk-local, which is what
 * this adds: the caller's pre-assume snapshot, taken by `applyRoleArnIfSet`
 * before it overwrote `AWS_*`, is published through cdk-local's
 * `recordAssumedRole` (go-to-k/cdkd#3240, go-to-k/cdk-local#783).
 *
 * The four engine commands (`start-service` / `start-alb` / `start-cloudfront`
 * / `start-agentcore`) do not come here: cdk-local's own `applyRoleArnIfSet`
 * runs inside them and records the assume itself. Kept out of
 * `src/utils/role-arn.ts` so a deploy never loads `cdk-local/internal`.
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
  if (getAssumedRoleCredentials() === undefined) return;
  recordAssumedRole(getPreAssumeEnvCredentials());
}
