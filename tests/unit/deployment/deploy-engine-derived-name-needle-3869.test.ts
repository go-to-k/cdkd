/**
 * The deploy engine's half of the derived-name needle (go-to-k/cdkd#3869).
 *
 * A resource NAMED from a secret prints its physical id in the engine's own
 * lines (`Deleting old <id>`, `was replaced: <old> -> <new>`), in a
 * provider's lines and in the error a failed operation throws, and the id
 * there is no recorded plaintext: a rewriting provider folded it, or it was
 * minted from a value since rotated. The engine registers such a record's
 * needles, binds them as a PRINTING bag around the resource's whole body, and
 * masks its events and errors with them.
 *
 * And the wiring a reader depends on: every context `buildResolverContext`
 * builds answers the needle question from the record it serves and the
 * target's own bag, except the two whose bag DECIDES something from its
 * log-only needles (the masked-input fingerprint pass, the outputs pass).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const logLines = vi.hoisted(() => [] as string[]);
// Each line through the sink masker `ConsoleLogger` applies, so a line the
// engine masks only by the bag bound around it reads as the terminal shows it.
vi.mock('../../../src/utils/logger.js', async () => {
  const { currentLogLineMasker: sink } = await import('../../../src/utils/log-line-masker.js');
  const push =
    (level: string) =>
    (...args: unknown[]): void => {
      const line = args.map(String).join(' ');
      logLines.push(`${level} ${sink()?.(line) ?? line}`);
    };
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

const resolveSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: resolveSpy,
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const stackName = 'DerivedNameStack';
const REF = '{{resolve:secretsmanager:team:SecretString:role::}}';
/** The id IAM holds for a role whose `RoleName` came from the secret. */
const ROLE_ID = 'team-secret-role-name';

describe('DeployEngine — a resource named from a secret (go-to-k/cdkd#3869)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let diffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let registry: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    logLines.length = 0;
    events.length = 0;
    resolveSpy.mockImplementation((value: unknown) => Promise.resolve(value));
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'phys' }),
      update: vi.fn().mockResolvedValue({ physicalId: ROLE_ID }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    diffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  const events: Array<Record<string, unknown>> = [];

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Role']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      diffCalculator as never,
      registry as never,
      { dryRun: false, eventRecorder: { record: (e: Record<string, unknown>) => void events.push(e) } } as never,
      'us-east-1'
    );
  }

  /** An in-place UPDATE of `Role`, whose recorded `RoleName` is `roleName`. */
  function primeRoleUpdate(roleName: string): CloudFormationTemplate {
    const desired = { RoleName: roleName, Description: 'updated' };
    stateBackend.getState!.mockResolvedValue({
      state: {
        version: 8,
        stackName,
        region: 'us-east-1',
        resources: {
          Role: {
            physicalId: ROLE_ID,
            resourceType: 'AWS::IAM::Role',
            properties: { RoleName: roleName, Description: 'initial' },
          },
        },
        outputs: {},
        lastModified: 1,
      },
      etag: 'etag-old',
    });
    diffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Role',
          {
            logicalId: 'Role',
            changeType: 'UPDATE',
            resourceType: 'AWS::IAM::Role',
            desiredProperties: desired,
            currentProperties: { RoleName: roleName, Description: 'initial' },
            propertyChanges: [
              {
                path: 'Description',
                oldValue: 'initial',
                newValue: 'updated',
                requiresReplacement: false,
              },
            ],
          },
        ],
      ])
    );
    return { Resources: { Role: { Type: 'AWS::IAM::Role', Properties: desired } } };
  }

  it('masks the id in every line logged during the resource body, a provider line included', async () => {
    const template = primeRoleUpdate(REF);
    let providerLine: string | undefined;
    provider.update!.mockImplementation(() => {
      providerLine = currentLogLineMasker()?.(`Updating role ${ROLE_ID}`);
      return Promise.resolve({ physicalId: ROLE_ID });
    });

    await makeEngine().deploy(stackName, template);

    expect(providerLine).toBe('Updating role ***');
  });

  it('masks the old AND the new id on the `was replaced` line', async () => {
    const template = primeRoleUpdate(REF);
    // Shares no needle-length span with the old id, so only its own
    // registration can mask it.
    const newId = 'replacement-role-qz';
    provider.update!.mockResolvedValue({ physicalId: newId, wasReplaced: true });

    await makeEngine().deploy(stackName, template);

    const replaced = logLines.filter((line) => line.includes('was replaced'));
    // Non-vacuity: the line under test was logged.
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).not.toContain(ROLE_ID);
    expect(replaced[0]).not.toContain(newId);
  });

  it('negative control: an ordinary name binds nothing to mask', async () => {
    const template = primeRoleUpdate('plain-role-name');
    let masker: unknown = 'unset';
    provider.update!.mockImplementation(() => {
      masker = currentLogLineMasker();
      return Promise.resolve({ physicalId: ROLE_ID });
    });

    await makeEngine().deploy(stackName, template);

    expect(masker).toBeUndefined();
  });

  it('masks the id in the failed operation’s error line and thrown error', async () => {
    const template = primeRoleUpdate(REF);
    provider.update!.mockRejectedValue(new Error(`AccessDenied on role ${ROLE_ID}`));

    const error = await makeEngine()
      .deploy(stackName, template)
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(error).toBeInstanceOf(Error);
    const chain: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
      chain.push(e.message);
    }
    // Non-vacuity: the failure under test really surfaced.
    expect(chain.join('\n')).toContain('AccessDenied on role');
    expect(chain.join('\n')).not.toContain(ROLE_ID);
    expect(logLines.filter((line) => line.includes('AccessDenied')).length).toBeGreaterThan(0);
    expect(logLines.join('\n')).not.toContain(ROLE_ID);
    // The durable event's error text too.
    const failed = events.filter((e) => e['eventType'] === 'RESOURCE_FAILED');
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0]!['error'])).toContain('AccessDenied on role');
    expect(JSON.stringify(failed[0]!['error'])).not.toContain(ROLE_ID);
  });

  it('every context answers the needle question from the served record and the target’s bag', () => {
    const engine = makeEngine();
    const resources: Record<string, ResourceState> = {
      Role: {
        physicalId: ROLE_ID,
        resourceType: 'AWS::IAM::Role',
        properties: { RoleName: REF },
        dependencies: [],
      } as ResourceState,
      Raw: {
        physicalId: 'resolved-secret-name',
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: 'resolved-secret-name' },
        dependencies: [],
      } as ResourceState,
    };
    const context = engine.buildResolverContext({ template: { Resources: {} }, resources }, stackName);
    expect([...(context.secretNameNeedles?.('Role') ?? [])]).toContain(ROLE_ID);
    // A name resolved this deploy is plaintext in memory: only the target's
    // OWN bag says it is a secret.
    expect(context.secretNameNeedles?.('Raw')).toBeUndefined();
    engine.perResourceSecrets.set('Raw', new Map([['resolved-secret-name', REF]]));
    expect([...(context.secretNameNeedles?.('Raw') ?? [])]).toContain('resolved-secret-name');
    expect(context.secretNameNeedles?.('Missing')).toBeUndefined();
    // Judging a record registers it for the resource's own lines.
    expect(engine.maskForResource('Role', `Deleting old Role (${ROLE_ID})...`)).toBe(
      'Deleting old Role (***)...'
    );
  });

  it('the masked-input fingerprint pass and the outputs pass carry no needle callback', async () => {
    const engine = makeEngine();
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: { Out: { Value: 'v' } },
    };
    (engine as unknown as { fingerprintParameters: unknown }).fingerprintParameters = {
      parameterInput: () => ({ kind: 'clean' }),
      bound: {},
    };
    const contexts: Array<Record<string, unknown>> = [];
    resolveSpy.mockImplementation((value: unknown, ctx: Record<string, unknown>) => {
      contexts.push(ctx);
      return Promise.resolve(value);
    });

    await engine.maskedInputSources(template, {}, undefined, stackName)!.resolve('v');
    await engine.resolveOutputs(template, {}, stackName, template);

    expect(contexts.length).toBeGreaterThanOrEqual(2);
    for (const ctx of contexts) expect(ctx).not.toHaveProperty('secretNameNeedles');
    // The control: an ordinary context does carry it.
    expect(
      engine.buildResolverContext({ template, resources: {} }, stackName)
    ).toHaveProperty('secretNameNeedles');
  });
});
