import { Option } from 'commander';
import { assertFlagRoleArn } from '../../utils/role-arn.js';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';

/**
 * The entry check every command runs for `--emulate-role-via`: a malformed ARN
 * is refused before any AWS call (like `--ecr-role-arn`), and a value given
 * without the role flag (absent, or `--no-assume-role`) warns, since nothing
 * would ever read it.
 */
export function checkEmulateRoleVia(
  value: string | undefined,
  args: { roleFlag: string; roleRequested: boolean }
): void {
  if (value === undefined) return;
  assertFlagRoleArn('--emulate-role-via', value);
  if (!args.roleRequested) {
    // cdkd-raw-beside-safe: `args.roleFlag` is a caller LITERAL (a flag name).
    getLogger().warn(
      safeMsg`--emulate-role-via has no effect without ${args.roleFlag}: it is used only when that flag's AssumeRole is refused.`
    );
  }
}

/**
 * `--emulate-role-via <arn>` (go-to-k/cdkd#6201), shared by the cdkd-owned
 * `cdkd local` commands whose role flag (`roleFlag`) assumes the workload's
 * execution role. When that AssumeRole is refused, cdkd emulates the role's
 * permissions with session policies (`src/local/role-permission-emulation.ts`);
 * an IAM user needs no flag (GetFederationToken), any other caller names a role
 * it can assume here.
 */
export function emulateRoleViaOption(roleFlag: string): Option {
  return new Option(
    '--emulate-role-via <arn>',
    `When the ${roleFlag} AssumeRole is refused (the role does not trust you), cdkd emulates the ` +
      "role's permissions: it assumes THIS role with the execution role's policies as session " +
      'policies, so only what both allow is allowed. For callers that are not an IAM user ' +
      '(IAM Identity Center, a role session); an IAM user gets the same through ' +
      'sts:GetFederationToken without this flag. An approximation: resource-based policies, ' +
      'key policies and conditions naming the role, and its permissions boundary, are not reproduced.'
  );
}
