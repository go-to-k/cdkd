import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { LockInfo, StackState } from '../../../src/types/state.js';

// go-to-k/cdkd#5868: `cdkd state show` / `state resources` write to STDOUT,
// which no log masker sees. An AppSync ApiKey's id `<apiId>|<apiKeyId>` (and
// the `ApiKey` / `Arn` attributes echoing the key) render the key as
// `****last4` in every mode; the record, and `cdkd export`, keep it whole.

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: vi.fn(),
}));
const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState } | null>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: vi.fn(async () => [{ stackName: 'S', region: 'us-east-1' }]),
    verifyBucketExists: vi.fn(async () => undefined),
  })),
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    getLockInfo: vi.fn(async (): Promise<LockInfo | null> => null),
    isLocked: vi.fn(),
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';
import { splitCompositePhysicalId } from '../../../src/cli/commands/export/composite-id-splitters.js';

const API = 'abcdefghijklmnopqrstuvwxyz';
const KEY = 'da2-5868statekeysecretvalue9876';
/** A superseded copy's key, and a rollback orphan's. */
const SUP_KEY = 'da2-5868supersededkeyvalue1111';
const ORPH_KEY = 'da2-5868orphankeysecretvalu2222';
const MASKED = `${API}|****9876`;
const ARN = `arn:aws:appsync:us-east-1:123456789012:apis/${API}/apikeys/${KEY}`;
const ALL_KEYS = [KEY, SUP_KEY, ORPH_KEY];
/** A nested child's own key, which the parent's row repeats in its outputs. */
const CHILD_KEY = 'da2-5868childkeysecretvalue3333';

function keyRecord(resourceType: string, key: string) {
  return {
    physicalId: `${API}|${key}`,
    resourceType,
    properties: { ApiId: API },
    attributes: { ApiKey: key, Arn: ARN.replace(KEY, key) },
    dependencies: [],
  };
}

/**
 * The key wherever a state can hold it: the ApiKey record, a superseded copy,
 * a rollback orphan, another resource's property (a Lambda env var reading
 * `Fn::GetAtt Key.ApiKey`), a stack output, and a nested child's parameter.
 */
function stateOf(resourceType: string): StackState {
  return {
    version: 15,
    stackName: 'S',
    region: 'us-east-1',
    resources: {
      Key: keyRecord(resourceType, KEY),
      Fn: {
        physicalId: 'fn-5868',
        resourceType: 'AWS::Lambda::Function',
        properties: { Environment: { Variables: { API_KEY: KEY, OLD_KEY: ORPH_KEY } } },
        attributes: {},
        dependencies: ['Key'],
      },
      Child: {
        physicalId: 'cdkd-local::stack::S~Child',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: { Parameters: { ApiKey: KEY } },
        attributes: { 'Outputs.ChildKey': CHILD_KEY },
        dependencies: [],
      },
    },
    outputs: { GraphQlKey: SUP_KEY },
    orphans: [{ logicalId: 'OldKey', orphanedAt: 1, state: keyRecord(resourceType, ORPH_KEY) }],
    supersededResources: [
      { logicalId: 'Key', supersededAt: 1, state: keyRecord(resourceType, SUP_KEY) },
    ],
    lastModified: 0,
  } as unknown as StackState;
}

/** The nested child: it holds the parent's key in a parameter it read. */
function childOf(resourceType: string): StackState {
  return {
    version: 15,
    stackName: 'S~Child',
    region: 'us-east-1',
    resources: {
      Param: {
        physicalId: 'child-param',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: KEY },
        attributes: {},
        dependencies: [],
      },
      ChildKey: keyRecord(resourceType, CHILD_KEY),
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

function serve(resourceType: string): StackState {
  const state = stateOf(resourceType);
  mockGetState.mockImplementation(async (name: string) =>
    name === 'S' ? { state } : { state: childOf(resourceType) }
  );
  return state;
}

async function run(args: string[]): Promise<string> {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    process.stdout.write = original;
  }
  return output.join('');
}

// Literal argv at every call, so the commander-arity convention check reads them.
const MODES: Array<[string, () => Promise<string>]> = [
  ['state show', () => run(['show', 'S'])],
  ['state show --json', () => run(['show', 'S', '--json'])],
  ['state show --show-nested', () => run(['show', 'S', '--show-nested'])],
  ['state show --show-nested --json', () => run(['show', 'S', '--show-nested', '--json'])],
  ['state resources', () => run(['resources', 'S'])],
  ['state resources --long', () => run(['resources', 'S', '--long'])],
  ['state resources --json', () => run(['resources', 'S', '--json'])],
];

describe('cdkd state never prints an AppSync ApiKey (go-to-k/cdkd#5868)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockGetState.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  it.each(MODES)('%s: masks every key, keeps the apiId', async (label, runMode) => {
    const state = serve('AWS::AppSync::ApiKey');
    const out = await runMode();
    expect(out).toContain(MASKED);
    expect(out).toContain(API);
    for (const key of ALL_KEYS) expect(out).not.toContain(key);
    if (label.startsWith('state show')) {
      // Premise: the copies outside the ApiKey record were printed, masked.
      expect(out).toContain('****1111'); // the output holding the superseded key
      expect(out).toContain('****2222'); // the Lambda env var holding the orphan's key
    }
    if (label.startsWith('state show') && label.includes('--json')) {
      // ...and the superseded and orphan records themselves.
      expect(out).toContain(`${API}|****1111`);
      expect(out).toContain(`${API}|****2222`);
      // Object KEYS are never rewritten.
      expect(out).toContain('"attributes"');
    }
    if (label.includes('--show-nested')) {
      // Premise: the child rendered, its parameter holding the parent's key.
      expect(out).toContain('S~Child');
      expect(out).toContain('child-param');
      // The child's own key, which the parent's row repeats, is masked in both.
      expect(out).not.toContain(CHILD_KEY);
      expect(out).toContain('****3333');
    }
    // The record itself is untouched: only the display copy is masked.
    expect(state.resources['Key']!.physicalId).toBe(`${API}|${KEY}`);
    expect(state.resources['Key']!.attributes).toEqual({ ApiKey: KEY, Arn: ARN });
    expect(state.outputs).toEqual({ GraphQlKey: SUP_KEY });
    expect(JSON.stringify(state.supersededResources)).toContain(SUP_KEY);
  });

  it.each(MODES)('negative control, a DataSource of the same shape: %s', async (label, runMode) => {
    serve('AWS::AppSync::DataSource');
    const out = await runMode();
    expect(out).toContain(`${API}|${KEY}`);
    if (label.startsWith('state show')) expect(out).toContain(SUP_KEY);
    expect(out).not.toContain('****');
  });

  // Without --show-nested: only the parent's row says its output carries a
  // child's key, through the `secretNamedAttributes` the deploy recorded. A
  // Stack row kept as a rollback orphan or a superseded copy says it too.
  const ORPH_STACK_KEY = 'da2-5868orphanstackkeyvalue5555';
  const SUP_STACK_KEY = 'da2-5868superstackkeyvalue66666';
  const stackRow = (key: string, named: boolean) => ({
    physicalId: 'cdkd-local::stack::S~Old',
    resourceType: 'AWS::CloudFormation::Stack',
    properties: {},
    attributes: { 'Outputs.K': key },
    ...(named && { secretNamedAttributes: ['Outputs.K'] }),
    dependencies: [],
  });
  // Literal argv at every call, as above. `[mode, keys it prints]`: the text
  // views print the live rows only; `state resources` prints attributes only
  // with --long or --json.
  const NAMED_MODES: Array<[string, () => Promise<string>, string[]]> = [
    ['state show', () => run(['show', 'S']), [CHILD_KEY]],
    ['state show --json', () => run(['show', 'S', '--json']), [CHILD_KEY, ORPH_STACK_KEY, SUP_STACK_KEY]],
    ['state resources --long', () => run(['resources', 'S', '--long']), [CHILD_KEY]],
    ['state resources --json', () => run(['resources', 'S', '--json']), [CHILD_KEY]],
  ];
  it.each(NAMED_MODES)(
    "%s: a child's key in a Stack row's output, named by secretNamedAttributes",
    async (_l, runMode, keys) => {
      for (const named of [true, false]) {
        const state = serve('AWS::AppSync::DataSource');
        if (named) {
          (state.resources['Child'] as { secretNamedAttributes?: string[] }).secretNamedAttributes = [
            'Outputs.ChildKey',
          ];
        }
        const s = state as unknown as { orphans: unknown[]; supersededResources: unknown[] };
        s.orphans.push({ logicalId: 'OldStack', orphanedAt: 1, state: stackRow(ORPH_STACK_KEY, named) });
        s.supersededResources.push({
          logicalId: 'SupStack',
          supersededAt: 1,
          state: stackRow(SUP_STACK_KEY, named),
        });
        const out = await runMode();
        // Premise: the row's output printed.
        expect(out).toContain('Outputs.ChildKey');
        for (const key of keys) {
          expect(out.includes(key), `named=${named} ${key}`).toBe(!named);
          if (named) expect(out).toContain(`****${key.slice(-4)}`);
        }
      }
    }
  );

  it("cdkd export's import identifier keeps the full key", () => {
    expect(
      splitCompositePhysicalId('AWS::AppSync::ApiKey', `${API}|${KEY}`, { ApiId: API })
        .resourceIdentifier
    ).toEqual({ ApiId: API, ApiKeyId: KEY });
  });
});
