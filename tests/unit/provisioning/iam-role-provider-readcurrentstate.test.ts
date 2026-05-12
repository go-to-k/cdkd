import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetRoleCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  ListRoleTagsCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
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

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';

describe('IAMRoleProvider.readCurrentState', () => {
  let provider: IAMRoleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMRoleProvider();
  });

  it('returns CFn-shaped properties (URL-decoded AssumeRolePolicyDocument + ManagedPolicyArns)', async () => {
    const assumeDoc = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    };

    // GetRole — note AssumeRolePolicyDocument is URL-encoded JSON like AWS returns.
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'my-role',
        Description: 'a role',
        MaxSessionDuration: 3600,
        Path: '/',
        PermissionsBoundary: { PermissionsBoundaryArn: 'arn:aws:iam::aws:policy/AdminBoundary' },
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(assumeDoc)),
        // AWS-managed fields the comparator should ignore (still safe to surface
        // since they don't appear in state, but our impl filters them anyway):
        Arn: 'arn:aws:iam::123:role/my-role',
        RoleId: 'AROA...',
        CreateDate: new Date(0),
      },
    });
    // ListAttachedRolePolicies
    mockSend.mockResolvedValueOnce({
      AttachedPolicies: [
        { PolicyArn: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess', PolicyName: 's3' },
        { PolicyArn: 'arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole', PolicyName: 'lambda' },
      ],
    });
    // ListRolePolicies — no inline policies
    mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });
    // ListRoleTags — no user tags
    mockSend.mockResolvedValueOnce({ Tags: [], IsTruncated: false });

    const result = await provider.readCurrentState('my-role', 'Logical', 'AWS::IAM::Role');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetRoleCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListAttachedRolePoliciesCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListRolePoliciesCommand);
    expect(mockSend.mock.calls[3]?.[0]).toBeInstanceOf(ListRoleTagsCommand);
    expect(result).toEqual({
      RoleName: 'my-role',
      Description: 'a role',
      MaxSessionDuration: 3600,
      Path: '/',
      PermissionsBoundary: 'arn:aws:iam::aws:policy/AdminBoundary',
      AssumeRolePolicyDocument: assumeDoc,
      ManagedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
        'arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole',
      ],
      Policies: [],
      Tags: [],
    });
  });

  it('returns undefined when role does not exist', async () => {
    mockSend.mockRejectedValueOnce(
      new NoSuchEntityException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState('my-role', 'Logical', 'AWS::IAM::Role');
    expect(result).toBeUndefined();
  });

  it('does not declare any drift-unknown paths (inline Policies are now read back via GetRolePolicy)', () => {
    // The previous behavior was `getDriftUnknownPaths() => ['Policies']`
    // because surfacing inline policy names without bodies would have
    // fired guaranteed false-positive drift. Inline bodies are now read
    // by readCurrentState (one GetRolePolicy per policy, capped at IAM's
    // 10-per-role limit) so the unknown-path declaration is no longer
    // needed. If a future change re-introduces an unreadable subtree
    // here, this test must be updated consciously.
    expect(provider.getDriftUnknownPaths?.() ?? []).toEqual([]);
  });

  it('emits empty ManagedPolicyArns placeholder when there are none attached', async () => {
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'role',
        Path: '/',
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ V: 1 })),
      },
    });
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });
    mockSend.mockResolvedValueOnce({ Tags: [], IsTruncated: false });

    const result = await provider.readCurrentState('role', 'Logical', 'AWS::IAM::Role');
    expect(result?.ManagedPolicyArns).toEqual([]);
  });

  it('surfaces Tags from ListRoleTags with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'role',
        Path: '/',
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ V: 1 })),
      },
    });
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });
    mockSend.mockResolvedValueOnce({
      Tags: [
        { Key: 'Foo', Value: 'Bar' },
        { Key: 'aws:cdk:path', Value: 'MyStack/MyRole/Resource' },
      ],
      IsTruncated: false,
    });

    const result = await provider.readCurrentState('role', 'Logical', 'AWS::IAM::Role');
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('emits empty Tags array when ListRoleTags returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'role',
        Path: '/',
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ V: 1 })),
      },
    });
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });
    mockSend.mockResolvedValueOnce({
      Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyRole/Resource' }],
      IsTruncated: false,
    });

    const result = await provider.readCurrentState('role', 'Logical', 'AWS::IAM::Role');
    expect(result?.Tags).toEqual([]);
  });

  it('emits PermissionsBoundary placeholder when AWS reports none', async () => {
    // Always-emit guard (PR #145 pattern): without the placeholder a
    // console-side ADD on a role that was deployed without a boundary
    // would never enter observedProperties and the drift comparator
    // (state-keys-only top-level walk) would silently ignore it.
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'role',
        Path: '/',
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ V: 1 })),
        // PermissionsBoundary deliberately undefined.
      },
    });
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });
    mockSend.mockResolvedValueOnce({ Tags: [], IsTruncated: false });

    const result = await provider.readCurrentState('role', 'Logical', 'AWS::IAM::Role');
    expect(result?.PermissionsBoundary).toBe('');
  });

  it('surfaces inline Policies with URL-decoded + parsed PolicyDocument bodies', async () => {
    const docA = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
    };
    const docB = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'logs:PutLogEvents', Resource: '*' }],
    };
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'role',
        Path: '/',
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ V: 1 })),
      },
    });
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    // ListRolePolicies returns names in some order; we sort AWS-only
    // names lexicographically when state has none, so 'A' before 'B'.
    mockSend.mockResolvedValueOnce({
      PolicyNames: ['B', 'A'],
      IsTruncated: false,
    });
    // GetRolePolicy is fired in parallel — we use a name → response map
    // so order of sequential mocks doesn't matter.
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetRolePolicyCommand) {
        const input = (cmd as GetRolePolicyCommand).input;
        if (input.PolicyName === 'A') {
          return Promise.resolve({
            RoleName: 'role',
            PolicyName: 'A',
            PolicyDocument: encodeURIComponent(JSON.stringify(docA)),
          });
        }
        if (input.PolicyName === 'B') {
          return Promise.resolve({
            RoleName: 'role',
            PolicyName: 'B',
            PolicyDocument: encodeURIComponent(JSON.stringify(docB)),
          });
        }
      }
      // Default: ListRoleTags (the trailing call after the parallel GetRolePolicy fan-out).
      return Promise.resolve({ Tags: [], IsTruncated: false });
    });

    const result = await provider.readCurrentState('role', 'Logical', 'AWS::IAM::Role');

    expect(result?.Policies).toEqual([
      { PolicyName: 'A', PolicyDocument: docA },
      { PolicyName: 'B', PolicyDocument: docB },
    ]);
  });

  it('reconciles inline Policies order against state.Policies so positional compare does not fire false drift', async () => {
    const docA = { V: 'a' };
    const docB = { V: 'b' };
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'role',
        Path: '/',
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ V: 1 })),
      },
    });
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    // AWS returns the names in lexicographic order (A, B), but state
    // has them in (B, A). The reconciliation logic should emit (B, A)
    // matching state's order so the deepEqual positional compare
    // passes.
    mockSend.mockResolvedValueOnce({
      PolicyNames: ['A', 'B'],
      IsTruncated: false,
    });
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetRolePolicyCommand) {
        const input = (cmd as GetRolePolicyCommand).input;
        return Promise.resolve({
          RoleName: 'role',
          PolicyName: input.PolicyName,
          PolicyDocument: encodeURIComponent(
            JSON.stringify(input.PolicyName === 'A' ? docA : docB)
          ),
        });
      }
      return Promise.resolve({ Tags: [], IsTruncated: false });
    });

    const result = await provider.readCurrentState(
      'role',
      'Logical',
      'AWS::IAM::Role',
      // State's Policies array — order is (B, A).
      {
        Policies: [
          { PolicyName: 'B', PolicyDocument: docB },
          { PolicyName: 'A', PolicyDocument: docA },
        ],
      }
    );

    expect(result?.Policies).toEqual([
      { PolicyName: 'B', PolicyDocument: docB },
      { PolicyName: 'A', PolicyDocument: docA },
    ]);
  });

  it('appends AWS-only inline Policies (added via console) at the end so length / content mismatch surfaces as drift', async () => {
    const docA = { V: 'a' };
    const docX = { V: 'x' };
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'role',
        Path: '/',
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ V: 1 })),
      },
    });
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    // State has only A; AWS has A + Xtra (Xtra was added via console).
    mockSend.mockResolvedValueOnce({
      PolicyNames: ['A', 'Xtra'],
      IsTruncated: false,
    });
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetRolePolicyCommand) {
        const input = (cmd as GetRolePolicyCommand).input;
        return Promise.resolve({
          RoleName: 'role',
          PolicyName: input.PolicyName,
          PolicyDocument: encodeURIComponent(
            JSON.stringify(input.PolicyName === 'A' ? docA : docX)
          ),
        });
      }
      return Promise.resolve({ Tags: [], IsTruncated: false });
    });

    const result = await provider.readCurrentState('role', 'Logical', 'AWS::IAM::Role', {
      Policies: [{ PolicyName: 'A', PolicyDocument: docA }],
    });

    // State has length 1; result has length 2 → drift fires on Policies.
    expect(result?.Policies).toEqual([
      { PolicyName: 'A', PolicyDocument: docA },
      { PolicyName: 'Xtra', PolicyDocument: docX },
    ]);
  });

  // Structural regression test for the always-emit-placeholder convention
  // (docs/provider-development.md § 3b). Ensures every user-controllable
  // top-level CFn key is present in the result even when AWS returns
  // the resource with all optional fields undefined / empty. A future
  // refactor that drops a placeholder for any of these keys must update
  // this test consciously — silent regression is structurally prevented.
  it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
    // GetRole — minimum fields only; Description / MaxSessionDuration /
    // PermissionsBoundary deliberately undefined.
    mockSend.mockResolvedValueOnce({
      Role: {
        RoleName: 'r',
        Path: '/',
        AssumeRolePolicyDocument: '%7B%7D',
      },
    });
    // ListAttachedRolePolicies — none attached.
    mockSend.mockResolvedValueOnce({ AttachedPolicies: [] });
    // ListRolePolicies — no inline.
    mockSend.mockResolvedValueOnce({ PolicyNames: [], IsTruncated: false });
    // ListRoleTags — no tags.
    mockSend.mockResolvedValueOnce({ Tags: [], IsTruncated: false });

    const result = await provider.readCurrentState('r', 'Logical', 'AWS::IAM::Role');

    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        'AssumeRolePolicyDocument',
        'Description',
        'ManagedPolicyArns',
        'Path',
        'PermissionsBoundary',
        'Policies',
        'RoleName',
        'Tags',
      ].sort()
    );
    expect(result?.Description).toBe('');
    expect(result?.PermissionsBoundary).toBe('');
    expect(result?.ManagedPolicyArns).toEqual([]);
    expect(result?.Policies).toEqual([]);
    expect(result?.Tags).toEqual([]);
  });
});
