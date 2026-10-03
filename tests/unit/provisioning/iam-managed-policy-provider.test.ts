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
import { getLogger } from '../../../src/utils/logger.js';
import {
  FORGED_CTRL,
  FORGED_QUOTE,
  expectWithheld,
} from './pasteable-aws-command-assert.js';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../src/types/resource.js';
/** Narrow a `readCurrentState` result to its property bag; fails on `RESOURCE_NOT_FOUND`. */
function bagOf(
  r: Record<string, unknown> | ResourceNotFound | undefined
): Record<string, unknown> | undefined {
  expect(r).not.toBe(RESOURCE_NOT_FOUND);
  return r as Record<string, unknown> | undefined;
}

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

    it('replaces the policy when Path changes', async () => {
      const newArn = 'arn:aws:iam::123456789012:policy/new/MyManagedPolicy';
      mockSend.mockResolvedValueOnce({ Policy: { Arn: newArn, PolicyName: 'MyManagedPolicy' } });
      // delete() path
      mockSend.mockResolvedValueOnce({ Policy: { Arn: ARN } });
      mockSend.mockResolvedValueOnce({ IsTruncated: false });
      mockSend.mockResolvedValueOnce({ Versions: [], IsTruncated: false });
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'MyManagedPolicy',
        ARN,
        'AWS::IAM::ManagedPolicy',
        { PolicyDocument: POLICY_DOC, Path: '/new/' },
        { PolicyDocument: POLICY_DOC, Path: '/' }
      );

      expect(result.wasReplaced).toBe(true);
      expect(result.physicalId).toBe(newArn);
      // The clean control for the partial arm below: a replacement whose old
      // policy IS deleted must carry no outcome, or every replacement would be
      // counted and rendered as a partial.
      expect(result.outcome).toBeUndefined();
    });

    // Issue #1819: the old policy survives when its delete fails, and before
    // the outcome channel that was a bare logger.warn with the deploy exiting 0
    // and the policy out of state.
    // The case below cannot tell `safeStringify(err)` from
    // `describeAwsFailure(err).detail`: its fixture puts the wire code in the
    // MESSAGE, where both spellings find it. `reason` is PERSISTED as the row's
    // `outcome: 'partial'` text, so its wording may not move -- and a real AWS
    // failure carries the code as `name`, which only `String(err)` renders.
    //
    // The spy is what reaches that path: this provider's delete wraps every
    // failure into a `ProvisioningError`, so in production the dropped prefix
    // is `ProvisioningError: ` rather than AWS's own code. The PROPERTY is the
    // same either way -- a persisted reason does not change wording -- and the
    // spy states it in the form where the two spellings visibly differ.
    it('persists the unwrapped delete failure verbatim, name included', async () => {
      const newArn = 'arn:aws:iam::123456789012:policy/new/MyManagedPolicy';
      mockSend.mockResolvedValueOnce({ Policy: { Arn: newArn, PolicyName: 'MyManagedPolicy' } });
      vi.spyOn(provider, 'delete').mockRejectedValue(
        Object.assign(new Error('Cannot delete a policy attached to entities.'), {
          name: 'DeleteConflict',
          $metadata: { httpStatusCode: 409 },
        })
      );

      const result = await provider.update(
        'MyManagedPolicy',
        ARN,
        'AWS::IAM::ManagedPolicy',
        { PolicyDocument: POLICY_DOC, Path: '/new/' },
        { PolicyDocument: POLICY_DOC, Path: '/' }
      );

      expect(result.outcome).toBe('partial');
      expect(result.reason).toBe(
        `old managed policy ${ARN} could not be deleted: DeleteConflict: ` +
          'Cannot delete a policy attached to entities.'
      );
    });

    it('reports partial when the old policy cannot be deleted', async () => {
      const newArn = 'arn:aws:iam::123456789012:policy/new/MyManagedPolicy';
      mockSend.mockResolvedValueOnce({ Policy: { Arn: newArn, PolicyName: 'MyManagedPolicy' } });
      mockSend.mockRejectedValueOnce(new Error('DeleteConflict: policy still attached'));

      const result = await provider.update(
        'MyManagedPolicy',
        ARN,
        'AWS::IAM::ManagedPolicy',
        { PolicyDocument: POLICY_DOC, Path: '/new/' },
        { PolicyDocument: POLICY_DOC, Path: '/' }
      );

      // The row still succeeded -- the new policy exists and is what state
      // must point at.
      expect(result.wasReplaced).toBe(true);
      expect(result.physicalId).toBe(newArn);
      expect(result.outcome).toBe('partial');
      // The reason names the OLD arn: state now points at the new one, so
      // nothing else downstream still knows which policy survived.
      expect(result.reason).toContain(ARN);
      expect(result.reason).toContain('DeleteConflict');
    });

    // The #1778 SKIP class: non-throwing, so it bypasses the catch entirely.
    it('reports partial when the inner delete SKIPS rather than throws', async () => {
      const newArn = 'arn:aws:iam::123456789012:policy/new/MyManagedPolicy';
      mockSend.mockResolvedValueOnce({ Policy: { Arn: newArn, PolicyName: 'MyManagedPolicy' } });
      vi.spyOn(provider, 'delete').mockResolvedValue({
        outcome: 'skipped',
        reason: 'malformed physicalId in state — no delete issued',
      });

      const result = await provider.update(
        'MyManagedPolicy',
        ARN,
        'AWS::IAM::ManagedPolicy',
        { PolicyDocument: POLICY_DOC, Path: '/new/' },
        { PolicyDocument: POLICY_DOC, Path: '/' }
      );

      expect(result.outcome).toBe('partial');
      expect(result.reason).toContain(ARN);
      expect(result.reason).toContain('no delete issued');
    });

    it('replaces the policy when Description changes (Description is immutable)', async () => {
      const newArn = 'arn:aws:iam::123456789012:policy/MyManagedPolicy';
      mockSend.mockResolvedValueOnce({ Policy: { Arn: newArn, PolicyName: 'MyManagedPolicy' } });
      mockSend.mockResolvedValueOnce({ Policy: { Arn: ARN } });
      mockSend.mockResolvedValueOnce({ IsTruncated: false });
      mockSend.mockResolvedValueOnce({ Versions: [], IsTruncated: false });
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'MyManagedPolicy',
        ARN,
        'AWS::IAM::ManagedPolicy',
        { PolicyDocument: POLICY_DOC, Description: 'new desc' },
        { PolicyDocument: POLICY_DOC, Description: 'old desc' }
      );

      expect(result.wasReplaced).toBe(true);
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

    // Issue #4023: `cdkd drift --revert` (`desiredFromAwsReadback`) derives the
    // name outside the deploy's stack-name / prefix scope, so its bag can name
    // the template's pre-prefix name while the live policy carries the
    // prefixed one. The same input WITHOUT the flag replaces (control below),
    // so the flag is what keeps the live policy.
    describe('drift revert keeps the recorded name (issue #4023)', () => {
      const PREFIXED_ARN = 'arn:aws:iam::123456789012:policy/MyStack-my-policy';
      const bags = (): [Record<string, unknown>, Record<string, unknown>] => [
        { PolicyDocument: POLICY_DOC, ManagedPolicyName: 'my-policy' },
        { PolicyDocument: POLICY_DOC, ManagedPolicyName: 'MyStack-my-policy' },
      ];

      it('updates in place and warns instead of replacing', async () => {
        const [desired, previous] = bags();
        const warn = vi.mocked(getLogger().child('IAMManagedPolicyProvider').warn);
        warn.mockClear();

        const result = await provider.update(
          'MyManagedPolicy',
          PREFIXED_ARN,
          'AWS::IAM::ManagedPolicy',
          desired,
          previous,
          { desiredFromAwsReadback: true }
        );

        expect(result.wasReplaced).toBe(false);
        expect(result.physicalId).toBe(PREFIXED_ARN);
        expect(callsOfType(CreatePolicyCommand)).toHaveLength(0);
        expect(callsOfType(DeletePolicyCommand)).toHaveLength(0);
        // Nothing but the name differs, so no in-place call is needed either.
        expect(mockSend).not.toHaveBeenCalled();
        const lines = warn.mock.calls.map((c) => String(c[0]));
        expect(
          lines.some(
            (l) =>
              l.includes('ManagedPolicyName is not reverted') &&
              l.includes('MyStack-my-policy') &&
              l.includes('derive my-policy')
          )
        ).toBe(true);
      });

      it('still replaces on the template path (control)', async () => {
        const [desired, previous] = bags();
        const newArn = 'arn:aws:iam::123456789012:policy/my-policy';
        mockSend.mockResolvedValueOnce({ Policy: { Arn: newArn, PolicyName: 'my-policy' } });
        mockSend.mockResolvedValueOnce({ Policy: { Arn: PREFIXED_ARN } });
        mockSend.mockResolvedValueOnce({ IsTruncated: false });
        mockSend.mockResolvedValueOnce({ Versions: [], IsTruncated: false });
        mockSend.mockResolvedValueOnce({});

        const result = await provider.update(
          'MyManagedPolicy',
          PREFIXED_ARN,
          'AWS::IAM::ManagedPolicy',
          desired,
          previous
        );

        expect(result.wasReplaced).toBe(true);
        expect(callsOfType(CreatePolicyCommand)).toHaveLength(1);
        expect(callsOfType(DeletePolicyCommand)).toHaveLength(1);
      });

      it.each([
        ['Path', { Path: '/other/' }],
        ['Description', { Description: 'other' }],
      ])('refuses a %s revert instead of replacing the policy', async (field, extra) => {
        const [desired, previous] = bags();
        await expect(
          provider.update(
            'MyManagedPolicy',
            PREFIXED_ARN,
            'AWS::IAM::ManagedPolicy',
            { ...desired, ...extra },
            previous,
            { desiredFromAwsReadback: true }
          )
        ).rejects.toThrow(new RegExp(`${field} cannot be reverted .*never replaces`));
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('masks a secret-derived recorded name in the warning', async () => {
        const warn = vi.mocked(getLogger().child('IAMManagedPolicyProvider').warn);
        warn.mockClear();
        const secret = `Secret_Value_${'x'.repeat(130)}`;
        const recorded = `MyStack-Secret-Value-${'x'.repeat(98)}-deadbeef`;
        const arn = `arn:aws:iam::123456789012:policy/${recorded}`;

        await provider.update(
          'MyManagedPolicy',
          arn,
          'AWS::IAM::ManagedPolicy',
          { PolicyDocument: POLICY_DOC, ManagedPolicyName: secret },
          { PolicyDocument: POLICY_DOC, ManagedPolicyName: recorded },
          {
            desiredFromAwsReadback: true,
            maskSecrets: (t: string) => t.split(secret).join('***'),
          }
        );

        const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('is not reverted'));
        expect(line).toBeDefined();
        expect(line).not.toContain('Secret-Value');
        expect(line).not.toContain('Secret_Value');
      });

      it('does not warn when the reverted name matches the recorded one', async () => {
        const warn = vi.mocked(getLogger().child('IAMManagedPolicyProvider').warn);
        warn.mockClear();

        const result = await provider.update(
          'MyManagedPolicy',
          PREFIXED_ARN,
          'AWS::IAM::ManagedPolicy',
          { PolicyDocument: POLICY_DOC, ManagedPolicyName: 'MyStack-my-policy' },
          { PolicyDocument: POLICY_DOC, ManagedPolicyName: 'MyStack-my-policy' },
          { desiredFromAwsReadback: true }
        );

        expect(result.wasReplaced).toBe(false);
        expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
          'is not reverted'
        );
      });
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

      const result = bagOf(await provider.readCurrentState(ARN, 'MyManagedPolicy', 'AWS::IAM::ManagedPolicy'));

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

    it('returns RESOURCE_NOT_FOUND when the policy is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'gone' })
      );
      const result = await provider.readCurrentState(ARN, 'MyManagedPolicy', 'AWS::IAM::ManagedPolicy');
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyManagedPolicy',
        resourceType: 'AWS::IAM::ManagedPolicy',
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

    it('paginates ListPolicies when resolving a knownPhysicalId by name', async () => {
      // First page: no match, IsTruncated=true with a Marker.
      mockSend.mockResolvedValueOnce({
        Policies: [{ PolicyName: 'OtherA', Arn: 'arn:aws:iam::123456789012:policy/OtherA' }],
        IsTruncated: true,
        Marker: 'page2',
      });
      // Second page: match.
      mockSend.mockResolvedValueOnce({
        Policies: [{ PolicyName: 'MyManagedPolicy', Arn: ARN }],
        IsTruncated: false,
      });

      const result = await provider.import!(makeInput({ knownPhysicalId: 'MyManagedPolicy' }));
      expect(result?.physicalId).toBe(ARN);
      const lists = callsOfType(ListPoliciesCommand);
      expect(lists).toHaveLength(2);
      expect(lists[1].input.Marker).toBe('page2');
    });

    it('refuses to adopt an AWS-managed policy via explicit ARN override', async () => {
      await expect(
        provider.import!(
          makeInput({ knownPhysicalId: 'arn:aws:iam::aws:policy/AdministratorAccess' })
        )
      ).rejects.toThrow(/AWS-managed policy/);
      // No GetPolicy call before the refusal.
      expect(callsOfType(GetPolicyCommand)).toHaveLength(0);
    });

    // Issue #1815: the refusal predicate was pinned to `arn:aws:iam::aws:`, so
    // an AWS-managed policy in any OTHER partition fell through and was
    // ADOPTED as if customer-managed — destroy would then detach it from every
    // principal in the account before `DeletePolicy` was (always) rejected.
    // AWS-managed policies exist under every partition
    // (`arn:aws-us-gov:iam::aws:policy/AdministratorAccess` is real), so a
    // commercial-only test cannot detect this. The commercial case above is
    // the byte-identical counter-case.
    it.each([
      ['aws-cn', 'arn:aws-cn:iam::aws:policy/AdministratorAccess'],
      ['aws-us-gov', 'arn:aws-us-gov:iam::aws:policy/AdministratorAccess'],
      ['aws-iso', 'arn:aws-iso:iam::aws:policy/AdministratorAccess'],
      ['aws-iso-b', 'arn:aws-iso-b:iam::aws:policy/ReadOnlyAccess'],
      ['aws-eusc', 'arn:aws-eusc:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
    ])(
      'refuses to adopt an AWS-managed policy in the %s partition (issue #1815)',
      async (_partition, arn) => {
        await expect(provider.import!(makeInput({ knownPhysicalId: arn }))).rejects.toThrow(
          /AWS-managed policy/
        );
        // The refusal happens BEFORE any AWS call — that ordering is what
        // keeps `detachAllPrincipals` from ever seeing the policy.
        expect(callsOfType(GetPolicyCommand)).toHaveLength(0);
      }
    );

    // Counter-case: widening the partition segment must NOT start refusing
    // customer-managed policies, whose account segment is a 12-digit id. If it
    // did, import would break for every non-commercial user in the opposite
    // direction.
    it.each([
      ['aws-cn', 'arn:aws-cn:iam::123456789012:policy/MyManagedPolicy'],
      ['aws-us-gov', 'arn:aws-us-gov:iam::123456789012:policy/MyManagedPolicy'],
    ])(
      'still adopts a customer-managed policy in the %s partition (issue #1815)',
      async (_partition, arn) => {
        mockSend.mockResolvedValueOnce({ Policy: { Arn: arn } });
        const result = await provider.import!(makeInput({ knownPhysicalId: arn }));
        expect(result).toEqual({ physicalId: arn, attributes: { PolicyArn: arn } });
        expect(callsOfType(GetPolicyCommand)).toHaveLength(1);
      }
    );

    // The other two #1815 sites carry an `arn:notaws:` row; this one did not.
    // `aws[a-z0-9-]*` is deliberately loose, so the segment that must remain
    // load-bearing is the ACCOUNT (`:iam::aws:`) — a partition-shaped
    // impostor with a 12-digit account is still a customer-managed policy and
    // must be adopted, not refused.
    it.each([
      ['a non-AWS partition spelling', 'arn:notaws:iam::aws:policy/AdministratorAccess'],
      ['an aws-prefixed impostor with a real account', 'arn:awsfoo:iam::123456789012:policy/Mine'],
    ])('does not refuse %s', async (_label, arn) => {
      mockSend.mockResolvedValueOnce({ Policy: { Arn: arn } });
      const result = await provider.import!(makeInput({ knownPhysicalId: arn }));
      expect(result).toEqual({ physicalId: arn, attributes: { PolicyArn: arn } });
    });

    it('returns null when an ARN override does not exist on AWS', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchEntityException({ $metadata: {}, message: 'gone' })
      );
      const result = await provider.import!(makeInput({ knownPhysicalId: ARN }));
      expect(result).toBeNull();
    });

    // The `aws:cdk:path` tag walk was removed (issue #1134): AWS rejects
    // `aws:`-prefixed tag writes, so the tag never exists on a real policy.
    // With no override, import returns null without issuing any AWS call.
    it('returns null without any AWS call when no override is supplied', async () => {
      const result = await provider.import!(makeInput());
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});

// Reference unused-import guard for SDK commands the test asserts via mock.constructor.name:
// reference them so import elision doesn't drop them.
void GetPolicyVersionCommand;
void ListPolicyTagsCommand;
void ListPolicyVersionsCommand;
void ListEntitiesForPolicyCommand;

// Issue #3136: the policy ARN is AWS-minted but embeds the TEMPLATE-chosen
// `Path`, whose AWS pattern admits every printable ASCII character — so all
// three manual-cleanup commands render through `pasteableAwsCommand`.
describe('IAMManagedPolicyProvider partial-create manual-cleanup commands (issue #3136)', () => {
  const warn = (getLogger().child('x') as unknown as { warn: ReturnType<typeof vi.fn> }).warn;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockClear();
  });

  async function warnFor(arn: string): Promise<string> {
    mockSend.mockResolvedValueOnce({ Policy: { Arn: arn, PolicyName: 'P' } }); // CreatePolicy
    mockSend.mockRejectedValueOnce(new Error('AttachRolePolicy boom')); // attach fails
    mockSend.mockRejectedValue(new Error('cleanup also failed')); // every cleanup call
    await expect(
      new IAMManagedPolicyProvider().create('P', 'AWS::IAM::ManagedPolicy', {
        PolicyDocument: POLICY_DOC,
        Roles: ['r'],
      })
    ).rejects.toThrow();
    return warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('Manual deletion'))!;
  }

  it('renders a clean ARN bare in every command, and withholds every command for a forged one', async () => {
    const clean = await warnFor(ARN);
    expect(clean).toContain(`aws iam list-entities-for-policy --policy-arn ${ARN}`);
    expect(clean).toContain(`aws iam list-policy-versions --policy-arn ${ARN}`);
    expect(clean).toContain(`aws iam delete-policy --policy-arn ${ARN}`);

    // A shell-active character withholds them (go-to-k/cdkd#3950).
    warn.mockClear();
    expectWithheld(await warnFor(`arn:aws:iam::123456789012:policy/$(id)/${FORGED_QUOTE}`), '--policy-arn');
  });

  it('withholds every command for an ARN carrying a control byte', async () => {
    expectWithheld(await warnFor(`${ARN}${FORGED_CTRL}`), '--policy-arn');
  });
});

