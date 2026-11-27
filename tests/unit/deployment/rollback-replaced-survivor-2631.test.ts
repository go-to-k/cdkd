/**
 * go-to-k/cdkd#2631: the reverse replacement of an op journaled
 * `oldResourceMaySurvive: true` reads AWS for the old resource before it
 * re-creates it: still there, it is re-adopted (no duplicate, no collision);
 * reported gone, it is re-created; unreadable, the op is refused with the
 * journal kept and nothing sent. An op without the flag sends no read.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  probeReplacedSurvivor,
  replacedDeleteFailureVerdict,
} from '../../../src/deployment/rollback-executor/replaced-survivor.js';
import { PASTE_PAYLOADS, expectNoCommandBesideDisplay } from '../utils/paste-harness.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ tag: 'process-global' }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const TYPE = 'AWS::SNS::Topic';

function rec(physicalId: string, overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId,
    resourceType: TYPE,
    properties: { DisplayName: physicalId === 'topic-old' ? 'old' : 'new' },
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
    ...overrides,
  };
}

function op(extra: Partial<CompletedOperation> = {}): CompletedOperation {
  return {
    logicalId: 'Topic',
    changeType: 'UPDATE',
    resourceType: TYPE,
    provisionedBy: 'sdk',
    physicalId: 'topic-new',
    previousState: rec('topic-old', { provisionedBy: 'cc-api' }),
    oldResourceRetained: false,
    oldResourceMaySurvive: 'kept',
    ...extra,
  };
}

describe('reverse replacement of an old resource that may survive (#2631)', () => {
  let live: Set<string>;
  let read: ReturnType<typeof vi.fn>;
  let provider: Record<string, unknown> & {
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let routed: Array<{ resourceType: string; provisionedBy?: string }>;
  let warns: string[];
  let infos: string[];
  let ctx: RollbackExecutorContext;

  beforeEach(() => {
    live = new Set(['topic-old', 'topic-new']);
    read = vi.fn(async (physicalId: string) =>
      live.has(physicalId) ? { DisplayName: 'old' } : RESOURCE_NOT_FOUND
    );
    provider = {
      create: vi.fn(async () => {
        live.add('topic-old-2');
        return { physicalId: 'topic-old-2', attributes: {} };
      }),
      delete: vi.fn(async (_l: string, physicalId: string) => {
        live.delete(physicalId);
      }),
      readCurrentState: read,
    };
    routed = [];
    warns = [];
    infos = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn((m: string) => infos.push(m)),
      warn: vi.fn((m: string) => warns.push(m)),
      error: vi.fn(),
      setLevel: vi.fn(),
      child: () => logger,
    } as unknown as RollbackExecutorContext['logger'];
    ctx = {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: (r: { resourceType: string; provisionedBy?: string }) => {
          routed.push(r);
          return { provider, provisionedBy: r.provisionedBy ?? 'sdk' };
        },
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
  });

  const state = (): Record<string, ResourceState> => ({ Topic: rec('topic-new') });

  it('re-adopts a survivor: deletes the new copy, no re-create, state names the old one', async () => {
    const s = state();
    const result = await replayRollback([op()], s, 'S', ctx);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toBe('topic-old');
    // Read through the OLD record's route.
    expect(routed[0]).toEqual({ resourceType: TYPE, provisionedBy: 'cc-api' });
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.delete.mock.calls[0]![1]).toBe('topic-new');
    expect([...live]).toEqual(['topic-old']);
    expect(s['Topic']!.physicalId).toBe('topic-old');
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(1);
    expect(warns.join('\n')).toContain(
      'the old resource of Topic (topic-old) still exists — the deploy\'s delete of it was not confirmed — so it is re-adopted instead of re-created'
    );
  });

  it('records the re-adopt reason on the success event and names the old resource surviving', async () => {
    const events: Array<Record<string, unknown>> = [];
    ctx.recordEvent = (e) => events.push(e as Record<string, unknown>);
    await replayRollback([op()], state(), 'S', ctx);
    const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(ok?.reason).toContain('re-adopted instead of re-created');
    expect(ok?.reason).toContain('check it with cdkd drift');
    // The deleted new copy's id does not ride as a survivor.
    expect(ok && 'physicalId' in ok).toBe(false);
    expect(infos.join('\n')).toContain('Rollback: Topic restored to the surviving old resource');
    expect(infos.join('\n')).not.toContain('retained old');
  });

  it('records both reasons when the new copy is itself retained', async () => {
    const events: Array<Record<string, unknown>> = [];
    ctx.recordEvent = (e) => events.push(e as Record<string, unknown>);
    await replayRollback([op()], { Topic: rec('topic-new', { updateReplacePolicy: 'Retain' }) }, 'S', ctx);
    const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(ok?.physicalId).toBe('topic-new');
    expect(String(ok?.reason)).toMatch(/; the old resource survived a delete/);
  });

  // go-to-k/cdkd#6374: a delete deferred to the cleanup phase was never sent,
  // so nothing went wrong with the old resource: nothing counted, and no
  // reason on the event (a reason there marks a survivor record). The one
  // warning line is go-to-k/cdkd#6655's: an SNS topic cannot prove identity.
  it('re-adopts a deferred old resource with no count and no reason on its success event', async () => {
    const events: Array<Record<string, unknown>> = [];
    ctx.recordEvent = (e) => events.push(e as Record<string, unknown>);
    const s = state();
    const result = await replayRollback([op({ oldResourceMaySurvive: 'deferred' })], s, 'S', ctx);

    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete.mock.calls.map((c) => c[1])).toEqual(['topic-new']);
    expect(s['Topic']!.physicalId).toBe('topic-old');
    expect(result.warnings).toBe(0);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('cdkd could not prove');
    const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(ok).toBeDefined();
    expect(ok && 'reason' in ok).toBe(false);
    expect(ok && 'physicalId' in ok).toBe(false);
    expect(infos.join('\n')).toContain('Rollback: Topic restored to the surviving old resource');
  });

  // go-to-k/cdkd#6399: a later deploy's cleanup can have deleted the old
  // resource since this segment journaled `'deferred'`. On a read that
  // cannot answer, only state still listing the old resource as superseded
  // licenses the re-adopt.
  describe('a deferred op whose survivor read cannot answer (#6399)', () => {
    const entry = (physicalId: string, resourceType = TYPE) => ({
      logicalId: 'Topic',
      supersededAt: 1,
      state: rec(physicalId, { resourceType }),
    });
    beforeEach(() => {
      read.mockImplementation(async () => {
        throw new Error('ThrottlingException: Rate exceeded');
      });
    });

    it('re-adopts while state still lists the old resource as superseded', async () => {
      ctx.supersededResources = [entry('topic-old')];
      const s = state();
      const result = await replayRollback([op({ oldResourceMaySurvive: 'deferred' })], s, 'S', ctx);
      expect(result.failures).toBe(0);
      expect(provider.delete.mock.calls.map((c) => c[1])).toEqual(['topic-new']);
      expect(s['Topic']!.physicalId).toBe('topic-old');
    });

    it.each([
      ['no entry at all', []],
      ['an entry for another id', [entry('topic-other')]],
      ['an entry of another type under the id', [entry('topic-old', 'AWS::SQS::Queue')]],
    ])('refuses, deleting nothing, when state has %s', async (_label, superseded) => {
      ctx.supersededResources = superseded;
      const s = state();
      const result = await replayRollback([op({ oldResourceMaySurvive: 'deferred' })], s, 'S', ctx);
      expect(result.failures).toBe(1);
      expect(provider.delete).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(s['Topic']!.physicalId).toBe('topic-new');
    });

    it('an existing survivor re-adopts whatever state lists', async () => {
      read.mockImplementation(async () => ({ DisplayName: 'old' }));
      ctx.supersededResources = [];
      const s = state();
      await replayRollback([op({ oldResourceMaySurvive: 'deferred' })], s, 'S', ctx);
      expect(s['Topic']!.physicalId).toBe('topic-old');
    });
  });

  // go-to-k/cdkd#6393: a same-named resource someone else created after the
  // old one went is not the stack's. An AWS-minted identity the old record
  // carries (an IAM role's RoleId) must match the live one to re-adopt.
  describe('a survivor whose recorded identity differs (#6393)', () => {
    const ROLE = 'AWS::IAM::Role';
    const roleOp = (verdict: 'kept' | 'deferred' | 'unconfirmed', recordedRoleId: unknown) =>
      op({
        resourceType: ROLE,
        oldResourceMaySurvive: verdict,
        previousState: {
          // Recorded on Cloud Control: the identity is read through the
          // TYPE's SDK provider anyway, since the CC route has no read for it.
          ...rec('topic-old', { provisionedBy: 'cc-api', resourceType: ROLE }),
          attributes: { RoleId: recordedRoleId },
        },
      });
    const roleState = (): Record<string, ResourceState> => ({
      Topic: rec('topic-new', { resourceType: ROLE }),
    });
    let liveRoleId: () => Promise<unknown>;
    let identityReads: string[];
    beforeEach(() => {
      liveRoleId = async () => 'AROA-OLD';
      identityReads = [];
      // The route the record names answers existence but has no identity
      // read, as CloudControlProvider; the type's SDK provider has one.
      const sdk = {
        resourceIdentity: vi.fn(async (physicalId: string) => {
          identityReads.push(physicalId);
          return liveRoleId();
        }),
      };
      (ctx.providerRegistry as unknown as { getProvider: (t: string) => unknown }).getProvider = () => sdk;
    });

    it.each(['kept', 'deferred'] as const)(
      'refuses a %s op, sending nothing, when the live RoleId is another role',
      async (verdict) => {
        liveRoleId = async () => 'AROA-STRANGER';
        const s = roleState();
        const result = await replayRollback([roleOp(verdict, 'AROA-OLD')], s, 'S', ctx);
        expect(result.failures).toBe(1);
        expect(identityReads).toEqual(['topic-old']);
        expect(provider.delete).not.toHaveBeenCalled();
        expect(provider.create).not.toHaveBeenCalled();
        expect(s['Topic']!.physicalId).toBe('topic-new');
        const text = JSON.stringify(result) + warns.join('\n');
        expect(text).not.toContain('AROA-STRANGER');
        expect(text).not.toContain('delete the old resource by hand');
      }
    );

    // go-to-k/cdkd#6655 (D2): the types whose recorded id equals their
    // `resourceIdentity` token, each compared by its own key.
    it.each([
      ['AWS::IAM::ManagedPolicy', 'PolicyId'],
      ['AWS::DynamoDB::Table', 'TableId'],
      ['AWS::RDS::DBInstance', 'DbiResourceId'],
      ['AWS::RDS::DBCluster', 'DBClusterResourceId'],
      ['AWS::IAM::User', 'UserId'],
      ['AWS::IAM::Group', 'GroupId'],
      ['AWS::IAM::InstanceProfile', 'InstanceProfileId'],
    ] as const)('refuses a %s survivor whose live %s differs', async (type, key) => {
      const typedOp = (recorded: string) =>
        op({
          resourceType: type,
          oldResourceMaySurvive: 'deferred',
          previousState: {
            ...rec('topic-old', { provisionedBy: 'cc-api', resourceType: type }),
            attributes: { [key]: recorded },
          },
        });
      liveRoleId = async () => 'ID-STRANGER';
      const s = { Topic: rec('topic-new', { resourceType: type }) };
      const refused = await replayRollback([typedOp('ID-OLD')], s, 'S', ctx);
      expect(refused.failures).toBe(1);
      expect(provider.delete).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(s['Topic'].physicalId).toBe('topic-new');
      expect(JSON.stringify(refused) + warns.join('\n')).not.toContain('ID-STRANGER');
      // The negative control: the same op whose live id matches re-adopts.
      liveRoleId = async () => 'ID-OLD';
      const matched = { Topic: rec('topic-new', { resourceType: type }) };
      const ok = await replayRollback([typedOp('ID-OLD')], matched, 'S', ctx);
      expect(ok.failures).toBe(0);
      expect(matched['Topic'].physicalId).toBe('topic-old');
    });

    const unverifiedLines = () => warns.filter((w) => w.includes('cdkd could not prove'));

    it('re-adopts with no unverified warning when the live RoleId matches', async () => {
      const s = roleState();
      const result = await replayRollback([roleOp('deferred', 'AROA-OLD')], s, 'S', ctx);
      expect(result.failures).toBe(0);
      expect(s['Topic']!.physicalId).toBe('topic-old');
      expect(unverifiedLines()).toEqual([]);
    });

    // go-to-k/cdkd#6655 (D5): what cannot prove identity keeps re-adopting,
    // with one warning line per op naming the way out; nothing counted.
    describe('a survivor that cannot prove identity (#6655 D5)', () => {
      it.each([
        ['kept', undefined],
        ['deferred', undefined],
        ['kept', ''],
        ['deferred', ''],
      ] as const)(
        'a %s record with RoleId %j re-adopts, warns once, and sends no identity read',
        async (verdict, recorded) => {
          const s = roleState();
          const result = await replayRollback([roleOp(verdict, recorded)], s, 'S', ctx);
          expect(result.failures).toBe(0);
          expect(s['Topic']!.physicalId).toBe('topic-old');
          expect(identityReads).toEqual([]);
          // The kept arm's own survivor warning is the only one counted.
          expect(result.warnings).toBe(verdict === 'kept' ? 1 : 0);
          expect(unverifiedLines()).toHaveLength(1);
          const line = unverifiedLines()[0]!;
          expect(line).toContain('its state record holds no RoleId');
          expect(line).toContain('cdkd state orphan');
          expect(line).toContain('--resource Topic');
          expect(line).not.toContain('topic-old');
        }
      );

      it.each(['kept', 'deferred'] as const)(
        'a %s survivor of a type with no identity attribute re-adopts and warns once, naming the type',
        async (verdict) => {
          const s = state();
          const result = await replayRollback([op({ oldResourceMaySurvive: verdict })], s, 'S', ctx);
          expect(result.failures).toBe(0);
          expect(s['Topic']!.physicalId).toBe('topic-old');
          expect(identityReads).toEqual([]);
          expect(result.warnings).toBe(verdict === 'kept' ? 1 : 0);
          expect(unverifiedLines()).toHaveLength(1);
          expect(unverifiedLines()[0]).toContain(
            `cdkd records no AWS-assigned id for ${TYPE} to compare`
          );
          expect(unverifiedLines()[0]).not.toContain('topic-old');
        }
      );

      it('a journaled op whose old attributes are null re-adopts and warns, never throwing', async () => {
        const nulled = roleOp('kept', undefined);
        (nulled.previousState as unknown as { attributes: unknown }).attributes = null;
        const s = roleState();
        const result = await replayRollback([nulled], s, 'S', ctx);
        expect(result.failures).toBe(0);
        expect(s['Topic']!.physicalId).toBe('topic-old');
        expect(unverifiedLines()).toHaveLength(1);
        expect(unverifiedLines()[0]).toContain('its state record holds no RoleId');
      });

      it('prints no unverified line when the re-adopt itself fails', async () => {
        provider.delete.mockImplementation(async () => {
          throw new Error('AccessDenied: not authorized');
        });
        const s = state();
        const result = await replayRollback(
          [op({ oldResourceMaySurvive: 'deferred' })],
          s,
          'S',
          ctx
        );
        expect(result.failures).toBe(1);
        expect(unverifiedLines()).toEqual([]);
      });

      it('describes a resource type that is not plain instead of printing it', async () => {
        const odd = 'Custom::X$(touch y)';
        const typed = op({
          resourceType: odd,
          oldResourceMaySurvive: 'deferred',
          previousState: rec('topic-old', { resourceType: odd }),
        });
        await replayRollback([typed], { Topic: rec('topic-new', { resourceType: odd }) }, 'S', ctx);
        expect(unverifiedLines()).toHaveLength(1);
        expect(unverifiedLines()[0]).not.toContain('$(touch');
      });

      it('a type whose provider has no identity read re-adopts and warns once', async () => {
        (ctx.providerRegistry as unknown as { getProvider: (t: string) => unknown }).getProvider =
          () => ({});
        const s = roleState();
        const result = await replayRollback([roleOp('kept', 'AROA-OLD')], s, 'S', ctx);
        expect(result.failures).toBe(0);
        expect(s['Topic']!.physicalId).toBe('topic-old');
        expect(unverifiedLines()).toHaveLength(1);
        expect(unverifiedLines()[0]).toContain(`cdkd has no read of the RoleId for ${ROLE}`);
        expect(unverifiedLines()[0]).not.toContain('AROA-OLD');
      });

      it('an unconfirmed op is still refused, with no unverified warning', async () => {
        const s = roleState();
        const result = await replayRollback([roleOp('unconfirmed', undefined)], s, 'S', ctx);
        expect(result.failures).toBe(1);
        expect(provider.delete).not.toHaveBeenCalled();
        expect(s['Topic']!.physicalId).toBe('topic-new');
        expect(unverifiedLines()).toEqual([]);
      });

      it('a non-plain logical id is described, and the command keeps a hole', async () => {
        const odd = 'Topic$(x)';
        const typed = op({ logicalId: odd, oldResourceMaySurvive: 'deferred' });
        await replayRollback([typed], { [odd]: rec('topic-new') }, 'S', ctx);
        expect(unverifiedLines()).toHaveLength(1);
        expect(unverifiedLines()[0]).not.toContain(odd);
      });
    });

    // go-to-k/cdkd#6655 (D5): an id was recorded but could not be compared
    // this time: the existing `'unknown'` handling (go-to-k/cdkd#6399).
    describe('a recorded id that could not be compared takes the unknown rule (#6655 D5)', () => {
      // [label, recorded, live read, transient]: only a failed read is worth a re-run.
      const cases = [
        ['the recorded RoleId is masked', '***', async (): Promise<unknown> => 'AROA-STRANGER', false],
        [
          'the identity read fails',
          'AROA-OLD',
          async (): Promise<unknown> => {
            throw new Error('AccessDenied');
          },
          true,
        ],
        ['the identity read cannot name it', 'AROA-OLD', async (): Promise<unknown> => undefined, false],
      ] as const;
      const uncomparedLines = () => warns.filter((w) => w.includes('could not compare it'));

      it.each(cases)(
        'refuses a kept op, sending nothing, worded for the compare, when %s',
        async (_label, recorded, live, transient) => {
          liveRoleId = live;
          const s = roleState();
          const result = await replayRollback([roleOp('kept', recorded)], s, 'S', ctx);
          expect(result.failures).toBe(1);
          expect(provider.delete).not.toHaveBeenCalled();
          expect(provider.create).not.toHaveBeenCalled();
          expect(s['Topic']!.physicalId).toBe('topic-new');
          expect(unverifiedLines()).toEqual([]);
          const text = warns.join('\n');
          expect(text).toContain('AWS reports a resource under that id, but');
          expect(text).toContain('RoleId');
          expect(text).toContain("cannot be proven the stack's");
          // Not the existence read's wording, and no hand delete of what may be another's.
          expect(text).not.toContain('cdkd could not read whether it does');
          expect(text).not.toContain('delete the old resource by hand');
          expect(text).toContain('--orphan');
          if (transient) {
            expect(text).toContain('the read of its RoleId failed');
            expect(text).toContain('reads it again');
            expect(text).not.toContain('a re-run meets the same answer');
          } else {
            expect(text).toContain('could not compare it with the recorded RoleId');
            expect(text).toContain('a re-run meets the same answer');
            expect(text).not.toContain('reads it again');
          }
          expect(JSON.stringify(result) + text).not.toContain('AROA-STRANGER');
          expect(text).not.toContain('AROA-OLD');
        }
      );

      it.each(cases)(
        'a deferred op re-adopts, warned once, only while state lists it as superseded, when %s',
        async (_label, recorded, live) => {
          liveRoleId = live;
          const listed = {
            logicalId: 'Topic',
            supersededAt: 1,
            state: rec('topic-old', { resourceType: ROLE }),
          };
          ctx.supersededResources = [listed];
          const s = roleState();
          const ok = await replayRollback([roleOp('deferred', recorded)], s, 'S', ctx);
          expect(ok.failures).toBe(0);
          expect(ok.warnings).toBe(0);
          expect(s['Topic']!.physicalId).toBe('topic-old');
          expect(unverifiedLines()).toHaveLength(1);
          expect(uncomparedLines()).toHaveLength(1);
          expect(uncomparedLines()[0]).toContain('state still lists it as awaiting its delete');
          expect(uncomparedLines()[0]).toContain('--resource Topic');
          expect(uncomparedLines()[0]).not.toContain('AROA-');

          warns.length = 0;
          ctx.supersededResources = [];
          const refusedState = roleState();
          const refused = await replayRollback([roleOp('deferred', recorded)], refusedState, 'S', ctx);
          expect(refused.failures).toBe(1);
          expect(refusedState['Topic']!.physicalId).toBe('topic-new');
          expect(uncomparedLines()).toHaveLength(1);
          expect(unverifiedLines()).toEqual([]);
        }
      );

      it('an existence read that fails keeps its own re-run wording', async () => {
        read.mockImplementation(async () => {
          throw new Error('ThrottlingException: Rate exceeded');
        });
        const s = roleState();
        const result = await replayRollback([roleOp('kept', 'AROA-OLD')], s, 'S', ctx);
        expect(result.failures).toBe(1);
        expect(identityReads).toEqual([]);
        const text = warns.join('\n');
        expect(text).toContain('cdkd could not read whether it does');
        expect(text).not.toContain('could not compare it');
      });
    });

    it('re-creates when the identity read finds the role gone after the existence read', async () => {
      liveRoleId = async () => RESOURCE_NOT_FOUND;
      const s = roleState();
      await replayRollback([roleOp('deferred', 'AROA-OLD')], s, 'S', ctx);
      expect(provider.create).toHaveBeenCalledTimes(1);
    });

    it('never asks for an identity on a type the table does not list', async () => {
      await replayRollback([op({ oldResourceMaySurvive: 'deferred' })], state(), 'S', ctx);
      expect(identityReads).toEqual([]);
    });
  });

  it('a deferred re-adopt whose new copy is retained records only the retained reason', async () => {
    const events: Array<Record<string, unknown>> = [];
    ctx.recordEvent = (e) => events.push(e as Record<string, unknown>);
    await replayRollback(
      [op({ oldResourceMaySurvive: 'deferred' })],
      { Topic: rec('topic-new', { updateReplacePolicy: 'Retain' }) },
      'S',
      ctx
    );
    const ok = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(ok?.physicalId).toBe('topic-new');
    expect(String(ok?.reason)).toContain('UpdateReplacePolicy: Retain');
    expect(String(ok?.reason)).not.toContain('the old resource survived');
    expect(String(ok?.reason)).not.toContain('undefined');
  });

  it('re-creates an old resource AWS reports gone, as before', async () => {
    live.delete('topic-old');
    const s = state();
    const result = await replayRollback([op()], s, 'S', ctx);

    // The existence read of the old id, then the re-created copy's drift
    // baseline (go-to-k/cdkd#7129).
    expect(read.mock.calls.map((c) => c[0])).toEqual(['topic-old', 'topic-old-2']);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(s['Topic']!.physicalId).toBe('topic-old-2');
    expect(live.has('topic-new')).toBe(false);
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(0);
    expect(infos.join('\n')).toContain('the old resource of Topic (topic-old) is gone — re-creating it');
  });

  // go-to-k/cdkd#6713: an `'unconfirmed'` delete was sent by the deploy, so a
  // gone old resource is one the deploy deleted; a `'kept'` one was not sent.
  it.each([
    ['unconfirmed' as const, 1],
    ['kept' as const, 0],
  ])('a %s old resource found gone: the early-delete advisory lines %d', async (verdict, n) => {
    live.delete('topic-old');
    const result = await replayRollback([op({ oldResourceMaySurvive: verdict })], state(), 'S', ctx);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(
      warns.filter((m) =>
        m.includes('the deploy deleted the old resource before the deploy succeeded')
      )
    ).toHaveLength(n);
    expect(result.warnings).toBe(0);
  });

  it('sends no read for an op without the flag (an ordinary reverse replacement)', async () => {
    const s = state();
    await replayRollback([op({ oldResourceMaySurvive: undefined })], s, 'S', ctx);
    // No existence read of the old id; the only read is the re-created copy's
    // drift baseline (go-to-k/cdkd#7129).
    expect(read.mock.calls.map((c) => c[0])).toEqual(['topic-old-2']);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  const refusalCases: Array<[string, () => void, string]> = [
    [
      'the provider has no read',
      () => {
        delete provider['readCurrentState'];
      },
      'cdkd has no read for this resource type that can tell whether it does.',
    ],
    [
      'the read answers an empty bag',
      () => {
        read.mockResolvedValue({});
      },
      'cdkd has no read for this resource type that can tell whether it does.',
    ],
    [
      'the read answers undefined',
      () => {
        read.mockResolvedValue(undefined);
      },
      'cdkd has no read for this resource type that can tell whether it does.',
    ],
    [
      'the read answers a non-object',
      () => {
        read.mockResolvedValue(['DisplayName']);
      },
      'cdkd could not read whether it does',
    ],
    [
      'the old type cannot be routed for the read',
      () => {
        const route = ctx.providerRegistry.getProviderFor;
        let calls = 0;
        (ctx.providerRegistry as unknown as { getProviderFor: unknown }).getProviderFor = (
          r: never
        ) => {
          if (++calls === 1) throw new Error('no provider for this type');
          return route(r);
        };
      },
      'cdkd could not read whether it does',
    ],
    [
      'the read throws',
      () => {
        read.mockRejectedValue(new Error('AccessDenied'));
      },
      'cdkd could not read whether it does (the read failed or did not answer in time); re-running cdkd rollback reads it again.',
    ],
  ];
  for (const [name, arrange, why] of refusalCases) {
    it(`refuses, sending nothing, when ${name}`, async () => {
      arrange();
      const s = state();
      const failed: Array<Record<string, unknown>> = [];
      ctx.recordEvent = (e) => {
        if (e.eventType === 'ROLLBACK_RESOURCE_FAILED') failed.push(e as Record<string, unknown>);
      };
      const result = await replayRollback([op()], s, 'S', ctx);

      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
      expect(s['Topic']!.physicalId).toBe('topic-new');
      expect(result.failures).toBe(1);
      const text = warns.join('\n');
      expect(text).toContain(
        'Cannot reverse the replacement of Topic (AWS::SNS::Topic): the deploy did not confirm that it deleted the old resource (topic-old), so it may still exist, and ' +
          why
      );
      expect(text).toContain('Nothing was sent and the journal is kept.');
      expect(text).toContain('--orphan Topic');
      expect(failed).toHaveLength(1);
    });
  }

  // Both lines name a `cdkd` command, so a non-plain old id is described.
  for (const payload of PASTE_PAYLOADS) {
    it(`shows no ${payload.label} old id beside a command, on the re-adopt and refusal lines`, async () => {
      const prev = rec(payload.value, { provisionedBy: 'cc-api' });
      live.add(payload.value);
      await replayRollback([op({ previousState: prev })], state(), 'S', ctx);
      read.mockRejectedValue(new Error('AccessDenied'));
      await replayRollback([op({ previousState: prev })], state(), 'S', ctx);
      const survivorLines = warns.filter((w) => w.includes('the old resource') || w.includes('old resource ('));
      expect(survivorLines.length).toBeGreaterThanOrEqual(2);
      for (const line of survivorLines) expectNoCommandBesideDisplay(line, payload.value);
    });
  }

  it('refuses, naming the interruption, when the rollback is interrupted during the read', async () => {
    let interrupted = false;
    read.mockImplementation(
      () =>
        new Promise(() => {
          interrupted = true;
        })
    );
    const s = state();
    const result = await replayRollback([op()], s, 'S', ctx, { isInterrupted: () => interrupted });
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(s['Topic']!.physicalId).toBe('topic-new');
    expect(result.failures).toBe(1);
    expect(warns.join('\n')).toContain(
      'the rollback was interrupted before cdkd could read whether it does'
    );
  });

  it('refuses an alive old resource whose delete may still be running, sending nothing', async () => {
    const s = state();
    const result = await replayRollback([op({ oldResourceMaySurvive: 'unconfirmed' })], s, 'S', ctx);
    expect(read).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(s['Topic']!.physicalId).toBe('topic-new');
    expect(result.failures).toBe(1);
    expect(warns.join('\n')).toContain(
      'so it may still exist, and AWS still reports it, but its failed delete may have been accepted and still be running, or only partly ran.'
    );
  });

  it('re-creates an unconfirmed old resource AWS reports gone', async () => {
    live.delete('topic-old');
    const s = state();
    const result = await replayRollback([op({ oldResourceMaySurvive: 'unconfirmed' })], s, 'S', ctx);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(s['Topic']!.physicalId).toBe('topic-old-2');
    expect(result.failures).toBe(0);
  });

  it('names no id, rather than "undefined", when the old record has none', async () => {
    const result = await replayRollback(
      [op({ previousState: { ...rec('topic-old', { provisionedBy: 'cc-api' }), physicalId: '' } })],
      state(),
      'S',
      ctx
    );
    expect(result.failures).toBe(1);
    const text = warns.join('\n');
    expect(text).toContain('deleted the old resource (no recorded id)');
    expect(text).not.toContain('(undefined)');
  });

  it('reads a Type-changed old resource through its OLD type', async () => {
    const OLD = 'AWS::SNS::OldTopic';
    const s = state();
    const result = await replayRollback(
      [op({ previousResourceType: OLD, previousState: rec('topic-old', { provisionedBy: 'cc-api', resourceType: OLD }) })],
      s,
      'S',
      ctx
    );
    expect(routed[0]).toEqual({ resourceType: OLD, provisionedBy: 'cc-api' });
    expect(read.mock.calls[0]![2]).toBe(OLD);
    // The readopt deletes the NEW copy through the new type.
    expect(routed.some((r) => r.resourceType === TYPE)).toBe(true);
    expect(provider.delete.mock.calls[0]![2]).toBe(TYPE);
    expect(s['Topic']!.resourceType).toBe(OLD);
    expect(result.failures).toBe(0);
  });

  it('re-adopts without deleting a new copy that is itself retained', async () => {
    const s = { Topic: rec('topic-new', { updateReplacePolicy: 'Retain' }) };
    const result = await replayRollback([op()], s, 'S', ctx);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(s['Topic']!.physicalId).toBe('topic-old');
    expect(result.failures).toBe(0);
  });
});

describe('probeReplacedSurvivor', () => {
  const scope = (provider: unknown, isInterrupted?: () => boolean) => ({
    op: op(),
    ctx: {
      region: 'us-east-1',
      logger: {} as never,
      providerRegistry: { getProviderFor: () => ({ provider }) } as never,
    },
    secrets: new Map(),
    isInterrupted,
  });

  it('sends no read once the rollback is interrupted', async () => {
    const readCurrentState = vi.fn();
    expect(await probeReplacedSurvivor(scope({ readCurrentState }, () => true), TYPE)).toBe(
      'interrupted'
    );
    expect(readCurrentState).not.toHaveBeenCalled();
  });

  it('stops waiting for a read when the rollback is interrupted mid-read', async () => {
    let interrupted = false;
    const provider = { readCurrentState: () => new Promise(() => undefined) };
    const started = Date.now();
    const pending = probeReplacedSurvivor(scope(provider, () => interrupted), TYPE, 60_000);
    setTimeout(() => {
      interrupted = true;
    }, 50);
    expect(await pending).toBe('interrupted');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('leaves no timer or interrupt poll behind once the read answers', async () => {
    vi.useFakeTimers();
    try {
      const provider = { readCurrentState: async () => ({ DisplayName: 'old' }) };
      // go-to-k/cdkd#6655: an SNS topic records no AWS-minted id to compare.
      expect(await probeReplacedSurvivor(scope(provider, () => false), TYPE)).toBe(
        'identity-unverified'
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers unknown when the read does not answer in time', async () => {
    const provider = { readCurrentState: () => new Promise(() => undefined) };
    const verdict = await probeReplacedSurvivor(
      {
        op: op(),
        ctx: {
          region: 'us-east-1',
          logger: {} as never,
          providerRegistry: { getProviderFor: () => ({ provider }) } as never,
        },
        secrets: new Map(),
        isInterrupted: undefined,
      },
      TYPE,
      5
    );
    expect(verdict).toBe('unknown');
  });

  it('answers unknown for an old record with no usable physical id, without routing', async () => {
    const getProviderFor = vi.fn();
    const verdict = await probeReplacedSurvivor(
      {
        op: op({ previousState: rec('', { provisionedBy: 'cc-api' }) }),
        ctx: {
          region: 'us-east-1',
          logger: {} as never,
          providerRegistry: { getProviderFor } as never,
        },
        secrets: new Map(),
        isInterrupted: undefined,
      },
      TYPE
    );
    expect(verdict).toBe('unknown');
    expect(getProviderFor).not.toHaveBeenCalled();
  });
});

describe('replacedDeleteFailureVerdict', () => {
  const named = (name: string, extra: Record<string, unknown> = {}): Error =>
    Object.assign(new Error('x'), { name }, extra);

  it('is kept only for an outright AWS refusal, by name, Code or code, through causes', () => {
    for (const name of ['AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'AuthorizationError', 'DependencyViolation', 'DeleteConflict', 'DeleteConflictException']) {
      expect(replacedDeleteFailureVerdict(named(name))).toBe('kept');
    }
    expect(replacedDeleteFailureVerdict(Object.assign(new Error('x'), { Code: 'AccessDenied' }))).toBe('kept');
    expect(replacedDeleteFailureVerdict(Object.assign(new Error('x'), { code: 'UnauthorizedOperation' }))).toBe('kept');
    expect(
      replacedDeleteFailureVerdict(new Error('wrapped', { cause: new Error('mid', { cause: named('AccessDenied') }) }))
    ).toBe('kept');
  });

  it('is unconfirmed for anything that may leave a delete running', () => {
    expect(replacedDeleteFailureVerdict(new Error('Timed out waiting for DBInstance to be deleted'))).toBe('unconfirmed');
    expect(replacedDeleteFailureVerdict(named('ConflictException'))).toBe('unconfirmed');
    // DynamoDB / Kinesis answer it for a resource already DELETING.
    expect(replacedDeleteFailureVerdict(named('ResourceInUseException'))).toBe('unconfirmed');
    expect(replacedDeleteFailureVerdict(named('ResourceInUse'))).toBe('unconfirmed');
    expect(replacedDeleteFailureVerdict(named('InvalidDBInstanceState'))).toBe('unconfirmed');
    // Read off the NAME, never the message.
    expect(replacedDeleteFailureVerdict(new Error('AccessDenied: in the message only'))).toBe('unconfirmed');
    expect(replacedDeleteFailureVerdict('AccessDenied')).toBe('unconfirmed');
    expect(replacedDeleteFailureVerdict(undefined)).toBe('unconfirmed');
  });
});
