/**
 * go-to-k/cdkd#6668: a superseded entry carries the generation its deferral
 * read (`identity`), and its carried delete (a later deploy, `cdkd destroy`)
 * compares the holder of the name with it before sending anything, with the
 * cleanup phase's arms (go-to-k/cdkd#6655, the shared
 * `judgeJournaledHolder`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { retryCarriedSupersededResources } from '../../../src/deployment/deploy-engine/superseded-retry.js';
import { SUPERSEDED_KEPT_REMEDY, deleteSupersededEntry } from '../../../src/deployment/superseded-resources.js';
import { journaledHolderRead } from '../../../src/deployment/journaled-holder.js';
import type { ResourceProvider, SurvivorIdentityRead } from '../../../src/types/resource.js';
import type { StackState, SupersededResourceRecord } from '../../../src/types/state.js';

const printed = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', async () => {
  const sink = (level: 'info' | 'warn') =>
    vi.fn((message: unknown) => {
      printed[level].push(String(message));
    });
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: sink('info'),
    warn: sink('warn'),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const D1 = '2026-11-01T00:00:00.000Z';
const D2 = '2026-11-20T00:00:00.000Z';

describe('a superseded entry carrying identity compares the holder first (go-to-k/cdkd#6668)', () => {
  let holder: () => Promise<SurvivorIdentityRead>;
  let reads: number;
  const routed = { delete: vi.fn(async () => undefined) };
  const typed = {
    replacedSurvivorIdentity: vi.fn(() => {
      reads++;
      return holder();
    }),
  };
  const saved = { ...journaledHolderRead };

  beforeEach(() => {
    vi.clearAllMocks();
    notes.length = 0;
    printed.info.length = 0;
    printed.warn.length = 0;
    reads = 0;
    journaledHolderRead.delayMs = 0;
    holder = async () => ({ kind: 'owned', identity: `us-east-1|${D1}` });
  });
  afterEach(() => {
    Object.assign(journaledHolderRead, saved);
  });

  const entry = (extra: Partial<SupersededResourceRecord> = {}): SupersededResourceRecord => ({
    logicalId: 'Bucket',
    supersededAt: 1,
    state: { physicalId: 'bucket-old', resourceType: 'AWS::S3::Bucket', properties: {} },
    identity: `us-east-1|${D1}`,
    ...extra,
  });

  const notes: string[] = [];
  const send = (e: SupersededResourceRecord, withHolder = true, region = 'us-east-1') =>
    deleteSupersededEntry(e, {
      warn: (m) => notes.push(m),
      provider: routed as unknown as ResourceProvider,
      region,
      maskSecrets: (t) => t,
      stop: () => false,
      once: true,
      ...(withHolder && { holderProvider: () => typed }),
    });

  it('deletes the generation it recorded', async () => {
    await expect(send(entry())).resolves.toEqual({ kind: 'deleted' });
    expect(reads).toBe(1);
    expect(routed.delete).toHaveBeenCalledTimes(1);
  });

  it('reads nothing and deletes by name for an entry without identity', async () => {
    const { identity: _none, ...legacy } = entry();
    await expect(send(legacy)).resolves.toEqual({ kind: 'deleted' });
    expect(reads).toBe(0);
    expect(routed.delete).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the name is free', async () => {
    holder = async () => ({ kind: 'gone' });
    await expect(send(entry())).resolves.toEqual({ kind: 'gone' });
    expect(routed.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['other-account', 'owning account'],
    ['other-region', 'region'],
  ] as const)('leaves a %s holder alone, naming the attribute', async (seen, attribute) => {
    holder = async () => ({ kind: 'foreign', seen });
    const outcome = await send(entry());
    expect(outcome.kind).toBe('notOurs');
    expect(outcome.kind === 'notOurs' && outcome.cause).toContain(`its ${attribute} differs`);
    expect(routed.delete).not.toHaveBeenCalled();
  });

  // Measured for #6671: only a re-create moves CreationDate in us-east-1.
  it('leaves another us-east-1 generation alone, naming the creation time only', async () => {
    holder = async () => ({ kind: 'owned', identity: `us-east-1|${D2}` });
    const outcome = await send(entry());
    expect(outcome.kind).toBe('notOurs');
    const text = outcome.kind === 'notOurs' ? outcome.cause : '';
    expect(text).toContain('its creation time differs');
    expect(text).not.toContain(D1);
    expect(text).not.toContain(D2);
    expect(routed.delete).not.toHaveBeenCalled();
  });

  it('deletes despite another generation outside us-east-1, where writes move it', async () => {
    holder = async () => ({ kind: 'owned', identity: `us-west-2|${D2}` });
    await expect(send(entry({ identity: `us-west-2|${D1}` }), true, 'us-west-2')).resolves.toEqual({
      kind: 'deleted',
    });
  });

  // Parent security review S1: a value no run can ever compare (a token of
  // another region than the read's, a malformed one, no holder read) warns
  // and takes the by-name delete of an entry without one, so the entry can
  // leave state.
  it.each([
    ['a token of another region', () => send(entry({ identity: `eu-west-1|${D1}` })), "names another region than the stack's"],
    ['a malformed identity', () => send(entry({ identity: 42 as unknown as string })), 'is malformed'],
    ['an empty identity', () => send(entry({ identity: '' })), 'is malformed'],
    ['no type provider handed in', () => send(entry(), false), 'reads no holder for this resource type'],
  ] as const)('warns and deletes by name, reading nothing, on %s', async (_l, run, reason) => {
    await expect(run()).resolves.toEqual({ kind: 'deleted' });
    expect(reads).toBe(0);
    expect(routed.delete).toHaveBeenCalledTimes(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(reason);
    expect(notes[0]).toContain('so the delete is sent by name');
    expect(notes[0]).not.toContain(D1);
  });

  it('warns and deletes by name when the type provider reads no holder', async () => {
    const outcome = await deleteSupersededEntry(entry(), {
      provider: routed as unknown as ResourceProvider,
      region: 'us-east-1',
      maskSecrets: (t) => t,
      stop: () => false,
      once: true,
      holderProvider: () => ({}),
      warn: (m) => notes.push(m),
    });
    expect(outcome).toEqual({ kind: 'deleted' });
    expect(notes[0]).toContain('reads no holder for this resource type');
  });

  it('words an unread holder without a doubled period or a capitalized product name', async () => {
    holder = async () => ({ kind: 'unknown' });
    const outcome = await send(entry());
    expect(outcome.kind === 'failed' && (outcome.error as Error).message).toBe(
      'No delete was sent: cdkd could not read what holds that name now to confirm it is the resource the deploy replaced'
    );
  });

  it.each([
    ['an unanswered read', async () => ({ kind: 'unknown' }) as SurvivorIdentityRead],
    ['a read that throws', async (): Promise<SurvivorIdentityRead> => { throw new Error('SlowDown'); }],
    ['an owned read without a date', async () => ({ kind: 'owned', identity: undefined }) as SurvivorIdentityRead],
  ] as const)('fails unsent, keeping the entry, on %s (a later run may read it)', async (_l, answer) => {
    holder = answer;
    const outcome = await send(entry());
    expect(outcome.kind).toBe('failed');
    expect(reads).toBe(journaledHolderRead.attempts);
    expect(routed.delete).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });

  // The deploy's carried retry: what it prints and keeps per outcome.
  describe('a later deploy', () => {
    function carry(e: SupersededResourceRecord) {
      const engine = new DeployEngine(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
          getProvider: () => typed,
          getProviderFor: () => ({ provider: routed, provisionedBy: 'cc-api' }),
        } as never,
        { concurrency: 1 } as never,
        'us-east-1'
      );
      const host: Pick<StackState, 'supersededResources'> = { supersededResources: [e] };
      return retryCarriedSupersededResources(engine, host, [e], {}).then(() => host);
    }

    it('drops the entry of a holder proven not the stack, saying it was left alone', async () => {
      holder = async () => ({ kind: 'foreign', seen: 'other-region' });
      const host = await carry(entry());
      expect(routed.delete).not.toHaveBeenCalled();
      expect(host.supersededResources ?? []).toEqual([]);
      expect(printed.warn.join('\n')).toContain('its region differs');
      expect(printed.warn.join('\n')).not.toContain('Delete it manually');
    });

    it('drops the entry of a free name, sending nothing', async () => {
      holder = async () => ({ kind: 'gone' });
      const host = await carry(entry());
      expect(routed.delete).not.toHaveBeenCalled();
      expect(host.supersededResources ?? []).toEqual([]);
      expect(printed.info.join('\n')).toContain('is already gone; no delete was sent');
    });

    it('keeps the entry, unsent, when the holder cannot be read', async () => {
      holder = async () => ({ kind: 'unknown' });
      const e = entry();
      const host = await carry(e);
      expect(routed.delete).not.toHaveBeenCalled();
      expect(host.supersededResources).toEqual([e]);
      const text = printed.warn.join('\n');
      expect(text).toContain(`the deploy replaced. ${SUPERSEDED_KEPT_REMEDY}.`);
      expect(text).not.toContain('..');
      expect(text).not.toContain(D1);
    });
  });
});
