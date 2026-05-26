import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AttachGroupPolicyCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  DetachGroupPolicyCommand,
  DetachRolePolicyCommand,
  DetachUserPolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  ListEntitiesForPolicyCommand,
  ListPoliciesCommand,
  ListPolicyTagsCommand,
  ListPolicyVersionsCommand,
  NoSuchEntityException,
  TagPolicyCommand,
  UntagPolicyCommand,
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

import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';

const ARN = 'arn:aws:iam::123456789012:policy/MyManagedPolicy';
const POLICY_DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};

function callsOfType(klass: { new (...args: any[]): any }): any[] {
  return mockSend.mock.calls
    .filter((call) => call[0].constructor.name === klass.name)
    .map((call) => call[0]);
}

describe('IAMManagedPolicyProvider', () => {
  let provider: IAMManagedPolicyProvider;
  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMManagedPolicyProvider();
  });

  describe('create', () => {
    it('creates a managed policy with the minimal property set + no attachments', async () => {
      mockSend.mockResolvedValueOnce({ Policy: { Arn: ARN, PolicyName: 'MyManagedPolicy' } });

      const result = await provider.create('MyManagedPolicy', 'AWS::IAM::ManagedPolicy', {
        PolicyDocument: POLICY_DOC,
      });

      expect(result.physicalId).toBe(ARN);
      expect(result.attributes).toEqual({ PolicyArn: ARN });
      const created = callsOfType(CreatePolicyCommand)[0].input;
      expect(created.PolicyDocument).toBe(JSON.stringify(POLICY_DOC));
      expect(created.PolicyName).toBeTruthy();
      expect(created.Description).toBeUndefined();
      expect(created.Path).toBeUndefined();
      expect(created.Tags).toBeUndefined();
    });

    it('forwards Description, Path, and Tags to CreatePolicy when supplied', async () => {
      mockSend.mockResolvedValueOnce({ Policy: { Arn: ARN, PolicyName: 'MyManagedPolicy' } });

      await provider.create('MyManagedPolicy', 'AWS::IAM::ManagedPolicy', {
        PolicyDocument: POLICY_DOC,
        Description: 'my desc',
        Path: '/custom/',
        Tags: [{ Key: 'env', Value: 'test' }],
      });

      const created = callsOfType(CreatePolicyCommand)[0].input;
      expect(created.Description).toBe('my desc');
      expect(created.Path).toBe('/custom/');
      expect(created.Tags).toEqual([{ Key: 'env', Value: 'test' }]);
    });

    it('attaches groups, roles, and users after CreatePolicy', async () => {
      mockSend.mockResolvedValueOnce({ Policy: { Arn: ARN, PolicyName: 'MyManagedPolicy' } });
      // Each Attach* call resolves
      mockSend.mockResolvedValue({});

      await provider.create('MyManagedPolicy', 'AWS::IAM::ManagedPolicy', {
        PolicyDocument: POLICY_DOC,
        Groups: ['g1', 'g2'],
        Roles: ['r1'],
        Users: ['u1'],
      });

      expect(callsOfType(AttachGroupPolicyCommand)).toHaveLength(2);
      expect(callsOfType(AttachRolePolicyCommand)).toHaveLength(1);
      expect(callsOfType(AttachUserPolicyCommand)).toHaveLength(1);
    });

    it('throws when PolicyDocument is missing', async () => {
      await expect(
        provider.create('MyManagedPolicy', 'AWS::IAM::ManagedPolicy', {})
      ).rejects.toThrow(/PolicyDocument is required/);
    });

    it('cleans up the partially-created policy when an attachment call fails', async () => {
      // CreatePolicy succeeds.
      mockSend.mockResolvedValueOnce({ Policy: { Arn: ARN, PolicyName: 'MyManagedPolicy' } });
      // AttachGroupPolicy fails.
      mockSend.mockRejectedValueOnce(new Error('boom'));
      // Cleanup: ListEntitiesForPolicy -> empty (no principals attached).
      mockSend.mockResolvedValueOnce({ IsTruncated: false });
      // ListPolicyVersions -> empty.
      mockSend.mockResolvedValueOnce({ Versions: [], IsTruncated: false });
      // DeletePolicy.
      mockSend.mockResolvedValueOnce({});

      await expect(
        provider.create('MyManagedPolicy', 'AWS::IAM::ManagedPolicy', {
          PolicyDocument: POLICY_DOC,
          Groups: ['g1'],
        })
      ).rejects.toThrow(/Failed to create IAM managed policy/);

      expect(callsOfType(DeletePolicyCommand)).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('creates a new policy version when PolicyDocument changes', async () => {
      // ensureVersionCapacity -> ListPolicyVersions (only 1 version, no prune).
      mockSend.mockResolvedValueOnce({
        Versions: [{ VersionId: 'v1', IsDefaultVersion: true, CreateDate: new Date(2024, 0, 1) }],
        IsTruncated: false,
      });
      // CreatePolicyVersion.
      mockSend.mockResolvedValueOnce({ PolicyVersion: { VersionId: 'v2' } });
      // updatePrincipals: nothing changes (both empty).
      // updateTags: nothing changes (both empty).

      const newDoc = { ...POLICY_DOC, Statement: [...POLICY_DOC.Statement, { Sid: 'new' }] };

      const result = await provider.update(
        'MyManagedPolicy',
        ARN,
        'AWS::IAM::ManagedPolicy',
        { PolicyDocument: newDoc },
        { PolicyDocument: POLICY_DOC }
      );

      expect(result.wasReplaced).toBe(false);
      expect(result.physicalId).toBe(ARN);
      const create = callsOfType(CreatePolicyVersionCommand)[0].input;
      expect(create.PolicyArn).toBe(ARN);
      expect(create.SetAsDefault).toBe(true);
      expect(create.PolicyDocument).toBe(JSON.stringify(newDoc));
    });

    it('prunes the oldest non-default version before creating a new one at the 5-version cap', async () => {
      const t = (n: number) => new Date(2024, 0, n);
      mockSend.mockResolvedValueOnce({
        Versions: [
          { VersionId: 'v5', IsDefaultVersion: true, CreateDate: t(5) },
          { VersionId: 'v4', IsDefaultVersion: false, CreateDate: t(4) },
          { VersionId: 'v3', IsDefaultVersion: false, CreateDate: t(3) },
          { VersionId: 'v2', IsDefaultVersion: false, CreateDate: t(2) },
          { VersionId: 'v1', IsDefaultVersion: false, CreateDate: t(1) },
        ],
        IsTruncated: false,
      });
      // DeletePolicyVersion (pruning v1).
      mockSend.mockResolvedValueOnce({});
      // CreatePolicyVersion.
      mockSend.mockResolvedValueOnce({ PolicyVersion: { VersionId: 'v6' } });

      await provider.update(
        'MyManagedPolicy',
        ARN,
        'AWS::IAM::ManagedPolicy',
        { PolicyDocument: { x: 1 } },
        { PolicyDocument: { x: 0 } }
      );

      const prune = callsOfType(DeletePolicyVersionCommand)[0].input;
      expect(prune.VersionId).toBe('v1');
    });

    it('attaches new principals and detaches removed principals', async () => {
      // No PolicyDocument change -> no version churn.
      // Diff: Groups [g1] -> [g1, g2] (attach g2). Roles [r1, r2] -> [r2] (detach r1).
      mockSend.mockResolvedValue({});

      await provider.update(
        'MyManagedPolicy',
        ARN,
        'AWS::IAM::ManagedPolicy',
        { PolicyDocument: POLICY_DOC, Groups: ['g1', 'g2'], Roles: ['r2'] },
        { PolicyDocument: POLICY_DOC, Groups: ['g1'], Roles: ['r1', 'r2'] }
      );

      const attachedGroups = callsOfType(AttachGroupPolicyCommand).map((c) => c.input.GroupName);
      expect(attachedGroups).toEqual(['g2']);
      const detachedRoles = callsOfType(DetachRolePolicyCommand).map((c) => c.input.RoleName);
      expect(detachedRoles).toEqual(['r1']);
    });

    it('replaces the policy when ManagedPolicyName changes', async () => {
      const newArn = 'arn:aws:iam::123456789012:policy/Renamed';
      // create() path: CreatePolicy
      mockSend.mockResolvedValueOnce({ Policy: { Arn: newArn, PolicyName: 'Renamed' } });
      // delete() path: GetPolicy succeeds.
      mockSend.mockResolvedValueOnce({ Policy: { Arn: ARN } });
      // detachAllPrincipals: ListEntitiesForPolicy -> empty.
      mockSend.mockResolvedValueOnce({ IsTruncated: false });
      // deleteAllNonDefaultVersions: ListPolicyVersions -> empty.
      mockSend.mockResolvedValueOnce({ Versions: [], IsTruncated: false });
      // DeletePolicy.
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'MyManagedPolicy',
        ARN,
        'AWS::IAM::ManagedPolicy',
        { PolicyDocument: POLICY_DOC, ManagedPolicyName: 'Renamed' },
        { PolicyDocument: POLICY_DOC, ManagedPolicyName: 'MyManagedPolicy' }
      );

      expect(result.wasReplaced).toBe(true);
      expect(result.physicalId).toBe(newArn);
      expect(callsOfType(DeletePolicyCommand)).toHaveLength(1);
    });

    it('diffs and applies tag changes', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'MyManagedPolicy',
        ARN,
        'AWS::IAM::ManagedPolicy',
        {
          PolicyDocument: POLICY_DOC,
          Tags: [
            { Key: 'env', Value: 'prod' },
            { Key: 'team', Value: 'platform' },
          ],
        },
        {
          PolicyDocument: POLICY_DOC,
          Tags: [
            { Key: 'env', Value: 'staging' },
            { Key: 'owner', Value: 'alice' },
          ],
        }
      );

      const tagged = callsOfType(TagPolicyCommand)[0].input;
      expect(tagged.Tags).toEqual([
        { Key: 'env', Value: 'prod' },
        { Key: 'team', Value: 'platform' },
      ]);
      const untagged = callsOfType(UntagPolicyCommand)[0].input;
      expect(untagged.TagKeys).toEqual(['owner']);
    });
  });

  describe('delete', () => {
    it('detaches every principal AWS-side and deletes non-default versions before DeletePolicy', async () => {
      // GetPolicy.
      mockSend.mockResolvedValueOnce({ Policy: { Arn: ARN } });
      // ListEntitiesForPolicy returns one of each.
      mockSend.mockResolvedValueOnce({
        PolicyGroups: [{ GroupName: 'g1' }],
        PolicyRoles: [{ RoleName: 'r1' }],
        PolicyUsers: [{ UserName: 'u1' }],
        IsTruncated: false,
      });
      // 3 detach calls.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});
      // ListPolicyVersions returns 1 default + 1 non-default.
      mockSend.mockResolvedValueOnce({
        Versions: [
          { VersionId: 'v2', IsDefaultVersion: true },
          { VersionId: 'v1', IsDefaultVersion: false },
        ],
        IsTruncated: false,
      });
      // DeletePolicyVersion (the non-default one).
      mockSend.mockResolvedValueOnce({});
      // DeletePolicy.
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyManagedPolicy', ARN, 'AWS::IAM::ManagedPolicy');

      expect(callsOfType(DetachGroupPolicyCommand)).toHaveLength(1);
      expect(callsOfType(DetachRolePolicyCommand)).toHaveLength(1);
      expect(callsOfType(DetachUserPolicyCommand)).toHaveLength(1);
      const versionDeletes = callsOfType(DeletePolicyVersionCommand);
      expect(versionDeletes).toHaveLength(1);
      expect(versionDeletes[0].input.VersionId).toBe('v1');
      expect(callsOfType(DeletePolicyCommand)).toHaveLength(1);
    });

    it('treats NoSuchEntity on GetPolicy as idempotent success', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'gone' })
      );

      await provider.delete('MyManagedPolicy', ARN, 'AWS::IAM::ManagedPolicy');

      // No follow-up Detach* / Delete* calls.
      expect(callsOfType(DeletePolicyCommand)).toHaveLength(0);
    });
  });

  describe('getAttribute', () => {
    it('returns the ARN for PolicyArn', async () => {
      const v = await provider.getAttribute(ARN, 'AWS::IAM::ManagedPolicy', 'PolicyArn');
      expect(v).toBe(ARN);
    });

    it('returns undefined for unknown attributes', async () => {
      const v = await provider.getAttribute(ARN, 'AWS::IAM::ManagedPolicy', 'NotAnAttribute');
      expect(v).toBeUndefined();
    });
  });

  describe('readCurrentState', () => {
    it('fetches GetPolicy + GetPolicyVersion + ListEntitiesForPolicy + ListPolicyTags', async () => {
      mockSend.mockResolvedValueOnce({
        Policy: {
          PolicyName: 'MyManagedPolicy',
          Description: 'my desc',
          Path: '/',
          DefaultVersionId: 'v1',
        },
      });
      const docStr = encodeURIComponent(JSON.stringify(POLICY_DOC));
      mockSend.mockResolvedValueOnce({ PolicyVersion: { Document: docStr } });
      mockSend.mockResolvedValueOnce({
        PolicyGroups: [{ GroupName: 'g1' }],
        PolicyRoles: [],
        PolicyUsers: [],
        IsTruncated: false,
      });
      mockSend.mockResolvedValueOnce({
        Tags: [
          { Key: 'env', Value: 'prod' },
          { Key: 'aws:cdk:path', Value: 'Stack/MyManagedPolicy' },
        ],
        IsTruncated: false,
      });

      const result = await provider.readCurrentState(ARN, 'MyManagedPolicy', 'AWS::IAM::ManagedPolicy');

      expect(result).toBeDefined();
      expect(result!['ManagedPolicyName']).toBe('MyManagedPolicy');
      expect(result!['Description']).toBe('my desc');
      expect(result!['Path']).toBe('/');
      expect(result!['PolicyDocument']).toEqual(POLICY_DOC);
      expect(result!['Groups']).toEqual(['g1']);
      expect(result!['Roles']).toEqual([]);
      expect(result!['Users']).toEqual([]);
      // aws:* filtered.
      expect(result!['Tags']).toEqual([{ Key: 'env', Value: 'prod' }]);
    });

    it('returns undefined when the policy is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'gone' })
      );
      const result = await provider.readCurrentState(ARN, 'MyManagedPolicy', 'AWS::IAM::ManagedPolicy');
      expect(result).toBeUndefined();
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyManagedPolicy',
        resourceType: 'AWS::IAM::ManagedPolicy',
        cdkPath: 'MyStack/MyManagedPolicy',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {} as Record<string, unknown>,
        ...overrides,
      };
    }

    it('verifies a knownPhysicalId given as an ARN via GetPolicy', async () => {
      mockSend.mockResolvedValueOnce({ Policy: { Arn: ARN } });
      const result = await provider.import!(makeInput({ knownPhysicalId: ARN }));
      expect(result).toEqual({ physicalId: ARN, attributes: { PolicyArn: ARN } });
      expect(callsOfType(GetPolicyCommand)).toHaveLength(1);
    });

    it('resolves a knownPhysicalId given as a name via ListPolicies(Scope:Local)', async () => {
      mockSend.mockResolvedValueOnce({
        Policies: [{ PolicyName: 'OtherName', Arn: 'arn:aws:iam::123456789012:policy/Other' }],
        IsTruncated: false,
      });
      mockSend.mockResolvedValueOnce({
        Policies: [{ PolicyName: 'MyManagedPolicy', Arn: ARN }],
        IsTruncated: false,
      });
      // Call once: first response will be used since first ListPolicies includes "OtherName".
      // We arranged the mock so the loop finds "MyManagedPolicy" on the second iteration.
      // But our impl returns on the first call's match if it has the right name. So
      // simplify: only one response with the matching entry.
      mockSend.mockReset();
      mockSend.mockResolvedValueOnce({
        Policies: [
          { PolicyName: 'Other', Arn: 'arn:aws:iam::123456789012:policy/Other' },
          { PolicyName: 'MyManagedPolicy', Arn: ARN },
        ],
        IsTruncated: false,
      });

      const result = await provider.import!(makeInput({ knownPhysicalId: 'MyManagedPolicy' }));
      expect(result).toEqual({ physicalId: ARN, attributes: { PolicyArn: ARN } });
      expect(callsOfType(ListPoliciesCommand)[0].input.Scope).toBe('Local');
    });

    it('returns null when an ARN override does not exist on AWS', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'gone' })
      );
      const result = await provider.import!(makeInput({ knownPhysicalId: ARN }));
      expect(result).toBeNull();
    });

    it('falls back to cdkPath tag lookup when no override is supplied', async () => {
      mockSend.mockResolvedValueOnce({
        Policies: [
          { PolicyName: 'OneOff', Arn: 'arn:aws:iam::123456789012:policy/OneOff' },
          { PolicyName: 'MyManagedPolicy', Arn: ARN },
        ],
        IsTruncated: false,
      });
      // First candidate's tags: no match.
      mockSend.mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'Other/X' }] });
      // Second candidate's tags: match.
      mockSend.mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyManagedPolicy' }],
      });

      const result = await provider.import!(makeInput());
      expect(result).toEqual({ physicalId: ARN, attributes: { PolicyArn: ARN } });
    });

    it('returns null when nothing matches the cdkPath', async () => {
      mockSend.mockResolvedValueOnce({
        Policies: [{ PolicyName: 'OneOff', Arn: 'arn:aws:iam::123456789012:policy/OneOff' }],
        IsTruncated: false,
      });
      mockSend.mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'Other/X' }] });
      const result = await provider.import!(makeInput());
      expect(result).toBeNull();
    });
  });
});

// Reference unused-import guard for SDK commands the test asserts via mock.constructor.name:
// reference them so import elision doesn't drop them.
void GetPolicyVersionCommand;
void ListPolicyTagsCommand;
void ListPolicyVersionsCommand;
void ListEntitiesForPolicyCommand;
