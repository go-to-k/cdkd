import { awsClientDefaults } from '../utils/aws-client-defaults.js';
import { displayIdent, ROLE_ARN_MAX_CODE_POINTS, safeMsg } from '../utils/display-safe.js';
import { describeLocalAwsFailureForWarn } from '../utils/local-aws-failure.js';
import { getLogger } from '../utils/logger.js';
import { parseIamRoleArn, sendableAssumeRoleCommand } from '../utils/role-arn.js';

/**
 * Emulating an execution role's permissions when the real `AssumeRole` of it
 * is refused (go-to-k/cdkd#6201).
 *
 * A role CDK creates trusts only its service principal, so `--assume-role`
 * (and each command's equivalent) is refused with AccessDenied unless the user
 * edits the trust policy. Instead of falling back to the caller's own (usually
 * broader) credentials, cdkd reads the role's inline and attached managed
 * policies and obtains credentials for the CALLER with those policies as
 * SESSION POLICIES. The effective permissions are then the intersection of the
 * caller's and the role's, so a permission the role lacks fails locally.
 *
 * Credential source:
 *   - `--emulate-role-via <arn>` given: `sts:AssumeRole` of that role (one the
 *     caller CAN assume), with the session policies.
 *   - otherwise, an IAM user caller: `sts:GetFederationToken` with the session
 *     policies.
 *   - otherwise (IAM Identity Center, a role session, root): no emulation.
 *
 * Every "cannot emulate" outcome warns and returns `undefined`; the call site
 * then does what a refused `--assume-role` did before this existed.
 */

/** The STS-issued credentials an emulation returns. */
export interface EmulatedRoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** STS caps the plaintext of the inline and managed session policies together. */
export const SESSION_POLICY_MAX_CHARS = 2048;
/** STS accepts at most this many managed session policy ARNs. */
export const SESSION_POLICY_MAX_ARNS = 10;

/**
 * Applied when the role has no policies at all. Without a session policy,
 * `AssumeRole` would grant the via-role's FULL permissions, while the role
 * being emulated grants nothing.
 */
const DENY_ALL_POLICY =
  '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}';

/** The role's policies, as IAM returned them. */
export interface RolePolicies {
  /** Each inline policy's document, parsed. */
  inline: unknown[];
  /** The attached managed policies' ARNs. */
  managedArns: string[];
  /**
   * The role's permissions boundary ARN, if any. STS combines the inline and
   * managed session policies as a UNION, so a boundary cannot be added as one
   * more session policy: emulating such a role would allow what its boundary
   * denies, and is refused instead (go-to-k/cdkd#6220).
   */
  permissionsBoundaryArn?: string | undefined;
}

export type SessionPolicyPlan =
  | { ok: true; policy: string; policyArns: string[] }
  | { ok: false; reason: string };

/**
 * Turn the role's policies into STS session-policy parameters: the inline
 * policies combined into ONE minified document (STS takes a single `Policy`),
 * the managed policies passed by ARN. `Sid`s are dropped: they do not affect
 * evaluation, two inline policies may reuse one, and they cost characters
 * against the limit.
 *
 * Refused (with the reason the warning prints) when the inline documents do
 * not share one `Version` (combining them would change how policy variables
 * evaluate), when there are more than {@link SESSION_POLICY_MAX_ARNS} managed
 * policies, or when the plaintext exceeds {@link SESSION_POLICY_MAX_CHARS}.
 */
export function buildSessionPolicy(policies: RolePolicies): SessionPolicyPlan {
  const { inline, managedArns } = policies;
  if (managedArns.length > SESSION_POLICY_MAX_ARNS) {
    return {
      ok: false,
      reason: `the role has ${managedArns.length} managed policies, more than the ${SESSION_POLICY_MAX_ARNS} STS accepts as session policies`,
    };
  }
  let policy: string;
  if (inline.length === 0) {
    policy = managedArns.length === 0 ? DENY_ALL_POLICY : '';
  } else {
    const versions = new Set<string>();
    const statements: unknown[] = [];
    for (const doc of inline) {
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        return { ok: false, reason: 'an inline policy of the role is not a JSON object' };
      }
      const record = doc as Record<string, unknown>;
      versions.add(typeof record['Version'] === 'string' ? record['Version'] : '');
      const raw = record['Statement'];
      for (const statement of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
        if (statement !== null && typeof statement === 'object' && !Array.isArray(statement)) {
          const { Sid: _sid, ...rest } = statement as Record<string, unknown>;
          statements.push(rest);
        } else {
          statements.push(statement);
        }
      }
    }
    if (versions.size > 1) {
      return {
        ok: false,
        reason:
          'the inline policies of the role use different policy Version values and cannot be combined into one session policy',
      };
    }
    const [version] = [...versions];
    policy =
      statements.length === 0
        ? // Inline policies with no statement grant nothing; an empty
          // `Statement` would be refused or, with no managed ARN, mean "no
          // session policy" — the via role's full permissions.
          managedArns.length === 0
          ? DENY_ALL_POLICY
          : ''
        : JSON.stringify({
            ...(version !== undefined && version !== '' && { Version: version }),
            Statement: statements,
          });
  }
  const chars = policy.length + managedArns.reduce((sum, arn) => sum + arn.length, 0);
  if (chars > SESSION_POLICY_MAX_CHARS) {
    return {
      ok: false,
      reason: `the role's policies take ${chars} characters as session policies, more than the ${SESSION_POLICY_MAX_CHARS} STS accepts`,
    };
  }
  return { ok: true, policy, policyArns: managedArns };
}

/** An IAM user's ARN (`arn:<partition>:iam::<account>:user/<path/name>`). */
export function isIamUserArn(arn: string | undefined): boolean {
  return arn !== undefined && /^arn:[^:]+:iam::\d{12}:user\//.test(arn);
}

/**
 * The refusal `AssumeRole` answers when the trust policy does not allow the
 * caller. By NAME only: a bare 403 is also `InvalidClientTokenId`,
 * `SignatureDoesNotMatch` or `ExpiredToken` — broken caller credentials, which
 * emulation cannot help and must not hide.
 */
export function isAssumeRoleAccessDenied(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AccessDenied';
}

/** The last path segment of a role ARN: `IAM GetRole` / `GetRolePolicy`'s `RoleName`. */
function roleNameOf(roleArn: string): string {
  const resource = roleArn.split(':').slice(5).join(':');
  return resource.slice(resource.lastIndexOf('/') + 1);
}

/**
 * The approximation notice prints once per role per process: `local
 * invoke-agentcore` assumes one role up to three times in a run, and `local
 * start-api` once per Lambda that shares it.
 */
const noticedRoles = new Set<string>();
/** The "cannot emulate" warning, likewise once per role per process. */
const failedRoles = new Set<string>();

export interface EmulateRoleArgs {
  /** The execution role whose `AssumeRole` was refused. */
  roleArn: string;
  /** The STS / IAM client region. */
  region: string | undefined;
  /** `awsClientDefaults`'s `realAws` (mixed mode / `--aws-emulator` routing). */
  realAws: boolean;
  /** `--emulate-role-via <arn>`: a role the caller can assume. */
  emulateRoleVia?: string;
  /** The flag the warnings name, e.g. `--assume-role`. */
  flag: string;
  /** `RoleSessionName` prefix for the `--emulate-role-via` assume. */
  sessionNamePrefix: string;
}

/**
 * When `err` is the AccessDenied a refused `AssumeRole(args.roleArn)` threw,
 * emulate the role's permissions (see the module doc). Returns the
 * credentials, or `undefined` when `err` is anything else or emulation is not
 * possible (after a warning naming why).
 *
 * Nothing secret is printed: the credentials never reach a message, and AWS
 * failures are rendered through `describeLocalAwsFailureForWarn`.
 */
export async function emulateRoleAfterDeniedAssume(
  err: unknown,
  args: EmulateRoleArgs
): Promise<EmulatedRoleCredentials | undefined> {
  if (!isAssumeRoleAccessDenied(err)) return undefined;
  // Never throws: the call site rethrows (or warns about) the ORIGINAL refusal
  // when this returns `undefined`, so an unexpected failure here must not
  // replace it.
  try {
    return await emulate(args);
  } catch (unexpected) {
    if (failedRoles.has(args.roleArn)) return undefined;
    failedRoles.add(args.roleArn);
    // cdkd-raw-beside-safe: `args.flag` is a caller LITERAL (the flag's own name).
    getLogger().warn(
      safeMsg`${args.flag}: emulating the role's permissions failed: ${describeLocalAwsFailureForWarn(unexpected, 'role permission emulation')}.`
    );
    return undefined;
  }
}

async function emulate(args: EmulateRoleArgs): Promise<EmulatedRoleCredentials | undefined> {
  const logger = getLogger();
  const shownRole = displayIdent(args.roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS });
  const cannot = (reason: string): undefined => {
    if (failedRoles.has(args.roleArn)) return undefined;
    failedRoles.add(args.roleArn);
    // cdkd-raw-beside-safe: `args.flag` is a caller LITERAL (the flag's own
    // name), and `reason` is cdkd's own text with any AWS failure already
    // rendered by `describeLocalAwsFailureForWarn`; `safeMsg` flattens both.
    logger.warn(
      safeMsg`${args.flag}: AssumeRole(${shownRole}) was refused, and cdkd cannot emulate the role's permissions instead: ${reason}.`
    );
    return undefined;
  };

  const { STSClient, GetCallerIdentityCommand, GetFederationTokenCommand } =
    await import('@aws-sdk/client-sts');
  // The CALLER's (`ignoreAssumedRole`): the emulated credentials reach the
  // workload, never a `--role-arn` deploy role's. Routed like the refused hop
  // it replaces: the caller decides `realAws` (mixed mode / `--aws-emulator`).
  const sts = new STSClient({
    ...awsClientDefaults({ ignoreAssumedRole: true, realAws: args.realAws }),
    ...(args.region && { region: args.region }),
  });
  try {
    let callerArn: string | undefined;
    try {
      callerArn = (await sts.send(new GetCallerIdentityCommand({}))).Arn;
    } catch (idErr) {
      return cannot(describeLocalAwsFailureForWarn(idErr, 'STS GetCallerIdentity'));
    }
    // IAM is read by role NAME in the caller's account, so a role in another
    // account would read a same-named role of the caller's instead.
    const roleAccount = parseIamRoleArn(args.roleArn)?.accountId;
    if (roleAccount === undefined || roleAccount !== callerArn?.split(':')[4]) {
      return cannot("the role is not in your credentials' account, so its policies cannot be read");
    }
    if (args.emulateRoleVia === undefined && !isIamUserArn(callerArn)) {
      return cannot(
        'your credentials are not an IAM user, and only an IAM user can call sts:GetFederationToken. ' +
          "Pass --emulate-role-via <arn> naming a role you can assume, and cdkd assumes it with the role's policies as session policies"
      );
    }

    let policies: RolePolicies;
    try {
      policies = await readRolePolicies(args);
    } catch (readErr) {
      return cannot(
        `reading the role's policies failed (it needs iam:GetRole, iam:ListRolePolicies, iam:GetRolePolicy and iam:ListAttachedRolePolicies): ${describeLocalAwsFailureForWarn(readErr, 'IAM role policy read')}`
      );
    }
    if (policies.permissionsBoundaryArn !== undefined) {
      return cannot(
        `the role has a permissions boundary (${displayIdent(policies.permissionsBoundaryArn)}), which session policies cannot reproduce, so the emulation could allow what the role cannot`
      );
    }
    const plan = buildSessionPolicy(policies);
    if (!plan.ok) return cannot(plan.reason);

    const sessionPolicies = {
      ...(plan.policy !== '' && { Policy: plan.policy }),
      ...(plan.policyArns.length > 0 && { PolicyArns: plan.policyArns.map((arn) => ({ arn })) }),
    };
    let via: string;
    let response;
    try {
      if (args.emulateRoleVia !== undefined) {
        via = `AssumeRole of --emulate-role-via ${displayIdent(args.emulateRoleVia, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}`;
        response = await sts.send(
          sendableAssumeRoleCommand({
            RoleArn: args.emulateRoleVia,
            RoleSessionName: `${args.sessionNamePrefix}-emulate-${Date.now()}`,
            DurationSeconds: 3600,
            ...sessionPolicies,
          })
        );
      } else {
        via = 'sts:GetFederationToken';
        response = await sts.send(
          new GetFederationTokenCommand({
            Name: `cdkd-${Date.now()}`,
            DurationSeconds: 3600,
            ...sessionPolicies,
          })
        );
      }
    } catch (stsErr) {
      const stsName = (stsErr as { name?: unknown } | null)?.name;
      // The SDK names the modeled error `PackedPolicyTooLargeException`; the
      // wire code `PackedPolicyTooLarge` is accepted too.
      if (stsName === 'PackedPolicyTooLargeException' || stsName === 'PackedPolicyTooLarge') {
        return cannot(
          "the role's policies are larger than STS accepts as session policies (PackedPolicyTooLarge)"
        );
      }
      const rendered = describeLocalAwsFailureForWarn(stsErr, 'STS session-policy credentials');
      // Temporary IAM-user credentials (GetSessionToken / MFA) still have a
      // `user/` ARN, but STS refuses GetFederationToken for them.
      return cannot(
        args.emulateRoleVia === undefined
          ? `${rendered}. Temporary IAM user credentials (GetSessionToken / MFA) cannot call sts:GetFederationToken; pass --emulate-role-via <arn> naming a role you can assume instead`
          : rendered
      );
    }
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      return cannot('STS returned no usable credentials');
    }
    if (!noticedRoles.has(args.roleArn)) {
      noticedRoles.add(args.roleArn);
      const count = policies.inline.length + policies.managedArns.length;
      const who = args.emulateRoleVia !== undefined ? 'that role' : 'you';
      const federationNote =
        args.emulateRoleVia === undefined
          ? ' A GetFederationToken session cannot call IAM, nor STS except GetCallerIdentity.'
          : '';
      // cdkd-raw-beside-safe: `args.flag` is a caller LITERAL, `via` embeds
      // the only user value through `displayIdent`, and the rest are counts
      // and cdkd's literals.
      logger.warn(
        safeMsg`${args.flag}: AssumeRole(${shownRole}) was refused (the role's trust policy does not allow you), so cdkd EMULATES its permissions: credentials from ${via} with the role's ${policies.inline.length} inline and ${policies.managedArns.length} managed ${count === 1 ? 'policy' : 'policies'} as session policies, which allow only what both ${who} and the role allow. This is an APPROXIMATION: resource-based policies, KMS key policies and aws:PrincipalArn conditions that name the role see a different principal, and the role's session tags are not reproduced. Policy variables such as aws:username and aws:userid take this session's values, not the role's (a role session has no aws:username).${federationNote}`
      );
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } finally {
    sts.destroy();
  }
}

/**
 * The role's permissions boundary (`iam:GetRole`), inline policy documents and
 * attached managed policy ARNs (`iam:ListRolePolicies` / `iam:GetRolePolicy` /
 * `iam:ListAttachedRolePolicies`, every page).
 */
export async function readRolePolicies(args: {
  roleArn: string;
  region: string | undefined;
  realAws: boolean;
}): Promise<RolePolicies> {
  const {
    IAMClient,
    GetRoleCommand,
    ListRolePoliciesCommand,
    GetRolePolicyCommand,
    ListAttachedRolePoliciesCommand,
  } = await import('@aws-sdk/client-iam');
  // The CALLER reads the role (`ignoreAssumedRole`), routed with the STS hop.
  const iam = new IAMClient({
    ...awsClientDefaults({ ignoreAssumedRole: true, realAws: args.realAws }),
    ...(args.region && { region: args.region }),
  });
  const RoleName = roleNameOf(args.roleArn);
  try {
    const role = await iam.send(new GetRoleCommand({ RoleName }));
    const permissionsBoundaryArn = role.Role?.PermissionsBoundary?.PermissionsBoundaryArn;
    const names: string[] = [];
    let marker: string | undefined;
    do {
      const page = await iam.send(
        new ListRolePoliciesCommand({ RoleName, ...(marker && { Marker: marker }) })
      );
      names.push(...(page.PolicyNames ?? []));
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    const inline: unknown[] = [];
    for (const PolicyName of names) {
      const got = await iam.send(new GetRolePolicyCommand({ RoleName, PolicyName }));
      // IAM returns the document URL-encoded.
      let doc: unknown;
      try {
        doc = JSON.parse(decodeURIComponent(got.PolicyDocument ?? '{}'));
      } catch {
        // Fixed text: a SyntaxError's message quotes part of the document,
        // which would reach the --verbose debug line.
        throw new Error('an inline policy document of the role is not valid JSON');
      }
      inline.push(doc);
    }
    const managedArns: string[] = [];
    let attachedMarker: string | undefined;
    do {
      const page = await iam.send(
        new ListAttachedRolePoliciesCommand({
          RoleName,
          ...(attachedMarker && { Marker: attachedMarker }),
        })
      );
      for (const attached of page.AttachedPolicies ?? []) {
        if (attached.PolicyArn) managedArns.push(attached.PolicyArn);
      }
      attachedMarker = page.IsTruncated ? page.Marker : undefined;
    } while (attachedMarker);
    return {
      inline,
      managedArns,
      ...(permissionsBoundaryArn !== undefined && { permissionsBoundaryArn }),
    };
  } finally {
    iam.destroy();
  }
}
