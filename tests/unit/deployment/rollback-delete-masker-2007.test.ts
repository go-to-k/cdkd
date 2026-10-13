import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayFailedOperations,
  replayRollback,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { createOpMasker } from '../../../src/deployment/rollback-executor/names.js';
import { withReplayDeletePrinting } from '../../../src/deployment/rollback-executor/replay-scope.js';
import { markCreatedBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { SECRET_MASK, type RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';
import type { DeleteContext } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

// go-to-k/cdkd#2007: a rollback deletes what the FAILED DEPLOY made, with the
// bag and the name the deploy resolved, while each op's own bag re-resolves
// the PREVIOUS generation. Every replay delete therefore hands the provider a
// `DeleteContext.maskSecrets` over both, and runs under both as printing bags,
// so a secret that differs between the two generations prints from neither
// the provider's own lines nor the replay's.

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});
const ssmSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ ssm: { send: ssmSend } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const TYPE = 'AWS::SSM::Parameter';
/** Resolved by the failed deploy only: in no op's re-resolution. */
const DEPLOY_SECRET = 'deploy-generation-secret-2007';
/** The previous generation's value, which only the op's re-resolution holds. */
const PREVIOUS_SECRET = 'previous-generation-secret-2007';

const warnSpy = vi.fn();
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: warnSpy,
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

function res(physicalId: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId, resourceType: TYPE, properties, attributes: {}, dependencies: [] };
}

function deployBag(): RecordedSecretValues {
  return new Map([[DEPLOY_SECRET, '{{resolve:secretsmanager:x:SecretString:k::}}']]);
}

interface Seen {
  physicalId: string;
  context: DeleteContext | undefined;
  printed: string;
}

/** A provider whose `delete()` records its context and how a line it logs prints. */
function provider(
  seen: Seen[],
  extra: Record<string, unknown> = {},
  deleteImpl?: () => Promise<unknown>
) {
  return {
    ...extra,
    delete: vi.fn(
      (_l: string, physicalId: string, _t: string, _props: unknown, context?: DeleteContext) => {
        seen.push({
          physicalId,
          context,
          printed: (currentLogLineMasker() ?? ((t: string) => t))(`Deleting ${DEPLOY_SECRET}`),
        });
        return deleteImpl ? deleteImpl() : Promise.resolve(undefined);
      }
    ),
  };
}

function ctxFor(
  p: unknown,
  bag: RecordedSecretValues | undefined,
  events: string[] = []
): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider: p, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (e) => {
      if (e.error?.message) events.push(e.error.message);
    },
    ...(bag && { logOnlyNeedlesFor: (id: string) => (id === 'R' ? bag : undefined) }),
  };
}

/** One delete, of `physicalId` (the arm under test), masking the deploy bag. */
function expectMasked(seen: Seen[], physicalId: string): void {
  expect(seen.map((x) => x.physicalId)).toEqual([physicalId]);
  const mask = seen[0]!.context?.maskSecrets;
  expect(mask).toBeTypeOf('function');
  expect(mask!(`x ${DEPLOY_SECRET}`)).toBe(`x ${SECRET_MASK}`);
  expect(seen[0]!.printed).toBe(`Deleting ${SECRET_MASK}`);
}

describe('rollback replay deletes mask the failed deploy bag (go-to-k/cdkd#2007)', () => {
  beforeEach(() => warnSpy.mockClear());

  it("a completed CREATE's delete", async () => {
    const seen: Seen[] = [];
    const ops: CompletedOperation[] = [
      { logicalId: 'R', changeType: 'CREATE', resourceType: TYPE, physicalId: 'phys' },
    ];
    await replayRollback(
      ops,
      { R: res('phys', { Value: DEPLOY_SECRET }) },
      'S',
      ctxFor(provider(seen), deployBag())
    );
    expectMasked(seen, 'phys');
  });

  it("a reverse replacement's delete of the NEW resource", async () => {
    const seen: Seen[] = [];
    const create = vi.fn().mockResolvedValue({ physicalId: 'old' });
    const p = provider(seen, { create });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'new',
        previousState: res('old', { Name: 'old', Value: 'previous-generation' }),
      },
    ];
    await replayRollback(
      ops,
      { R: res('new', { Name: 'new', Value: DEPLOY_SECRET }) },
      'S',
      ctxFor(p, deployBag())
    );
    expect(create).toHaveBeenCalled();
    expectMasked(seen, 'new');
  });

  it("a reverse replacement's delete of the NEW resource FIRST (the forward deleted the old first)", async () => {
    const seen: Seen[] = [];
    const create = vi.fn().mockResolvedValue({ physicalId: 'old' });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'new',
        oldDeletedBeforeCreate: true,
        previousState: res('old', { Name: 'old', Value: 'previous-generation' }),
      },
    ];
    await replayRollback(
      ops,
      { R: res('new', { Name: 'new', Value: DEPLOY_SECRET }) },
      'S',
      ctxFor(provider(seen, { create }), deployBag())
    );
    expect(create).toHaveBeenCalled();
    expectMasked(seen, 'new');
  });

  it('the delete of what a failed re-create of the OLD resource made', async () => {
    const seen: Seen[] = [];
    const create = vi
      .fn()
      .mockRejectedValue(
        markCreatedBeforeFailure(new Error('tagging failed'), 'R', TYPE, 'made-by-recreate')
      );
    const ops: CompletedOperation[] = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'new',
        previousState: res('old', { Name: 'old', Value: 'previous-generation' }),
      },
    ];
    await replayRollback(
      ops,
      { R: res('new', { Name: 'new', Value: DEPLOY_SECRET }) },
      'S',
      ctxFor(provider(seen, { create }), deployBag())
    );
    expectMasked(seen, 'made-by-recreate');
  });

  it('a retained replacement\'s delete of the NEW copy (re-adopting the old one)', async () => {
    const seen: Seen[] = [];
    const ops: CompletedOperation[] = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'new',
        oldResourceRetained: true,
        previousState: res('old', { Name: 'old', Value: 'previous-generation' }),
      },
    ];
    await replayRollback(
      ops,
      { R: res('new', { Name: 'new', Value: DEPLOY_SECRET }) },
      'S',
      ctxFor(provider(seen), deployBag())
    );
    expectMasked(seen, 'new');
  });

  it("a failed CREATE's delete", async () => {
    const seen: Seen[] = [];
    const op: FailedOperation = {
      logicalId: 'R',
      changeType: 'CREATE',
      resourceType: TYPE,
      physicalId: 'phys',
      attemptedProperties: { Value: DEPLOY_SECRET },
    };
    await replayFailedOperations(
      [op],
      { R: res('phys', { Value: DEPLOY_SECRET }) },
      'S',
      ctxFor(provider(seen), deployBag())
    );
    expectMasked(seen, 'phys');
  });

  // The issue's own case: the secret ROTATED, so the op's re-resolution of the
  // previous generation holds one plaintext and the failed deploy's bag another.
  it('a rotated secret: one delete masks both generations', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: PREVIOUS_SECRET } });
    const seen: Seen[] = [];
    const create = vi.fn().mockResolvedValue({ physicalId: 'old' });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'new',
        previousState: res('old', { Name: 'old', Value: '{{resolve:ssm-secure:/p/2007}}' }),
      },
    ];
    await replayRollback(
      ops,
      { R: res('new', { Name: 'new', Value: DEPLOY_SECRET }) },
      'S',
      ctxFor(provider(seen, { create }), deployBag())
    );
    // Non-vacuity: the re-create was handed the previous generation resolved.
    expect(create.mock.calls[0]![2]).toMatchObject({ Value: PREVIOUS_SECRET });
    expectMasked(seen, 'new');
    expect(seen[0]!.context!.maskSecrets!(`x ${PREVIOUS_SECRET}`)).toBe(`x ${SECRET_MASK}`);
    expect(
      (currentLogLineMasker() ?? ((t: string) => t))(PREVIOUS_SECRET),
      'nothing stays bound after the replay'
    ).toBe(PREVIOUS_SECRET);
  });

  it("masks the replay's own failure line and event with the deploy bag too", async () => {
    const seen: Seen[] = [];
    const events: string[] = [];
    const p = provider(seen, {}, () =>
      Promise.reject(new Error(`AccessDenied on ${DEPLOY_SECRET}`))
    );
    const ops: CompletedOperation[] = [
      { logicalId: 'R', changeType: 'CREATE', resourceType: TYPE, physicalId: 'phys' },
    ];
    await replayRollback(
      ops,
      { R: res('phys', { Value: DEPLOY_SECRET }) },
      'S',
      ctxFor(p, deployBag(), events)
    );
    expect(events.join('\n')).toContain('AccessDenied');
    expect(events.join('\n')).not.toContain(DEPLOY_SECRET);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('AccessDenied');
    expect(warned).not.toContain(DEPLOY_SECRET);
  });

  it('`cdkd rollback` (no deploy bag) still hands a masker, which cannot know the value', async () => {
    const seen: Seen[] = [];
    const ops: CompletedOperation[] = [
      { logicalId: 'R', changeType: 'CREATE', resourceType: TYPE, physicalId: 'phys' },
    ];
    await replayRollback(
      ops,
      { R: res('phys', { Value: DEPLOY_SECRET }) },
      'S',
      ctxFor(provider(seen), undefined)
    );
    expect(seen[0]!.context?.maskSecrets!(DEPLOY_SECRET)).toBe(DEPLOY_SECRET);
    expect(seen[0]!.printed).toBe(`Deleting ${DEPLOY_SECRET}`);
  });
});

describe('withReplayDeletePrinting (go-to-k/cdkd#2007)', () => {
  it("binds the op's own bag, as well as the deploy's, for the provider's lines", () => {
    const secrets: RecordedSecretValues = new Map([['op-generation-secret', 'e1']]);
    const printed = withReplayDeletePrinting(
      { ctx: ctxFor({}, deployBag()), op: { logicalId: 'R' } as CompletedOperation, secrets },
      () => currentLogLineMasker()!(`op-generation-secret ${DEPLOY_SECRET}`)
    );
    expect(printed).toBe(`${SECRET_MASK} ${SECRET_MASK}`);
  });
});

describe('createOpMasker over a deploy bag (go-to-k/cdkd#2007)', () => {
  it('masks both bags in ONE pass, so an overlap across them leaves no tail', () => {
    // Bag by bag, the op's `abcdef1234` would mask first and leave the deploy
    // needle's `5678` tail, or the reverse.
    const op: RecordedSecretValues = new Map([['abcdef1234', 'e1']]);
    const deploy: RecordedSecretValues = new Map([['1234567890', 'e2']]);
    const masker = createOpMasker(logger, op, deploy);
    expect(masker.mask('x abcdef1234567890 y')).toBe(`x ${SECRET_MASK} y`);
  });

  it('reads both bags by reference', () => {
    const op: RecordedSecretValues = new Map();
    const deploy: RecordedSecretValues = new Map();
    const masker = createOpMasker(logger, op, deploy);
    op.set('op-later-value', 'e1');
    deploy.set('deploy-later-value', 'e2');
    expect(masker.mask('op-later-value deploy-later-value')).toBe(
      `${SECRET_MASK} ${SECRET_MASK}`
    );
  });
});
