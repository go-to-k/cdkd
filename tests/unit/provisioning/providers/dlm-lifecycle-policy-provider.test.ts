import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-dlm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dlm')>();
  return {
    ...actual,
    DLMClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { DLMLifecyclePolicyProvider } from '../../../../src/provisioning/providers/dlm-lifecycle-policy-provider.js';
import {
  CreateLifecyclePolicyCommand,
  UpdateLifecyclePolicyCommand,
  DeleteLifecyclePolicyCommand,
  GetLifecyclePolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dlm';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::DLM::LifecyclePolicy';
const POLICY_ID = 'policy-0123456789abcdef0';
const POLICY_ARN = `arn:aws:dlm:us-east-1:123456789012:policy/${POLICY_ID}`;

const POLICY_DETAILS = {
  PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
  ResourceTypes: ['VOLUME'],
  TargetTags: [{ Key: 'dlm', Value: 'true' }],
  Schedules: [
    {
      Name: 'Daily',
      CreateRule: { Interval: 24, IntervalUnit: 'HOURS', Times: ['03:00'] },
      RetainRule: { Count: 3 },
    },
  ],
};

function notFound(): ResourceNotFoundException {
  return new ResourceNotFoundException({
    message: 'Policy not found',
    $metadata: {},
  });
}

/** Route mockSend by command class; each entry maps a command name to a response. */
function routeSend(routes: Record<string, unknown>): void {
  mockSend.mockImplementation((command: object) => {
    const name = command.constructor.name;
    if (name in routes) {
      const value = routes[name];
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value);
    }
    return Promise.reject(new Error(`Unexpected command: ${name}`));
  });
}

function callsOf(commandClass: abstract new (...args: never[]) => object): object[] {
  return mockSend.mock.calls.map((c) => c[0] as object).filter((c) => c instanceof commandClass);
}

describe('DLMLifecyclePolicyProvider create', () => {
  let provider: DLMLifecyclePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DLMLifecyclePolicyProvider();
  });

  it('sends CreateLifecyclePolicy with the CFn fields mapped 1:1 and Tags converted to a map', async () => {
    routeSend({
      CreateLifecyclePolicyCommand: { PolicyId: POLICY_ID },
      GetLifecyclePolicyCommand: { Policy: { PolicyId: POLICY_ID, PolicyArn: POLICY_ARN } },
    });

    const result = await provider.create('MyPolicy', RESOURCE_TYPE, {
      Description: 'daily snapshots',
      ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm-role',
      State: 'ENABLED',
      PolicyDetails: POLICY_DETAILS,
      Tags: [
        { Key: 'env', Value: 'test' },
        { Key: 'team', Value: 'infra' },
      ],
    });

    expect(result.physicalId).toBe(POLICY_ID);
    expect(result.attributes).toEqual({ Arn: POLICY_ARN });

    const [create] = callsOf(CreateLifecyclePolicyCommand) as Array<{
      input: Record<string, unknown>;
    }>;
    expect(create.input).toEqual({
      Description: 'daily snapshots',
      ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm-role',
      State: 'ENABLED',
      PolicyDetails: POLICY_DETAILS,
      Tags: { env: 'test', team: 'infra' },
    });
  });

  it('omits Tags when the template has none and forwards default-policy shorthand fields', async () => {
    routeSend({
      CreateLifecyclePolicyCommand: { PolicyId: POLICY_ID },
      GetLifecyclePolicyCommand: { Policy: { PolicyId: POLICY_ID, PolicyArn: POLICY_ARN } },
    });

    await provider.create('MyPolicy', RESOURCE_TYPE, {
      State: 'ENABLED',
      DefaultPolicy: 'VOLUME',
      CreateInterval: 1,
      RetainInterval: 7,
      CopyTags: true,
      ExtendDeletion: false,
      CrossRegionCopyTargets: [{ TargetRegion: 'us-west-2' }],
      Exclusions: { ExcludeBootVolumes: true },
    });

    const [create] = callsOf(CreateLifecyclePolicyCommand) as Array<{
      input: Record<string, unknown>;
    }>;
    expect(create.input).toEqual({
      State: 'ENABLED',
      DefaultPolicy: 'VOLUME',
      CreateInterval: 1,
      RetainInterval: 7,
      CopyTags: true,
      ExtendDeletion: false,
      CrossRegionCopyTargets: [{ TargetRegion: 'us-west-2' }],
      Exclusions: { ExcludeBootVolumes: true },
    });
    expect(create.input).not.toHaveProperty('Tags');
  });

  it('does NOT fail the create when the post-create ARN fetch fails (no duplicate on retry)', async () => {
    // A throw here would surface as a retryable ProvisioningError and the
    // engine's outer withRetry would re-invoke create() — minting a SECOND
    // policy (DLM has no idempotency token). The fetch is best-effort.
    routeSend({
      CreateLifecyclePolicyCommand: { PolicyId: POLICY_ID },
      GetLifecyclePolicyCommand: new Error('ThrottlingException'),
    });

    const result = await provider.create('MyPolicy', RESOURCE_TYPE, { State: 'ENABLED' });

    expect(result.physicalId).toBe(POLICY_ID);
    expect(result.attributes).toEqual({});
  });

  it('wraps create failures in ProvisioningError', async () => {
    routeSend({ CreateLifecyclePolicyCommand: new Error('boom') });

    await expect(provider.create('MyPolicy', RESOURCE_TYPE, { State: 'ENABLED' })).rejects.toThrow(
      ProvisioningError
    );
  });

  it('fails when CreateLifecyclePolicy returns no PolicyId', async () => {
    routeSend({ CreateLifecyclePolicyCommand: {} });

    await expect(provider.create('MyPolicy', RESOURCE_TYPE, { State: 'ENABLED' })).rejects.toThrow(
      /did not return a PolicyId/
    );
  });
});

describe('DLMLifecyclePolicyProvider update', () => {
  let provider: DLMLifecyclePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DLMLifecyclePolicyProvider();
  });

  it('sends UpdateLifecyclePolicy with the policy fields (no Tags parameter)', async () => {
    routeSend({
      UpdateLifecyclePolicyCommand: {},
      GetLifecyclePolicyCommand: { Policy: { PolicyId: POLICY_ID, PolicyArn: POLICY_ARN } },
    });

    const result = await provider.update(
      'MyPolicy',
      POLICY_ID,
      RESOURCE_TYPE,
      { Description: 'new', State: 'DISABLED', PolicyDetails: POLICY_DETAILS },
      { Description: 'old', State: 'ENABLED', PolicyDetails: POLICY_DETAILS }
    );

    expect(result.physicalId).toBe(POLICY_ID);
    expect(result.wasReplaced).toBe(false);
    expect(result.attributes).toEqual({ Arn: POLICY_ARN });

    const [update] = callsOf(UpdateLifecyclePolicyCommand) as Array<{
      input: Record<string, unknown>;
    }>;
    expect(update.input).toEqual({
      PolicyId: POLICY_ID,
      Description: 'new',
      State: 'DISABLED',
      PolicyDetails: POLICY_DETAILS,
    });
    expect(update.input).not.toHaveProperty('Tags');
    expect(callsOf(TagResourceCommand)).toHaveLength(0);
    expect(callsOf(UntagResourceCommand)).toHaveLength(0);
  });

  it('applies tag diffs via TagResource / UntagResource', async () => {
    routeSend({
      UpdateLifecyclePolicyCommand: {},
      GetLifecyclePolicyCommand: { Policy: { PolicyId: POLICY_ID, PolicyArn: POLICY_ARN } },
      TagResourceCommand: {},
      UntagResourceCommand: {},
    });

    await provider.update(
      'MyPolicy',
      POLICY_ID,
      RESOURCE_TYPE,
      {
        State: 'ENABLED',
        Tags: [
          { Key: 'keep', Value: 'changed' },
          { Key: 'added', Value: 'new' },
        ],
      },
      {
        State: 'ENABLED',
        Tags: [
          { Key: 'keep', Value: 'original' },
          { Key: 'removed', Value: 'gone' },
        ],
      }
    );

    const [untag] = callsOf(UntagResourceCommand) as Array<{ input: Record<string, unknown> }>;
    expect(untag.input).toEqual({ ResourceArn: POLICY_ARN, TagKeys: ['removed'] });

    const [tag] = callsOf(TagResourceCommand) as Array<{ input: Record<string, unknown> }>;
    expect(tag.input).toEqual({
      ResourceArn: POLICY_ARN,
      Tags: { keep: 'changed', added: 'new' },
    });
  });

  it('removes ALL tags when the Tags property is dropped entirely (issue #981 regression class)', async () => {
    routeSend({
      UpdateLifecyclePolicyCommand: {},
      GetLifecyclePolicyCommand: { Policy: { PolicyId: POLICY_ID, PolicyArn: POLICY_ARN } },
      UntagResourceCommand: {},
    });

    await provider.update(
      'MyPolicy',
      POLICY_ID,
      RESOURCE_TYPE,
      { State: 'ENABLED' },
      {
        State: 'ENABLED',
        Tags: [
          { Key: 'a', Value: '1' },
          { Key: 'b', Value: '2' },
        ],
      }
    );

    const [untag] = callsOf(UntagResourceCommand) as Array<{ input: Record<string, unknown> }>;
    expect(untag.input).toEqual({ ResourceArn: POLICY_ARN, TagKeys: ['a', 'b'] });
    expect(callsOf(TagResourceCommand)).toHaveLength(0);
  });

  it('warns and skips tag operations when GetLifecyclePolicy returns no PolicyArn', async () => {
    routeSend({
      UpdateLifecyclePolicyCommand: {},
      GetLifecyclePolicyCommand: { Policy: { PolicyId: POLICY_ID } }, // no PolicyArn
    });

    const result = await provider.update(
      'MyPolicy',
      POLICY_ID,
      RESOURCE_TYPE,
      { State: 'ENABLED', Tags: [{ Key: 'a', Value: '1' }] },
      { State: 'ENABLED' }
    );

    // No tag calls were attempted (nothing to address them against) and the
    // update still succeeds — but never silently: the branch logs a warning.
    // The Arn attribute is omitted (not clobbered with '') so a previously
    // cached value in state survives.
    expect(callsOf(TagResourceCommand)).toHaveLength(0);
    expect(callsOf(UntagResourceCommand)).toHaveLength(0);
    expect(result.attributes).toEqual({});
  });

  it('rejects a DefaultPolicy transition from unset to set with ResourceUpdateNotSupportedError', async () => {
    await expect(
      provider.update(
        'MyPolicy',
        POLICY_ID,
        RESOURCE_TYPE,
        { State: 'ENABLED', DefaultPolicy: 'VOLUME' },
        { State: 'ENABLED' }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a DefaultPolicy change with ResourceUpdateNotSupportedError', async () => {
    await expect(
      provider.update(
        'MyPolicy',
        POLICY_ID,
        RESOURCE_TYPE,
        { State: 'ENABLED', DefaultPolicy: 'INSTANCE' },
        { State: 'ENABLED', DefaultPolicy: 'VOLUME' }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('wraps update failures in ProvisioningError', async () => {
    routeSend({ UpdateLifecyclePolicyCommand: new Error('boom') });

    await expect(
      provider.update('MyPolicy', POLICY_ID, RESOURCE_TYPE, { State: 'ENABLED' }, {})
    ).rejects.toThrow(ProvisioningError);
  });
});

describe('DLMLifecyclePolicyProvider delete', () => {
  let provider: DLMLifecyclePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DLMLifecyclePolicyProvider();
  });

  it('sends DeleteLifecyclePolicy with the policy id', async () => {
    routeSend({ DeleteLifecyclePolicyCommand: {} });

    await provider.delete('MyPolicy', POLICY_ID, RESOURCE_TYPE);

    const [del] = callsOf(DeleteLifecyclePolicyCommand) as Array<{
      input: Record<string, unknown>;
    }>;
    expect(del.input).toEqual({ PolicyId: POLICY_ID });
  });

  it('treats NotFound as idempotent success when the region matches', async () => {
    routeSend({ DeleteLifecyclePolicyCommand: notFound() });

    await expect(
      provider.delete('MyPolicy', POLICY_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('refuses to swallow NotFound when the client region mismatches the state region', async () => {
    routeSend({ DeleteLifecyclePolicyCommand: notFound() });

    await expect(
      provider.delete('MyPolicy', POLICY_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'eu-west-1',
      })
    ).rejects.toThrow(ProvisioningError);
  });

  it('wraps other delete failures in ProvisioningError', async () => {
    routeSend({ DeleteLifecyclePolicyCommand: new Error('boom') });

    await expect(provider.delete('MyPolicy', POLICY_ID, RESOURCE_TYPE)).rejects.toThrow(
      ProvisioningError
    );
  });
});

describe('DLMLifecyclePolicyProvider getAttribute', () => {
  let provider: DLMLifecyclePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DLMLifecyclePolicyProvider();
  });

  it('resolves Arn via GetLifecyclePolicy', async () => {
    routeSend({
      GetLifecyclePolicyCommand: { Policy: { PolicyId: POLICY_ID, PolicyArn: POLICY_ARN } },
    });

    await expect(provider.getAttribute(POLICY_ID, RESOURCE_TYPE, 'Arn')).resolves.toBe(POLICY_ARN);
  });

  it('returns the physicalId for Id / PolicyId without an API call', async () => {
    await expect(provider.getAttribute(POLICY_ID, RESOURCE_TYPE, 'Id')).resolves.toBe(POLICY_ID);
    await expect(provider.getAttribute(POLICY_ID, RESOURCE_TYPE, 'PolicyId')).resolves.toBe(
      POLICY_ID
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('wraps Arn lookup failures in ProvisioningError', async () => {
    routeSend({ GetLifecyclePolicyCommand: new Error('boom') });

    await expect(provider.getAttribute(POLICY_ID, RESOURCE_TYPE, 'Arn')).rejects.toThrow(
      ProvisioningError
    );
  });

  it('rejects unknown attributes', async () => {
    await expect(provider.getAttribute(POLICY_ID, RESOURCE_TYPE, 'Nope')).rejects.toThrow(
      /Unknown attribute/
    );
  });
});

describe('DLMLifecyclePolicyProvider readCurrentState / drift', () => {
  let provider: DLMLifecyclePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DLMLifecyclePolicyProvider();
  });

  it('surfaces Description / State / ExecutionRoleArn / Tags in CFn shape', async () => {
    routeSend({
      GetLifecyclePolicyCommand: {
        Policy: {
          PolicyId: POLICY_ID,
          Description: 'daily snapshots',
          State: 'ENABLED',
          ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm-role',
          PolicyDetails: POLICY_DETAILS,
          Tags: { env: 'test', 'aws:internal': 'filtered' },
          PolicyArn: POLICY_ARN,
        },
      },
    });

    const state = await provider.readCurrentState(POLICY_ID, 'MyPolicy', RESOURCE_TYPE);

    expect(state).toEqual({
      Description: 'daily snapshots',
      State: 'ENABLED',
      ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm-role',
      Tags: [{ Key: 'env', Value: 'test' }],
    });
    // PolicyDetails is deliberately not surfaced — the service normalizes it
    // and positional array comparison would fire phantom drift.
    expect(state).not.toHaveProperty('PolicyDetails');
  });

  it('returns undefined when the policy is gone', async () => {
    routeSend({ GetLifecyclePolicyCommand: notFound() });

    await expect(
      provider.readCurrentState(POLICY_ID, 'MyPolicy', RESOURCE_TYPE)
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the response carries no Policy', async () => {
    routeSend({ GetLifecyclePolicyCommand: {} });

    await expect(
      provider.readCurrentState(POLICY_ID, 'MyPolicy', RESOURCE_TYPE)
    ).resolves.toBeUndefined();
  });

  it('rethrows non-NotFound errors', async () => {
    routeSend({ GetLifecyclePolicyCommand: new Error('throttled') });

    await expect(provider.readCurrentState(POLICY_ID, 'MyPolicy', RESOURCE_TYPE)).rejects.toThrow(
      'throttled'
    );
  });

  it('declares the non-read-back paths as drift-unknown', () => {
    const paths = provider.getDriftUnknownPaths(RESOURCE_TYPE);
    expect(paths).toContain('PolicyDetails');
    expect(paths).toContain('CreateInterval');
    expect(paths).toContain('DefaultPolicy');
  });
});

describe('DLMLifecyclePolicyProvider import', () => {
  let provider: DLMLifecyclePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DLMLifecyclePolicyProvider();
  });

  function makeInput(
    overrides: Partial<{
      knownPhysicalId: string;
      properties: Record<string, unknown>;
    }> = {}
  ) {
    return {
      logicalId: 'MyPolicy',
      resourceType: RESOURCE_TYPE,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('explicit override: verifies via GetLifecyclePolicy and returns the physicalId + Arn', async () => {
    routeSend({
      GetLifecyclePolicyCommand: { Policy: { PolicyId: POLICY_ID, PolicyArn: POLICY_ARN } },
    });

    const result = await provider.import(makeInput({ knownPhysicalId: POLICY_ID }));

    expect(result).toEqual({ physicalId: POLICY_ID, attributes: { Arn: POLICY_ARN } });
  });

  it('explicit override: returns null when the policy does not exist', async () => {
    routeSend({ GetLifecyclePolicyCommand: notFound() });

    await expect(provider.import(makeInput({ knownPhysicalId: POLICY_ID }))).resolves.toBeNull();
  });

  it('explicit override: returns null when the response Policy has no PolicyId', async () => {
    routeSend({ GetLifecyclePolicyCommand: { Policy: {} } });

    await expect(provider.import(makeInput({ knownPhysicalId: POLICY_ID }))).resolves.toBeNull();
  });

  it('explicit override: rethrows non-NotFound errors', async () => {
    routeSend({ GetLifecyclePolicyCommand: new Error('access denied') });

    await expect(provider.import(makeInput({ knownPhysicalId: POLICY_ID }))).rejects.toThrow(
      'access denied'
    );
  });

  it('returns null without any AWS call when no override is supplied (no aws:cdk:path tag walk)', async () => {
    // The aws:cdk:path tag walk is gone (issue #1134): AWS rejects
    // aws:-prefixed tag writes, so the tag never exists on a real resource.
    // With no explicit override the provider resolves nothing and returns
    // null immediately — the import flow relies on --resource / CFn lookup.
    await expect(provider.import(makeInput())).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns null when there is no override and no cdkPath', async () => {
    const input = makeInput();
    await expect(provider.import({ ...input })).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
