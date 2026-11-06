/**
 * The `CloudTrailProvider` class keeps one delegator per method whose body
 * moved into `src/provisioning/providers/cloudtrail/` (go-to-k/cdkd#5835): each
 * is `return f.call(this, <its own parameters>)`. A delegator that swaps two
 * same-typed arguments, drops a trailing optional one, or drops the result
 * still type-checks.
 *
 * Every companion module is replaced by spies wrapping its real exports, so
 * each case calls the method through the instance, as the moved bodies do,
 * and asserts the moved function received the instance as `this`, every
 * argument in order (by identity), and that its result came back unchanged.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vite-plus/test';

const { spyAll, mockSend } = vi.hoisted(() => ({
  spyAll: (actual: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(actual).map(([key, value]) => [
        key,
        typeof value === 'function' ? vi.fn(value as (...args: unknown[]) => unknown) : value,
      ])
    ),
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-cloudtrail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudtrail')>();
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/provisioning/providers/cloudtrail/core.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/cloudtrail/delete.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/cloudtrail/read-state.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/cloudtrail/tags.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/cloudtrail/update.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);

import { AddTagsCommand, GetTrailCommand, RemoveTagsCommand } from '@aws-sdk/client-cloudtrail';
import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import * as core from '../../../src/provisioning/providers/cloudtrail/core.js';
import * as deleteModule from '../../../src/provisioning/providers/cloudtrail/delete.js';
import * as readState from '../../../src/provisioning/providers/cloudtrail/read-state.js';
import * as tags from '../../../src/provisioning/providers/cloudtrail/tags.js';
import * as update from '../../../src/provisioning/providers/cloudtrail/update.js';

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  delete: deleteModule,
  'read-state': readState,
  tags,
  update,
};

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set([
  'constructor',
  'getClient',
  'getCreateClient',
  'getDriftUnorderedPaths',
  'getAttribute',
]);

/** [companion module, class method, moved function, parameter count]. */
const CASES: ReadonlyArray<readonly [string, string, string, number]> = [
  ['core', 'create', 'create', 4],
  ['core', 'wrapCaughtError', 'wrapCaughtError', 3],
  ['delete', 'delete', 'deleteImpl', 5],
  ['read-state', 'import', 'importImpl', 1],
  ['read-state', 'readCurrentState', 'readCurrentState', 3],
  ['tags', 'applyTagDiff', 'applyTagDiff', 5],
  ['update', 'readLiveForRecord', 'readLiveForRecord', 2],
  ['update', 'update', 'update', 6],
];

describe('CloudTrailProvider delegators hand each argument to the moved body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('covers every delegating class method and every companion export, once each', () => {
    const methods = Object.getOwnPropertyNames(CloudTrailProvider.prototype).filter(
      (name) => !KEPT_ON_CLASS.has(name)
    );
    expect([...methods].sort()).toEqual(CASES.map(([, method]) => method).sort());
    const exported = Object.entries(MODULES).flatMap(([mod, exports]) =>
      Object.keys(exports).map((fn) => `${mod}:${fn}`)
    );
    expect(exported.sort()).toEqual(CASES.map(([mod, , fn]) => `${mod}:${fn}`).sort());
  });

  it.each(CASES)(
    '%s: %s forwards the instance, every argument in order, and the result',
    (mod, method, fn, arity) => {
      const provider = new CloudTrailProvider();
      const spy = MODULES[mod]![fn] as Mock;
      expect(vi.isMockFunction(spy), `${mod}.${fn} is not spied`).toBe(true);
      const result = { resultOf: method };
      spy.mockImplementationOnce(() => result);
      const args = Array.from({ length: arity }, (_, i) => ({ argument: i }));
      const delegator = (provider as unknown as Record<string, (...a: unknown[]) => unknown>)[
        method
      ]!;
      expect(delegator.apply(provider, args)).toBe(result);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.contexts[0]).toBe(provider);
      const received = spy.mock.calls[0]!;
      expect(received).toHaveLength(arity);
      received.forEach((arg, i) => expect(arg, `argument ${i}`).toBe(args[i]));
    }
  );

  it('a moved body sends through the instance client', async () => {
    const provider = new CloudTrailProvider();
    mockSend.mockResolvedValueOnce({ Trail: { Name: 'my-trail' } });
    await expect(
      provider.import({
        logicalId: 'Trail',
        resourceType: 'AWS::CloudTrail::Trail',
        stackName: 'Stack',
        region: 'us-east-1',
        knownPhysicalId: 'my-trail',
      } as Parameters<CloudTrailProvider['import']>[0])
    ).resolves.toEqual({ physicalId: 'my-trail', attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0] as unknown;
    expect(command).toBeInstanceOf(GetTrailCommand);
    expect((command as GetTrailCommand).input).toEqual({ Name: 'my-trail' });
  });

  it('the moved tag diff sends RemoveTags then AddTags through the instance client', async () => {
    const provider = new CloudTrailProvider();
    mockSend.mockResolvedValue({});
    await provider.applyTagDiff(
      'arn:aws:cloudtrail:us-east-1:123456789012:trail/my-trail',
      'AWS::CloudTrail::Trail',
      'Trail',
      [{ Key: 'old', Value: 'o' }],
      [{ Key: 'new', Value: 'n' }]
    );
    const commands = mockSend.mock.calls.map(([command]) => command as unknown);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBeInstanceOf(RemoveTagsCommand);
    expect((commands[0] as RemoveTagsCommand).input).toEqual({
      ResourceId: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/my-trail',
      TagsList: [{ Key: 'old', Value: 'o' }],
    });
    expect(commands[1]).toBeInstanceOf(AddTagsCommand);
    expect((commands[1] as AddTagsCommand).input).toEqual({
      ResourceId: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/my-trail',
      TagsList: [{ Key: 'new', Value: 'n' }],
    });
  });
});
