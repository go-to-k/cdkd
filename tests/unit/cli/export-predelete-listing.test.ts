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
  buildImportPlan,
  invokePreDeleteHandler,
  preDeleteListingLines,
  runPerStackImportLoop,
  type CdkdStateStackTree,
  type RecreateBeforePhase2Entry,
} from '../../../src/cli/commands/export.js';
import type { StackState } from '../../../src/types/state.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';

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

  it('caps each kind and counts the rest', () => {
    const roles = Array.from({ length: 25 }, (_, i) => `Role${i}`);
    const line = preDeleteListingLines(policy({ Roles: roles }))[1]!;
    expect(line).toContain('Role19 and 5 more');
    expect(line).not.toContain('Role20');
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
    expect(line).toContain("record the policy's Roles, Users or Groups in its cdkd state record");
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
        physicalId: '$default',
        properties: { ApiId: 'a1', Roles: ['NotARealField'] },
      })
    ).toEqual(['Stage (AWS::ApiGatewayV2::Stage) — physicalId: $default']);
  });
});

/**
 * The HANDLER refuses exactly what the plan shows as a refusal, before any
 * AWS call: one predicate decides both.
 */
describe('the IAM::Policy pre-delete refuses what the plan shows as a refusal', () => {
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
    const at = lines.findIndex((l) => l.startsWith('  [Root] → CFn stack'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines.slice(at + 1, at + 3)).toEqual([
      `    ${HEAD}`,
      '      removes inline policy HandlerPolicyName from roles: RoleA, RoleB',
    ]);
  });
});

/**
 * A pre-delete that would refuse is BLOCKED at plan time, so the export stops
 * before the lock and before phase 1 rather than between phases.
 */
describe('buildImportPlan blocks an IAM::Policy whose pre-delete would refuse', () => {
  const cfnClient = {
    send: vi.fn(async () => {
      throw new Error('no schema');
    }),
  } as unknown as AwsClients['cloudFormation'];

  function stateWithPolicy(properties: Record<string, unknown>): StackState {
    return {
      version: 9,
      stackName: 'S',
      region: 'us-east-1',
      resources: {
        HandlerPolicy: {
          physicalId: 'HandlerPolicyName',
          resourceType: 'AWS::IAM::Policy',
          properties,
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 1,
    } as unknown as StackState;
  }
  const template = { Resources: { HandlerPolicy: { Type: 'AWS::IAM::Policy', Properties: {} } } };

  it('blocks it, with the refusal as the reason', async () => {
    const plan = await buildImportPlan(stateWithPolicy({ Roles: 'RoleA' }), template, cfnClient, 'S', {
      recreateImportUnsupported: true,
      skipImportSupportPreflight: true,
    });
    expect(plan.recreateBeforePhase2).toEqual([]);
    expect(plan.blocked).toEqual([
      {
        logicalId: 'HandlerPolicy',
        resourceType: 'AWS::IAM::Policy',
        reason:
          'the pre-delete of this inline policy would refuse: its recorded properties.Roles is ' +
          'not a list of role names (found string)',
      },
    ]);
  });

  it('keeps a valid one on the pre-delete path', async () => {
    const plan = await buildImportPlan(
      stateWithPolicy({ Roles: ['RoleA'] }),
      template,
      cfnClient,
      'S',
      { recreateImportUnsupported: true, skipImportSupportPreflight: true }
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.recreateBeforePhase2.map((r) => r.logicalId)).toEqual(['HandlerPolicy']);
  });
});
