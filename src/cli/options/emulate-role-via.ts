import { Option } from 'commander';

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
