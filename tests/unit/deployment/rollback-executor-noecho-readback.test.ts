import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { ResourceState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

/**
 * go-to-k/cdkd#4043 Phase C (design section 4.4): a rollback revert of a
 * record that holds a NoEcho value only as `***` at a `noEchoLeaves`
 * coordinate reads the resource back and leaves the leaf as AWS holds it. It
 * never sends `***`, never re-persists the value, and masks it in every line
 * and event, a short or numeric value included. An unreadable leaf, and a
 * re-create with no live resource, refuse with a NoEcho-specific remedy.
 */

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: vi.fn() }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const PARAM_TYPE = 'AWS::SSM::Parameter';
const LIVE = 'live-noecho-value-4043';

const lines: string[] = [];
const push = (line: unknown): void => {
  lines.push(String(line));
};
const logger = {
  debug: vi.fn(push),
  info: vi.fn(push),
  warn: vi.fn(push),
  error: vi.fn(push),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

const events: unknown[] = [];

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: PARAM_TYPE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(provider: Record<string, unknown>): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: (event) => {
      events.push(event);
    },
  };
}

/** A baseline and a current record, both masked at `Value` by a NoEcho source. */
function marked(physicalId = 'phys'): {
  prev: ResourceState;
  state: Record<string, ResourceState>;
  ops: CompletedOperation[];
} {
  const prev = res({
    physicalId,
    properties: { Name: '/app/token', Value: SECRET_MASK, Description: 'old' },
    noEchoLeaves: [['Value']],
  });
  const state: Record<string, ResourceState> = {
    Param: res({
      properties: { Name: '/app/token', Value: SECRET_MASK, Description: 'new' },
      noEchoLeaves: [['Value']],
    }),
  };
  const ops: CompletedOperation[] = [
    {
      logicalId: 'Param',
      changeType: 'UPDATE',
      resourceType: PARAM_TYPE,
      physicalId: 'phys',
      previousState: prev,
    },
  ];
  return { prev, state, ops };
}

const persisted = (state: Record<string, ResourceState>): string => JSON.stringify(state);

beforeEach(() => {
  lines.length = 0;
  events.length = 0;
  resetAccountInfoCache();
});

describe('rollback revert of a marked NoEcho leaf (go-to-k/cdkd#4043 Phase C)', () => {
  it('substitutes the value AWS holds, never sends the mask, and re-persists only the mask', async () => {
    // An attribute echoing the value under an undeclared name: the value arm
    // (the mask-only needle) is what masks it in the restored record.
    const update = vi
      .fn()
      .mockResolvedValue({ physicalId: 'phys', wasReplaced: false, attributes: { Echo: LIVE } });
    const readCurrentState = vi
      .fn()
      .mockResolvedValue({ Name: '/app/token', Value: LIVE, Description: 'new' });
    const { state, ops } = marked();

    const result = await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

    expect(result.failures).toBe(0);
    // Routed by the live record, handed that record MASKED at the coordinate.
    expect(readCurrentState).toHaveBeenCalledTimes(1);
    expect(readCurrentState.mock.calls[0]![0]).toBe('phys');
    expect((readCurrentState.mock.calls[0]![3] as Record<string, unknown>)['Value']).toBe(
      SECRET_MASK
    );
    const [, , , desired, previous] = update.mock.calls[0]! as [
      string,
      string,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(desired).toEqual({ Name: '/app/token', Value: LIVE, Description: 'old' });
    // The other side holds the same value, so a patch provider writes nothing there.
    expect(previous['Value']).toBe(LIVE);
    expect(JSON.stringify(update.mock.calls)).not.toContain(`"${SECRET_MASK}"`);
    // The restored record keeps the mask and the coordinates.
    expect(state['Param']!.properties).toEqual({
      Name: '/app/token',
      Value: SECRET_MASK,
      Description: 'old',
    });
    expect(state['Param']!.noEchoLeaves).toEqual([['Value']]);
    expect(persisted(state)).not.toContain(LIVE);
    expect(JSON.stringify(events)).not.toContain(LIVE);
  });

  // The record is masked BY POSITION, so a value of any type or length. A
  // line or event embedding the value is masked by the log-only needle, whose
  // substring arm keeps the mask-only floor (`MIN_NEEDLE_LENGTH`): a 1-3
  // character value is masked there only as a whole line, the documented
  // floor residual of design section 3.3.
  it.each([
    ['a 3-character value', 'q7z', false],
    ['a numeric value', 4242, true],
    ['a string value', LIVE, true],
  ])('masks %s in the record (and, from 4 characters, in the lines and the durable event)', async (_label, value, inText) => {
    const spelled = String(value);
    const update = vi.fn().mockResolvedValue({
      physicalId: 'phys',
      wasReplaced: false,
      outcome: 'partial',
      reason: `left a copy holding ${spelled} behind`,
      // A provider reporting the value it applied.
      effectiveProperties: { Name: '/app/token', Value: value, Description: 'old' },
      attributes: { Value: value },
    });
    const readCurrentState = vi.fn().mockResolvedValue({ Name: '/app/token', Value: value });
    const { prev, state, ops } = marked();
    prev.noEchoAttributeNames = ['Value'];

    const result = await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

    expect(result.failures).toBe(0);
    expect((update.mock.calls[0]![3] as Record<string, unknown>)['Value']).toBe(value);
    expect(state['Param']!.properties['Value']).toBe(SECRET_MASK);
    expect(state['Param']!.attributes?.['Value']).toBe(SECRET_MASK);
    const succeeded = events.find(
      (e) => (e as { eventType?: string }).eventType === 'ROLLBACK_RESOURCE_SUCCEEDED'
    ) as { reason?: string };
    if (inText) {
      expect(succeeded.reason).toContain(SECRET_MASK);
      expect(succeeded.reason).not.toContain(spelled);
      expect(lines.join('\n')).not.toContain(spelled);
    }
    expect(persisted(state)).not.toContain(`"${spelled}"`);
    expect(persisted(state)).not.toContain(`:${spelled}`);
  });

  it('masks the value in a failed update\'s line and ROLLBACK_RESOURCE_FAILED event', async () => {
    const update = vi.fn().mockRejectedValue(new Error(`ValidationException: bad value ${LIVE}`));
    const readCurrentState = vi.fn().mockResolvedValue({ Name: '/app/token', Value: LIVE });
    const { state, ops } = marked();

    const result = await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

    expect(result.failures).toBe(1);
    expect(lines.join('\n')).not.toContain(LIVE);
    expect(JSON.stringify(events)).not.toContain(LIVE);
    expect(JSON.stringify(events)).toContain('ROLLBACK_RESOURCE_FAILED');
  });

  it.each([
    ['echoes the mask it was handed', { Name: '/app/token', Value: SECRET_MASK }],
    ['does not return the value', { Name: '/app/token' }],
  ])('a readback that %s is not readable: refuses, sends nothing', async (_label, live) => {
    const update = vi.fn();
    const readCurrentState = vi.fn().mockResolvedValue(live);
    const { state, ops } = marked();

    const result = await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

    expect(update).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('holds a NoEcho value only as the redaction mask');
    expect(text).toContain('Value');
    expect(text).toContain("'cdkd deploy', which sends the NoEcho parameter's value again");
    expect(text).toContain('cannot read the value AWS holds there');
  });

  it('hands the provider the live record MASKED, so an echo of an in-process plaintext is never substituted', async () => {
    const update = vi.fn();
    // Echoes the bag it was handed, as a provider does for a field AWS omits.
    const readCurrentState = vi.fn(
      (_id: string, _l: string, _t: string, handed: Record<string, unknown>) =>
        Promise.resolve({ ...handed })
    );
    const { state, ops } = marked();
    state['Param']!.properties['Value'] = 'failed-deploy-plaintext';

    const result = await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

    expect(update).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(lines.join('\n')).toContain('holds a NoEcho value only as the redaction mask');
  });

  it('a provider with no readback refuses with the NoEcho remedy', async () => {
    const update = vi.fn();
    const { state, ops } = marked();

    const result = await replayRollback(ops, state, 'S', makeCtx({ update }));

    expect(update).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(lines.join('\n')).toContain('holds a NoEcho value only as the redaction mask');
  });

  it('a failing readback refuses as a retryable read, without printing its error', async () => {
    const update = vi.fn();
    const readCurrentState = vi.fn().mockRejectedValue(new Error(`AccessDenied ${LIVE}`));
    const { state, ops } = marked();

    const result = await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

    expect(update).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(lines.join('\n')).toContain('reading the resource back from AWS failed');
    expect(lines.join('\n')).not.toContain(LIVE);
  });

  it('an UNMARKED mask still takes the general refusal (the custom-resource class)', async () => {
    const update = vi.fn();
    const readCurrentState = vi.fn().mockResolvedValue({ Name: '/app/token', Value: LIVE });
    const { prev, state, ops } = marked();
    prev.properties['Other'] = SECRET_MASK;

    const result = await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

    expect(update).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(lines.join('\n')).toContain('four ways a baseline comes to hold it');
  });

  it('--revert-failed substitutes the same way', async () => {
    // A provider reporting what it applied, under the value arm's floor: only
    // the positional arm masks it in the restored record.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'phys',
      wasReplaced: false,
      effectiveProperties: { Name: '/app/token', Value: 'q7z' },
    });
    const readCurrentState = vi.fn().mockResolvedValue({ Name: '/app/token', Value: LIVE });
    const { prev, state } = marked();
    const failed: FailedOperation[] = [
      {
        logicalId: 'Param',
        changeType: 'UPDATE',
        resourceType: PARAM_TYPE,
        physicalId: 'phys',
        previousState: prev,
        attemptedProperties: { Name: '/app/token', Value: SECRET_MASK, Description: 'new' },
      },
    ];

    const result = await replayFailedOperations(
      failed,
      state,
      'S',
      makeCtx({ update, readCurrentState }),
      {}
    );

    expect(result.failures).toBe(0);
    expect((update.mock.calls[0]![3] as Record<string, unknown>)['Value']).toBe(LIVE);
    expect((update.mock.calls[0]![4] as Record<string, unknown>)['Value']).toBe(LIVE);
    expect(state['Param']!.properties['Value']).toBe(SECRET_MASK);
    expect(state['Param']!.noEchoLeaves).toEqual([['Value']]);
    expect(persisted(state)).not.toContain(LIVE);
  });

  it('a re-create (reverse-replacement) refuses with the NoEcho remedy: no live resource to read', async () => {
    const create = vi.fn();
    const del = vi.fn();
    const readCurrentState = vi.fn();
    const { state, ops } = marked('phys-OLD');
    state['Param']!.physicalId = 'phys-NEW';
    ops[0]!.physicalId = 'phys-NEW';

    const result = await replayRollback(
      ops,
      state,
      'S',
      makeCtx({ create, delete: del, readCurrentState })
    );

    expect(create).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('there is no live resource to read that value back from');
    expect(text).not.toContain('four ways a baseline comes to hold it');
  });

  it("a nested stack row's marked Parameters leaf is inert: replayed without a readback or a refusal", async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'child', wasReplaced: false });
    const readCurrentState = vi.fn();
    const NESTED = 'AWS::CloudFormation::Stack';
    const row = (template: string): ResourceState =>
      res({
        physicalId: 'child',
        resourceType: NESTED,
        properties: { TemplateURL: template, Parameters: { Token: SECRET_MASK } },
        noEchoLeaves: [['Parameters', 'Token']],
      });
    const state = { Child: row('new') };
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Child',
        changeType: 'UPDATE',
        resourceType: NESTED,
        physicalId: 'child',
        previousState: row('old'),
      },
    ];

    const result = await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

    expect(result.failures).toBe(0);
    expect(readCurrentState).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    // The replaying-state arm reads none of these properties.
    expect((update.mock.calls[0]![5] as { replayingState?: boolean }).replayingState).toBe(true);
  });

  describe('review round 1 (#4752)', () => {
    /** A revert op over a baseline/current pair the case builds. */
    const opFor = (prev: ResourceState): CompletedOperation[] => [
      {
        logicalId: 'Param',
        changeType: 'UPDATE',
        resourceType: prev.resourceType,
        physicalId: 'phys',
        previousState: prev,
      },
    ];

    it('a readback that never settles refuses as read-failed once the cap passes, sending nothing', async () => {
      vi.useFakeTimers();
      try {
        const update = vi.fn();
        const readCurrentState = vi.fn(() => new Promise(() => {}));
        const { state, ops } = marked();
        const running = replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));
        await vi.advanceTimersByTimeAsync(30_000);
        const result = await running;
        expect(update).not.toHaveBeenCalled();
        expect(result.failures).toBe(1);
        expect(lines.join('\n')).toContain('reading the resource back from AWS failed');
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('substitutes at a NESTED coordinate and inside a list paired by its identity field, without mutating the journal', async () => {
      const update = vi.fn().mockResolvedValue({ physicalId: 'phys', wasReplaced: false });
      const prev = res({
        properties: {
          Env: { Variables: { TOKEN: SECRET_MASK, PLAIN: 'p' } },
          Tags: [
            { Key: 'a', Value: 'x' },
            { Key: 'secret', Value: SECRET_MASK },
          ],
        },
        noEchoLeaves: [
          ['Env', 'Variables', 'TOKEN'],
          ['Tags', 1, 'Value'],
        ],
      });
      const journal = JSON.stringify(prev);
      // AWS returns the tags in another order.
      const readCurrentState = vi.fn().mockResolvedValue({
        Env: { Variables: { TOKEN: LIVE, PLAIN: 'p' } },
        Tags: [
          { Key: 'secret', Value: 'tag-live-value-4043' },
          { Key: 'a', Value: 'x' },
        ],
      });
      const state = { Param: res({ properties: { ...structuredClone(prev.properties), Changed: 'by-failed-deploy' } }) };

      const result = await replayRollback(opFor(prev), state, 'S', makeCtx({ update, readCurrentState }));

      expect(result.failures).toBe(0);
      const desired = update.mock.calls[0]![3] as {
        Env: { Variables: Record<string, unknown> };
        Tags: Array<Record<string, unknown>>;
      };
      expect(desired.Env.Variables).toEqual({ TOKEN: LIVE, PLAIN: 'p' });
      expect(desired.Tags[1]).toEqual({ Key: 'secret', Value: 'tag-live-value-4043' });
      expect(JSON.stringify(prev)).toBe(journal);
      expect(persisted(state)).not.toContain(LIVE);
      expect(persisted(state)).not.toContain('tag-live-value-4043');
    });

    it.each([
      ['a list no identity field pairs, reordered', { L: ['b', 'a'] }, [['L', 1]], { L: ['a', SECRET_MASK] }],
      ['a null from AWS', { V: null }, [['V']], { V: SECRET_MASK }],
      ["a service's own placeholder", { V: '****' }, [['V']], { V: SECRET_MASK }],
      ['a placeholder inside a list value', { V: ['a', '****'] }, [['V']], { V: [SECRET_MASK, SECRET_MASK] }],
    ])('%s is not readable', async (_label, live, leaves, properties) => {
      const update = vi.fn();
      const prev = res({ properties, noEchoLeaves: leaves as (string | number)[][] });
      const readCurrentState = vi.fn().mockResolvedValue(live);
      const state = { Param: res({ properties: { ...structuredClone(properties), Changed: 'x' } }) };

      const result = await replayRollback(opFor(prev), state, 'S', makeCtx({ update, readCurrentState }));

      expect(update).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
      expect(lines.join('\n')).toContain('holds a NoEcho value only as the redaction mask');
    });

    it('a type the registry cannot route is not readable', async () => {
      const update = vi.fn();
      const { state, ops } = marked();
      const ctx = makeCtx({ update });
      ctx.providerRegistry = {
        getProviderFor: vi
          .fn()
          .mockReturnValueOnce({ provider: { update } })
          .mockImplementation(() => {
            throw new Error('unroutable');
          }),
      } as unknown as RollbackExecutorContext['providerRegistry'];

      const result = await replayRollback(ops, state, 'S', ctx);

      expect(update).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
      expect(lines.join('\n')).toContain('holds a NoEcho value only as the redaction mask');
    });

    it('names only the coordinates it could not read', async () => {
      const update = vi.fn();
      const prev = res({
        properties: { Readable: SECRET_MASK, WriteOnly: SECRET_MASK },
        noEchoLeaves: [['Readable'], ['WriteOnly']],
      });
      const readCurrentState = vi.fn().mockResolvedValue({ Readable: LIVE });
      const state = { Param: res({ properties: { ...structuredClone(prev.properties), Changed: 'by-failed-deploy' } }) };

      await replayRollback(opFor(prev), state, 'S', makeCtx({ update, readCurrentState }));

      const text = lines.join('\n');
      expect(text).toContain('at WriteOnly,');
      expect(text).not.toContain('Readable');
    });

    it('--revert-failed refuses an unreadable leaf too, sending nothing', async () => {
      const update = vi.fn();
      const { prev, state } = marked();
      const failed: FailedOperation[] = [
        {
          logicalId: 'Param',
          changeType: 'UPDATE',
          resourceType: PARAM_TYPE,
          physicalId: 'phys',
          previousState: prev,
          attemptedProperties: { Name: '/app/token', Value: SECRET_MASK },
        },
      ];

      const result = await replayFailedOperations(failed, state, 'S', makeCtx({ update }), {});

      expect(update).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
      expect(lines.join('\n')).toContain('holds a NoEcho value only as the redaction mask');
    });

    it('leaves a previous side that holds no mask as it is (an in-process plaintext)', async () => {
      const update = vi.fn().mockResolvedValue({ physicalId: 'phys', wasReplaced: false });
      const readCurrentState = vi.fn().mockResolvedValue({ Name: '/app/token', Value: LIVE });
      const { state, ops } = marked();
      state['Param']!.properties['Value'] = 'failed-deploy-value';

      await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

      expect((update.mock.calls[0]![4] as Record<string, unknown>)['Value']).toBe(
        'failed-deploy-value'
      );
    });

    it('a list-valued leaf (CommaDelimitedList) is substituted whole and re-persisted as a list of masks', async () => {
      const update = vi.fn().mockResolvedValue({
        physicalId: 'phys',
        wasReplaced: false,
        effectiveProperties: { Ids: ['list-live-0001', 'list-live-0002'] },
      });
      const prev = res({ properties: { Ids: [SECRET_MASK, SECRET_MASK] }, noEchoLeaves: [['Ids']] });
      const readCurrentState = vi
        .fn()
        .mockResolvedValue({ Ids: ['list-live-0001', 'list-live-0002'] });
      const state = { Param: res({ properties: { ...structuredClone(prev.properties), Changed: 'by-failed-deploy' } }) };

      await replayRollback(opFor(prev), state, 'S', makeCtx({ update, readCurrentState }));

      expect((update.mock.calls[0]![3] as Record<string, unknown>)['Ids']).toEqual([
        'list-live-0001',
        'list-live-0002',
      ]);
      expect(state['Param']!.properties['Ids']).toEqual([SECRET_MASK, SECRET_MASK]);
      expect(persisted(state)).not.toContain('list-live');
    });

    it('a provider returning a reordered list in effectiveProperties still re-persists no value', async () => {
      const update = vi.fn().mockResolvedValue({
        physicalId: 'phys',
        wasReplaced: false,
        effectiveProperties: { Tags: [{ Key: 's', Value: 'q7z' }, { Key: 'a', Value: 'x' }] },
      });
      const prev = res({
        properties: { Tags: [{ Key: 'a', Value: 'x' }, { Key: 's', Value: SECRET_MASK }] },
        noEchoLeaves: [['Tags', 1, 'Value']],
      });
      const readCurrentState = vi
        .fn()
        .mockResolvedValue({ Tags: [{ Key: 'a', Value: 'x' }, { Key: 's', Value: 'q7z' }] });
      const state = { Param: res({ properties: { ...structuredClone(prev.properties), Changed: 'by-failed-deploy' } }) };

      await replayRollback(opFor(prev), state, 'S', makeCtx({ update, readCurrentState }));

      expect(persisted(state)).not.toContain('q7z');
    });

    it('a short value echoed under the SAME-NAMED undeclared attribute is masked; an unrelated equal one and the physical id are not', async () => {
      const update = vi.fn().mockResolvedValue({
        physicalId: 'q7z',
        wasReplaced: false,
        attributes: { Value: 'q7z', Port: 'q7z', Arn: 'q7z' },
      });
      const readCurrentState = vi.fn().mockResolvedValue({ Name: '/app/token', Value: 'q7z' });
      const { state, ops } = marked();
      state['Param']!.physicalId = 'q7z';
      ops[0]!.previousState!.physicalId = 'q7z';
      ops[0]!.physicalId = 'q7z';

      await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

      // Equal to the physical id: it only names the resource.
      expect(state['Param']!.attributes?.['Value']).toBe('q7z');
      expect(state['Param']!.attributes?.['Port']).toBe('q7z');
      expect(state['Param']!.attributes?.['Arn']).toBe('q7z');
    });

    it('masks a same-named echoed attribute of a short value', async () => {
      const update = vi.fn().mockResolvedValue({
        physicalId: 'phys',
        wasReplaced: false,
        attributes: { Value: 'q7z', Other: 'q7z' },
      });
      const readCurrentState = vi.fn().mockResolvedValue({ Name: '/app/token', Value: 'q7z' });
      const { state, ops } = marked();

      await replayRollback(ops, state, 'S', makeCtx({ update, readCurrentState }));

      expect(state['Param']!.attributes).toEqual({ Value: SECRET_MASK, Other: 'q7z' });
    });

    // Decision 3: an element of a list no identity field pairs is not read by
    // index, even in the same order (AWS may reorder such a list).
    it('an element of a plain-string list is not readable, even in the same order', async () => {
      const update = vi.fn();
      const prev = res({ properties: { L: ['a', SECRET_MASK, 'c'] }, noEchoLeaves: [['L', 1]] });
      const readCurrentState = vi.fn().mockResolvedValue({ L: ['a', 'list-live-0001', 'c'] });
      const state = { Param: res({ properties: { ...structuredClone(prev.properties), Changed: 'x' } }) };

      const result = await replayRollback(opFor(prev), state, 'S', makeCtx({ update, readCurrentState }));

      expect(update).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
    });

    it('hands the provider a reordered live list masked through the identity pairing', async () => {
      const update = vi.fn();
      const readCurrentState = vi.fn(
        (_id: string, _l: string, _t: string, handed: Record<string, unknown>) =>
          Promise.resolve(structuredClone(handed))
      );
      const prev = res({
        properties: { Users: [{ Name: 'a', Password: SECRET_MASK }] },
        noEchoLeaves: [['Users', 0, 'Password']],
      });
      // The failed deploy put another user first; its record still holds a plaintext.
      const state = {
        Param: res({
          properties: {
            Users: [
              { Name: 'b', Password: 'other' },
              { Name: 'a', Password: 'failed-deploy-pw' },
            ],
          },
        }),
      };

      const result = await replayRollback(opFor(prev), state, 'S', makeCtx({ update, readCurrentState }));

      expect(update).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
    });

    it("a nested stack row routed to Cloud Control is NOT inert (its properties would be sent)", async () => {
      const update = vi.fn();
      const NESTED = 'AWS::CloudFormation::Stack';
      const row = res({
        physicalId: 'child',
        resourceType: NESTED,
        provisionedBy: 'cc-api',
        properties: { Parameters: { Token: SECRET_MASK } },
        noEchoLeaves: [['Parameters', 'Token']],
      });
      const result = await replayRollback(
        [{ logicalId: 'Child', changeType: 'UPDATE', resourceType: NESTED, physicalId: 'child', previousState: row }],
        { Child: { ...row, properties: { ...row.properties, Changed: 'x' } } },
        'S',
        makeCtx({ update })
      );
      expect(update).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
    });

    it('a nested stack row whose OP is routed to Cloud Control is not inert either', async () => {
      const update = vi.fn();
      const NESTED = 'AWS::CloudFormation::Stack';
      const row = res({
        physicalId: 'child',
        resourceType: NESTED,
        properties: { Parameters: { Token: SECRET_MASK } },
        noEchoLeaves: [['Parameters', 'Token']],
      });
      const result = await replayRollback(
        [
          {
            logicalId: 'Child',
            changeType: 'UPDATE',
            resourceType: NESTED,
            physicalId: 'child',
            provisionedBy: 'cc-api',
            previousState: row,
          },
        ],
        { Child: { ...row, properties: { ...row.properties, Changed: 'x' } } },
        'S',
        makeCtx({ update })
      );
      expect(update).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
    });

    it('a nested stack row whose bag ALSO holds an unmarked mask keeps the general refusal', async () => {
      const update = vi.fn();
      const NESTED = 'AWS::CloudFormation::Stack';
      const row = res({
        physicalId: 'child',
        resourceType: NESTED,
        properties: { Parameters: { Token: SECRET_MASK, Other: SECRET_MASK } },
        noEchoLeaves: [['Parameters', 'Token']],
      });
      const result = await replayRollback(
        [{ logicalId: 'Child', changeType: 'UPDATE', resourceType: NESTED, physicalId: 'child', previousState: row }],
        { Child: { ...row, properties: { ...row.properties, Changed: 'x' } } },
        'S',
        makeCtx({ update })
      );
      expect(update).not.toHaveBeenCalled();
      expect(result.failures).toBe(1);
      expect(lines.join('\n')).toContain('four ways a baseline comes to hold it');
    });

    it('a re-create whose bag also holds an unmarked mask keeps the general refusal; a marked-only one names the path', async () => {
      const { state, ops } = marked('phys-OLD');
      state['Param']!.physicalId = 'phys-NEW';
      ops[0]!.physicalId = 'phys-NEW';
      ops[0]!.previousState!.properties['Other'] = SECRET_MASK;
      await replayRollback(ops, state, 'S', makeCtx({ create: vi.fn(), delete: vi.fn() }));
      expect(lines.join('\n')).toContain('four ways a baseline comes to hold it');

      lines.length = 0;
      const second = marked('phys-OLD');
      second.state['Param']!.physicalId = 'phys-NEW';
      second.ops[0]!.physicalId = 'phys-NEW';
      await replayRollback(second.ops, second.state, 'S', makeCtx({ create: vi.fn(), delete: vi.fn() }));
      expect(lines.join('\n')).toContain("('***') at Value,");
    });
  });
});
