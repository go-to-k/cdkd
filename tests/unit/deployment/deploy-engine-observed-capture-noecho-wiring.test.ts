import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#4043 (review M6), through the ENGINE's wiring: the deploy-start
 * auto-refresh captures with no secret bag, so its failure line is masked only
 * by the stack's NoEcho values. The engine hands `ObservedCapture` those values
 * through a LIVE getter, because `deploy-flow.ts` assigns
 * `fingerprintNoEchoValues` after the capture is built. A value captured at
 * construction is `undefined`, and the line then prints what AWS echoed.
 * `observed-capture-secret-scope.test.ts` pins the class with the values
 * injected directly; this pins the engine's half.
 */
const SECRET = 'Pw-zq8K-noecho-value-77';
const debugs = vi.hoisted(() => [] as string[]);

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);
vi.mock('../../../src/utils/logger.js', () => {
  const logger = (): Record<string, unknown> => ({
    debug: (...args: unknown[]) => debugs.push(args.map(String).join(' ')),
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger(),
  });
  return { getLogger: () => logger() };
});
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((p: unknown) => Promise.resolve(p)),
    resolveParameters: vi.fn().mockReturnValue({ Pw: 'Pw-zq8K-noecho-value-77' }),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

describe('the auto-refresh failure line is masked with the NoEcho values (engine wiring)', () => {
  it('reads the values the deploy assigned after the capture was built', async () => {
    const provider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      // Rejected on a LATER tick: the refresh is kicked off before
      // `fingerprintNoEchoValues` is assigned, and an immediate rejection would
      // log before it, telling a live getter from a captured value apart not at all.
      readCurrentState: vi.fn(
        () =>
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error(`AccessDenied on ${SECRET}`)), 0)
          )
      ),
    };
    // A v2 record without `observedProperties` is what the refresh captures.
    const state = {
      version: 2,
      region: 'us-east-1',
      stackName: 's',
      resources: {
        Q: { physicalId: 'q', resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'q' } },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const engine = new DeployEngine(
      {
        getState: vi.fn().mockResolvedValue({ state, etag: 'e' }),
        saveState: vi.fn().mockResolvedValue('e2'),
      } as never,
      { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      {
        calculateDiff: vi
          .fn()
          .mockResolvedValue(
            new Map<string, ResourceChange>([
              ['Q', { logicalId: 'Q', changeType: 'NO_CHANGE', resourceType: 'AWS::SQS::Queue' }],
            ])
          ),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false } as never,
      'us-east-1'
    );

    await engine.deploy('s', {
      Parameters: { Pw: { Type: 'String', NoEcho: true } },
      Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } },
    } as never);

    const lines = debugs.filter((line) => line.includes('observedProperties capture for'));
    // Premise: the refresh ran and its failure line was logged.
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SECRET);
  });
});
