/**
 * go-to-k/cdkd#6655: an `AWS::IAM::Policy` delete removes the inline policy
 * from each principal BY NAME, and runs before that principal's own delete
 * (and its identity compare). Each principal the policy names that is a
 * record of this stack with a recorded identity id is read and compared
 * first; another holder of the name is sent nothing and the delete refuses.
 *
 * Every case drives the provider's real `delete()` against a mocked IAM
 * client, inside the stack-records scope a deploy / destroy / rollback binds.
 * The identity table lists `RoleId`, `GroupId` and `UserId` (go-to-k/cdkd#6679,
 * #6693); the pin test below checks each reader against it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

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
    child: vi.fn(function (this: unknown) { return this; }),
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

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import { RECORDED_IDENTITY_REREAD_DELAY_MS } from '../../../src/provisioning/recorded-identity.js';
import { SURVIVOR_IDENTITY_ATTRIBUTES } from '../../../src/deployment/recorded-identity-attributes.js';
import { getLogger } from '../../../src/utils/logger.js';
import { INLINE_POLICY_PRINCIPAL_SPECS } from '../../../src/provisioning/providers/iam-policy/principal-identity.js';
import {
  deployStackRecordsView,
  destroyStackRecordsView,
  withStackRecords,
} from '../../../src/deployment/stack-records-scope.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { stateOrphanRecordRemedy } from '../../../src/provisioning/state-orphan-remedy.js';
import type { UpdateContext } from '../../../src/types/resource.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';
import type { ResourceState } from '../../../src/types/state.js';

type Handler = (input: Record<string, unknown>) => unknown;

let sent: Array<{ name: string; input: Record<string, unknown> }>;

function drive(handlers: Record<string, Handler>): void {
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      const handler = handlers[name];
      return handler ? handler(command.input) : {};
    }
  );
}

const names = (): string[] => sent.map((s) => s.name);
/** The principal each Delete*Policy went to. */
const deletedFrom = (): string[] =>
  sent
    .filter((s) => /^Delete(Role|Group|User)Policy/.test(s.name))
    .map((s) => String(s.input['RoleName'] ?? s.input['GroupName'] ?? s.input['UserName']));
const reads = (): string[] => names().filter((n) => /^Get(Role|Group|User)Command$/.test(n));

function record(
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown> = {}
): ResourceState {
  return { resourceType, physicalId, properties: {}, attributes, dependencies: [] } as ResourceState;
}

const RECORDED = 'AROA-recorded';
const SUCCESSOR = 'AROA-successor';

/** Live ids by principal name, answered by every Get{Role,Group,User}. */
function liveIds(ids: Record<string, string | Error>): Record<string, Handler> {
  const answer = (name: unknown, wrap: (id: string) => unknown) => {
    const id = ids[String(name)];
    if (id === undefined) {
      throw new NoSuchEntityException({ message: 'gone', $metadata: {} });
    }
    if (id instanceof Error) throw id;
    return wrap(id);
  };
  return {
    GetRoleCommand: (i) => answer(i['RoleName'], (RoleId) => ({ Role: { RoleId } })),
    GetGroupCommand: (i) => answer(i['GroupName'], (GroupId) => ({ Group: { GroupId } })),
    GetUserCommand: (i) => answer(i['UserName'], (UserId) => ({ User: { UserId } })),
  };
}

function del(
  records: Record<string, ResourceState> | undefined,
  properties: Record<string, unknown>,
  context?: DeleteContext
): Promise<unknown> {
  const run = () =>
    new IAMPolicyProvider().delete('P', 'my-policy', 'AWS::IAM::Policy', properties, context);
  return records === undefined ? run() : withStackRecords(destroyStackRecordsView(records), run);
}

async function settled(promise: Promise<unknown>): Promise<{ value?: unknown; error?: Error }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error as Error })
  );
  await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS);
  return outcome;
}

async function thrownBy(promise: Promise<unknown>): Promise<Error> {
  const { error } = await settled(promise);
  if (error === undefined) throw new Error('expected the delete to throw');
  return error;
}

const props = { PolicyName: 'inline', Roles: ['my-role'] };

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  sent = [];
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AWS::IAM::Policy delete compares in-stack principals (go-to-k/cdkd#6655)', () => {
  it('the in-stack role carries its recorded RoleId: read once, then removed as before', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    const { error } = await settled(
      del(
        {
          R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }),
          P: record('AWS::IAM::Policy', 'inline'),
        },
        props
      )
    );
    expect(error).toBeUndefined();
    expect(names()).toEqual(['GetRoleCommand', 'DeleteRolePolicyCommand']);
  });

  it('another RoleId under the name: nothing sent to it, refused non-retryably', async () => {
    drive(liveIds({ 'my-role': SUCCESSOR }));
    const error = await thrownBy(
      del({ R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) }, props)
    );
    // The read and its one re-read after the wait; no write.
    expect(names()).toEqual(['GetRoleCommand', 'GetRoleCommand']);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(isDeleteStarted(error)).toBe(false);
    expect(error.message).toContain('IAM policy P from IAM role R (its RoleId differs)');
    expect(error.message).toContain('kept the record');
    // The remedy ends the message (D1).
    expect(error.message.endsWith(`${stateOrphanRecordRemedy(undefined, 'P')}.`)).toBe(true);
    expect(error.message).toContain('cdkd state orphan');
    expect(error.message).toContain('--resource P');
    expect(error.message).not.toContain(RECORDED);
    expect(error.message).not.toContain(SUCCESSOR);
    expect(error.message).not.toMatch(/does not exist|not found|NoSuchEntity/i);
  });

  it('a stack destroy names the whole-stack orphan form', async () => {
    drive(liveIds({ 'my-role': SUCCESSOR }));
    const error = await thrownBy(
      del({ R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) }, props, {
        stackDestroy: true,
      })
    );
    expect(error.message).toContain('which drops every record');
  });

  it('a first read still answering the previous holder: the re-read decides', async () => {
    let n = 0;
    drive({ GetRoleCommand: () => ({ Role: { RoleId: ++n === 1 ? SUCCESSOR : RECORDED } }) });
    const { error } = await settled(
      del({ R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) }, props)
    );
    expect(error).toBeUndefined();
    expect(names()).toEqual(['GetRoleCommand', 'GetRoleCommand', 'DeleteRolePolicyCommand']);
  });

  it('a principal outside the stack: no read, removed by name as before', async () => {
    drive({});
    await del({ Other: record('AWS::IAM::Role', 'other-role', { RoleId: RECORDED }) }, props);
    expect(names()).toEqual(['DeleteRolePolicyCommand']);
  });

  it('no stack-records scope bound (drift --revert): no read', async () => {
    drive({});
    await del(undefined, props);
    expect(names()).toEqual(['DeleteRolePolicyCommand']);
  });

  it('a legacy in-stack record without the id: no read', async () => {
    drive({});
    await del({ R: record('AWS::IAM::Role', 'my-role') }, props);
    expect(names()).toEqual(['DeleteRolePolicyCommand']);
  });

  it.each([
    ['masked', '***'],
    ['partly masked', 'AROA***'],
    ['a secret reference', '{{resolve:secretsmanager:s:SecretString:id}}'],
    ['empty', ''],
  ])('a %s recorded id is no id: no read', async (_label, value) => {
    drive({});
    await del({ R: record('AWS::IAM::Role', 'my-role', { RoleId: value }) }, props);
    expect(names()).toEqual(['DeleteRolePolicyCommand']);
  });

  it('an unreadable principal: thrown to the retry classifier, nothing removed', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'Throttling',
      $metadata: { httpStatusCode: 400 },
    });
    drive(liveIds({ 'my-role': throttle }));
    const error = await thrownBy(
      del({ R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) }, props)
    );
    expect(names()).toEqual(['GetRoleCommand']);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(isRetryableTransientError(error, error.message)).toBe(true);
  });

  it('a read answering without an id: not gone, nothing removed, worded for the policy', async () => {
    drive({ GetRoleCommand: () => ({ Role: {} }) });
    const error = await thrownBy(
      del({ R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) }, props)
    );
    expect(names()).toEqual(['GetRoleCommand']);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(error.message).toContain('Cannot delete IAM policy P from IAM role R');
  });

  it('the in-stack role already gone: no delete sent, the idempotent arm', async () => {
    drive(liveIds({}));
    const { error, value } = await settled(
      del({ R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) }, props)
    );
    expect(error).toBeUndefined();
    expect(value).toBeUndefined();
    expect(names()).toEqual(['GetRoleCommand']);
  });

  it('a principal another resource of this deploy claimed: neither read nor removed', async () => {
    drive({});
    await del({ R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) }, props, {
      inlinePolicyClaimed: () => true,
    });
    expect(names()).toEqual([]);
  });

  it('the legacy "<policy>:<role>" physical id is compared too', async () => {
    drive(liveIds({ 'my-role': SUCCESSOR }));
    const run = () =>
      new IAMPolicyProvider().delete('P', 'inline:my-role', 'AWS::IAM::Policy', undefined);
    const error = await thrownBy(
      withStackRecords(
        destroyStackRecordsView({
          R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }),
        }),
        run
      )
    );
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(deletedFrom()).toEqual([]);
  });

  it('several principals mixed: every other one is done, the stranger is not, then refused', async () => {
    drive(
      liveIds({
        'ours-role': RECORDED,
        'taken-role': SUCCESSOR,
        'ours-group': 'AGPA-ours',
        'taken-user': 'AIDA-other',
      })
    );
    const error = await thrownBy(
      del(
        {
          Ours: record('AWS::IAM::Role', 'ours-role', { RoleId: RECORDED }),
          Taken: record('AWS::IAM::Role', 'taken-role', { RoleId: RECORDED }),
          Legacy: record('AWS::IAM::Role', 'legacy-role'),
          G: record('AWS::IAM::Group', 'ours-group', { GroupId: 'AGPA-ours' }),
          U: record('AWS::IAM::User', 'taken-user', { UserId: 'AIDA-ours' }),
        },
        {
          PolicyName: 'inline',
          Roles: ['ours-role', 'taken-role', 'legacy-role', 'external-role', 'ours-role'],
          Groups: ['ours-group'],
          Users: ['taken-user'],
        }
      )
    );
    // One read per in-stack principal with an id (a name listed twice read
    // once), all issued before any removal, plus each stranger's re-read.
    expect(reads().slice(0, 4).sort()).toEqual([
      'GetGroupCommand',
      'GetRoleCommand',
      'GetRoleCommand',
      'GetUserCommand',
    ]);
    expect(reads()).toHaveLength(6);
    expect(names().findIndex((n) => n.startsWith('Delete'))).toBe(6);
    expect(deletedFrom()).toEqual([
      'ours-role',
      'legacy-role',
      'external-role',
      'ours-role',
      'ours-group',
    ]);
    expect(isMarkedNonRetryable(error)).toBe(true);
    // Removed from some principals: never read as a whole survivor.
    expect(isDeleteStarted(error)).toBe(true);
    expect(error.message).toContain(
      'IAM role Taken (its RoleId differs), IAM user U (its UserId differs)'
    );
  });

  it('two records of one name: a re-read answering the second id is ours, not a refusal', async () => {
    let n = 0;
    drive({ GetRoleCommand: () => ({ Role: { RoleId: ++n === 1 ? SUCCESSOR : 'AROA-second' } }) });
    const { error } = await settled(
      del(
        {
          R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }),
          Stale: record('AWS::IAM::Role', 'my-role', { RoleId: 'AROA-second' }),
        },
        props
      )
    );
    expect(error).toBeUndefined();
    expect(names()).toEqual(['GetRoleCommand', 'GetRoleCommand', 'DeleteRolePolicyCommand']);
  });

  it('a failed read is thrown only once every other read settled (no wait outlives the attempt)', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'Throttling',
      $metadata: { httpStatusCode: 400 },
    });
    drive(liveIds({ 'throttled-role': throttle, 'taken-role': SUCCESSOR }));
    let thrown: unknown;
    const run = del(
      {
        A: record('AWS::IAM::Role', 'throttled-role', { RoleId: RECORDED }),
        B: record('AWS::IAM::Role', 'taken-role', { RoleId: RECORDED }),
      },
      { PolicyName: 'inline', Roles: ['throttled-role', 'taken-role'] }
    ).catch((error: unknown) => {
      thrown = error;
    });
    await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS - 1);
    expect(thrown).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    // The throttle, wrapped by the delete's failure (named by its class).
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('Throttling');
    // B's re-read ran inside this attempt; nothing was removed.
    expect(names()).toEqual(['GetRoleCommand', 'GetRoleCommand', 'GetRoleCommand']);
  });

  it('at most five principal reads in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    mockSend.mockImplementation(
      async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name !== 'GetRoleCommand') return {};
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return { Role: { RoleId: RECORDED } };
    }
    );
    const roleNames = Array.from({ length: 12 }, (_, i) => `role-${i}`);
    await del(
      Object.fromEntries(
        roleNames.map((name, i) => [`R${i}`, record('AWS::IAM::Role', name, { RoleId: RECORDED })])
      ),
      { PolicyName: 'inline', Roles: roleNames }
    );
    expect(reads()).toHaveLength(12);
    expect(peak).toBe(5);
    expect(deletedFrom()).toEqual(roleNames);
  });
});

describe('principal specs agree with the identity table', () => {
  it('each spec reads the attribute the table lists for its type', async () => {
    for (const spec of Object.values(INLINE_POLICY_PRINCIPAL_SPECS)) {
      expect(SURVIVOR_IDENTITY_ATTRIBUTES[spec.resourceType]).toBe(spec.attribute);
    }
  });
});

describe('AWS::IAM::Policy update compares the in-stack principals it removes (go-to-k/cdkd#6655)', () => {
  const DOC = { Version: '2012-10-17', Statement: [] };
  const warn = () => getLogger().child('x').warn as unknown as ReturnType<typeof vi.fn>;
  const upd = (
    records: Record<string, ResourceState>,
    previous: Record<string, unknown>,
    desired: Record<string, unknown>,
    context?: UpdateContext
  ) =>
    // A deploy's view in which the staying role `S` was created by this
    // deploy: its put is not compared (go-to-k/cdkd#6722), so these cases
    // pin the removal side alone.
    withStackRecords(
      deployStackRecordsView(records, records, new Set(), undefined, undefined, (lid) => lid === 'S'),
      () =>
      new IAMPolicyProvider().update(
        'P',
        'inline',
        'AWS::IAM::Policy',
        { PolicyName: 'inline', PolicyDocument: DOC, ...desired },
        { PolicyName: 'inline', PolicyDocument: DOC, ...previous },
        context
      )
    );
  const stays = record('AWS::IAM::Role', 'stays', { RoleId: 'AROA-stays' });

  it('a leaving in-stack role carrying its RoleId: read, then removed as before', async () => {
    drive(liveIds({ leaves: RECORDED }));
    const { error } = await settled(
      upd(
        { S: stays, L: record('AWS::IAM::Role', 'leaves', { RoleId: RECORDED }) },
        { Roles: ['stays', 'leaves'] },
        { Roles: ['stays'] }
      )
    );
    expect(error).toBeUndefined();
    // Only the leaver is read, before any write.
    expect(names()).toEqual(['GetRoleCommand', 'PutRolePolicyCommand', 'DeleteRolePolicyCommand']);
    expect(deletedFrom()).toEqual(['leaves']);
  });

  it('a leaving role held by another RoleId: sent nothing, warned, the update completes', async () => {
    drive(liveIds({ leaves: SUCCESSOR }));
    warn().mockClear();
    const { error, value } = await settled(
      upd(
        { S: stays, L: record('AWS::IAM::Role', 'leaves', { RoleId: RECORDED }) },
        { Roles: ['stays', 'leaves'] },
        { Roles: ['stays'] }
      )
    );
    expect(error).toBeUndefined();
    expect(deletedFrom()).toEqual([]);
    expect(names()).toEqual(['GetRoleCommand', 'GetRoleCommand', 'PutRolePolicyCommand']);
    // No narrowing: the record takes the desired lists.
    expect(value).not.toHaveProperty('effectiveProperties');
    const lines = warn().mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('IAM role L leaving') && l.includes('RoleId differs'))).toBe(
      true
    );
    expect(lines.join('\n')).not.toContain(RECORDED);
    expect(lines.join('\n')).not.toContain(SUCCESSOR);
  });

  it('a leaving group and user compare their GroupId / UserId', async () => {
    drive(liveIds({ g: 'AGPA-other', u: 'AIDA-ours' }));
    const { error } = await settled(
      upd(
        {
          S: stays,
          G: record('AWS::IAM::Group', 'g', { GroupId: 'AGPA-ours' }),
          U: record('AWS::IAM::User', 'u', { UserId: 'AIDA-ours' }),
        },
        { Roles: ['stays'], Groups: ['g'], Users: ['u'] },
        { Roles: ['stays'] }
      )
    );
    expect(error).toBeUndefined();
    expect(deletedFrom()).toEqual(['u']);
    expect(names()).toContain('GetGroupCommand');
    expect(names()).toContain('GetUserCommand');
  });

  it('a leaving principal outside the stack, or without a recorded id: no read', async () => {
    drive({});
    await upd(
      { S: stays, L: record('AWS::IAM::Role', 'legacy') },
      { Roles: ['stays', 'legacy', 'external'] },
      { Roles: ['stays'] }
    );
    expect(reads()).toEqual([]);
    expect(deletedFrom()).toEqual(['legacy', 'external']);
  });

  it('an unreadable leaving principal: thrown before any write', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'Throttling',
      $metadata: { httpStatusCode: 400 },
    });
    drive(liveIds({ leaves: throttle }));
    const error = await thrownBy(
      upd(
        { S: stays, L: record('AWS::IAM::Role', 'leaves', { RoleId: RECORDED }) },
        { Roles: ['stays', 'leaves'] },
        { Roles: ['stays'] }
      )
    );
    expect(names()).toEqual(['GetRoleCommand']);
    expect(isRetryableTransientError(error, error.message)).toBe(true);
  });

  it('a leaving principal already gone: no removal sent', async () => {
    drive(liveIds({}));
    await settled(
      upd(
        { S: stays, L: record('AWS::IAM::Role', 'leaves', { RoleId: RECORDED }) },
        { Roles: ['stays', 'leaves'] },
        { Roles: ['stays'] }
      )
    );
    expect(names()).toEqual(['GetRoleCommand', 'PutRolePolicyCommand']);
  });

  it('a leaver another resource of this deploy claimed: neither read nor written', async () => {
    drive(liveIds({ leaves: SUCCESSOR }));
    const inlinePolicyClaimed = vi.fn(
      (kind: string, name: string) => kind === 'role' && name === 'leaves'
    );
    const { error } = await settled(
      upd(
        { S: stays, L: record('AWS::IAM::Role', 'leaves', { RoleId: RECORDED }) },
        { Roles: ['stays', 'leaves'] },
        { Roles: ['stays'] },
        { inlinePolicyClaimed }
      )
    );
    expect(error).toBeUndefined();
    expect(names()).toEqual(['PutRolePolicyCommand']);
    expect(inlinePolicyClaimed).toHaveBeenCalledWith('role', 'leaves', 'inline');
  });

  it('a leaving principal answered without its id: refused, worded for the update', async () => {
    drive({ GetRoleCommand: () => ({ Role: {} }) });
    const error = await thrownBy(
      upd(
        { S: stays, L: record('AWS::IAM::Role', 'leaves', { RoleId: RECORDED }) },
        { Roles: ['stays', 'leaves'] },
        { Roles: ['stays'] }
      )
    );
    expect(names()).toEqual(['GetRoleCommand']);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(error.message).toContain(
      'Cannot remove IAM policy P from IAM role L during an update: AWS answered without its RoleId'
    );
    expect(error.message).not.toContain('Cannot delete');
  });
});
