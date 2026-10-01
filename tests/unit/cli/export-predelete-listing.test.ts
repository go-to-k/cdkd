/**
 * The plan `cdkd export` prints before its confirmation names, for an
 * `AWS::IAM::Policy` pre-delete, the roles, users and groups the inline policy
 * is detached from (go-to-k/cdkd#3857). Those targets come from the state
 * record, and the confirmation tells the operator to "see plan above" for what
 * is deleted between phases.
 *
 * The single-stack plan is driven through `createExportCommand()` in
 * `export-plan-record-display.test.ts`; this file pins the shared helper and
 * the nested-tree summary, driven through `runPerStackImportLoop` on a
 * `--dry-run`, which returns before any lock, prompt or AWS write.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const infoSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import {
  blockedMigrationTail,
  buildImportPlan,
  invokePreDeleteHandler,
  preDeleteManualCommands,
  preDeleteListingLines,
  runPerStackImportLoop,
  type CdkdStateStackTree,
  type RecreateBeforePhase2Entry,
} from '../../../src/cli/commands/export.js';
import type { StackState } from '../../../src/types/state.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';

/** No case here reads SSM (go-to-k/cdkd#3915); a read would fail the case by name. */
const UNUSED_SSM = {
  send: () => Promise.reject(new Error('unexpected SSM read')),
} as unknown as AwsClients['ssm'];

function policy(properties: Record<string, unknown>): RecreateBeforePhase2Entry {
  return {
    logicalId: 'HandlerPolicy',
    resourceType: 'AWS::IAM::Policy',
    physicalId: 'HandlerPolicyName',
    properties,
  };
}

const HEAD = 'HandlerPolicy (AWS::IAM::Policy) — physicalId: HandlerPolicyName';

const ON = '  removes inline policy HandlerPolicyName from ';


// The IAM::Policy pre-delete builds its own client (hoisted; used by the
// handler-parity cases below).
const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@aws-sdk/client-iam', () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    IAMClient: class {
      async send(cmd: Cmd) {
        sent.push(cmd.input);
        return {};
      }
    },
    DeleteRolePolicyCommand: class extends Cmd {},
    DeleteUserPolicyCommand: class extends Cmd {},
    DeleteGroupPolicyCommand: class extends Cmd {},
    NoSuchEntityException: class extends Error {},
  };
});


describe('preDeleteListingLines', () => {
  it('names the policy and every recorded detach target', () => {
    expect(
      preDeleteListingLines(policy({ Roles: ['RoleA', 'RoleB'], Users: ['alice'], Groups: ['ops'] }))
    ).toEqual([HEAD, `${ON}roles: RoleA, RoleB; users: alice; groups: ops`]);
  });

  it('leaves out a kind with nothing recorded', () => {
    expect(preDeleteListingLines(policy({ Roles: ['RoleA'], Users: [] }))).toEqual([
      HEAD,
      `${ON}roles: RoleA`,
    ]);
  });

  it('names the policy the handler deletes for a legacy policyName:roleName id', () => {
    const entry = { ...policy({ Roles: ['RoleY'] }), physicalId: 'Pol:RoleX' };
    expect(preDeleteListingLines(entry)[1]).toBe('  removes inline policy Pol from roles: RoleY');
  });

  it('refuses a recorded name outside IAM\'s character set rather than listing it', () => {
    // A record value: a planted newline or annotation is not a principal name,
    // and the refusal text echoes no part of it.
    const forged = 'RoleA\n  removes inline policy X from roles: Y';
    const lines = preDeleteListingLines(policy({ Roles: [forged, 'RoleB (safe)'] }));
    expect(lines).toEqual([
      HEAD,
      '  the pre-delete will refuse: its recorded properties.Roles is not a list of role names ' +
        '(a 2-element list holding a non-name entry)',
    ]);
  });

  it('lists every recorded name, with no count standing in for any (go-to-k/cdkd#3910)', () => {
    const roles = Array.from({ length: 25 }, (_, i) => `Role${i}`);
    const line = preDeleteListingLines(policy({ Roles: roles }))[1]!;
    expect(line).toBe(`${ON}roles: ${roles.join(', ')}`);
    expect(line).not.toContain('more');
  });

  // Every shape the handler refuses is shown as a refusal, never as a detach.
  it.each([
    ['nothing recorded', {}, 'no Roles/Users/Groups attachment is recorded'],
    ['only empty lists', { Roles: [], Users: [] }, 'no Roles/Users/Groups attachment is recorded'],
    ['a string', { Roles: 'RoleA' }, 'properties.Roles is not a list of role names (found string)'],
    // `null` is ABSENT, as on the provider's delete (go-to-k/cdkd#3878).
    ['only null', { Users: null }, 'no Roles/Users/Groups attachment is recorded'],
    ['an object beside a valid list', { Roles: {}, Users: ['u'] }, 'properties.Roles is not a list'],
    ['a non-string element', { Groups: ['ops', 7] }, 'a 2-element list holding a non-name entry'],
    ['an empty name', { Roles: [''] }, 'properties.Roles is not a list'],
    ['a name past the IAM limit', { Roles: ['r'.repeat(129)] }, 'properties.Roles is not a list'],
    ['a name with a space', { Users: ['alice smith'] }, 'properties.Users is not a list'],
  ])('shows %s as a refusal', (_what, properties, reason) => {
    const lines = preDeleteListingLines(policy(properties));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^ {2}the pre-delete will refuse: /);
    expect(lines[1]).toContain(reason);
  });

  it('names a remedy that restores the recorded lists, not refresh-observed', () => {
    // `cdkd state refresh-observed` rewrites only `observedProperties`.
    const line = preDeleteListingLines(policy({}))[1]!;
    expect(line).toContain('re-import the policy so its record carries the principals');
    expect(line).not.toContain('refresh-observed');
  });

  it('refuses a physicalId that names no policy', () => {
    expect(preDeleteListingLines({ ...policy({ Roles: ['R'] }), physicalId: ':R' })[1]).toBe(
      '  the pre-delete will refuse: its physicalId names no policy'
    );
  });

  it('adds nothing for a type whose pre-delete detaches nothing', () => {
    expect(
      preDeleteListingLines({
        logicalId: 'Stage',
        resourceType: 'AWS::ApiGatewayV2::Stage',
        physicalId: 'stage-1',
        properties: { ApiId: 'a1', Roles: ['NotARealField'] },
      })
    ).toEqual(['Stage (AWS::ApiGatewayV2::Stage) — physicalId: stage-1']);
  });

  it('describes a physical id that is not inert on a command line (go-to-k/cdkd#4229)', () => {
    for (const physicalId of ['$default', 'x$(touch OWNED)', "x'y", 'a|b']) {
      const [head] = preDeleteListingLines({
        logicalId: 'Stage',
        resourceType: 'AWS::ApiGatewayV2::Stage',
        physicalId,
        properties: { ApiId: 'a1' },
      });
      expect(head, physicalId).toBe(
        'Stage (AWS::ApiGatewayV2::Stage) — physicalId: (not shown: it is not a plain identifier)'
      );
    }
    // And a forged LOGICAL id on the row is described (`rowIdent`), never
    // displayed in JSON or shell quotes (go-to-k/cdkd#4229).
    const [forgedRow] = preDeleteListingLines({
      logicalId: 'x$(touch OWNED)',
      resourceType: 'AWS::ApiGatewayV2::Stage',
      physicalId: 'stage-1',
      properties: { ApiId: 'a1' },
    });
    expect(forgedRow).toBe(
      '(not shown: it is not a plain identifier) (AWS::ApiGatewayV2::Stage) — physicalId: stage-1'
    );
  });
});

/**
 * The HANDLER refuses exactly what the plan shows as a refusal, before any
 * AWS call: one predicate decides both.
 */
describe('the IAM::Policy pre-delete refuses what the plan shows as a refusal', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it.each([
    ['a string', { Roles: 'RoleA' }],
    ['an object beside a valid list', { Roles: {}, Users: ['u'] }],
    ['a non-string element', { Roles: ['R', null] }],
  ])('refuses %s with no AWS call', async (_what, properties) => {
    await expect(invokePreDeleteHandler('AWS::IAM::Policy', policy(properties))).rejects.toThrow(
      /cannot be pre-deleted: its recorded properties\.\w+ is not a list/
    );
    expect(sent).toEqual([]);
  });

  it('reads a null list as absent beside a valid one', async () => {
    await invokePreDeleteHandler('AWS::IAM::Policy', policy({ Roles: null, Users: ['u'] }));
    expect(sent).toEqual([{ UserName: 'u', PolicyName: 'HandlerPolicyName' }]);
  });

  it('detaches a legacy policyName:roleName record with no lists from that role, as the provider does', async () => {
    await invokePreDeleteHandler('AWS::IAM::Policy', {
      ...policy({}),
      physicalId: 'Pol:LegacyRole',
    });
    expect(sent).toEqual([{ RoleName: 'LegacyRole', PolicyName: 'Pol' }]);
  });

  it('removes the listed policy from exactly the listed principals', async () => {
    await invokePreDeleteHandler(
      'AWS::IAM::Policy',
      { ...policy({ Roles: ['RoleY'], Groups: ['ops'] }), physicalId: 'Pol:RoleX' }
    );
    expect(sent).toEqual([
      { RoleName: 'RoleY', PolicyName: 'Pol' },
      { GroupName: 'ops', PolicyName: 'Pol' },
    ]);
  });
});

describe('the nested-tree plan summary names each pre-delete and its detach targets', () => {
  beforeEach(() => infoSpy.mockClear());

  it('lists the IAM::Policy detach targets under its stack', async () => {
    const state: StackState = {
      version: 9,
      stackName: 'Root',
      region: 'us-east-1',
      resources: {
        Bucket: {
          physicalId: 'my-bucket',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: {},
          dependencies: [],
        },
        HandlerPolicy: {
          physicalId: 'HandlerPolicyName',
          resourceType: 'AWS::IAM::Policy',
          properties: { PolicyName: 'HandlerPolicyName', Roles: ['RoleA', 'RoleB'] },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 1,
    } as unknown as StackState;
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state,
      nestedChildren: new Map(),
    };
    const template = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        HandlerPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: { PolicyName: 'HandlerPolicyName', Roles: ['RoleA', 'RoleB'] },
        },
      },
    };
    // Every CloudFormation call answers "does not exist": the absence check
    // is the only one a dry run makes.
    const cfnClient = {
      send: vi.fn(async () => {
        throw new Error('Stack with id Root does not exist');
      }),
    } as unknown as AwsClients['cloudFormation'];

    const result = await runPerStackImportLoop({
      rootStackName: 'Root',
      rootRegion: 'us-east-1',
      rootStackInfoNestedTemplates: {},
      rootTemplateFormat: 'json',
      tree,
      rootTemplate: template,
      cfnStackNameOverrides: { childMap: new Map() },
      rootParameters: [],
      deps: {
        cfnClient,
        stateBackend: {} as S3StateBackend,
        lockManager: {} as LockManager,
        uploadOpts: { stateBucket: 'b' },
        lockOwner: 'test',
        ssmClient: UNUSED_SSM,
      },
      options: {
        dryRun: true,
        yes: false,
        includeNonImportable: false,
        recreateImportUnsupported: true,
        skipImportSupportPreflight: true,
      },
      lockRecovery: {},
    });

    expect(result.outcome).toBe('dry-run');
    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    const at = lines.findIndex((l) => l.startsWith("  ['Root'] → CFn stack"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines.slice(at + 1, at + 3)).toEqual([
      `    ${HEAD}`,
      '      removes inline policy HandlerPolicyName from roles: RoleA, RoleB',
    ]);
  });
});

/**
 * A pre-delete that would refuse, or would remove the policy from somewhere
 * phase 2 does not put it back, is BLOCKED at plan time, so the export stops
 * before phase 1 rather than between phases (go-to-k/cdkd#3857,
 * go-to-k/cdkd#3910).
 */
describe('buildImportPlan checks an IAM::Policy pre-delete against the template', () => {
  const cfnClient = {
    send: vi.fn(async () => {
      throw new Error('no schema');
    }),
  } as unknown as AwsClients['cloudFormation'];

  function stateWithPolicy(
    properties: Record<string, unknown>,
    physicalId = 'HandlerPolicyName',
    extra: StackState['resources'] = {}
  ): StackState {
    return {
      version: 9,
      stackName: 'S',
      region: 'us-east-1',
      resources: {
        HandlerPolicy: {
          physicalId,
          resourceType: 'AWS::IAM::Policy',
          properties,
          attributes: {},
          dependencies: [],
        },
        ...extra,
      },
      outputs: {},
      lastModified: 1,
    } as unknown as StackState;
  }
  const templateWith = (
    properties: Record<string, unknown>,
    others: Record<string, unknown> = {},
    parameters?: Record<string, unknown>
  ) => ({
    ...(parameters && { Parameters: parameters }),
    Resources: { HandlerPolicy: { Type: 'AWS::IAM::Policy', Properties: properties }, ...others },
  });
  const plan = (
    st: StackState,
    props: Record<string, unknown>,
    others: Record<string, unknown> = {},
    extra: {
      parameters?: Record<string, unknown>;
      parameterValues?: Record<string, string>;
      parametersFromCli?: boolean;
      rootStackName?: string;
    } = {}
  ) =>
    buildImportPlan(st, templateWith(props, others, extra.parameters), cfnClient, 'S', {
      recreateImportUnsupported: true,
      skipImportSupportPreflight: true,
      ...(extra.parameterValues && { parameterValues: extra.parameterValues }),
      ...(extra.parametersFromCli !== undefined && { parametersFromCli: extra.parametersFromCli }),
      ...(extra.rootStackName !== undefined && { rootStackName: extra.rootStackName }),
    });
  const REPAIR_STEM = "cdkd import '<stack>' --resource HandlerPolicy='<physicalId>' --force";
  // A record the template has moved on from is converged by a deploy; a
  // re-import would rewrite only the record and leave the old grant in AWS.
  const DEPLOY_REPAIR = "cdkd deploy '<stack>'";
  // ...and the diff that shows that same detach goes FIRST.
  const DIFF_FIRST = "cdkd diff '<stack>'";
  const role = (physicalId: string) => ({
    physicalId,
    resourceType: 'AWS::IAM::Role',
    properties: {},
    attributes: {},
    dependencies: [],
  });

  it('blocks a refusing record, with the refusal as the reason and a re-import repair', async () => {
    const p = await plan(stateWithPolicy({ Roles: 'RoleA' }), { Roles: ['RoleA'] });
    expect(p.recreateBeforePhase2).toEqual([]);
    expect(p.blocked).toEqual([
      {
        logicalId: 'HandlerPolicy',
        resourceType: 'AWS::IAM::Policy',
        reason:
          'the pre-delete of this inline policy would refuse: its recorded properties.Roles is ' +
          'not a list of role names (found string)',
        repair: REPAIR_STEM,
      },
    ]);
  });

  it('keeps a record whose principals are the template literals', async () => {
    const p = await plan(stateWithPolicy({ Roles: ['RoleA'] }), {
      PolicyName: 'HandlerPolicyName',
      Roles: ['RoleA'],
    });
    expect(p.blocked).toEqual([]);
    expect(p.recreateBeforePhase2.map((r) => r.logicalId)).toEqual(['HandlerPolicy']);
    expect(p.recreateBeforePhase2[0]!.unconfirmedPrincipals).toBeUndefined();
  });

  it('resolves a template Ref to a role this stack records (the CDK grant shape)', async () => {
    const st = stateWithPolicy({ Roles: ['ServiceRoleName'] }, 'HandlerPolicyName', {
      HandlerServiceRole: {
        physicalId: 'ServiceRoleName',
        resourceType: 'AWS::IAM::Role',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    } as unknown as StackState['resources']);
    const p = await plan(
      st,
      { Roles: [{ Ref: 'HandlerServiceRole' }] },
      { HandlerServiceRole: { Type: 'AWS::IAM::Role', Properties: {} } }
    );
    expect(p.blocked).toEqual([]);
    expect(p.recreateBeforePhase2[0]!.unconfirmedPrincipals).toBeUndefined();
  });

  it('does not resolve a PARAMETER Ref from a state entry of the same name', async () => {
    // A record can carry a resources entry keyed by a template parameter's
    // name; the parameter's real value is what phase 2 attaches to.
    const st = stateWithPolicy({ Roles: ['VictimRole'] }, 'HandlerPolicyName', {
      ParentRoleRef: role('VictimRole'),
    } as unknown as StackState['resources']);
    const p = await plan(st, { Roles: [{ Ref: 'ParentRoleRef' }] });
    expect(p.blocked).toEqual([]);
    expect(p.recreateBeforePhase2[0]!.unconfirmedPrincipals).toEqual([
      { kind: 'role', name: 'VictimRole' },
    ]);
  });

  it('marks, not blocks, a principal list that is not a literal list', async () => {
    const p = await plan(stateWithPolicy({ Roles: ['RoleA'] }), {
      Roles: { 'Fn::If': ['Cond', ['RoleA'], ['RoleB']] },
    });
    expect(p.blocked).toEqual([]);
    expect(p.recreateBeforePhase2[0]!.unconfirmedPrincipals).toEqual([{ kind: 'role', name: 'RoleA' }]);
  });

  it('marks, not blocks, a PolicyName that is not a literal', async () => {
    const p = await plan(stateWithPolicy({ Roles: ['RoleA'] }), {
      PolicyName: { 'Fn::Join': ['-', [{ Ref: 'AWS::StackName' }, 'p']] },
      Roles: ['RoleA'],
    });
    expect(p.blocked).toEqual([]);
    const entry = p.recreateBeforePhase2[0]!;
    expect(entry.policyNameUnconfirmed).toBe(true);
    expect(preDeleteListingLines(entry)).toContain(
      "  phase 2 cannot be confirmed to re-create it as HandlerPolicyName: the template's " +
        'PolicyName is not a literal, so a differently named policy may replace it and this ' +
        'one would be removed for good'
    );
  });

  it('blocks a record naming more principals than the plan lists', async () => {
    const roles = Array.from({ length: 101 }, (_, i) => `Role${i}`);
    const p = await plan(stateWithPolicy({ Roles: roles }), { Roles: roles });
    expect(p.blocked).toEqual([
      {
        logicalId: 'HandlerPolicy',
        resourceType: 'AWS::IAM::Policy',
        reason:
          'its record removes the policy from 101 principals, more than the plan lists (100); ' +
          'check the record and the template against AWS before exporting',
        manual: true,
      },
    ]);
    // A destroy or a removal would detach the policy from all of them unseen,
    // so the generic remedy is not said of it.
    const tail = blockedMigrationTail(p.blocked);
    expect(tail).not.toContain('destroy them first');
    expect(tail).toBe(
      'Resolve each row that names its own check as it says — destroying or removing that ' +
        'resource is not a remedy, since it would perform the very removal the row refuses.'
    );
  });

  it('lists exactly 100 principals rather than blocking', async () => {
    const roles = Array.from({ length: 100 }, (_, i) => `Role${i}`);
    const p = await plan(stateWithPolicy({ Roles: roles }), { Roles: roles });
    expect(p.blocked).toEqual([]);
  });

  it('blocks a physical id that is not the policy name the record and template share', async () => {
    const p = await plan(stateWithPolicy({ PolicyName: 'Real', Roles: ['RoleA'] }, 'Stack-Polic-ABC'), {
      PolicyName: 'Real',
      Roles: ['RoleA'],
    });
    expect(p.blocked).toEqual([
      {
        logicalId: 'HandlerPolicy',
        resourceType: 'AWS::IAM::Policy',
        reason:
          "its physical id Stack-Polic-ABC is not the policy's name, which the record and the " +
          'template both give as Real; the pre-delete would target a policy that does not exist ' +
          'and leave the real one attached',
        repair: REPAIR_STEM,
      },
    ]);
  });

  it('blocks a recorded principal the template does not name: phase 2 would not re-attach it', async () => {
    const p = await plan(stateWithPolicy({ Roles: ['RoleA', 'AdminRole'], Users: ['alice'] }), {
      Roles: ['RoleA'],
    });
    expect(p.recreateBeforePhase2).toEqual([]);
    expect(p.blocked).toEqual([
      {
        logicalId: 'HandlerPolicy',
        resourceType: 'AWS::IAM::Policy',
        reason:
          'its record removes the policy from role AdminRole, user alice, which the template ' +
          'does not name, so phase 2 would not re-attach it there and the pre-delete would ' +
          'remove it for good. This is typically a template change not yet deployed, and the ' +
          "deploy below removes the policy from them too: run the 'Check first with:' diff and " +
          'confirm they are principals this app attached it to before running the deploy',
        checkFirst: DIFF_FIRST,
        repair: DEPLOY_REPAIR,
      },
    ]);
  });

  it('does not read a Ref to a non-principal resource as a name', async () => {
    const st = stateWithPolicy({ Roles: ['q-1'] }, 'HandlerPolicyName', {
      Queue: {
        physicalId: 'q-1',
        resourceType: 'AWS::SQS::Queue',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    } as unknown as StackState['resources']);
    // Not a role: unresolved, so the recorded name is UNCONFIRMED, not accepted.
    const p = await plan(st, { Roles: [{ Ref: 'Queue' }] });
    expect(p.blocked).toEqual([]);
    expect(p.recreateBeforePhase2[0]!.unconfirmedPrincipals).toEqual([{ kind: 'role', name: 'q-1' }]);
  });

  it('blocks a recorded policy name that is not the template PolicyName', async () => {
    const p = await plan(stateWithPolicy({ Roles: ['RoleA'] }), {
      PolicyName: 'OtherPolicy',
      Roles: ['RoleA'],
    });
    expect(p.blocked).toEqual([
      {
        logicalId: 'HandlerPolicy',
        resourceType: 'AWS::IAM::Policy',
        reason:
          "its recorded policy name HandlerPolicyName is not the template's PolicyName " +
          'OtherPolicy, so phase 2 would create a differently named policy and the recorded one ' +
          'would be removed for good. This is typically a template change not yet deployed, and ' +
          "the deploy below removes the recorded policy too: run the 'Check first with:' diff " +
          'and confirm it is a policy this app attached before running the deploy',
        checkFirst: DIFF_FIRST,
        repair: DEPLOY_REPAIR,
      },
    ]);
  });

  it('marks, not blocks, a principal the template names through a value cdkd cannot resolve', async () => {
    const p = await plan(stateWithPolicy({ Roles: ['RoleA', 'CrossStackRole'] }), {
      PolicyName: 'HandlerPolicyName',
      Roles: ['RoleA', { 'Fn::ImportValue': 'SharedRoleName' }],
    });
    expect(p.blocked).toEqual([]);
    const entry = p.recreateBeforePhase2[0]!;
    expect(entry.unconfirmedPrincipals).toEqual([{ kind: 'role', name: 'CrossStackRole' }]);
    expect(preDeleteListingLines(entry)[2]).toBe(
      '  phase 2 cannot be confirmed to re-attach it to role CrossStackRole: the template names ' +
        'its principals through a value cdkd cannot resolve'
    );
  });

  it('reads a legacy policyName:roleName id with no lists as that role, as the provider does', async () => {
    const p = await plan(stateWithPolicy({}, 'HandlerPolicyName:LegacyRole'), {
      Roles: ['LegacyRole'],
    });
    expect(p.blocked).toEqual([]);
    expect(preDeleteListingLines(p.recreateBeforePhase2[0]!)[1]).toBe(
      '  removes inline policy HandlerPolicyName from roles: LegacyRole'
    );
  });

  it('checks the real CDK grant shape: a literal PolicyName and a Ref to a template role', async () => {
    const st = stateWithPolicy({ Roles: ['ServiceRoleName'] }, 'HandlerPolicyName', {
      HandlerServiceRole: role('ServiceRoleName'),
    } as unknown as StackState['resources']);
    const p = await plan(
      st,
      { PolicyName: 'HandlerPolicyName', Roles: [{ Ref: 'HandlerServiceRole' }] },
      { HandlerServiceRole: { Type: 'AWS::IAM::Role', Properties: {} } }
    );
    // Confirmed on both counts: no marks.
    expect(p.blocked).toEqual([]);
    const entry = p.recreateBeforePhase2[0]!;
    expect(entry.unconfirmedPrincipals).toBeUndefined();
    expect(entry.policyNameUnconfirmed).toBeUndefined();
    expect(preDeleteListingLines(entry)).toHaveLength(2);
  });

  it('marks a missing PolicyName as unconfirmed (CloudFormation would name the policy itself)', async () => {
    const p = await plan(stateWithPolicy({ Roles: ['RoleA'] }), { Roles: ['RoleA'] });
    expect(p.blocked).toEqual([]);
    expect(p.recreateBeforePhase2[0]!.policyNameUnconfirmed).toBe(true);
  });

  // Each type check decides on its own (test-M1): a template resource of the
  // wrong type, and a state record of the wrong type.
  it('does not confirm a Ref whose TEMPLATE resource is not a role, even if state says role', async () => {
    const st = stateWithPolicy({ Roles: ['q-role'] }, 'HandlerPolicyName', {
      X: role('q-role'),
    } as unknown as StackState['resources']);
    const p = await plan(
      st,
      { PolicyName: 'HandlerPolicyName', Roles: [{ Ref: 'X' }] },
      { X: { Type: 'AWS::SQS::Queue', Properties: {} } }
    );
    expect(p.blocked).toEqual([]);
    expect(p.recreateBeforePhase2[0]!.unconfirmedPrincipals).toEqual([{ kind: 'role', name: 'q-role' }]);
  });

  it('does not confirm a Ref whose STATE record is not a role, even if the template says role', async () => {
    const st = stateWithPolicy({ Roles: ['q-role'] }, 'HandlerPolicyName', {
      X: { ...role('q-role'), resourceType: 'AWS::SQS::Queue' },
    } as unknown as StackState['resources']);
    const p = await plan(
      st,
      { PolicyName: 'HandlerPolicyName', Roles: [{ Ref: 'X' }] },
      { X: { Type: 'AWS::IAM::Role', Properties: {} } }
    );
    expect(p.blocked).toEqual([]);
    expect(p.recreateBeforePhase2[0]!.unconfirmedPrincipals).toEqual([{ kind: 'role', name: 'q-role' }]);
  });

  it('checks a principal passed as a Parameter whose value cdkd knows', async () => {
    const parameters = { RoleParam: { Type: 'String' }, NameParam: { Type: 'String' } };
    const props = { PolicyName: { Ref: 'NameParam' }, Roles: [{ Ref: 'RoleParam' }] };
    const parameterValues = { RoleParam: 'RoleA', NameParam: 'HandlerPolicyName' };
    const ok = await plan(stateWithPolicy({ Roles: ['RoleA'] }), props, {}, {
      parameters,
      parameterValues,
    });
    expect(ok.blocked).toEqual([]);
    expect(ok.recreateBeforePhase2[0]!.unconfirmedPrincipals).toBeUndefined();
    expect(ok.recreateBeforePhase2[0]!.policyNameUnconfirmed).toBeUndefined();
    // An extra recorded principal is now BLOCKED, not merely marked.
    const extra = await plan(stateWithPolicy({ Roles: ['RoleA', 'AdminRole'] }), props, {}, {
      parameters,
      parameterValues,
    });
    expect(extra.blocked[0]!.reason).toContain('role AdminRole, which the template does not name');
    // The root's values come from --parameter / Default, so a wrong one is named
    // as a cause too (only when the caller says they do).
    expect(extra.blocked[0]!.reason).not.toContain('--parameter');
    const fromCli = await plan(stateWithPolicy({ Roles: ['RoleA', 'AdminRole'] }), props, {}, {
      parameters,
      parameterValues,
      parametersFromCli: true,
    });
    expect(fromCli.blocked[0]!.reason).toMatch(
      /the deploy; or, if the stack was deployed with other values, re-run the export with the --parameter values the stack was deployed with$/
    );
    // ...and for a policy NAME read through a Parameter.
    const renamed = await plan(stateWithPolicy({ Roles: ['RoleA'] }), props, {}, {
      parameters,
      parameterValues: { RoleParam: 'RoleA', NameParam: 'OtherName' },
      parametersFromCli: true,
    });
    expect(renamed.blocked[0]!.reason).toContain("is not the template's PolicyName OtherName");
    expect(renamed.blocked[0]!.reason).toContain('re-run the export with the --parameter values');
    // A mismatch that no Parameter took part in gets no such hint.
    const literal = await plan(
      stateWithPolicy({ Roles: ['RoleA', 'AdminRole'] }),
      { PolicyName: 'HandlerPolicyName', Roles: ['RoleA'] },
      {},
      { parametersFromCli: true }
    );
    expect(literal.blocked[0]!.reason).toContain('role AdminRole, which the template does not name');
    expect(literal.blocked[0]!.reason).not.toContain('--parameter');
  });

  it('names a plain stack in the diff and deploy, and leaves a hole for any other', async () => {
    const mismatch = (rootStackName: string) =>
      plan(
        stateWithPolicy({ Roles: ['RoleA', 'AdminRole'] }),
        { PolicyName: 'HandlerPolicyName', Roles: ['RoleA'] },
        {},
        { rootStackName }
      );
    const plain = (await mismatch('AppStack')).blocked[0]!;
    expect(plain.checkFirst).toBe('cdkd diff AppStack');
    expect(plain.repair).toBe('cdkd deploy AppStack');
    const odd = (await mismatch('App Stack;rm')).blocked[0]!;
    expect(odd.checkFirst).toBe(DIFF_FIRST);
    expect(odd.repair).toBe(DEPLOY_REPAIR);
  });

  it('reads a Ref as a Parameter only when the template DECLARES that parameter', async () => {
    // A submitted value for an undeclared key must not shadow the template
    // role the Ref names: X is a Role recorded as RoleA, so the check confirms
    // RoleA and does not block on the stray 'Other'.
    const st = stateWithPolicy({ Roles: ['RoleA'] }, 'HandlerPolicyName', {
      X: role('RoleA'),
    } as unknown as StackState['resources']);
    const p = await plan(
      st,
      { PolicyName: 'HandlerPolicyName', Roles: [{ Ref: 'X' }] },
      { X: { Type: 'AWS::IAM::Role', Properties: {} } },
      { parameterValues: { X: 'Other' } }
    );
    expect(p.blocked).toEqual([]);
    expect(p.recreateBeforePhase2[0]!.unconfirmedPrincipals).toBeUndefined();
  });

  it('does not read an SSM-typed Parameter value as a principal or policy name', async () => {
    const p = await plan(
      stateWithPolicy({ Roles: ['RealRole'] }),
      { PolicyName: { Ref: 'NameParam' }, Roles: [{ Ref: 'RoleParam' }] },
      {},
      {
        parameters: {
          RoleParam: { Type: 'AWS::SSM::Parameter::Value<String>' },
          NameParam: { Type: 'AWS::SSM::Parameter::Value<String>' },
        },
        parameterValues: { RoleParam: '/app/role', NameParam: '/app/policy' },
      }
    );
    // Not a false "not named" block: both are unconfirmed, i.e. marked.
    expect(p.blocked).toEqual([]);
    const entry = p.recreateBeforePhase2[0]!;
    expect(entry.unconfirmedPrincipals).toEqual([{ kind: 'role', name: 'RealRole' }]);
    expect(entry.policyNameUnconfirmed).toBe(true);
  });

  it('splits a list-typed Parameter as CloudFormation does', async () => {
    const p = await plan(
      stateWithPolicy({ Roles: ['RoleA', 'RoleB'] }),
      { PolicyName: 'HandlerPolicyName', Roles: { Ref: 'RolesParam' } },
      {},
      {
        parameters: { RolesParam: { Type: 'CommaDelimitedList' } },
        parameterValues: { RolesParam: 'RoleA, RoleB' },
      }
    );
    expect(p.blocked).toEqual([]);
    expect(p.recreateBeforePhase2[0]!.unconfirmedPrincipals).toBeUndefined();
  });

  it('marks, never blocks, a policy whose principal or name cannot be resolved', async () => {
    // No mode blocks a mark (go-to-k/cdkd#3910): --yes and --dry-run keep
    // working for a legitimate app that names a role through Fn::ImportValue.
    const unresolved = await plan(
      stateWithPolicy({ Roles: ['CrossStackRole'] }),
      { Roles: [{ 'Fn::ImportValue': 'Shared' }] },
      {}
    );
    expect(unresolved.blocked).toEqual([]);
    const entry = unresolved.recreateBeforePhase2[0]!;
    expect(entry.unconfirmedPrincipals).toEqual([{ kind: 'role', name: 'CrossStackRole' }]);
    expect(entry.policyNameUnconfirmed).toBe(true);
  });

  it('refuses a legacy policyName:roleName id whose record has an EMPTY list, as the provider does', async () => {
    // `Roles: []` is a recorded list, so the id's role is not used.
    const p = await plan(stateWithPolicy({ Roles: [] }, 'Pol:RoleX'), {
      PolicyName: 'Pol',
      Roles: ['RoleX'],
    });
    expect(p.recreateBeforePhase2).toEqual([]);
    expect(p.blocked[0]!.reason).toContain('no Roles/Users/Groups attachment is recorded');
  });

  it('does not take a legacy role that is not an IAM name', async () => {
    const p = await plan(stateWithPolicy({}, 'HandlerPolicyName:not a name'), { Roles: [] });
    expect(p.blocked[0]!.reason).toContain('no Roles/Users/Groups attachment is recorded');
  });
});

describe('blockedMigrationTail scopes the generic remedy to the rows without their own (go-to-k/cdkd#3910)', () => {
  const row = (logicalId: string, repair?: string) => ({
    logicalId,
    resourceType: 'AWS::IAM::Policy',
    reason: 'r',
    ...(repair !== undefined && { repair }),
  });

  it('points only at the Repair with: commands when every row has one', () => {
    const tail = blockedMigrationTail([row('A', 'cmd'), row('B', 'cmd')]);
    expect(tail).toBe("Run each row's 'Repair with:' command, then re-run cdkd export.");
    expect(tail).not.toContain('destroy');
  });

  it('keeps the generic remedy when no row has one', () => {
    expect(blockedMigrationTail([row('A')])).toMatch(/^Either destroy them first/);
  });

  it('scopes the generic remedy to the rows without one when mixed', () => {
    expect(blockedMigrationTail([row('A', 'cmd'), row('B')])).toBe(
      "Run each 'Repair with:' command given; for the resources with a reason that has neither, " +
        'either destroy them first (cdkd destroy / cdkd state destroy cherry-picked), or remove ' +
        'them from the CDK app and re-synthesize.'
    );
  });

  it('says each part once when repaired, manual and generic rows mix', () => {
    const manual = { ...row('M'), manual: true as const };
    expect(blockedMigrationTail([row('A', 'cmd'), manual, row('B')])).toBe(
      "Run each 'Repair with:' command given; resolve each row that names its own check as it " +
        'says — destroying or removing that resource is not a remedy, since it would perform ' +
        'the very removal the row refuses; for the resources with a reason that has neither, ' +
        'either destroy them first (cdkd destroy / cdkd state destroy cherry-picked), or remove ' +
        'them from the CDK app and re-synthesize.'
    );
  });

  it('lets a manual reason win for its resource over a generic one', () => {
    const manual = { ...row('A'), manual: true as const };
    const tail = blockedMigrationTail([manual, row('A')]);
    expect(tail).not.toContain('destroy them first');
    expect(tail).toMatch(/^Resolve each row that names its own check as it says/);
  });

  it('treats a resource with a repaired AND a manual reason as manual only', () => {
    expect(blockedMigrationTail([row('A', 'cmd'), { ...row('A'), manual: true as const }])).toBe(
      'Resolve each row that names its own check as it says — destroying or removing that ' +
        'resource is not a remedy, since it would perform the very removal the row refuses.'
    );
  });

  it('counts a resource with a reason that has no repair as one the generic remedy covers', () => {
    // The same resource with a repaired and an unrepaired reason is NOT fixed
    // by the repair alone.
    expect(blockedMigrationTail([row('A', 'cmd'), row('A')])).toMatch(/^Either destroy/);
  });
});

describe('preDeleteManualCommands names a by-hand delete per type present (go-to-k/cdkd#3910)', () => {
  const STAGE =
    "aws apigatewayv2 delete-stage --api-id '<ApiId>' --stage-name '<StageName>'";
  const ROLE =
    "aws iam delete-role-policy --role-name '<RoleName>' --policy-name '<PolicyName>'";
  const USER =
    "aws iam delete-user-policy --user-name '<UserName>' --policy-name '<PolicyName>'";
  const GROUP =
    "aws iam delete-group-policy --group-name '<GroupName>' --policy-name '<PolicyName>'";
  // A shell comment, so pasting it with the commands runs nothing.
  const NOTE =
    '# run each iam line once per listed principal still attached: a partial pre-delete may ' +
    'already have removed some';
  const policyEntry = (properties: Record<string, unknown>) => ({
    resourceType: 'AWS::IAM::Policy',
    physicalId: 'P',
    properties,
  });

  it('gives only the Stage command for a Stage', () => {
    expect(preDeleteManualCommands([{ resourceType: 'AWS::ApiGatewayV2::Stage' }])).toEqual([STAGE]);
  });

  it('gives one pasteable iam line per recorded principal kind, then the note on its own line', () => {
    expect(preDeleteManualCommands([policyEntry({ Roles: ['r'], Groups: ['g'] })])).toEqual([
      ROLE,
      GROUP,
      NOTE,
    ]);
    expect(preDeleteManualCommands([policyEntry({ Users: ['u'] })])).toEqual([USER, NOTE]);
  });

  it('gives every kind when a record is unreadable', () => {
    expect(preDeleteManualCommands([policyEntry({ Roles: 'x' })])).toEqual([ROLE, USER, GROUP, NOTE]);
  });

  it('gives one line per type and kind, once each', () => {
    expect(
      preDeleteManualCommands([
        policyEntry({ Roles: ['a'] }),
        { resourceType: 'AWS::ApiGatewayV2::Stage' },
        policyEntry({ Roles: ['b'] }),
      ])
    ).toEqual([STAGE, ROLE, NOTE]);
  });
});
