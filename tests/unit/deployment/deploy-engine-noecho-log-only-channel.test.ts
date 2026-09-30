import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  SECRET_MASK,
  hasMaskableValues,
  maskSecretsInText,
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type {
  CloudFormationTemplate,
  CreateContext,
  TemplateOutput,
} from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

// go-to-k/cdkd#1998, the ENGINE half, with the REAL resolver: a `Ref` to a
// `NoEcho: true` parameter is masked by the provider's masker, in the engine's
// thrown error and in the `deployments/*.jsonl` event, and the state the deploy
// PERSISTS is byte-identical to the same deploy without `NoEcho`.
const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const capture = (...args: unknown[]): void => {
    logLines.push(args.map(String).join(' '));
  };
  const fns = {
    setLevel: vi.fn(),
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi
        .fn()
        .mockResolvedValue({ Parameter: { Value: 'dynref-secret-value', Type: 'SecureString' } }),
    },
  }),
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const NOECHO = 'hunter2-noecho-password';

// `Tier` FIRST: the dynamic reference is recorded before the `Fn::Base64`
// resolves, so the persist detector there runs against a non-empty map.
const PROPS = {
  Tier: '{{resolve:ssm-secure:/app/pw}}',
  Name: '/app/param',
  Type: 'String',
  Value: { Ref: 'Secret' },
  Description: { 'Fn::Sub': 'built for ${Secret} at ${Plain}' },
  AllowedPattern: { 'Fn::Base64': { 'Fn::Join': ['', ['pw=', { Ref: 'Secret' }]] } },
};
// `Export.Name` is typed as a string; an intrinsic one is what a template holds.
// The name reads the PUBLIC parameter: one holding the NoEcho value is refused
// (go-to-k/cdkd#4043, `export-name-noecho-refusal-4043.test.ts`), which would
// make the two states below differ by design.
const OUTPUTS = {
  Echo: { Value: { Ref: 'Secret' }, Export: { Name: { 'Fn::Sub': 'exp-${Plain}' } } },
} as unknown as Record<string, TemplateOutput>;

function templateOf(noEcho: boolean, props: Record<string, unknown> = PROPS): CloudFormationTemplate {
  return {
    Parameters: { Secret: { Type: 'String', NoEcho: noEcho }, Plain: { Type: 'String' } },
    Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: props } },
    Outputs: OUTPUTS,
  };
}

interface Harness {
  engine: DeployEngine;
  provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  saveState: ReturnType<typeof vi.fn>;
  events: unknown[];
}

function harness(
  props: Record<string, unknown> = PROPS,
  extraOptions: Record<string, unknown> = {}
): Harness {
  const provider = {
    create: vi.fn().mockResolvedValue({ physicalId: '/app/param' }),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const events: unknown[] = [];
  const diff = {
    calculateDiff: vi.fn().mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'R',
          {
            logicalId: 'R',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: props,
          },
        ],
      ])
    ),
    hasChanges: vi.fn().mockReturnValue(true),
    filterByType: vi
      .fn()
      .mockImplementation((c: Map<string, ResourceChange>, t: string) =>
        [...c.values()].filter((x) => x.changeType === t)
      ),
  };
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['R']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    diff as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      dryRun: false,
      parameters: { Secret: NOECHO, Plain: 'public-plain' },
      eventRecorder: { runId: 'run', record: (event: unknown) => events.push(event) } as never,
      ...extraOptions,
    },
    'us-east-1'
  );
  return { engine, provider, saveState, events };
}

beforeEach(() => {
  logLines.length = 0;
});

describe("DeployEngine - a NoEcho parameter is masked on the deploy's provider, error, event and resolver surfaces (go-to-k/cdkd#1998)", () => {
  it("hands the provider a masker that masks the parameter's value", async () => {
    const h = harness();
    await h.engine.deploy('s', templateOf(true));
    const sent = h.provider.create.mock.calls[0]![2] as Record<string, unknown>;
    // The value AWS receives is the real one.
    expect(sent['Value']).toBe(NOECHO);
    const context = h.provider.create.mock.calls[0]![3] as CreateContext;
    expect(context.maskSecrets!(`Value '${NOECHO}' failed`)).toBe(`Value '${SECRET_MASK}' failed`);
    expect(context.maskSecrets!('public-plain')).toBe('public-plain');
  });

  it('masks a provider error quoting the value in the thrown error, the event and the log', async () => {
    const h = harness();
    h.provider.create.mockRejectedValue(
      new Error(`1 validation error: Value '${NOECHO}' at 'value' failed`)
    );
    let thrown: unknown;
    try {
      await h.engine.deploy('s', templateOf(true));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The whole chain, as `util.inspect` would render it at the CLI boundary.
    const chain: string[] = [];
    for (let e: unknown = thrown; e instanceof Error; e = (e as { cause?: unknown }).cause) {
      chain.push(e.message, e.stack ?? '');
    }
    expect(chain.join('\n')).toContain('validation error');
    expect(chain.join('\n')).not.toContain(NOECHO);
    const failed = h.events.filter((e) => JSON.stringify(e).includes('validation error'));
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.events)).not.toContain(NOECHO);
    expect(logLines.join('\n')).not.toContain(NOECHO);
  });

  it('masks the event with a bag holding ONLY log-only needles', async () => {
    // No `{{resolve:...}}` in this resource: the bag has no map entry, which is
    // what the event masker's short-circuit used to read as "nothing to mask".
    const props = { Name: '/app/param', Type: 'String', Value: { Ref: 'Secret' } };
    const h = harness(props);
    h.provider.create.mockRejectedValue(new Error(`Value '${NOECHO}' failed`));
    await expect(h.engine.deploy('s', templateOf(true, props))).rejects.toThrow();
    const failed = h.events.filter((e) => JSON.stringify(e).includes('failed'));
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.events)).not.toContain(NOECHO);
  });
});

describe('DeployEngine - persistence is unchanged by NoEcho (go-to-k/cdkd#1998)', () => {
  it('saves byte-identical state with and without NoEcho on the parameter', async () => {
    const saved = async (noEcho: boolean): Promise<string> => {
      const h = harness();
      await h.engine.deploy('s', templateOf(noEcho));
      expect(h.saveState).toHaveBeenCalled();
      return JSON.stringify(
        h.saveState.mock.calls.map((call) => {
          const state = { ...(call[2] as StackState) };
          delete (state as { lastModified?: unknown }).lastModified;
          return state;
        })
      );
    };
    const withNoEcho = await saved(true);
    const without = await saved(false);
    // Non-vacuity: the value, the encoding and the output value are all in
    // the persisted state in the clear (the decision on #1998), the export
    // alias is published, and the dynamic reference beside them is still
    // redacted.
    const encoded = Buffer.from(`pw=${NOECHO}`).toString('base64');
    expect(withNoEcho).toContain(`"Value":"${NOECHO}"`);
    expect(withNoEcho).toContain(encoded);
    expect(withNoEcho).toContain(`"Echo":"${NOECHO}"`);
    expect(withNoEcho).toContain(`"exp-public-plain":"${NOECHO}"`);
    expect(withNoEcho).toContain(`built for ${NOECHO}`);
    expect(withNoEcho).toContain('{{resolve:ssm-secure:/app/pw}}');
    expect(withNoEcho).not.toContain('dynref-secret-value');
    expect(withNoEcho).toBe(without);
  });
});

describe('DeployEngine - the side set crosses its copies (go-to-k/cdkd#1998)', () => {
  it("hands the in-process rollback the resource's own bag for its log-only needles", () => {
    const { engine } = harness();
    const bag: RecordedSecretValues = new Map();
    recordLogOnlyValue(bag, NOECHO);
    (engine as unknown as { perResourceSecrets: Map<string, RecordedSecretValues> })
      .perResourceSecrets.set('R', bag);
    const ctx = (
      engine as unknown as {
        rollbackExecutorContext: (
          s: StackState,
          n: string
        ) => { logOnlyNeedlesFor?: (id: string) => RecordedSecretValues | undefined };
      }
    ).rollbackExecutorContext(
      { version: 8, stackName: 's', region: 'us-east-1', resources: {}, outputs: {}, lastModified: 0 },
      's'
    );
    expect(ctx.logOnlyNeedlesFor?.('R')).toBe(bag);
    expect(ctx.logOnlyNeedlesFor?.('Other')).toBeUndefined();
  });

  it('carries the Export.Name pass needles into the bag the failure is masked with', async () => {
    // The name resolves through its own ForwardingSecrets map, which writes
    // ENTRIES through but not the instance-keyed side set. A name resolution
    // that fails AFTER recording the value must still have it masked.
    const props = { Name: '/app/param', Type: 'String', Value: 'plain' };
    const h = harness(props);
    const outputs = {
      Echo: {
        Value: 'v',
        Export: {
          Name: { 'Fn::Join': ['', [{ Ref: 'Secret' }, { 'Fn::GetAtt': ['Missing', 'Arn'] }]] },
        },
      },
    } as unknown as Record<string, TemplateOutput>;
    type Resolve = (value: unknown, ctx: { recordedSecretValues?: RecordedSecretValues }) => Promise<unknown>;
    const resolver = (h.engine as unknown as { resolver: { resolve: Resolve } }).resolver;
    const real = resolver.resolve.bind(resolver);
    resolver.resolve = vi.fn<Resolve>(async (value, ctx) => {
      if (value === outputs['Echo']!.Export!.Name) {
        recordLogOnlyValue(ctx.recordedSecretValues!, NOECHO);
        throw new Error(`export ${NOECHO} could not be named`);
      }
      return real(value, ctx);
    });
    await h.engine.deploy('s', {
      Parameters: { Secret: { Type: 'String', NoEcho: true }, Plain: { Type: 'String' } },
      Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: props } },
      Outputs: outputs,
    });
    const lines = logLines.join('\n');
    expect(lines).toContain('could not be named');
    expect(lines).not.toContain(NOECHO);
  });
});

describe('DeployEngine - a SUCCESSFUL Export.Name carries its needles to the pass map (go-to-k/cdkd#1998)', () => {
  it('masks a later output failure quoting a value only the name resolution recorded', async () => {
    const props = { Name: '/app/param', Type: 'String', Value: 'plain' };
    const h = harness(props);
    const outputs = {
      A: { Value: 'a', Export: { Name: { 'Fn::Join': ['', ['name-', { Ref: 'Plain' }]] } } },
      // Aliases resolve after every value, in declaration order: B's name
      // fails AFTER A's succeeded, quoting a value only A's resolution saw.
      B: { Value: 'b', Export: { Name: { 'Fn::Join': ['', ['other-', { Ref: 'Plain' }]] } } },
    } as unknown as Record<string, TemplateOutput>;
    type Resolve = (
      value: unknown,
      ctx: { recordedSecretValues?: RecordedSecretValues }
    ) => Promise<unknown>;
    const resolver = (h.engine as unknown as { resolver: { resolve: Resolve } }).resolver;
    const real = resolver.resolve.bind(resolver);
    resolver.resolve = vi.fn<Resolve>(async (value, ctx) => {
      if (value === outputs['A']!.Export!.Name) {
        recordLogOnlyValue(ctx.recordedSecretValues!, NOECHO);
        return 'name-ok';
      }
      if (value === outputs['B']!.Export!.Name) throw new Error(`output quoted ${NOECHO} here`);
      return real(value, ctx);
    });
    await h.engine.deploy('s', {
      Parameters: { Secret: { Type: 'String', NoEcho: true }, Plain: { Type: 'String' } },
      Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: props } },
      Outputs: outputs,
    });
    const lines = logLines.join('\n');
    expect(lines).toContain('here');
    expect(lines).not.toContain(NOECHO);
  });
});

describe('DeployEngine - a nested child engine receives a log-only-only bag (go-to-k/cdkd#1998)', () => {
  it("masks the child's parameter line and its consuming resource with the parent's needles", async () => {
    // The child's own parameter never says NoEcho (CDK synthesizes it), so
    // only the inherited bag knows the value.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const props = { Name: '/app/param', Type: 'String', Value: { Ref: 'ChildParam' } };
    const h = harness(props, {
      parameters: { ChildParam: NOECHO },
      inheritedSecrets: inherited,
      parentStackInfo: { parentStack: 'P', parentLogicalId: 'C', parentRegion: 'us-east-1' },
    });
    await h.engine.deploy('P~C', {
      Parameters: { ChildParam: { Type: 'String' } },
      Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: props } },
    });
    expect(logLines.join('\n')).toContain('Parameter ChildParam: using user-provided value');
    expect(logLines.join('\n')).not.toContain(NOECHO);
    const context = h.provider.create.mock.calls[0]![3] as CreateContext;
    expect(context.maskSecrets!(`Value '${NOECHO}' failed`)).toBe(`Value '${SECRET_MASK}' failed`);
  });

  it('binds an inherited bag holding only log-only needles into its resolver contexts', () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    expect(hasMaskableValues(inherited)).toBe(true);
    const engine = new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { dryRun: false, inheritedSecrets: inherited },
      'us-east-1'
    );
    const context = (
      engine as unknown as {
        buildResolverContext: (
          base: { template: CloudFormationTemplate; resources: Record<string, never> },
          stackName: string
        ) => { inheritedSecrets?: RecordedSecretValues };
      }
    ).buildResolverContext({ template: { Resources: {} }, resources: {} }, 's');
    expect(context.inheritedSecrets).toBe(inherited);
    expect(maskSecretsInText(NOECHO, context.inheritedSecrets!)).toBe(SECRET_MASK);
  });
});
