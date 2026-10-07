import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { ConsoleLogger, getLogger, setLogger } from '../../../src/utils/logger.js';
import { kickOffObservedCapture } from '../../../src/deployment/deploy-engine/observed-capture.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import { RESOURCE_NOT_FOUND, type ResourceProvider } from '../../../src/types/resource.js';

/**
 * go-to-k/cdkd#4362: the observed-state readback after a CREATE / UPDATE runs
 * after the provider call returned, so outside the `withCurrentResourceSecrets`
 * scope that call bound. `kickOffObservedCapture` re-binds the caller's bag
 * around the readback, so both the provider's own `readCurrentState` lines and
 * the engine's failure line are masked at the logger sink (the #2177 pattern,
 * `logger-sink-secret-mask.test.ts`).
 */
const SECRET = 'queue-name-from-secret';

function bag(...plaintexts: string[]): RecordedSecretValues {
  return new Map(plaintexts.map((p) => [p, `{{resolve:secretsmanager:${p}}}`]));
}

function fakeEngine() {
  return {
    options: { captureObservedState: true },
    observedCaptureTasks: new Map<string, Promise<unknown>>(),
    logger: getLogger().child('DeployEngine'),
    // go-to-k/cdkd#4043 (review M6): the failure line also masks with the
    // resource's derived-name bag and the stack's NoEcho values.
    printingSecretsFor: () => undefined,
    fingerprintNoEchoValues: undefined,
  };
}

function providerReading(behaviour: 'log' | 'reject'): ResourceProvider {
  const logger = getLogger().child('FakeProvider');
  return {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    async readCurrentState(physicalId: string) {
      // An await first: the line runs in a later continuation, as a real
      // provider's does after its SDK call.
      await Promise.resolve();
      if (behaviour === 'reject') throw new Error(`Queue ${physicalId} does not exist`);
      logger.debug(`Reading queue ${physicalId}`);
      return { QueueName: physicalId };
    },
  } as unknown as ResourceProvider;
}

describe('kickOffObservedCapture binds the resource secret bag (issue #4362)', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  const printed = (): string =>
    debugSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

  beforeEach(() => {
    setLogger(new ConsoleLogger('debug', false));
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    setLogger(new ConsoleLogger());
  });

  async function capture(behaviour: 'log' | 'reject', secrets?: RecordedSecretValues) {
    const engine = fakeEngine();
    kickOffObservedCapture.call(
      engine as never,
      providerReading(behaviour),
      'Queue',
      SECRET,
      'AWS::SQS::Queue',
      { QueueName: SECRET },
      { afterOwnWrite: true },
      secrets
    );
    await engine.observedCaptureTasks.get('Queue');
  }

  it("masks the provider's own readback line", async () => {
    await capture('log', bag(SECRET));
    expect(printed()).toContain('Reading queue ***');
    expect(printed()).not.toContain(SECRET);
  });

  it("masks the engine's capture-failure line, whose text AWS can echo", async () => {
    await capture('reject', bag(SECRET));
    expect(printed()).toContain('observedProperties capture for Queue');
    expect(printed()).toContain('Queue *** does not exist');
    expect(printed()).not.toContain(SECRET);
  });

  it('binds nothing when the caller passes no bag (the schema-upgrade refresh)', async () => {
    await capture('log');
    expect(printed()).toContain(`Reading queue ${SECRET}`);
  });

  it("masks the bagless refresh's failure line with the stack's NoEcho values (go-to-k/cdkd#4043 review M6)", async () => {
    const engine = { ...fakeEngine(), fingerprintNoEchoValues: bag(SECRET) };
    kickOffObservedCapture.call(
      engine as never,
      providerReading('reject'),
      'Queue',
      SECRET,
      'AWS::SQS::Queue',
      { QueueName: SECRET },
      { afterOwnWrite: true }
    );
    await engine.observedCaptureTasks.get('Queue');
    expect(printed()).toContain('observedProperties capture for Queue');
    expect(printed()).not.toContain(SECRET);
  });
});

describe('kickOffObservedCapture on a resource AWS reports gone (go-to-k/cdkd#4283)', () => {
  it('resolves to no baseline, never the sentinel as a property bag', async () => {
    const engine = fakeEngine();
    const provider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      readCurrentState: vi.fn(async () => RESOURCE_NOT_FOUND),
    } as unknown as ResourceProvider;
    kickOffObservedCapture.call(
      engine as never,
      provider,
      'Queue',
      'q',
      'AWS::SQS::Queue',
      { QueueName: 'q' }
    );

    await expect(engine.observedCaptureTasks.get('Queue')).resolves.toBeUndefined();
  });
});
