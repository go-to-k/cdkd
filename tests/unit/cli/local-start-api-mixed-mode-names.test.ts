/**
 * go-to-k/cdkd#6150: in AWS Emulator mixed mode, `local start-api` resolves
 * names PER FUNCTION. Function A excepts DynamoDB (`"real-aws"`) in its own
 * `--env-vars` section, B does not: A gets the REAL table's name, B the
 * emulator's — each the name its own runtime addresses where its calls go.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const stateSource = vi.hoisted(() => ({ createLocalStateProvider: vi.fn() }));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: stateSource.createLocalStateProvider,
}));

import { awsEmulatorRealServices, setAwsEmulatorServiceRouting } from 'cdk-local/internal';
import { loadStateForRoutedStacks } from '../../../src/cli/commands/local-start-api.js';
import { stateBundleKey } from '../../../src/cli/commands/local-start-api/state.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

const fn = (path: string) => ({
  Type: 'AWS::Lambda::Function',
  Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
  Metadata: { 'aws:cdk:path': `Api/${path}/Resource` },
});
const STACK = {
  stackName: 'Api',
  displayName: 'Api',
  region: 'us-east-1',
  template: { Resources: { FnA1234: fn('FnA'), FnB5678: fn('FnB') } },
} as unknown as StackInfo;

afterEach(() => {
  setAwsEmulatorServiceRouting(undefined);
  stateSource.createLocalStateProvider.mockReset();
});

describe('local start-api names per function in mixed mode', () => {
  it('A (own DynamoDB exception) reads the real name, B (none) the emulator name', async () => {
    setAwsEmulatorServiceRouting({
      realServices: ['DYNAMODB'],
      override: { endpoint: 'https://127.0.0.1:9381' },
      envOverrides: { 'Api/FnA': { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } },
    });
    // A provider standing for cdkd's: the emulator's name when the workload it
    // was built for routes DynamoDB, else the real one.
    stateSource.createLocalStateProvider.mockImplementation(
      (_o: unknown, _s: string, _r: string, behavior: { workload?: object }) => ({
        label: '--from-state',
        load: vi.fn(async () => ({
          region: 'us-east-1',
          outputs: {},
          resources: {
            Table: {
              resourceType: 'AWS::DynamoDB::Table',
              physicalId: (awsEmulatorRealServices(behavior.workload) ?? []).includes('DYNAMODB')
                ? 'Real-Table'
                : 'Emu-Table',
              properties: {},
            },
          },
        })),
        dispose: vi.fn(),
      })
    );
    const route = (id: string) =>
      ({ lambdaLogicalId: id, apiStackName: 'Api' }) as unknown as DiscoveredRoute;
    const bundles = await loadStateForRoutedStacks([STACK], [route('FnA1234'), route('FnB5678')], [], {
      fromState: true,
    } as never);

    const a = bundles.get(stateBundleKey('Api', { logicalId: 'FnA1234', cdkPath: 'Api/FnA/Resource' }));
    const b = bundles.get(stateBundleKey('Api', { logicalId: 'FnB5678', cdkPath: 'Api/FnB/Resource' }));
    expect(a?.state.resources['Table']?.physicalId).toBe('Real-Table');
    expect(b?.state.resources['Table']?.physicalId).toBe('Emu-Table');
    // Grouped as cdk-local groups (go-to-k/cdk-local#905): the stack's shared
    // names for UNNAMED_WORKLOAD ({}), then A's group, excepted apart. B rides
    // the shared record: it excepts the same set as `Parameters` (nothing).
    const workloads = stateSource.createLocalStateProvider.mock.calls.map((c) => c[3]?.workload);
    expect(workloads).toEqual([{}, { logicalId: 'FnA1234', cdkPath: 'Api/FnA/Resource' }]);
  });

  it('outside mixed mode the key is the stack name alone (one load per stack)', () => {
    expect(stateBundleKey('Api', { logicalId: 'FnA1234' })).toBe('Api');
  });
});
