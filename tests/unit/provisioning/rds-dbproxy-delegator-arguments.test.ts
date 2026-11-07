/**
 * The `RDSDBProxyProvider` method bodies live in
 * `src/provisioning/providers/rds-dbproxy/*.ts`; the class keeps one
 * `return f.call(this, ...)` delegator per moved method, and each argument a
 * delegator hands on is a hand-off the split introduced.
 *
 * Every companion function is a pass-through spy on the real one. The first
 * block stubs each spy once and pins, for EVERY delegator, that it calls its
 * own function with the provider as `this`, every argument in declared order,
 * and returns that function's result. The second block runs real bodies end to
 * end and pins the SDK command each sends, by class and input.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-rds')>('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

/** Replace every function a module exports with a pass-through spy. */
async function spied(path: string): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<Record<string, unknown>>(path);
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(v as (...a: unknown[]) => unknown) : v,
    ])
  );
}

vi.mock('../../../src/provisioning/providers/rds-dbproxy/create.js', () =>
  spied('../../../src/provisioning/providers/rds-dbproxy/create.js')
);
vi.mock('../../../src/provisioning/providers/rds-dbproxy/update.js', () =>
  spied('../../../src/provisioning/providers/rds-dbproxy/update.js')
);
vi.mock('../../../src/provisioning/providers/rds-dbproxy/delete.js', () =>
  spied('../../../src/provisioning/providers/rds-dbproxy/delete.js')
);
vi.mock('../../../src/provisioning/providers/rds-dbproxy/read-state.js', () =>
  spied('../../../src/provisioning/providers/rds-dbproxy/read-state.js')
);

import {
  AddTagsToResourceCommand,
  CreateDBProxyCommand,
  DBProxyNotFoundFault,
  DeleteDBProxyCommand,
  DescribeDBProxiesCommand,
  ListTagsForResourceCommand,
  ModifyDBProxyCommand,
  RemoveTagsFromResourceCommand,
} from '@aws-sdk/client-rds';
import { RDSDBProxyProvider } from '../../../src/provisioning/providers/rds-dbproxy-provider.js';
import * as create from '../../../src/provisioning/providers/rds-dbproxy/create.js';
import * as update from '../../../src/provisioning/providers/rds-dbproxy/update.js';
import * as del from '../../../src/provisioning/providers/rds-dbproxy/delete.js';
import * as readState from '../../../src/provisioning/providers/rds-dbproxy/read-state.js';

const MODULES: Record<string, Record<string, unknown>> = {
  create,
  update,
  delete: del,
  'read-state': readState,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['create', 'create', 'create', 4],
  ['update', 'update', 'update', 6],
  ['waitForAvailableAfterModify', 'update', 'waitForAvailableAfterModify', 4],
  ['warnOnRetainedRemovals', 'update', 'warnOnRetainedRemovals', 5],
  ['removedRetained', 'update', 'removedRetained', 3],
  ['applyTagDiff', 'update', 'applyTagDiff', 6],
  ['delete', 'delete', 'deleteImpl', 5],
  ['getAttribute', 'read-state', 'getAttribute', 3],
  ['import', 'read-state', 'importImpl', 1],
  ['readCurrentState', 'read-state', 'readCurrentState', 1],
  ['buildImportResult', 'read-state', 'buildImportResult', 1],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set([
  'constructor',
  'getClient',
  'getCreateClient',
  'invalidateAttributeCache',
  'wrapCaughtError',
  'wrapDeleteError',
]);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

const PROXY = 'my-proxy';
const PROXY_ARN = 'arn:aws:rds:us-east-1:123456789012:db-proxy:prx-aaaa';
const TYPE = 'AWS::RDS::DBProxy';
const AVAILABLE = {
  DBProxies: [
    {
      DBProxyName: PROXY,
      DBProxyArn: PROXY_ARN,
      Endpoint: 'my-proxy.example',
      VpcId: 'vpc-1',
      Status: 'available',
    },
  ],
};

describe('RDSDBProxyProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(RDSDBProxyProvider.prototype).filter(
      (m) => !KEPT_ON_CLASS.has(m)
    );
    expect(methods.sort()).toEqual(DELEGATORS.map(([m]) => m).sort());
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} calls ${mod}.${fn} with this, ${arity} argument(s) in order, and returns its result`, () => {
      const spy = MODULES[mod]![fn] as Spy;
      expect(vi.isMockFunction(spy), `${mod}.${fn} is not spied`).toBe(true);
      const result = { result: method };
      spy.mockImplementationOnce(() => result);
      const provider = new RDSDBProxyProvider();
      const args = Array.from({ length: arity }, (_, i) => ({ arg: i }));
      const returned = (provider as unknown as Record<string, Callable>)[method]!(...args);
      expect(returned).toBe(result);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(args);
      spy.mock.calls[0]!.forEach((a, i) => expect(a).toBe(args[i]));
      expect(spy.mock.contexts[0]).toBe(provider);
    });
  }
});

describe('RDSDBProxyProvider moved bodies send the SDK command the delegator names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  /** The input of every sent command of `cls`, in send order. */
  function sent(cls: abstract new (...a: never[]) => unknown): unknown[] {
    return mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof cls)
      .map((c) => c.input);
  }

  it('create sends CreateDBProxy with the declared name, then polls it until available', async () => {
    mockSend.mockImplementation(async (command: unknown) =>
      command instanceof DescribeDBProxiesCommand ? AVAILABLE : {}
    );
    const result = await new RDSDBProxyProvider().create('Proxy', TYPE, {
      DBProxyName: PROXY,
      EngineFamily: 'POSTGRESQL',
      Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:secret' }],
      RoleArn: 'arn:aws:iam::123456789012:role/r',
      VpcSubnetIds: ['subnet-1'],
    });
    expect(sent(CreateDBProxyCommand)).toEqual([
      expect.objectContaining({ DBProxyName: PROXY, EngineFamily: 'POSTGRESQL' }),
    ]);
    expect(sent(DescribeDBProxiesCommand)).toEqual([{ DBProxyName: PROXY }]);
    expect(result.physicalId).toBe(PROXY);
    expect(result.attributes).toEqual({
      DBProxyArn: PROXY_ARN,
      Endpoint: 'my-proxy.example',
      VpcId: 'vpc-1',
    });
  });

  it('update sends ModifyDBProxy for a changed field, then polls the physical id', async () => {
    mockSend.mockImplementation(async (command: unknown) =>
      command instanceof DescribeDBProxiesCommand ? AVAILABLE : {}
    );
    await new RDSDBProxyProvider().update(
      'Proxy',
      PROXY,
      TYPE,
      { DBProxyName: PROXY, RequireTLS: true },
      { DBProxyName: PROXY, RequireTLS: false }
    );
    expect(sent(ModifyDBProxyCommand)).toEqual([{ DBProxyName: PROXY, RequireTLS: true }]);
    expect(sent(DescribeDBProxiesCommand)).toEqual([{ DBProxyName: PROXY }]);
  });

  it('applyTagDiff removes the dropped keys and adds the set ones on the proxy ARN', async () => {
    mockSend.mockImplementation(async (command: unknown) =>
      command instanceof DescribeDBProxiesCommand ? AVAILABLE : {}
    );
    await new RDSDBProxyProvider().applyTagDiff(
      PROXY,
      [
        { Key: 'keep', Value: 'old' },
        { Key: 'gone', Value: 'x' },
      ],
      [{ Key: 'keep', Value: 'new' }],
      TYPE,
      'Proxy'
    );
    expect(sent(DescribeDBProxiesCommand)).toEqual([{ DBProxyName: PROXY }]);
    expect(sent(RemoveTagsFromResourceCommand)).toEqual([
      { ResourceName: PROXY_ARN, TagKeys: ['gone'] },
    ]);
    expect(sent(AddTagsToResourceCommand)).toEqual([
      { ResourceName: PROXY_ARN, Tags: [{ Key: 'keep', Value: 'new' }] },
    ]);
  });

  it('delete sends DeleteDBProxy for the physical id and polls until it is gone', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeDBProxiesCommand) {
        throw new DBProxyNotFoundFault({ message: 'gone', $metadata: {} });
      }
      return {};
    });
    await new RDSDBProxyProvider().delete('Proxy', PROXY, TYPE);
    expect(sent(DeleteDBProxyCommand)).toEqual([{ DBProxyName: PROXY }]);
    expect(sent(DescribeDBProxiesCommand)).toEqual([{ DBProxyName: PROXY }]);
  });

  it('readCurrentState describes the proxy by the physical id and lists tags by its ARN', async () => {
    mockSend.mockImplementation(async (command: unknown) =>
      command instanceof DescribeDBProxiesCommand ? AVAILABLE : { TagList: [] }
    );
    const state = await new RDSDBProxyProvider().readCurrentState(PROXY);
    expect(sent(DescribeDBProxiesCommand)).toEqual([{ DBProxyName: PROXY }]);
    expect(sent(ListTagsForResourceCommand)).toEqual([{ ResourceName: PROXY_ARN }]);
    expect(state).toMatchObject({ DBProxyName: PROXY, Tags: [] });
  });

  it('getAttribute and import read the proxy by the physical id', async () => {
    mockSend.mockImplementation(async () => AVAILABLE);
    const provider = new RDSDBProxyProvider();
    expect(await provider.getAttribute(PROXY, TYPE, 'Endpoint')).toBe('my-proxy.example');
    const imported = await provider.import({
      logicalId: 'Proxy',
      resourceType: TYPE,
      stackName: 'Stack',
      region: 'us-east-1',
      properties: { DBProxyName: PROXY },
    });
    expect(imported).toEqual({
      physicalId: PROXY,
      attributes: { DBProxyArn: PROXY_ARN, Endpoint: 'my-proxy.example', VpcId: 'vpc-1' },
    });
    expect(sent(DescribeDBProxiesCommand)).toEqual([{ DBProxyName: PROXY }, { DBProxyName: PROXY }]);
  });
});
