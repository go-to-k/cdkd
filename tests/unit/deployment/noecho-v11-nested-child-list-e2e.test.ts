import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  type NestedStackProviderContext,
  withNestedStackContext,
} from '../../../src/provisioning/nested-stack-context.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

// The calculator's create-only lookup (`DescribeType`) fails fast:
// registry-only classification, as in the other real-calculator suites.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: vi.fn(() =>
        Promise.reject(
          Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        )
      ),
    },
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));


/**
 * go-to-k/cdkd#4043 review round 11 (a real-AWS regression of the
 * noecho-parameter-masking fixture): a parent `NoEcho` PARAMETER passed into
 * a nested child's `CommaDelimitedList` / `Number` parameter. The value arm
 * records the value as a mask-only entry of the row's bag, and the child's
 * coercion refusal (#1903) counted it as a secret dynamic reference and
 * refused the child. Driven through the REAL parent engine, the REAL
 * `NestedStackProvider` and the REAL child engine, so the option hop the
 * other nested-child suites inject directly is exercised too.
 */
const PARENT = 'ParentNoEchoList';
const CHILD = `${PARENT}~Child`;
const REGION = 'us-east-1';
const LIST = 'alpha-piece-r11,bravo-piece-r11';
const SHORT_LIST = 'ab,cd';
const PORT = '5432';

const tempDirs: string[] = [];

function childTemplatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-4043-r11-'));
  tempDirs.push(dir);
  const path = join(dir, 'child.nested.template.json');
  const child = {
    Parameters: {
      ListIn: { Type: 'CommaDelimitedList' },
      ShortIn: { Type: 'CommaDelimitedList' },
      PortIn: { Type: 'Number' },
    },
    Resources: {
      ListReader: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/c/list', Type: 'String', Value: { 'Fn::Select': [0, { Ref: 'ListIn' }] } },
      },
      ShortReader: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/c/short', Type: 'String', Value: { 'Fn::Select': [1, { Ref: 'ShortIn' }] } },
      },
      PortReader: {
        Type: 'AWS::SQS::Queue',
        Properties: { QueueName: 'q', DelaySeconds: { Ref: 'PortIn' } },
      },
    },
  };
  writeFileSync(path, JSON.stringify(child));
  return path;
}

describe('a parent NoEcho parameter into a child list / Number parameter, through the real provider (review round 11)', () => {
  let states: Map<string, StackState>;
  let leaf: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    states = new Map<string, StackState>();
    // What "AWS" holds per physical id: what the provider was last sent, so
    // a readback answers it exactly (an unchanged redeploy sends nothing).
    const live = new Map<string, Record<string, unknown>>();
    leaf = {
      create: vi.fn((logicalId: string, _type: string, properties: Record<string, unknown>) => {
        live.set(`${logicalId}-phys`, structuredClone(properties));
        return Promise.resolve({ physicalId: `${logicalId}-phys`, attributes: {} });
      }),
      update: vi.fn(
        (_id: string, physicalId: string, _type: string, properties: Record<string, unknown>) => {
          live.set(physicalId, structuredClone(properties));
          return Promise.resolve({ physicalId, wasReplaced: false });
        }
      ),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn((physicalId: string) =>
        Promise.resolve(live.has(physicalId) ? structuredClone(live.get(physicalId)) : undefined)
      ),
    } as unknown as ResourceProvider;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function run(): Promise<Awaited<ReturnType<DeployEngine['deploy']>>> {
    const nested = new NestedStackProvider();
    const pick = (type: string) =>
      type === 'AWS::CloudFormation::Stack' ? (nested as unknown as ResourceProvider) : leaf;
    const providerRegistry = {
      getProvider: vi.fn((type: string) => pick(type)),
      getProviderFor: vi.fn((input: { resourceType: string }) => ({
        provider: pick(input.resourceType),
        provisionedBy: 'sdk',
      })),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    const stateBackend = {
      getState: vi.fn(async (name: string) => {
        const state = states.get(name);
        return state ? { state: structuredClone(state), etag: `etag-${name}` } : null;
      }),
      saveState: vi.fn(async (name: string, _region: string, state: StackState) => {
        states.set(name, structuredClone(state));
        return `etag-${name}`;
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
    saves = stateBackend.saveState;
    const lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const exportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
    const dagBuilder = new DagBuilder();
    const diffCalculator = new DiffCalculator();
    const options = { dryRun: false, concurrency: 1, captureObservedState: false };
    const engine = new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder,
      diffCalculator,
      providerRegistry as never,
      options,
      REGION,
      exportIndexStore as never
    );
    const ctx: NestedStackProviderContext = {
      stateBackend: stateBackend as never,
      lockManager: lockManager as never,
      providerRegistry: providerRegistry as never,
      parentStackName: PARENT,
      parentRegion: REGION,
      accountId: '123456789012',
      awsClients: {} as never,
      stateBucket: 'cdkd-state-test',
      exportIndexStore: exportIndexStore as never,
      nestedTemplates: { Child: childTemplatePath() },
      dagBuilder,
      diffCalculator,
      options,
    };
    const parentTemplate = {
      Parameters: {
        Tok: { Type: 'String', NoEcho: true, Default: LIST },
        Short: { Type: 'String', NoEcho: true, Default: SHORT_LIST },
        Port: { Type: 'String', NoEcho: true, Default: PORT },
      },
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'https://s3.amazonaws.com/a/child.json',
            Parameters: {
              ListIn: { Ref: 'Tok' },
              ShortIn: { Ref: 'Short' },
              PortIn: { Ref: 'Port' },
            },
          },
        },
      },
    } as unknown as CloudFormationTemplate;
    return withNestedStackContext(ctx, () => engine.deploy(PARENT, parentTemplate));
  }

  let saves: ReturnType<typeof vi.fn>;

  it('deploys, sends the real elements and number, and masks each by position in the child', async () => {
    await run();

    const sent = (id: string): Record<string, unknown> =>
      vi.mocked(leaf.create).mock.calls.find((c) => c[0] === id)![2] as Record<string, unknown>;
    expect(sent('ListReader')['Value']).toBe('alpha-piece-r11');
    expect(sent('ShortReader')['Value']).toBe('cd');
    expect(sent('PortReader')['DelaySeconds']).toBe(5432);

    const child = states.get(CHILD)!;
    expect(child.resources['ListReader']!.properties['Value']).toBe('***');
    expect(child.resources['ListReader']!.noEchoLeaves).toEqual([['Value']]);
    expect(child.resources['ShortReader']!.properties['Value']).toBe('***');
    expect(child.resources['ShortReader']!.noEchoLeaves).toEqual([['Value']]);
    expect(child.resources['PortReader']!.properties['DelaySeconds']).toBe('***');
    expect(child.resources['PortReader']!.noEchoLeaves).toEqual([['DelaySeconds']]);
    const everySave = JSON.stringify(saves.mock.calls);
    for (const needle of ['alpha-piece-r11', 'bravo-piece-r11', '"cd"', '"ab"', '5432']) {
      expect(everySave).not.toContain(needle);
    }
  });

  it('an unchanged second deploy sends nothing to the child resources and persists no value (review round 12)', async () => {
    await run();
    expect(vi.mocked(leaf.create)).toHaveBeenCalledTimes(3);
    vi.mocked(leaf.create).mockClear();
    vi.mocked(leaf.update).mockClear();
    vi.mocked(leaf.readCurrentState!).mockClear();

    await run();

    // Premise: the second deploy reached the child and read its readers back.
    expect(vi.mocked(leaf.readCurrentState!).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(leaf.create)).not.toHaveBeenCalled();
    expect(vi.mocked(leaf.update)).not.toHaveBeenCalled();
    const everySave = JSON.stringify(saves.mock.calls);
    for (const needle of ['alpha-piece-r11', 'bravo-piece-r11', '"cd"', '"ab"', '5432']) {
      expect(everySave).not.toContain(needle);
    }
    expect(states.get(CHILD)!.resources['ListReader']!.properties['Value']).toBe('***');
  });
});
