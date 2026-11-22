/**
 * go-to-k/cdkd#6772, the deploy side: a template that drops a role and the
 * `DeletionPolicy: Retain` instance profile holding it keeps the profile, and
 * the role's delete is refused naming it. The profile's name came from a
 * `{{resolve:secretsmanager:...}}` reference, and its record is gone from
 * `stateResources` by then, so only the records as the deploy found them
 * (`preDeploySecretNamedRecords`) still know it: the delete's stack-wide
 * printing masker (`stackSecretNameMasker`) masks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeleteConflictException } from '@aws-sdk/client-iam';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
import {
  SecretsRunState,
  stackSecretNameMasker,
} from '../../../src/deployment/deploy-engine/masking.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { replacementDeleteContext } from '../../../src/deployment/deploy-engine/replacement/delete-context.js';
import { secretNamedRecordNeedles } from '../../../src/deployment/secret-name-needles.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));
vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const REF = '{{resolve:secretsmanager:team:SecretString:profile::}}';
const PROFILE = 'SECRET-profile';

beforeEach(() => {
  mockSend.mockReset();
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
  // The kept profile still holds the role, so `DeleteRole` is refused.
  mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'GetRoleCommand':
        return { Role: { RoleName: 'my-role' } };
      case 'GetInstanceProfileCommand':
        return { InstanceProfile: { Roles: [{ RoleName: 'my-role' }] } };
      case 'ListAttachedRolePoliciesCommand':
        return { AttachedPolicies: [] };
      case 'ListRolePoliciesCommand':
        return { PolicyNames: [] };
      case 'ListInstanceProfilesForRoleCommand':
        return { InstanceProfiles: [{ InstanceProfileName: PROFILE }] };
      case 'DeleteRoleCommand':
        throw new DeleteConflictException({
          $metadata: {},
          message: 'Cannot delete entity, must remove roles from instance profile first.',
        });
      default:
        return {};
    }
  });
});

function engine(): InstanceType<typeof DeployEngine> {
  const provider = new IAMRoleProvider();
  const registry = {
    getProvider: vi.fn().mockReturnValue(provider),
    getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
    getRegisteredTypes: vi.fn().mockReturnValue([]),
    validateResourceTypes: vi.fn(),
    validateResourceProperties: vi.fn(),
  };
  return new DeployEngine(
    {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag'),
      loadCreateTokenLedger: vi.fn().mockResolvedValue(null),
      saveCreateTokenLedger: vi.fn().mockResolvedValue(undefined),
      loadRetainedRecord: vi.fn(async () => []),
      saveRetainedResources: vi.fn(async () => undefined),
    } as unknown as never,
    { acquireLockWithRetry: vi.fn(), releaseLock: vi.fn() } as unknown as never,
    { buildGraph: vi.fn(), getExecutionLevels: vi.fn(), getDirectDependencies: vi.fn() } as unknown as never,
    { calculateDiff: vi.fn(), hasChanges: vi.fn(), filterByType: vi.fn() } as unknown as never,
    registry as unknown as never,
    {},
    'us-east-1'
  );
}

/** The role delete's refusal, after the profile's Retain removal. */
async function roleRefusal(profileName: string): Promise<string> {
  const e = engine();
  const stateResources: Record<string, ResourceState> = {
    Role: {
      physicalId: 'my-role',
      resourceType: 'AWS::IAM::Role',
      properties: {},
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    },
    Profile: {
      physicalId: PROFILE,
      resourceType: 'AWS::IAM::InstanceProfile',
      properties: { InstanceProfileName: profileName, Roles: ['my-role'] },
      attributes: {},
      dependencies: ['Role'],
      deletionPolicy: 'Retain',
      provisionedBy: 'sdk',
    } as ResourceState,
  };
  const remove = (id: string, type: string) =>
    provisionResource(
      e,
      id,
      { logicalId: id, changeType: 'DELETE', resourceType: type, currentProperties: {} } as ResourceChange,
      stateResources,
      'MyStack',
      { Resources: {} }
    );
  let refusal: unknown;
  (e as unknown as { doDeploy: () => Promise<unknown> }).doDeploy = async () => {
    // As the deploy flow judges them before anything provisions.
    e.secretsRun.preDeploySecretNamedRecords = secretNamedRecordNeedles(stateResources, undefined);
    await remove('Profile', 'AWS::IAM::InstanceProfile');
    // Premise: the kept profile's record is gone before the role's delete.
    expect(stateResources['Profile']).toBeUndefined();
    refusal = await remove('Role', 'AWS::IAM::Role').then(
      () => undefined,
      (error: unknown) => error
    );
    return {};
  };
  await e.deploy('MyStack', { Resources: {} } as CloudFormationTemplate);
  expect(refusal).toBeInstanceOf(Error);
  // The engine's wrap names the resource; the provider's refusal is its cause.
  const chain: string[] = [];
  for (let link: unknown = refusal; link instanceof Error; link = link.cause) {
    chain.push(link.message);
  }
  return chain.join('\n');
}

describe("a deploy's removal refusal masks a kept sibling's secret-derived name (go-to-k/cdkd#6772)", () => {
  it("masks the Retain profile in the role's refusal", async () => {
    const message = await roleRefusal(REF);
    expect(message).toContain('is still in instance profile(s) ***');
    expect(message).not.toContain('SECRET');
  });

  it('negative control: a profile with an ordinary name is named as it is', async () => {
    const message = await roleRefusal('plain-profile-name');
    expect(message).toContain(`is still in instance profile(s) ${PROFILE}`);
  });
});

describe('stackSecretNameMasker (go-to-k/cdkd#6772)', () => {
  it('masks a pre-deploy record needle and a registry needle, read at each call', () => {
    const run = new SecretsRunState();
    const before = new Map();
    recordLogOnlyValue(before, 'kept-secret-name');
    run.preDeploySecretNamedRecords = before;
    const mask = stackSecretNameMasker(run);
    expect(mask('a kept-secret-name b')).toBe('a *** b');
    // A needle the run registers AFTER the masker was built is masked too.
    const registry = new Map();
    recordLogOnlyValue(registry, 'resolved-this-run');
    run.secretNameNeedles.set('Later', registry);
    expect(mask('x resolved-this-run kept-secret-name')).toBe('x *** ***');
    // Negative control: an ordinary word is left as it is.
    expect(mask('plain-profile-name')).toBe('plain-profile-name');
  });

  it('masks overlapping needles of different bags in one pass (go-to-k/cdkd#4049)', () => {
    const run = new SecretsRunState();
    const names = new Map();
    recordLogOnlyValue(names, 'team-secret');
    run.preDeploySecretNamedRecords = names;
    const own = new Map();
    recordLogOnlyValue(own, 'secret-profile');
    run.secretNameNeedles.set('Role', own);
    expect(stackSecretNameMasker(run)('name team-secret-profile end')).toBe('name *** end');
  });
});

describe("a replacement's delete takes the stack-wide printing masker (go-to-k/cdkd#6772)", () => {
  it('replacementDeleteContext hands it over the run', () => {
    const run = new SecretsRunState();
    const kept = new Map();
    recordLogOnlyValue(kept, 'kept-secret-name');
    run.preDeploySecretNamedRecords = kept;
    const context = replacementDeleteContext(
      { options: {}, secretsRun: () => run } as unknown as Parameters<typeof replacementDeleteContext>[0],
      undefined
    );
    expect(context.maskStackSecretNames('profile kept-secret-name')).toBe('profile ***');
  });
});
