/**
 * go-to-k/cdkd#6772: a `cdkd destroy` delete refusal that names a resource the
 * stack RETAINED masks that resource's secret-derived name.
 *
 * The role's refusal names the instance profiles still holding it. A profile
 * kept by `DeletionPolicy: Retain` whose name came from a
 * `{{resolve:secretsmanager:...}}` reference is in no bag of the role's own
 * (the role does not read the profile), so it printed, and was recorded in
 * the RESOURCE_FAILED event, in plaintext. The destroy now hands every delete
 * a stack-wide printing masker over every record's secret-derived names.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeleteConflictException } from '@aws-sdk/client-iam';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn((): unknown => logger),
  };
  return { getLogger: () => logger };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));
// The role's settle waits run at once (`setTimeout` below), which must not
// expire the per-resource deadline.
vi.mock('../../../src/deployment/resource-deadline.js', async () => ({
  ...(await vi.importActual('../../../src/deployment/resource-deadline.js')),
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';

const REGION = 'us-east-1';
const REF = '{{resolve:secretsmanager:team:SecretString:profile::}}';
const PROFILE = 'SECRET-profile';

function makeState(profileName: string, profileId: string): StackState {
  const role: ResourceState = {
    physicalId: 'my-role',
    resourceType: 'AWS::IAM::Role',
    properties: { AssumeRolePolicyDocument: {} },
    attributes: {},
    dependencies: [],
  };
  const profile = {
    physicalId: profileId,
    resourceType: 'AWS::IAM::InstanceProfile',
    properties: { InstanceProfileName: profileName, Roles: ['my-role'] },
    attributes: {},
    dependencies: ['Role'],
    deletionPolicy: 'Retain',
  } as ResourceState;
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: { Role: role, Profile: profile },
    outputs: {},
    lastModified: 1,
  };
}

function makeCtx(state: StackState, record: ReturnType<typeof vi.fn>) {
  const provider = new IAMRoleProvider();
  return {
    stateBackend: {
      saveState: vi.fn().mockResolvedValue('"etag"'),
      deleteState: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn(async () => ({ state, etag: 'e' })),
      listStacks: vi.fn().mockResolvedValue([]),
    } as unknown as S3StateBackend,
    lockManager: {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
    } as unknown as LockManager,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
      getProvider: () => provider,
    } as unknown as ProviderRegistry,
    baseAwsClients: {} as AwsClients,
    baseRegion: REGION,
    stateBucket: 'test-bucket',
    skipConfirmation: true,
    eventRecorder: { record: record as unknown as (event: unknown) => void },
  };
}

beforeEach(() => {
  mockSend.mockReset();
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
  // The retained profile still holds the role, so `DeleteRole` is refused.
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

/** The role's RESOURCE_FAILED event text. */
async function refusalOf(profileName: string): Promise<string> {
  const state = makeState(profileName, PROFILE);
  const record = vi.fn();
  const result = await runDestroyForStack('TestStack', state, makeCtx(state, record));
  expect(result.errorCount).toBe(1);
  const failed = record.mock.calls
    .map(([event]) => event as { eventType: string; logicalId?: string; error?: unknown })
    .filter((event) => event.eventType === 'RESOURCE_FAILED' && event.logicalId === 'Role');
  expect(failed).toHaveLength(1);
  return JSON.stringify(failed[0]!.error);
}

describe('cdkd destroy masks a retained sibling named in a refusal (go-to-k/cdkd#6772)', () => {
  it("masks a retained, secret-named profile in the role's refusal event", async () => {
    const text = await refusalOf(REF);
    // Premise: the refusal is the one naming the profile.
    expect(text).toContain('is still in instance profile(s) ***');
    expect(text).not.toContain(PROFILE);
    expect(text).not.toContain('SECRET');
  });

  it('negative control: a profile with an ordinary name is named as it is', async () => {
    const text = await refusalOf('plain-profile-name');
    expect(text).toContain(`is still in instance profile(s) ${PROFILE}`);
  });
});
