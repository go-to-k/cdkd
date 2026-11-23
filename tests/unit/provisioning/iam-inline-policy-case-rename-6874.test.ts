/**
 * go-to-k/cdkd#6874: IAM holds one inline policy per name ignoring case on a
 * principal, and a put in another case keeps the first spelling (measured
 * us-east-1, 2026-11-23). The role / user / group updates paired names
 * exactly, so a case-only rename put the new spelling (replacing the
 * document) and then deleted the old one: the only policy. They now delete
 * the old spelling FIRST and then put the new one, the order CloudFormation
 * uses (CloudTrail of a CFn A/B: DeleteRolePolicy CasePol, PutRolePolicy
 * casepol; backward the same), and a real removal still deletes.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

import { NoSuchEntityException } from '@aws-sdk/client-iam';
import {
  planInlinePolicyNames,
  updateInlinePolicies,
} from '../../../src/provisioning/providers/iam-role/update.js';
import { updateGroupInlinePolicies } from '../../../src/provisioning/providers/iam-user-group/group.js';
import { updateUserInlinePolicies } from '../../../src/provisioning/providers/iam-user-group/user-update.js';
import { collectInlinePolicyNamesManagedBySiblings } from '../../../src/provisioning/providers/iam-role-provider.js';
import { createMaskedLogSinks } from '../../../src/provisioning/masked-retry-logger.js';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const DOC_A = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }] };
const DOC_B = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:PutObject', Resource: '*' }] };

let calls: string[];
let send: ReturnType<typeof vi.fn>;
const log = createMaskedLogSinks({ debug: () => {}, warn: () => {} }, undefined);

beforeEach(() => {
  calls = [];
  send = vi.fn(async (command: Cmd) => {
    calls.push(`${command.constructor.name.replace(/Command$/, '')} ${String(command.input['PolicyName'])}`);
    return {};
  });
});

const KINDS = [
  {
    kind: 'role',
    prefix: 'Role',
    run: (next: unknown[], prev: unknown[]) =>
      updateInlinePolicies.call({ iamClient: { send } } as never, 'p', next as never, prev as never, log),
  },
  {
    kind: 'group',
    prefix: 'Group',
    run: (next: unknown[], prev: unknown[]) =>
      updateGroupInlinePolicies.call(
        { iamClient: { send } } as never,
        'p',
        next as never,
        prev as never,
        log,
        undefined
      ),
  },
  {
    kind: 'user',
    prefix: 'User',
    run: (next: unknown[], prev: unknown[]) =>
      updateUserInlinePolicies.call(
        { iamClient: { send } } as never,
        'p',
        next as never,
        prev as never,
        log,
        undefined
      ),
  },
] as const;

describe.each(KINDS)('$kind inline Policies (go-to-k/cdkd#6874)', ({ prefix, run }) => {
  it('a case-only rename deletes the old spelling first, then puts the new one with its document', async () => {
    await run([{ PolicyName: 'casepol', PolicyDocument: DOC_B }], [
      { PolicyName: 'CasePol', PolicyDocument: DOC_A },
    ]);
    expect(calls).toEqual([`Delete${prefix}Policy CasePol`, `Put${prefix}Policy casepol`]);
    const put = send.mock.calls.at(-1)![0] as Cmd;
    expect(JSON.parse(String(put.input['PolicyDocument']))).toEqual(DOC_B);
  });

  it('the rollback replay (backward rename) does the same in the other direction', async () => {
    await run([{ PolicyName: 'CasePol', PolicyDocument: DOC_A }], [
      { PolicyName: 'casepol', PolicyDocument: DOC_B },
    ]);
    expect(calls).toEqual([`Delete${prefix}Policy casepol`, `Put${prefix}Policy CasePol`]);
  });

  it('a rename beyond case puts the new name, then deletes the old one (a real removal)', async () => {
    await run([{ PolicyName: 'CasePol2', PolicyDocument: DOC_B }], [
      { PolicyName: 'CasePol', PolicyDocument: DOC_A },
    ]);
    expect(calls).toEqual([`Put${prefix}Policy CasePol2`, `Delete${prefix}Policy CasePol`]);
  });

  it('a policy dropped from the list is deleted; an unchanged name is only re-put', async () => {
    await run([{ PolicyName: 'Keep', PolicyDocument: DOC_A }], [
      { PolicyName: 'Keep', PolicyDocument: DOC_A },
      { PolicyName: 'Gone', PolicyDocument: DOC_B },
    ]);
    expect(calls).toEqual([`Put${prefix}Policy Keep`, `Delete${prefix}Policy Gone`]);
  });

  it('an old spelling already gone (NoSuchEntity) still gets the new one put', async () => {
    send.mockImplementationOnce(async (command: Cmd) => {
      calls.push(`${command.constructor.name.replace(/Command$/, '')} ${String(command.input['PolicyName'])}`);
      throw new NoSuchEntityException({ $metadata: {}, message: 'gone' });
    });
    await run([{ PolicyName: 'casepol', PolicyDocument: DOC_B }], [
      { PolicyName: 'CasePol', PolicyDocument: DOC_A },
    ]);
    expect(calls).toEqual([`Delete${prefix}Policy CasePol`, `Put${prefix}Policy casepol`]);
  });
});

describe('planInlinePolicyNames', () => {
  it('splits case-only respellings from removals; exact names are neither', () => {
    expect(planInlinePolicyNames(['a', 'B', 'c'], ['a', 'b', 'C2', 'd'])).toEqual({
      respelled: ['b'],
      removed: ['C2', 'd'],
    });
  });
});

describe('the sibling inline-policy filter ignores case (go-to-k/cdkd#6874)', () => {
  const siblings = (policyName: string, role: string) => ({
    siblings: {
      Pol: {
        resourceType: 'AWS::IAM::Policy',
        properties: { PolicyName: policyName, Roles: [role] },
      },
    },
  });

  it("a sibling's case-only renamed policy, still listed in the old spelling, is the sibling's", () => {
    const owned = collectInlinePolicyNamesManagedBySiblings(
      'my-role',
      siblings('casepol', 'my-role') as never,
      'Roles'
    );
    expect(owned.has('CasePol')).toBe(true);
    expect([...owned]).toEqual(['casepol']);
  });

  it('a principal named in another case is the same role', () => {
    const owned = collectInlinePolicyNamesManagedBySiblings(
      'my-role',
      siblings('pol', 'My-Role') as never,
      'Roles'
    );
    expect(owned.has('pol')).toBe(true);
  });

  it('a name or role differing beyond case is not the sibling\'s', () => {
    expect(
      collectInlinePolicyNamesManagedBySiblings('my-role', siblings('casepol2', 'my-role') as never, 'Roles').has(
        'CasePol'
      )
    ).toBe(false);
    expect(
      collectInlinePolicyNamesManagedBySiblings('my-role', siblings('casepol', 'my-role2') as never, 'Roles').has(
        'casepol'
      )
    ).toBe(false);
  });
});
