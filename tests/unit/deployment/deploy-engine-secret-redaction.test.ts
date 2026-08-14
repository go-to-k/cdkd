import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

// Logger silenced.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const SECRET_PLAINTEXT = 'super-secret-plaintext-value';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:client_secret::}}';

// A secret-aware mock resolver. It resolves a `{ __resolveSecret: [plaintext,
// expr] }` sentinel to the PLAINTEXT (what the AWS provider must receive) AND
// records (plaintext -> expr) into ctx.recordedSecretValues, exactly as the
// real resolver does for a {{resolve:secretsmanager:...}} reference. This lets
// the test prove the deploy engine PERSISTS the expression while the AWS call
// gets the plaintext.
function resolveWithSecrets(value: unknown, ctx: { recordedSecretValues?: Map<string, string> }): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveWithSecrets(v, ctx));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('__resolveSecret' in obj) {
      const [plaintext, expr] = obj['__resolveSecret'] as [string, string];
      ctx.recordedSecretValues?.set(plaintext, expr);
      return plaintext;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveWithSecrets(v, ctx);
    return out;
  }
  return value;
}

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi
      .fn()
      .mockImplementation((props: unknown, ctx: { recordedSecretValues?: Map<string, string> }) =>
        Promise.resolve(resolveWithSecrets(props, ctx ?? {}))
      ),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - resolved secrets are redacted out of persisted state (GHSA fix)', () => {
  const stackName = 'secret-redaction-stack';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let mockLockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  let mockDagBuilder: {
    buildGraph: ReturnType<typeof vi.fn>;
    getExecutionLevels: ReturnType<typeof vi.fn>;
    getDirectDependencies: ReturnType<typeof vi.fn>;
  };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };
  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Idp']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-new') };
  });

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1'
    );
  }

  it('CREATE: persists the {{resolve:...}} expression in state while the AWS call gets the plaintext', async () => {
    mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
    mockProvider.create.mockResolvedValue({
      physicalId: 'idp-phys',
      // Readback-style attribute that echoes the resolved secret (the Cognito
      // ProviderDetails.client_secret case): must be redacted in state too.
      attributes: { ProviderDetails: { client_secret: SECRET_PLAINTEXT } },
    });
    // observedProperties also echoes the secret (async capture drain path).
    mockProvider.readCurrentState.mockResolvedValue({
      ProviderName: 'oidc',
      ProviderDetails: { client_secret: SECRET_PLAINTEXT },
    });

    const desiredProps = {
      ProviderName: 'oidc',
      ProviderDetails: {
        client_id: 'public-client-id',
        client_secret: { __resolveSecret: [SECRET_PLAINTEXT, SECRET_EXPR] },
      },
    };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Idp',
          {
            logicalId: 'Idp',
            changeType: 'CREATE',
            resourceType: 'AWS::Cognito::UserPoolIdentityProvider',
            desiredProperties: desiredProps,
          },
        ],
      ])
    );

    const template: CloudFormationTemplate = {
      Resources: {
        Idp: { Type: 'AWS::Cognito::UserPoolIdentityProvider', Properties: desiredProps },
      },
      // A CfnOutput whose Value resolves a secret (the anti-pattern the code
      // review flagged) must also be redacted in persisted outputs.
      Outputs: {
        LeakedSecret: { Value: { __resolveSecret: [SECRET_PLAINTEXT, SECRET_EXPR] } },
        PublicOut: { Value: 'not-a-secret' },
      },
    };

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);
    expect(result.created).toBe(1);

    // The AWS provider call received the RESOLVED plaintext (so the real
    // secret reaches AWS).
    const createArgs = mockProvider.create.mock.calls[0]!;
    const createdProps = createArgs[2] as Record<string, unknown>;
    expect((createdProps['ProviderDetails'] as Record<string, unknown>)['client_secret']).toBe(
      SECRET_PLAINTEXT
    );

    // Persisted state holds the EXPRESSION, never the plaintext — across
    // properties, attributes, AND observedProperties.
    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    const record = savedState.resources['Idp']!;
    expect((record.properties['ProviderDetails'] as Record<string, unknown>)['client_secret']).toBe(
      SECRET_EXPR
    );
    // Non-secret sibling is untouched.
    expect((record.properties['ProviderDetails'] as Record<string, unknown>)['client_id']).toBe(
      'public-client-id'
    );
    expect(
      (record.attributes!['ProviderDetails'] as Record<string, unknown>)['client_secret']
    ).toBe(SECRET_EXPR);
    expect(
      (record.observedProperties!['ProviderDetails'] as Record<string, unknown>)['client_secret']
    ).toBe(SECRET_EXPR);

    // Outputs are redacted too: the secret-valued output holds the expression,
    // the public output is untouched.
    expect(savedState.outputs['LeakedSecret']).toBe(SECRET_EXPR);
    expect(savedState.outputs['PublicOut']).toBe('not-a-secret');

    // Hard invariant: the plaintext must appear NOWHERE in the serialized state.
    expect(JSON.stringify(savedState)).not.toContain(SECRET_PLAINTEXT);
  });

  it('does not redact anything when no secret was resolved (identity path)', async () => {
    mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
    mockProvider.create.mockResolvedValue({ physicalId: 'phys' });
    mockProvider.readCurrentState.mockResolvedValue(undefined);

    const desiredProps = { Name: 'plain', Nested: { Value: 'also-plain' } };
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Idp',
          {
            logicalId: 'Idp',
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: desiredProps,
          },
        ],
      ])
    );
    const template: CloudFormationTemplate = {
      Resources: { Idp: { Type: 'AWS::S3::Bucket', Properties: desiredProps } },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(savedState.resources['Idp']!.properties).toEqual({
      Name: 'plain',
      Nested: { Value: 'also-plain' },
    });
  });
});
