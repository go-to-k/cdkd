/**
 * The `Route53Provider` class keeps one delegator per method whose body moved
 * into `src/provisioning/providers/route53/` (go-to-k/cdkd#5835): each is
 * `return f.call(this, <its own parameters>)`. A delegator that swaps two
 * same-typed arguments, drops a trailing optional one, or drops the result
 * still type-checks.
 *
 * Every companion module is replaced by spies wrapping its real exports, so
 * each case calls the method through the instance, as the moved bodies do,
 * and asserts the moved function received the instance as `this`, every
 * argument in order (by identity), and that its result came back unchanged.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vite-plus/test';

const { spyAll } = vi.hoisted(() => ({
  spyAll: (actual: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(actual).map(([key, value]) => [
        key,
        typeof value === 'function' ? vi.fn(value as (...args: unknown[]) => unknown) : value,
      ])
    ),
}));

vi.mock('../../../src/provisioning/providers/route53/core.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/route53/hosted-zone.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/route53/hosted-zone-delete.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/route53/import.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/route53/read-state.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/route53/record-set.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/route53/resolve.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/route53/zone-config.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);

import { Route53Client } from '@aws-sdk/client-route-53';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import * as core from '../../../src/provisioning/providers/route53/core.js';
import * as hostedZone from '../../../src/provisioning/providers/route53/hosted-zone.js';
import * as hostedZoneDelete from '../../../src/provisioning/providers/route53/hosted-zone-delete.js';
import * as importModule from '../../../src/provisioning/providers/route53/import.js';
import * as readState from '../../../src/provisioning/providers/route53/read-state.js';
import * as recordSet from '../../../src/provisioning/providers/route53/record-set.js';
import * as resolve from '../../../src/provisioning/providers/route53/resolve.js';
import * as zoneConfig from '../../../src/provisioning/providers/route53/zone-config.js';

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  'hosted-zone': hostedZone,
  'hosted-zone-delete': hostedZoneDelete,
  import: importModule,
  'read-state': readState,
  'record-set': recordSet,
  resolve,
  'zone-config': zoneConfig,
};

/** [companion module, class method, moved function, parameter count]. */
const CASES: ReadonlyArray<readonly [string, string, string, number]> = [
  ['core', 'create', 'create', 4],
  ['core', 'delete', 'deleteImpl', 5],
  ['core', 'getAttribute', 'getAttribute', 3],
  ['core', 'getClient', 'getClient', 0],
  ['core', 'getHostedZoneAttribute', 'getHostedZoneAttribute', 2],
  ['core', 'update', 'update', 6],
  ['core', 'warnFailureText', 'warnFailureText', 3],
  ['core', 'wrapCaughtError', 'wrapCaughtError', 3],
  ['core', 'wrapDeleteError', 'wrapDeleteError', 3],
  ['hosted-zone', 'createHostedZone', 'createHostedZone', 5],
  ['hosted-zone', 'createOrAdoptHostedZone', 'createOrAdoptHostedZone', 2],
  ['hosted-zone', 'findHostedZoneByCallerReference', 'findHostedZoneByCallerReference', 2],
  ['hosted-zone', 'updateHostedZone', 'updateHostedZone', 7],
  ['hosted-zone-delete', 'deleteHostedZone', 'deleteHostedZone', 4],
  [
    'hosted-zone-delete',
    'ensureAcceleratedRecoveryDisabledForDelete',
    'ensureAcceleratedRecoveryDisabledForDelete',
    3,
  ],
  [
    'hosted-zone-delete',
    'waitForAcceleratedRecoveryFeatureSettled',
    'waitForAcceleratedRecoveryFeatureSettled',
    5,
  ],
  [
    'hosted-zone-delete',
    'waitForAcceleratedRecoveryMutable',
    'waitForAcceleratedRecoveryMutable',
    4,
  ],
  ['import', 'compositeAgreesWithTemplate', 'compositeAgreesWithTemplate', 2],
  ['import', 'hostedZoneImportAttributes', 'hostedZoneImportAttributes', 2],
  ['import', 'import', 'importImpl', 1],
  ['import', 'importHostedZone', 'importHostedZone', 1],
  ['import', 'importRecordSet', 'importRecordSet', 1],
  ['read-state', 'getDriftUnorderedPaths', 'getDriftUnorderedPaths', 1],
  ['read-state', 'readCurrentState', 'readCurrentState', 4],
  ['read-state', 'readHostedZone', 'readHostedZone', 3],
  ['read-state', 'readRecordSet', 'readRecordSet', 2],
  ['read-state', 'readRecordSetAt', 'readRecordSetAt', 2],
  ['read-state', 'readUnsettled', 'readUnsettled', 7],
  ['record-set', 'buildResourceRecordSet', 'buildResourceRecordSet', 1],
  ['record-set', 'createRecordSet', 'createRecordSet', 4],
  ['record-set', 'deleteRecordSet', 'deleteRecordSet', 5],
  ['record-set', 'findLiveRecordSet', 'findLiveRecordSet', 2],
  ['record-set', 'updateRecordSet', 'updateRecordSet', 6],
  ['resolve', 'resolveHostedZoneId', 'resolveHostedZoneId', 5],
  ['resolve', 'resolveRecordSetIdentity', 'resolveRecordSetIdentity', 3],
  ['zone-config', 'applyHostedZoneTags', 'applyHostedZoneTags', 5],
  ['zone-config', 'applyQueryLoggingConfig', 'applyQueryLoggingConfig', 6],
  ['zone-config', 'deleteQueryLoggingConfigForZone', 'deleteQueryLoggingConfigForZone', 3],
  ['zone-config', 'listQueryLoggingConfigIds', 'listQueryLoggingConfigIds', 1],
  ['zone-config', 'readHostedZoneTags', 'readHostedZoneTags', 1],
  ['zone-config', 'readQueryLogGroupArn', 'readQueryLogGroupArn', 1],
  ['zone-config', 'syncVPCAssociations', 'syncVPCAssociations', 6],
];

describe('Route53Provider delegators hand each argument to the moved body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('covers every class method and every companion export, once each', () => {
    const methods = Object.getOwnPropertyNames(Route53Provider.prototype).filter(
      (name) => name !== 'constructor'
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
      const provider = new Route53Provider();
      const spy = MODULES[mod]![fn] as Mock;
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

  it('getClient builds a Route53Client once and returns the same one after', () => {
    const provider = new Route53Provider();
    const client = provider.getClient();
    expect(client).toBeInstanceOf(Route53Client);
    expect(provider.getClient()).toBe(client);
  });
});
