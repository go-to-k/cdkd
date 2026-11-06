/**
 * The `ServiceDiscoveryProvider` method bodies live in
 * `src/provisioning/providers/servicediscovery/*.ts`; the class keeps one
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

const mockSend = vi.fn();
const mockStsSend = vi.fn();

vi.mock('@aws-sdk/client-servicediscovery', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-servicediscovery')>(
    '@aws-sdk/client-servicediscovery'
  );
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-sts')>('@aws-sdk/client-sts');
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
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

vi.mock('../../../src/provisioning/providers/servicediscovery/core.js', () =>
  spied('../../../src/provisioning/providers/servicediscovery/core.js')
);
vi.mock('../../../src/provisioning/providers/servicediscovery/dispatch.js', () =>
  spied('../../../src/provisioning/providers/servicediscovery/dispatch.js')
);
vi.mock('../../../src/provisioning/providers/servicediscovery/namespace.js', () =>
  spied('../../../src/provisioning/providers/servicediscovery/namespace.js')
);
vi.mock('../../../src/provisioning/providers/servicediscovery/service.js', () =>
  spied('../../../src/provisioning/providers/servicediscovery/service.js')
);
vi.mock('../../../src/provisioning/providers/servicediscovery/read-state.js', () =>
  spied('../../../src/provisioning/providers/servicediscovery/read-state.js')
);
vi.mock('../../../src/provisioning/providers/servicediscovery/import.js', () =>
  spied('../../../src/provisioning/providers/servicediscovery/import.js')
);

import {
  DeleteServiceCommand,
  GetServiceCommand,
  ServiceNotFound,
} from '@aws-sdk/client-servicediscovery';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import * as core from '../../../src/provisioning/providers/servicediscovery/core.js';
import * as dispatch from '../../../src/provisioning/providers/servicediscovery/dispatch.js';
import * as namespace from '../../../src/provisioning/providers/servicediscovery/namespace.js';
import * as service from '../../../src/provisioning/providers/servicediscovery/service.js';
import * as readState from '../../../src/provisioning/providers/servicediscovery/read-state.js';
import * as importMod from '../../../src/provisioning/providers/servicediscovery/import.js';

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  dispatch,
  namespace,
  service,
  'read-state': readState,
  import: importMod,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['getClient', 'core', 'getClient', 0],
  ['getStsClient', 'core', 'getStsClient', 0],
  ['maskedRetryLogger', 'core', 'maskedRetryLogger', 1],
  ['maskErrorMessage', 'core', 'maskErrorMessage', 2],
  ['wrapCaughtError', 'core', 'wrapCaughtError', 3],
  ['create', 'dispatch', 'create', 4],
  ['update', 'dispatch', 'update', 6],
  ['delete', 'dispatch', 'deleteImpl', 5],
  ['createNamespace', 'namespace', 'createNamespace', 4],
  ['updateNamespace', 'namespace', 'updateNamespace', 6],
  ['deleteNamespace', 'namespace', 'deleteNamespace', 4],
  ['createHttpNamespace', 'namespace', 'createHttpNamespace', 4],
  ['updateHttpNamespace', 'namespace', 'updateHttpNamespace', 6],
  ['createPublicDnsNamespace', 'namespace', 'createPublicDnsNamespace', 4],
  ['updatePublicDnsNamespace', 'namespace', 'updatePublicDnsNamespace', 6],
  ['createService', 'service', 'createService', 4],
  ['updateService', 'service', 'updateService', 7],
  ['planServiceChange', 'service', 'planServiceChange', 3],
  ['warnUnappliedDnsConfigMembers', 'service', 'warnUnappliedDnsConfigMembers', 4],
  ['keepUndeclaredServiceFields', 'service', 'keepUndeclaredServiceFields', 2],
  ['deleteService', 'service', 'deleteService', 4],
  ['extractSoaTtlProperties', 'core', 'extractSoaTtlProperties', 1],
  ['resolveSoaTtlChange', 'core', 'resolveSoaTtlChange', 3],
  ['resolveNamespaceArn', 'core', 'resolveNamespaceArn', 1],
  ['syncNamespaceTags', 'core', 'syncNamespaceTags', 5],
  ['wrapOperationFailedError', 'core', 'wrapOperationFailedError', 4],
  ['pollOperation', 'core', 'pollOperation', 4],
  ['getAttribute', 'read-state', 'getAttribute', 3],
  ['isSameResource', 'read-state', 'isSameResource', 4],
  ['readNamespaceIdForIdentity', 'read-state', 'readNamespaceIdForIdentity', 2],
  ['readServiceIdForIdentity', 'read-state', 'readServiceIdForIdentity', 1],
  ['readCurrentState', 'read-state', 'readCurrentState', 3],
  ['getDriftUnknownPaths', 'read-state', 'getDriftUnknownPaths', 1],
  ['readNamespace', 'read-state', 'readNamespace', 2],
  ['readService', 'read-state', 'readService', 1],
  ['normalizeServiceAttributes', 'read-state', 'normalizeServiceAttributes', 1],
  ['attachTags', 'read-state', 'attachTags', 2],
  ['import', 'import', 'importImpl', 1],
  ['importNamespaceResource', 'import', 'importNamespaceResource', 1],
  ['importServiceResource', 'import', 'importServiceResource', 1],
  ['buildNamespaceArn', 'core', 'buildNamespaceArn', 1],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set(['constructor']);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

const SERVICE_TYPE = 'AWS::ServiceDiscovery::Service';
const SERVICE_ID = 'srv-abcdefghij012345';

describe('ServiceDiscoveryProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(ServiceDiscoveryProvider.prototype).filter(
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
      const provider = new ServiceDiscoveryProvider();
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

describe('ServiceDiscoveryProvider moved bodies send the SDK command the delegator names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockStsSend.mockReset();
  });

  it('readCurrentState gets the service the physical id names', async () => {
    mockSend.mockRejectedValue(new ServiceNotFound({ message: 'gone', $metadata: {} }));
    const result = await new ServiceDiscoveryProvider().readCurrentState(
      SERVICE_ID,
      'MyService',
      SERVICE_TYPE
    );
    expect(result).toBe(RESOURCE_NOT_FOUND);
    const command = mockSend.mock.calls[0]![0] as GetServiceCommand;
    expect(command).toBeInstanceOf(GetServiceCommand);
    expect(command.input).toEqual({ Id: SERVICE_ID });
  });

  it('delete deletes the service the physical id names', async () => {
    mockSend.mockResolvedValue({});
    await new ServiceDiscoveryProvider().delete('MyService', SERVICE_ID, SERVICE_TYPE);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0] as DeleteServiceCommand;
    expect(command).toBeInstanceOf(DeleteServiceCommand);
    expect(command.input).toEqual({ Id: SERVICE_ID });
  });

  it('import reads back the service the known physical id names', async () => {
    mockSend.mockResolvedValue({ Service: { Arn: 'arn:svc', Name: 'svc' } });
    const result = await new ServiceDiscoveryProvider().import({
      logicalId: 'MyService',
      resourceType: SERVICE_TYPE,
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: SERVICE_ID,
    });
    expect(result).toEqual({
      physicalId: SERVICE_ID,
      attributes: { Id: SERVICE_ID, Arn: 'arn:svc', Name: 'svc' },
    });
    const command = mockSend.mock.calls[0]![0] as GetServiceCommand;
    expect(command).toBeInstanceOf(GetServiceCommand);
    expect(command.input).toEqual({ Id: SERVICE_ID });
  });

  it('buildNamespaceArn asks STS for the account and builds the namespace ARN', async () => {
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    const arn = await new ServiceDiscoveryProvider().buildNamespaceArn('ns-abcdefghij012345');
    expect(arn).toBe(
      'arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-abcdefghij012345'
    );
    const command = mockStsSend.mock.calls[0]![0] as GetCallerIdentityCommand;
    expect(command).toBeInstanceOf(GetCallerIdentityCommand);
    expect(command.input).toEqual({});
  });
});
