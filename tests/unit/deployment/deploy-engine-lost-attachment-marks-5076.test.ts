/**
 * go-to-k/cdkd#5076: on a deploy that FAILS after re-creating a principal
 * under the same name, the lost-attachment rebuild of a child's record
 * (`executeDeployment`, the trimmed-record arms) used to spread its
 * `properties` into a new, unmarked object. The one child that reaches that
 * rebuild holding THIS pass's resolved bag is a Cloud Control child whose
 * update completed but sent nothing (it is dropped from `written`): its bag
 * is marked same-generation, and the spread lost the mark, so a 1-3
 * character secret embedded in a literal persisted in plaintext.
 *
 * Driven through `DeployEngine.deploy` with the REAL `DiffCalculator`,
 * `DagBuilder` and `IntrinsicFunctionResolver`; only the providers and the
 * Secrets Manager / STS clients are doubles.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import {
  clearRecordedSecretExpressions,
  isLeafCertifiedBag,
  isSameGenerationBag,
  markLeafCertifiedBag,
  markSameGenerationBag,
} from '../../../src/deployment/secret-redaction.js';
import { withPropertiesMarksOf } from '../../../src/deployment/deploy-engine/record-shape.js';
import {
  isWrittenFromDeployedTemplate,
  markWrittenFromDeployedTemplate,
} from '../../../src/deployment/masked-property-fingerprints.js';

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

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return { SecretString: JSON.stringify({ pin: 'x9' }), VersionId: 'v1' };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSTSClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return { Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/t', UserId: 'u' };
    }
    destroy(): void {}
  }
  return { ...actual, STSClient: FakeSTSClient };
});

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const PIN = '{{resolve:secretsmanager:pin:SecretString:pin}}';
const TAG_SOURCE = `pin=${PIN}`;

function record(
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  dependencies: string[] = [],
  provisionedBy: 'sdk' | 'cc-api' = 'sdk'
): ResourceState {
  return {
    physicalId,
    resourceType,
    properties,
    observedProperties: properties,
    attributes: {},
    dependencies,
    provisionedBy,
  } as ResourceState;
}

type Provider = Record<'create' | 'update' | 'delete' | 'getAttribute', ReturnType<typeof vi.fn>>;

function makeProvider(): Provider {
  return {
    create: vi.fn((logicalId: string) =>
      Promise.resolve({
        physicalId: logicalId === 'Group' ? 'fixed-group' : `${logicalId}-new`,
        attributes: {},
      })
    ),
    update: vi.fn((_logicalId: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false })
    ),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
}

describe('the lost-attachment rebuild keeps the record bag\'s marks (go-to-k/cdkd#5076)', () => {
  let sdk: Provider;
  let cc: Provider;
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    clearRecordedSecretExpressions();
    sdk = makeProvider();
    cc = makeProvider();
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-new') };
  });

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(sdk),
        getProviderFor: vi
          .fn()
          .mockImplementation((input: { provisionedBy?: 'sdk' | 'cc-api' }) =>
            input.provisionedBy === 'cc-api'
              ? { provider: cc, provisionedBy: 'cc-api' as const }
              : { provider: sdk, provisionedBy: 'sdk' as const }
          ),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      {
        dryRun: false,
        noRollback: true,
        recreateTargets: {
          stackName: 's',
          viaCcApi: new Set(['Group']),
          viaSdkProvider: new Set<string>(),
        },
      } as never,
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  function saved(id: string): ResourceState | undefined {
    const calls = stateBackend.saveState.mock.calls;
    return (calls[calls.length - 1]?.[2] as StackState | undefined)?.resources[id];
  }

  it('a Cloud Control child whose update sent nothing keeps its embedded short secret as its token', async () => {
    const tags = [{ Key: 'pin', Value: TAG_SOURCE }];
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: 's',
      resources: {
        Group: record('fixed-group', 'AWS::IAM::Group', { GroupName: 'fixed-group' }),
        Child: record(
          'member',
          'AWS::IAM::User',
          { UserName: 'member', Groups: ['fixed-group'], Tags: tags },
          ['Group'],
          'cc-api'
        ),
        Sib: record('sib', 'AWS::SSM::Parameter', { Name: 'sib', Type: 'String', Value: 'v1' }),
      },
      outputs: {},
      lastModified: 0,
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    cc.update.mockImplementation((_l: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false, sentNothing: true })
    );
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Sib'
        ? Promise.reject(new Error('ValidationException: forced sibling failure'))
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const template: CloudFormationTemplate = {
      Resources: {
        Group: { Type: 'AWS::IAM::Group', Properties: { GroupName: 'fixed-group' } },
        Child: {
          Type: 'AWS::IAM::User',
          Properties: { UserName: 'member', Groups: [{ Ref: 'Group' }], Tags: tags },
        },
        Sib: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'sib', Type: 'String', Value: 'v2' },
          DependsOn: ['Child'],
        },
      },
    };

    await expect(makeEngine().deploy('s', template)).rejects.toThrow();

    // The premise: the child's update ran on Cloud Control and the rebuild
    // trimmed its record.
    expect(cc.update.mock.calls.filter((c) => c[0] === 'Child')).toHaveLength(1);
    const child = saved('Child');
    expect(child?.properties['Groups']).toEqual([]);
    // The fix: the short secret persists as its reference, never `pin=x9`.
    expect((child?.properties['Tags'] as Array<{ Value: string }>)[0]!.Value).toBe(TAG_SOURCE);
    expect(JSON.stringify(stateBackend.saveState.mock.calls)).not.toContain('pin=x9');
  });

  it('the trimmed-holders arm: an inline policy still on another holder keeps its embedded short secret as its token', async () => {
    const policyName = `pol=${PIN}`;
    const doc = { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 's3:*', Resource: '*' }] };
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: 's',
      resources: {
        Group: record('fixed-group', 'AWS::IAM::Group', { GroupName: 'fixed-group' }),
        Child: record(
          'inline-pol',
          'AWS::IAM::Policy',
          {
            PolicyName: policyName,
            PolicyDocument: doc,
            Groups: ['fixed-group'],
            Roles: ['other-role'],
          },
          ['Group'],
          'cc-api'
        ),
        Sib: record('sib', 'AWS::SSM::Parameter', { Name: 'sib', Type: 'String', Value: 'v1' }),
      },
      outputs: {},
      lastModified: 0,
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    cc.update.mockImplementation((_l: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false, sentNothing: true })
    );
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Sib'
        ? Promise.reject(new Error('ValidationException: forced sibling failure'))
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const template: CloudFormationTemplate = {
      Resources: {
        Group: { Type: 'AWS::IAM::Group', Properties: { GroupName: 'fixed-group' } },
        Child: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyName: policyName,
            PolicyDocument: doc,
            Groups: [{ Ref: 'Group' }],
            Roles: ['other-role'],
          },
        },
        Sib: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'sib', Type: 'String', Value: 'v2' },
          DependsOn: ['Child'],
        },
      },
    };

    await expect(makeEngine().deploy('s', template)).rejects.toThrow();

    expect(cc.update.mock.calls.filter((c) => c[0] === 'Child')).toHaveLength(1);
    const child = saved('Child');
    // The premise: this arm (still held elsewhere), not the attachment one.
    expect(child?.properties['Groups']).toEqual([]);
    expect(child?.properties['Roles']).toEqual(['other-role']);
    expect(child?.properties['PolicyName']).toBe(policyName);
    expect(JSON.stringify(stateBackend.saveState.mock.calls)).not.toContain('pol=x9');
  });
});

describe('withPropertiesMarksOf carries exactly the marks the original carries', () => {
  const marksOf = (bag: object): string[] =>
    [
      isSameGenerationBag(bag) && 'same-generation',
      isLeafCertifiedBag(bag) && 'leaf-certified',
      isWrittenFromDeployedTemplate(bag) && 'written',
    ].filter((m): m is string => m !== false);

  it('each mark, alone', () => {
    const cases: Array<[string, (b: object) => object]> = [
      ['same-generation', markSameGenerationBag],
      ['leaf-certified', markLeafCertifiedBag],
      ['written', markWrittenFromDeployedTemplate],
    ];
    for (const [name, mark] of cases) {
      const rebuilt = withPropertiesMarksOf(mark({}), {});
      expect({ name, marks: marksOf(rebuilt) }).toEqual({ name, marks: [name] });
    }
  });

  it('never mints a mark the original lacks', () => {
    expect(marksOf(withPropertiesMarksOf({}, {}))).toEqual([]);
    expect(marksOf(withPropertiesMarksOf(undefined, {}))).toEqual([]);
  });
});
