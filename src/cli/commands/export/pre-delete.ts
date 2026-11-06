import { commandHole } from '../../../utils/pasteable-command.js';
import {
  IAM_PRINCIPAL_NAME,
  readRecordedPrincipals,
} from '../../../provisioning/iam-policy-targets.js';
import { type StackState } from '../../../types/state.js';
import { awsClientDefaults } from '../../../utils/aws-client-defaults.js';
import { withPasteableAwsProfile } from '../../../utils/pasteable-aws-profile.js';
import { type RecreateBeforePhase2Entry } from './plan-types.js';
import { plainOrNotShown, recordValueOrNotShown, rowIdent, showRecordValue } from './render.js';
import { isSsmParameterType } from './parameters.js';

/**
 * Per-type AWS SDK delete handler invoked between phase-1 IMPORT and
 * phase-2 UPDATE so CFn's phase-2 CREATE doesn't collide with the
 * already-existing AWS-side resource. Each handler reads the parent
 * identifier (`ApiId` etc.) from `properties` and the secondary id
 * from `physicalId`, then issues the appropriate Delete API call.
 *
 * Errors propagate to the caller — a failed pre-delete is fatal
 * because phase 2 would then collide with the still-present AWS
 * resource. cdkd state and the post-phase-1 CFn stack are preserved
 * so the user can fix the underlying cause (typically permissions)
 * and re-run.
 */
type PreDeleteHandler = (entry: RecreateBeforePhase2Entry) => Promise<void>;

export const PRE_DELETE_HANDLERS: Record<string, PreDeleteHandler> = {
  'AWS::IAM::Policy': async (entry) => {
    // Mirrors IAMPolicyProvider.delete (src/provisioning/providers/
    // iam-policy-provider.ts): inline policy attachments are stored per-
    // target via PutRolePolicy/PutUserPolicy/PutGroupPolicy, so deletion
    // is per-target too. State carries Roles/Users/Groups arrays
    // capturing the attachment set at deploy time.
    const {
      IAMClient,
      DeleteRolePolicyCommand,
      DeleteUserPolicyCommand,
      DeleteGroupPolicyCommand,
      NoSuchEntityException,
    } = await import('@aws-sdk/client-iam');

    // The SAME verdict the plan printed before the confirmation
    // (go-to-k/cdkd#3857): one predicate, so the plan cannot name principals
    // this handler would not act on.
    const targets = policyDetachTargets(entry);
    if ('refusal' in targets) {
      throw new Error(
        `cdkd state for ${plainOrNotShown(entry.logicalId)} (${plainOrNotShown(entry.resourceType)}) ` +
          `cannot be pre-deleted: ${targets.refusal}`
      );
    }
    const { policyName, roles, users, groups } = targets;

    const client = new IAMClient({ ...awsClientDefaults() });

    // Each per-target send is idempotent on NoSuchEntityException
    // (matches IAMPolicyProvider.delete; covers partial-retry safety
    // after a previous pre-delete attempt succeeded for some targets).
    // Other errors propagate so phase 2 doesn't proceed against a
    // policy still attached to AWS.
    const deleteSafely = async (op: () => Promise<unknown>): Promise<void> => {
      try {
        await op();
      } catch (err) {
        if (err instanceof NoSuchEntityException) return;
        throw err;
      }
    };

    for (const roleName of roles) {
      await deleteSafely(() =>
        client.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }))
      );
    }
    for (const userName of users) {
      await deleteSafely(() =>
        client.send(new DeleteUserPolicyCommand({ UserName: userName, PolicyName: policyName }))
      );
    }
    for (const groupName of groups) {
      await deleteSafely(() =>
        client.send(new DeleteGroupPolicyCommand({ GroupName: groupName, PolicyName: policyName }))
      );
    }
  },
};

/**
 * Exported for unit testing — look up the pre-delete handler for
 * `resourceType` and invoke it against `entry`. Throws when no handler
 * is registered (same shape as the inline call site).
 */
export async function invokePreDeleteHandler(
  resourceType: string,
  entry: RecreateBeforePhase2Entry
): Promise<void> {
  const handler = PRE_DELETE_HANDLERS[resourceType];
  if (!handler) {
    throw new Error(`no pre-delete handler registered for ${resourceType}`);
  }
  await handler(entry);
}

/** What {@link policyDetachTargets} returns for a policy it will act on. */
interface PolicyDetachTargets {
  policyName: string;
  roles: string[];
  users: string[];
  groups: string[];
}

/**
 * THE decision for an `AWS::IAM::Policy` pre-delete: which inline policy is
 * removed from which principals, or why the pre-delete refuses. Shared by the
 * handler that acts on it and by {@link preDeleteListingLines}, which prints
 * it in the plan the operator confirms from, so the two cannot disagree
 * (go-to-k/cdkd#3857).
 *
 * The physicalId is the bare policy name (SDK provider format) or the legacy
 * `policyName:roleName` (Cloud Control, pre-SDK-provider state); the SDK
 * provider's own delete takes the first segment, and so does this. When the
 * record carries NO principal list at all, the legacy id's second segment is
 * the role, exactly as `IAMPolicyProvider.delete` reads it, provided it is an
 * IAM name (go-to-k/cdkd#3910).
 *
 * Each of `Roles` / `Users` / `Groups` is read by `readRecordedPrincipals`
 * (`src/provisioning/iam-policy-targets.ts`), the reader
 * `IAMPolicyProvider.delete` shares: a `malformed` one refuses before any AWS
 * call (go-to-k/cdkd#3878).
 */
export function policyDetachTargets(
  entry: RecreateBeforePhase2Entry
): PolicyDetachTargets | { refusal: string } {
  const physicalId = typeof entry.physicalId === 'string' ? entry.physicalId : '';
  const policyName = physicalId.includes(':') ? physicalId.split(':')[0]! : physicalId;
  if (!policyName) {
    return { refusal: 'its physicalId names no policy' };
  }
  let allAbsent = true;
  const read = (key: 'Roles' | 'Users' | 'Groups'): string[] | { refusal: string } => {
    const recorded = readRecordedPrincipals(entry.properties[key]);
    if (recorded.kind === 'absent') return [];
    allAbsent = false;
    if (recorded.kind === 'malformed') {
      return {
        refusal:
          `its recorded properties.${key} is not a list of ${key.slice(0, -1).toLowerCase()} names ` +
          `(${recorded.detail})`,
      };
    }
    return recorded.names;
  };
  const roles = read('Roles');
  if ('refusal' in roles) return roles;
  const users = read('Users');
  if ('refusal' in users) return users;
  const groups = read('Groups');
  if ('refusal' in groups) return groups;
  const legacyRole = physicalId.includes(':') ? physicalId.split(':')[1] : undefined;
  if (allAbsent && legacyRole !== undefined && IAM_PRINCIPAL_NAME.test(legacyRole)) {
    return { policyName, roles: [legacyRole], users: [], groups: [] };
  }
  if (roles.length + users.length + groups.length === 0) {
    return {
      refusal:
        // Not 'cdkd state refresh-observed': that command rewrites only
        // `observedProperties`, never the `properties` this reads.
        'no Roles/Users/Groups attachment is recorded (state may be from a pre-v0.74 cdkd ' +
        'binary), so there is nothing to remove it from; re-import the policy so its record ' +
        'carries the principals the template names',
    };
  }
  return { policyName, roles, users, groups };
}

const PRINCIPAL_KINDS = [
  {
    key: 'Roles',
    label: 'role',
    type: 'AWS::IAM::Role',
    pick: (t: PolicyDetachTargets) => t.roles,
  },
  {
    key: 'Users',
    label: 'user',
    type: 'AWS::IAM::User',
    pick: (t: PolicyDetachTargets) => t.users,
  },
  {
    key: 'Groups',
    label: 'group',
    type: 'AWS::IAM::Group',
    pick: (t: PolicyDetachTargets) => t.groups,
  },
] as const;

/**
 * The most principals one `AWS::IAM::Policy` pre-delete may name before the
 * plan refuses to list them (go-to-k/cdkd#3910). Every name is printed — none
 * is summarised as a count — so a record listing thousands would push the
 * rest of the plan off screen; such a record is blocked instead. Far above
 * what a CDK grant produces (one principal).
 */
const MAX_DETACH_PRINCIPALS = 100;

/** How {@link policyTemplateCheck} says a policy may not be exported as it stands. */
interface PolicyTemplateBlock {
  blocked: string;
  /**
   * `deploy`: the record differs from the template, which is what an
   * undeployed template change leaves, and a deploy converges AWS and the
   * record — a re-import would rewrite only the record and leave the old
   * attachment in AWS, unmanaged. `import`: the record's shape, not AWS, is
   * wrong.
   */
  remedy: 'deploy' | 'import' | 'manual';
  /** The template value compared came from a Parameter. */
  throughParameter?: boolean;
}

/** What {@link policyTemplateCheck} returns for a policy that may proceed. */
interface PolicyTemplatePass {
  unconfirmed: Array<{ kind: 'role' | 'user' | 'group'; name: string }>;
  /** The template's `PolicyName` is not a literal, so the name cannot be compared. */
  nameUnconfirmed: boolean;
}

/**
 * Compare an `AWS::IAM::Policy`'s pre-delete against what phase 2 puts back
 * (go-to-k/cdkd#3910). The pre-delete removes the policy from the RECORDED
 * principals; phase 2 re-CREATEs it from the TEMPLATE. A recorded principal
 * the template does not name therefore loses the policy for good, and a
 * recorded policy name the template does not carry is removed while phase 2
 * attaches a differently named one — neither is the brief window the plan
 * describes, so both block the export.
 *
 * A template principal is a literal name, or a `Ref` to a logical id that is
 * a RESOURCE of the matching type in this template AND that this stack's
 * cdkd state records (its physical id IS the name). Requiring the template
 * resource matters: a record can carry an entry whose key is a template
 * PARAMETER's name, and resolving a parameter `Ref` from state would confirm
 * a principal the parameter does not name. Anything else (`Fn::ImportValue`,
 * `Fn::GetAtt`, a parameter `Ref`, a non-list value) cannot be resolved here:
 * a recorded principal of that kind is returned as UNCONFIRMED and marked in
 * the plan rather than blocked, since refusing every such template would
 * refuse legitimate ones. A non-literal `PolicyName` is marked the same way.
 */
export function policyTemplateCheck(
  targets: PolicyDetachTargets,
  templateProperties: unknown,
  recordedProperties: Record<string, unknown>,
  templateResources: Record<string, unknown>,
  stateResources: StackState['resources'],
  templateParameters: unknown,
  parameterValues: Record<string, string>
): PolicyTemplateBlock | PolicyTemplatePass {
  const declaredParameters =
    templateParameters &&
    typeof templateParameters === 'object' &&
    !Array.isArray(templateParameters)
      ? (templateParameters as Record<string, unknown>)
      : {};
  // A `Ref` to one of THIS template's Parameters, read from the values this
  // stack's changeset submits. Only a DECLARED parameter counts: a submitted
  // key the template does not declare is not what the `Ref` names. A
  // list-typed parameter is split on commas, as CloudFormation does.
  const parameterRef = (el: unknown): string[] | undefined => {
    const ref =
      el && typeof el === 'object' && !Array.isArray(el)
        ? (el as Record<string, unknown>)['Ref']
        : undefined;
    if (typeof ref !== 'string' || !Object.hasOwn(declaredParameters, ref)) return undefined;
    if (!Object.hasOwn(parameterValues, ref)) return undefined;
    const value = parameterValues[ref]!;
    const type = (declaredParameters[ref] as { Type?: unknown } | undefined)?.Type;
    // An SSM-typed parameter's value is the SSM parameter's NAME; CloudFormation
    // substitutes the stored value, which cdkd does not read here.
    if (isSsmParameterType(type)) return undefined;
    const isList =
      typeof type === 'string' && (type === 'CommaDelimitedList' || type.startsWith('List<'));
    return isList ? value.split(',').map((v) => v.trim()) : [value];
  };
  const total = targets.roles.length + targets.users.length + targets.groups.length;
  if (total > MAX_DETACH_PRINCIPALS) {
    return {
      blocked:
        `its record removes the policy from ${total} principals, more than the plan lists ` +
        `(${MAX_DETACH_PRINCIPALS}); check the record and the template against AWS before ` +
        'exporting',
      // No command: a re-import records the template's list, which may be as
      // long; a deploy, a destroy or removing the resource all detach the
      // policy from every recorded principal, unreviewed — what this refuses.
      remedy: 'manual',
    };
  }
  const props =
    templateProperties &&
    typeof templateProperties === 'object' &&
    !Array.isArray(templateProperties)
      ? (templateProperties as Record<string, unknown>)
      : {};
  const namedByParameter = parameterRef(props['PolicyName']);
  const templateName =
    namedByParameter !== undefined && namedByParameter.length === 1
      ? namedByParameter[0]
      : props['PolicyName'];
  if (typeof templateName === 'string' && templateName !== targets.policyName) {
    // A record whose physical id is not the policy's name but whose recorded
    // PolicyName is the template's (a record adopted from CloudFormation can
    // carry CloudFormation's own id): the RECORD is wrong, not AWS.
    if (recordedProperties['PolicyName'] === templateName) {
      return {
        blocked:
          `its physical id ${showRecordValue(targets.policyName)} is not the policy's name, ` +
          `which the record and the template both give as ${showRecordValue(templateName)}; ` +
          'the pre-delete would target a policy that does not exist and leave the real one ' +
          'attached',
        remedy: 'import',
      };
    }
    return {
      blocked:
        `its recorded policy name ${showRecordValue(targets.policyName)} is not the template's ` +
        `PolicyName ${showRecordValue(templateName)}, so phase 2 would create a differently ` +
        'named policy and the recorded one would be removed for good. This is typically a ' +
        'template change not yet deployed, and the deploy below removes the recorded policy ' +
        "too: run the 'Check first with:' diff and confirm it is a policy this app attached " +
        'before running the deploy',
      remedy: 'deploy',
      throughParameter: namedByParameter !== undefined,
    };
  }
  const unconfirmed: Array<{ kind: 'role' | 'user' | 'group'; name: string }> = [];
  const permanent: string[] = [];
  let permanentThroughParameter = false;
  for (const kind of PRINCIPAL_KINDS) {
    const declared = props[kind.key];
    const names = new Set<string>();
    let resolved = true;
    let usedParameter = false;
    if (declared !== undefined) {
      const wholeList = Array.isArray(declared) ? undefined : parameterRef(declared);
      if (wholeList !== undefined) {
        // The whole list is one list-typed Parameter cdkd knows.
        usedParameter = true;
        for (const n of wholeList) names.add(n);
      } else if (!Array.isArray(declared)) {
        resolved = false;
      } else {
        for (const el of declared) {
          if (typeof el === 'string') {
            names.add(el);
            continue;
          }
          const fromParameter = parameterRef(el);
          if (fromParameter !== undefined) {
            usedParameter = true;
            for (const n of fromParameter) names.add(n);
            continue;
          }
          const ref =
            el && typeof el === 'object' && !Array.isArray(el)
              ? (el as Record<string, unknown>)['Ref']
              : undefined;
          const templateTarget =
            typeof ref === 'string' && Object.hasOwn(templateResources, ref)
              ? (templateResources[ref] as { Type?: unknown } | undefined)
              : undefined;
          const recorded =
            templateTarget?.Type === kind.type &&
            typeof ref === 'string' &&
            Object.hasOwn(stateResources, ref)
              ? stateResources[ref]
              : undefined;
          if (recorded?.resourceType === kind.type && typeof recorded.physicalId === 'string') {
            names.add(recorded.physicalId);
          } else {
            resolved = false;
          }
        }
      }
    }
    for (const name of kind.pick(targets)) {
      if (names.has(name)) continue;
      if (resolved) {
        permanent.push(`${kind.label} ${showRecordValue(name)}`);
        if (usedParameter) permanentThroughParameter = true;
      } else unconfirmed.push({ kind: kind.label, name });
    }
  }
  if (permanent.length > 0) {
    return {
      blocked:
        `its record removes the policy from ${permanent.join(', ')}, which the template does ` +
        'not name, so phase 2 would not re-attach it there and the pre-delete would remove it ' +
        'for good. This is typically a template change not yet deployed, and the deploy below ' +
        "removes the policy from them too: run the 'Check first with:' diff and confirm they " +
        'are principals this app attached it to before running the deploy',
      remedy: 'deploy',
      throughParameter: permanentThroughParameter,
    };
  }
  return {
    unconfirmed,
    // No `PolicyName` at all is unconfirmed too: CloudFormation would name the
    // policy itself, never the recorded name.
    nameUnconfirmed: typeof templateName !== 'string',
  };
}

/**
 * The plan lines for one `recreateBeforePhase2` entry: the resource, and for
 * an `AWS::IAM::Policy` the inline policy and EVERY role, user and group its
 * pre-delete removes it from, from {@link policyDetachTargets}, the handler's
 * own decision (go-to-k/cdkd#3857). The confirmation printed after the plan
 * says to "see plan above" for what cdkd deletes between phases, and these
 * targets come from the state RECORD, so none is summarised as a count
 * (go-to-k/cdkd#3910): each is an IAM name of at most 128 characters, so the
 * line stays bounded by the record's own list. A principal phase 2 cannot be
 * confirmed to re-attach gets its own line. Every recorded value goes through
 * {@link showRecordValue}. Shared by the single-stack plan and the nested-tree
 * summary. Exported for the unit cases.
 */
export function preDeleteListingLines(entry: RecreateBeforePhase2Entry): string[] {
  const head =
    `${rowIdent(entry.logicalId)} (${rowIdent(entry.resourceType)}) — physicalId: ` +
    recordValueOrNotShown(entry.physicalId);
  if (entry.resourceType !== 'AWS::IAM::Policy') return [head];
  const targets = policyDetachTargets(entry);
  // UNREACHABLE from both callers: `buildImportPlan` blocks a refusing policy
  // instead of queuing it, so neither plan ever reaches this arm. Kept so the
  // helper stays total for a direct caller and its unit cases.
  if ('refusal' in targets) return [head, `  the pre-delete will refuse: ${targets.refusal}`];
  const parts: string[] = [];
  for (const [label, names] of [
    ['roles', targets.roles],
    ['users', targets.users],
    ['groups', targets.groups],
  ] as const) {
    if (names.length === 0) continue;
    parts.push(`${label}: ${names.map((v) => showRecordValue(v)).join(', ')}`);
  }
  const lines = [
    head,
    `  removes inline policy ${showRecordValue(targets.policyName)} from ${parts.join('; ')}`,
  ];
  if (entry.policyNameUnconfirmed) {
    lines.push(
      `  phase 2 cannot be confirmed to re-create it as ${showRecordValue(targets.policyName)}: ` +
        "the template's PolicyName is not a literal, so a differently named policy may replace " +
        'it and this one would be removed for good'
    );
  }
  if (entry.unconfirmedPrincipals && entry.unconfirmedPrincipals.length > 0) {
    lines.push(
      '  phase 2 cannot be confirmed to re-attach it to ' +
        entry.unconfirmedPrincipals.map((p) => `${p.kind} ${showRecordValue(p.name)}`).join(', ') +
        ': the template names its principals through a value cdkd cannot resolve'
    );
  }
  return lines;
}

/**
 * The by-hand deletes for the pre-delete types a failed run may have left
 * behind, one line per principal KIND present (go-to-k/cdkd#3910): a command
 * is printed only for what the entries actually record. Every value is a
 * quoted `commandHole`, never a bare `<placeholder>`, which a shell reads as a
 * redirection.
 */
export function preDeleteManualCommands(
  entries: readonly {
    resourceType: string;
    physicalId?: string;
    properties?: Record<string, unknown>;
  }[]
): string[] {
  const lines: string[] = [];
  // One command per principal KIND a policy records, each alone on its line
  // so it pastes; the explanation is a line of its own after them.
  const kinds = new Set<'role' | 'user' | 'group'>();
  for (const e of entries) {
    if (e.resourceType !== 'AWS::IAM::Policy') continue;
    const targets = policyDetachTargets({
      logicalId: '',
      resourceType: e.resourceType,
      physicalId: e.physicalId ?? '',
      properties: e.properties ?? {},
    });
    if ('refusal' in targets) {
      // Nothing readable: name every kind rather than none.
      kinds.add('role').add('user').add('group');
      continue;
    }
    if (targets.roles.length > 0) kinds.add('role');
    if (targets.users.length > 0) kinds.add('user');
    if (targets.groups.length > 0) kinds.add('group');
  }
  const iam = [
    ['role', 'delete-role-policy', '--role-name', 'RoleName'],
    ['user', 'delete-user-policy', '--user-name', 'UserName'],
    ['group', 'delete-group-policy', '--group-name', 'GroupName'],
  ] as const;
  for (const [kind, verb, principalFlag, hole] of iam) {
    if (!kinds.has(kind)) continue;
    lines.push(
      withPasteableAwsProfile(
        `aws iam ${verb} ${principalFlag} ${commandHole(hole)} --policy-name ${commandHole('PolicyName')}`
      )
    );
  }
  if (kinds.size > 0) {
    lines.push(
      '# run each iam line once per listed principal still attached: a partial pre-delete ' +
        'may already have removed some'
    );
  }
  return lines;
}
