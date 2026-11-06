import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-v6';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeDeliveryStreamCommand } from '@aws-sdk/client-firehose';

/**
 * `FirehoseProvider` keeps one delegator per method whose body moved into its
 * companion directory (`src/provisioning/providers/firehose/`, go-to-k/cdkd#5835):
 * `method(...)` is `return fn.call(this, ...)`. Each companion module's functions
 * are mocked here, so a delegator call reaches the mock and the HAND-OFF itself
 * is what is pinned: the same instance as `this` (each provider owns its own
 * clients), every declared argument in order (none dropped, none swapped), and
 * the callee's own return value.
 *
 * Each body's behavior stays pinned by the per-feature Firehose suites.
 */

vi.mock('../../../src/provisioning/providers/firehose/core.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/firehose/create.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/firehose/update.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/firehose/encryption.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/firehose/delete.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/firehose/s3-destination.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/firehose/destination-updates.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});
vi.mock('../../../src/provisioning/providers/firehose/read-state.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
});

import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';
import * as core from '../../../src/provisioning/providers/firehose/core.js';
import * as create from '../../../src/provisioning/providers/firehose/create.js';
import * as update from '../../../src/provisioning/providers/firehose/update.js';
import * as encryption from '../../../src/provisioning/providers/firehose/encryption.js';
import * as deleteModule from '../../../src/provisioning/providers/firehose/delete.js';
import * as s3Destination from '../../../src/provisioning/providers/firehose/s3-destination.js';
import * as destinationUpdates from '../../../src/provisioning/providers/firehose/destination-updates.js';
import * as readState from '../../../src/provisioning/providers/firehose/read-state.js';

type Module = 'core' | 'create' | 'update' | 'encryption' | 'delete' | 's3-destination' | 'destination-updates' | 'read-state';

const MODULE_EXPORTS: Record<Module, Record<string, unknown>> = {
  'core': core,
  'create': create,
  'update': update,
  'encryption': encryption,
  'delete': deleteModule,
  's3-destination': s3Destination,
  'destination-updates': destinationUpdates,
  'read-state': readState,
};

/** [delegator, companion module, function it calls, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, Module, string, number]> = [
  ['wrapCaughtError', 'core', 'wrapCaughtError', 3],
  ['getClient', 'core', 'getClient', 0],
  ['getCreateClient', 'core', 'getCreateClient', 0],
  ['create', 'create', 'create', 4],
  ['update', 'update', 'update', 6],
  ['applyUpdate', 'update', 'applyUpdate', 6],
  ['warnUnappliedS3BackupMode', 'update', 'warnUnappliedS3BackupMode', 4],
  ['withRecordedEncryption', 'update', 'withRecordedEncryption', 3],
  ['applyExtendedS3DestinationUpdate', 'update', 'applyExtendedS3DestinationUpdate', 3],
  ['applyS3DestinationUpdate', 'update', 'applyS3DestinationUpdate', 3],
  ['applyTagsDiff', 'update', 'applyTagsDiff', 3],
  ['applyEncryptionUpdate', 'encryption', 'applyEncryptionUpdate', 6],
  ['warnIfUnfinished', 'encryption', 'warnIfUnfinished', 4],
  ['refuseToStartTransition', 'encryption', 'refuseToStartTransition', 4],
  ['waitForEncryption', 'encryption', 'waitForEncryption', 5],
  ['findDestinationKey', 'core', 'findDestinationKey', 1],
  ['delete', 'delete', 'deleteImpl', 5],
  ['readDeliveryStreamStatusForDelete', 'delete', 'readDeliveryStreamStatusForDelete', 1],
  ['mapS3DestinationConfiguration', 's3-destination', 'mapS3DestinationConfiguration', 1],
  ['mapExtendedS3DestinationConfiguration', 's3-destination', 'mapExtendedS3DestinationConfiguration', 1],
  ['mapExtendedS3ConfigToUpdate', 's3-destination', 'mapExtendedS3ConfigToUpdate', 1],
  ['applyRedshiftDestinationUpdate', 'destination-updates', 'applyRedshiftDestinationUpdate', 3],
  ['mapRedshiftConfigToUpdate', 'destination-updates', 'mapRedshiftConfigToUpdate', 1],
  ['applySplunkDestinationUpdate', 'destination-updates', 'applySplunkDestinationUpdate', 3],
  ['mapSplunkConfigToUpdate', 'destination-updates', 'mapSplunkConfigToUpdate', 1],
  ['applyAmazonopensearchserviceDestinationUpdate', 'destination-updates', 'applyAmazonopensearchserviceDestinationUpdate', 3],
  ['mapAmazonopensearchserviceConfigToUpdate', 'destination-updates', 'mapAmazonopensearchserviceConfigToUpdate', 1],
  ['applyAmazonOpenSearchServerlessDestinationUpdate', 'destination-updates', 'applyAmazonOpenSearchServerlessDestinationUpdate', 3],
  ['mapAmazonOpenSearchServerlessConfigToUpdate', 'destination-updates', 'mapAmazonOpenSearchServerlessConfigToUpdate', 1],
  ['applyHttpEndpointDestinationUpdate', 'destination-updates', 'applyHttpEndpointDestinationUpdate', 3],
  ['mapHttpEndpointConfigToUpdate', 'destination-updates', 'mapHttpEndpointConfigToUpdate', 1],
  ['applyElasticsearchDestinationUpdate', 'destination-updates', 'applyElasticsearchDestinationUpdate', 3],
  ['mapElasticsearchConfigToUpdate', 'destination-updates', 'mapElasticsearchConfigToUpdate', 1],
  ['applyIcebergDestinationUpdate', 'destination-updates', 'applyIcebergDestinationUpdate', 3],
  ['mapIcebergDestinationConfiguration', 'destination-updates', 'mapIcebergDestinationConfiguration', 1],
  ['mapIcebergConfigToUpdate', 'destination-updates', 'mapIcebergConfigToUpdate', 1],
  ['applySnowflakeDestinationUpdate', 'destination-updates', 'applySnowflakeDestinationUpdate', 3],
  ['mapSnowflakeConfigToUpdate', 'destination-updates', 'mapSnowflakeConfigToUpdate', 1],
  ['mapS3ConfigToUpdate', 's3-destination', 'mapS3ConfigToUpdate', 1],
  ['unsettledInTransition', 'read-state', 'unsettledInTransition', 4],
  ['readCurrentState', 'read-state', 'readCurrentState', 4],
  ['getDriftUnknownPaths', 'read-state', 'getDriftUnknownPaths', 0],
  ['import', 'read-state', 'importImpl', 1],
  ['waitForActive', 'core', 'waitForActive', 4],
  ['describeBeforeDeadline', 'core', 'describeBeforeDeadline', 1],
];

const FIREHOSE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/provisioning/providers/firehose'
);

describe('FirehoseProvider delegators hand off to their companion functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(DELEGATORS)('%s -> firehose/%s.ts %s (%i arguments)', (method, module, target, arity) => {
    const fn = MODULE_EXPORTS[module][target] as ReturnType<typeof vi.fn>;
    const returned = Symbol(`returned by ${target}`);
    fn.mockReturnValue(returned);
    const provider = new FirehoseProvider();
    // One more argument than declared, so a delegator forwarding an extra
    // argument fails as well as one forwarding fewer than it declares.
    const args = Array.from({ length: arity + 1 }, (_, i) => Symbol(`arg ${i}`));

    const result = (provider as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(
      ...args
    );

    expect(result).toBe(returned);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.contexts[0]).toBe(provider);
    expect(fn.mock.calls[0]).toStrictEqual(args.slice(0, arity));
  });

  it.each(DELEGATORS)(
    '%s: the row arity is firehose/%s.ts %s’s declared parameter count',
    (_method, module, target, arity) => {
      const path = join(FIREHOSE_DIR, `${module}.ts`);
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
      const declared = source.statements.find(
        (s): s is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(s) && s.body !== undefined && s.name?.text === target
      );
      expect(declared, `${target} in firehose/${module}.ts`).toBeDefined();
      const params = declared!.parameters.map((p) => p.name.getText(source));
      expect(params[0]).toBe('this');
      expect(params.length - 1).toBe(arity);
    }
  );

  it('lists every prototype method that delegates', () => {
    const delegating = Object.getOwnPropertyNames(FirehoseProvider.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        /\.call\(this\b/.test(
          String((FirehoseProvider.prototype as unknown as Record<string, unknown>)[name])
        )
    );
    expect(delegating.sort()).toEqual(DELEGATORS.map(([name]) => name).sort());
  });

  it('readDeliveryStreamStatusForDelete sends a DescribeDeliveryStreamCommand for the given stream', async () => {
    const actual = await vi.importActual<typeof import('../../../src/provisioning/providers/firehose/delete.js')>(
      '../../../src/provisioning/providers/firehose/delete.js'
    );
    const sent: unknown[] = [];
    vi.mocked(core.getClient).mockReturnValue({
      send: (command: unknown) => {
        sent.push(command);
        return Promise.resolve({ DeliveryStreamDescription: { DeliveryStreamStatus: 'DELETING' } });
      },
    } as unknown as ReturnType<typeof core.getClient>);
    const provider = new FirehoseProvider();

    await expect(
      actual.readDeliveryStreamStatusForDelete.call(provider, 'my-stream')
    ).resolves.toBe('DELETING');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(DescribeDeliveryStreamCommand);
    expect((sent[0] as DescribeDeliveryStreamCommand).input).toEqual({
      DeliveryStreamName: 'my-stream',
    });
  });
});
