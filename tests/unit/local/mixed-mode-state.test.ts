import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#6150: `--from-state` in AWS Emulator mixed mode (inverted:
// `--aws-emulator` is the target, `"real-aws"` marks the exceptions). Names
// resolve from the state `cdkd deploy --aws-emulator` wrote into the emulator,
// and the excepted services' resources from the state `cdkd deploy` wrote into
// real AWS. The loader is doubled; each call records which side it read
// (the endpoint override in force INSIDE it) and with which options.

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const leaf = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn(), child: () => leaf };
  return { ...actual, getLogger: () => leaf };
});

const loader = vi.hoisted(() => ({ load: vi.fn(), inFlight: 0, maxInFlight: 0 }));
const resolverBuild = vi.hoisted(() => vi.fn(async () => undefined as unknown));
vi.mock('../../../src/cli/commands/local-state-loader.js', () => ({
  loadStateForStack: loader.load,
  buildCrossStackResolver: resolverBuild,
}));

import {
  createLocalStateProvider as createCdkLocalStateProvider,
  resetEmbedConfig,
  setEmbedConfig,
} from 'cdk-local';
import {
  groupWorkloadsRoutedApart,
  setActiveWorkloadAwsWiring,
  setAwsEmulatorServiceRouting,
  UNNAMED_WORKLOAD,
} from 'cdk-local/internal';
import {
  cdkdExtraStateProviders,
  createLocalStateProvider,
} from '../../../src/cli/commands/local-state-source.js';
import { mixedModeEmulatorOverride } from '../../../src/local/local-aws-wiring.js';
import { REAL_FROM_STATE_LABEL, realMissReason } from '../../../src/local/mixed-mode-state.js';
import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';
import {
  awsEndpointOverrideUrl,
  setAwsEndpointOverrideSource,
} from '../../../src/utils/aws-client-defaults.js';
import { AwsClients, getAwsClients } from '../../../src/utils/aws-clients.js';

const EMULATOR_URL = 'https://127.0.0.1:9381';
const OVERRIDE = {
  endpoint: EMULATOR_URL,
  credentials: { accessKeyId: 'EMULATORKEY', secretAccessKey: 'emulator-secret' },
};

/**
 * Mixed mode as `cdkd local` installs it: cdk-local's routing with the parsed
 * `--env-vars`, its wiring, and cdkd's process default (the emulator).
 */
function mixed(envOverrides: Record<string, unknown>, realServices: string[]): void {
  setActiveWorkloadAwsWiring({
    mode: 'forward',
    mixed: { realServices, emulatorClientOverride: OVERRIDE },
    dispose: () => {},
  } as never);
  setAwsEmulatorServiceRouting({ realServices, override: OVERRIDE, envOverrides });
  setAwsEndpointOverrideSource(mixedModeEmulatorOverride);
}
/** DynamoDB excepted for every workload. */
const DDB_REAL = () => mixed({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } }, ['DYNAMODB']);

const OPTIONS = { fromState: true, statePrefix: 'cdkd', profile: 'prod', region: 'us-east-1' };

function record(table: string, fn: string) {
  return {
    state: {
      version: 2,
      stackName: 'S',
      resources: {
        Table: { physicalId: table, resourceType: 'AWS::DynamoDB::Table', properties: {} },
        Fn: { physicalId: fn, resourceType: 'AWS::Lambda::Function', properties: {} },
      },
      outputs: { TableName: table },
    },
    region: 'us-east-1',
    stateBucket: 'b',
  };
}

/** Each call: which side it read (by the override in force INSIDE it). */
const calls: { side: 'emulator' | 'real'; opts: Record<string, unknown>; region?: string }[] = [];
const sideNow = (): 'emulator' | 'real' => (awsEndpointOverrideUrl() === EMULATOR_URL ? 'emulator' : 'real');

beforeEach(() => {
  calls.length = 0;
  loader.inFlight = 0;
  loader.maxInFlight = 0;
  warn.mockReset();
  resolverBuild.mockReset();
  resolverBuild.mockResolvedValue(undefined);
  // cdk-local's merge warns through the host's logger, as under cdkd's embed config.
  setEmbedConfig({
    logger: { debug: () => {}, info: () => {}, warn, error: () => {}, setLevel: () => {}, getLevel: () => 'info' },
  });
  loader.load.mockImplementation(async (_stack: string, _synth: unknown, opts: Record<string, unknown>) => {
    loader.inFlight++;
    loader.maxInFlight = Math.max(loader.maxInFlight, loader.inFlight);
    const side = sideNow();
    calls.push({ side, opts, region: getAwsClients().configuredRegion });
    await new Promise((r) => setTimeout(r, 5));
    loader.inFlight--;
    return side === 'emulator' ? record('Emu-Table-111', 'Emu-Fn') : record('Real-Table-999', 'Real-Fn');
  });
});

afterEach(() => {
  setActiveWorkloadAwsWiring(undefined);
  setAwsEmulatorServiceRouting(undefined);
  setAwsEndpointOverrideSource(undefined);
  resetEmbedConfig();
});

describe('--from-state in AWS Emulator mixed mode', () => {
  it("takes every resource from the emulator, and an excepted service's from real AWS", async () => {
    DDB_REAL();
    const provider = createLocalStateProvider(OPTIONS as never, 'S', 'us-east-1')!;
    const rec = await provider.load('S', 'us-east-1');
    provider.dispose();
    expect(rec?.resources['Table']?.physicalId).toBe('Real-Table-999');
    expect(rec?.resources['Fn']?.physicalId).toBe('Emu-Fn');
    // An output naming the emulator's table takes the real name.
    expect(rec?.outputs['TableName']).toBe('Real-Table-999');
  });

  it('reads the real side on real AWS, with --profile and its own label; the emulator side through the emulator', async () => {
    DDB_REAL();
    const provider = createLocalStateProvider(OPTIONS as never, 'S', 'us-east-1')!;
    await provider.load('S', 'us-east-1');
    const emu = calls.find((c) => c.side === 'emulator')!;
    const real = calls.find((c) => c.side === 'real')!;
    expect(emu).toBeDefined();
    expect(real).toBeDefined();
    expect(real.opts['profile']).toBe('prod');
    expect(real.opts['logPrefix']).toBe(REAL_FROM_STATE_LABEL);
    expect(real.opts['scopedClients']).toBe(true);
    expect(real.region).toBe('us-east-1');
    expect(emu.opts['logPrefix']).toBeUndefined();
    // The real scope ends with the read: everything else stays on the emulator.
    expect(sideNow()).toBe('emulator');
  });

  it('never runs the two reads at once (the loader publishes process-global clients)', async () => {
    DDB_REAL();
    const provider = createLocalStateProvider(OPTIONS as never, 'S', 'us-east-1')!;
    await provider.load('S', 'us-east-1');
    expect(calls).toHaveLength(2);
    expect(loader.maxInFlight).toBe(1);
  });

  it('a stack missing from real AWS keeps the emulator names, with ONE warning carrying the reason', async () => {
    DDB_REAL();
    loader.load.mockImplementation(async (_s: string, _r: unknown, opts: Record<string, unknown>) => {
      if (sideNow() === 'real') {
        (opts['warn'] as (m: string) => void)(`${REAL_FROM_STATE_LABEL}: no cdkd state found for stack 'S'. Falling back.`);
        return undefined;
      }
      return record('Emu-Table-111', 'Emu-Fn');
    });
    const provider = createLocalStateProvider(OPTIONS as never, 'S', 'us-east-1')!;
    const rec = await provider.load('S', 'us-east-1');
    expect(rec?.resources['Table']?.physicalId).toBe('Emu-Table-111');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("no cdkd state found for stack 'S'");
  });

  it('a real side that throws keeps the emulator names, and the warning quotes just the cause', async () => {
    DDB_REAL();
    loader.load.mockImplementation(async () => {
      if (sideNow() === 'real') throw new Error(`${REAL_FROM_STATE_LABEL}: state bucket not found.`);
      return record('Emu-Table-111', 'Emu-Fn');
    });
    const provider = createLocalStateProvider(OPTIONS as never, 'S', 'us-east-1')!;
    const rec = await provider.load('S', 'us-east-1');
    expect(rec?.resources['Table']?.physicalId).toBe('Emu-Table-111');
    const text = String(warn.mock.calls[0]![0]);
    expect(text).toContain('state bucket not found');
    expect(text).not.toContain(`(${REAL_FROM_STATE_LABEL}`);
  });

  it('outside mixed mode the factory is the plain S3 provider (the flag decides where it reads)', async () => {
    const provider = cdkdExtraStateProviders['fromState']!(OPTIONS as never, {});
    expect(provider).toBeInstanceOf(S3LocalStateProvider);
    await provider.load('S', 'us-east-1');
    expect(calls).toHaveLength(1);
  });

  it('a workload with no exception reads ONLY the emulator — never real AWS', async () => {
    mixed({ FnA: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } }, ['DYNAMODB']);
    // UNNAMED_WORKLOAD: `Parameters` excepts nothing here.
    const shared = cdkdExtraStateProviders['fromState']!(OPTIONS as never, { workload: UNNAMED_WORKLOAD });
    const rec = await shared.load('S', 'us-east-1');
    expect(rec?.resources['Table']?.physicalId).toBe('Emu-Table-111');
    expect(calls.map((c) => c.side)).toEqual(['emulator']);
  });

  it("a group's workload excepting DynamoDB gets the real table's name", async () => {
    mixed({ FnA: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } }, ['DYNAMODB']);
    const forA = cdkdExtraStateProviders['fromState']!(OPTIONS as never, { workload: { logicalId: 'FnA' } });
    expect((await forA.load('S', 'us-east-1'))?.resources['Table']?.physicalId).toBe('Real-Table-999');
  });

  it("engine commands (cdk-local's dispatcher, grouped as start-service groups): B with no exception gets the emulator name, A the real one", async () => {
    mixed({ svcA: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } }, ['DYNAMODB']);
    const groups = groupWorkloadsRoutedApart([{ containerName: 'svcA' }, { containerName: 'svcB' }], (w) => w);
    expect(groups.map((g) => g.items)).toEqual([[{ containerName: 'svcA' }]]);
    const shared = createCdkLocalStateProvider(OPTIONS as never, 'S', 'us-east-1', cdkdExtraStateProviders, {
      workload: UNNAMED_WORKLOAD,
    })!;
    const forA = createCdkLocalStateProvider(OPTIONS as never, 'S', 'us-east-1', cdkdExtraStateProviders, {
      workload: groups[0]!.workload,
    })!;
    expect((await shared.load('S', 'us-east-1'))?.resources['Table']?.physicalId).toBe('Emu-Table-111');
    expect((await forA.load('S', 'us-east-1'))?.resources['Table']?.physicalId).toBe('Real-Table-999');
  });

  it('the real side reads the --stack-region before --region', async () => {
    DDB_REAL();
    const provider = createLocalStateProvider({ ...OPTIONS, stackRegion: 'eu-west-1' } as never, 'S', 'us-east-1')!;
    await provider.load('S', 'us-east-1');
    expect(calls.find((c) => c.side === 'real')?.region).toBe('eu-west-1');
  });

  it("a later stack's merge warning carries its own reason, not an earlier stack's", async () => {
    DDB_REAL();
    let n = 0;
    loader.load.mockImplementation(async () => {
      if (sideNow() === 'real') {
        n++;
        if (n === 1) throw new Error('first reason');
        return undefined;
      }
      return record('Emu-Table-111', 'Emu-Fn');
    });
    const provider = createLocalStateProvider(OPTIONS as never, 'S', 'us-east-1')!;
    await provider.load('S1', 'us-east-1');
    await provider.load('S2', 'us-east-1');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).not.toContain('first reason');
  });

  it('dispose reaches both sides, and the real read destroys its scoped clients', async () => {
    DDB_REAL();
    const dispose = vi.spyOn(S3LocalStateProvider.prototype, 'dispose');
    const destroy = vi.spyOn(AwsClients.prototype, 'destroy');
    const provider = createLocalStateProvider(OPTIONS as never, 'S', 'us-east-1')!;
    await provider.load('S', 'us-east-1');
    expect(destroy).toHaveBeenCalled();
    provider.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
    dispose.mockRestore();
    destroy.mockRestore();
  });

  it('serializes a cross-stack resolver build (the emulator side) with an in-flight read', async () => {
    DDB_REAL();
    const order: string[] = [];
    resolverBuild.mockImplementation(async () => {
      order.push(`resolver(inFlight=${loader.inFlight}, side=${sideNow()})`);
      return undefined;
    });
    const provider = createLocalStateProvider(OPTIONS as never, 'S', 'us-east-1')!;
    await Promise.all([provider.load('S', 'us-east-1'), provider.buildCrossStackResolver('us-east-1')]);
    expect(order).toEqual(['resolver(inFlight=0, side=emulator)']);
  });

  it('labels and the quoted cause', () => {
    expect(new S3LocalStateProvider({ statePrefix: 'cdkd' }).label).toBe('--from-state');
    expect(new S3LocalStateProvider({ statePrefix: 'cdkd', logPrefix: REAL_FROM_STATE_LABEL }).label).toBe(
      REAL_FROM_STATE_LABEL
    );
    expect(
      realMissReason(
        `${REAL_FROM_STATE_LABEL}: no cdkd state found for stack 'S' in bucket 'b'. Was it deployed via 'cdkd deploy'? Falling back.`
      )
    ).toBe("no cdkd state found for stack 'S' in bucket 'b'");
  });
});
