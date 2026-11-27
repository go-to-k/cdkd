/**
 * go-to-k/cdkd#7050 (PR #7060 review): a nested row parameter the parent marked
 * `sub-floor` with NO certified spelling persists as `***` in the child, while
 * the child's in-memory diff (comparison) value stays `xq7:{{BIG}}` (masking it
 * there plans a phantom UPDATE). `q7` is a secret below the value scan's
 * floor. This proves that comparison value reaches no RENDERED output:
 *
 * - the child's deploy: its plan line, the `--require-approval` summary at
 *   every level (the destructive list, the `broadening` security table), and
 *   every `--verbose` log line;
 * - `cdkd diff` over the parent, as text and `--json`, non-recursive and
 *   `--recursive` (the child's rows, its security table, every log line).
 *
 * Each scan finds no `q7` outside a `{{resolve:...}}` span, and no plaintext
 * of the secret above the floor. The resolver's own debug lines are scanned
 * too, in the diff pass and the provisioning pass alike: a piece read from the
 * parameter (`Fn::Select ... "xq7"`) is masked by provenance there
 * (go-to-k/cdkd#7077), and each such line is asserted present.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import {
  recordNestedStackParameterExpressions,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { redactSecretsForState } from '../../../src/deployment/secret-redaction/redact-state.js';
import { TEMPLATE_DERIVED_RULES } from '../../../src/deployment/secret-redaction/rules.js';
import { attributionRefusedParameters } from '../../../src/deployment/secret-redaction/nested-stack/parameter-tables.js';

const PIN = 'q7';
const BIG = 'b1g-s3cret-v4lue-7050';
const BIG2 = 'm0ved-s3cret-v4lue-7050';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        const name = command.input?.Name;
        if (name === '/app/pin') return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        if (name === '/app/big') return { Parameter: { Value: 'b1g-s3cret-v4lue-7050', Type: 'SecureString' } };
        if (name === '/app/big2') return { Parameter: { Value: 'm0ved-s3cret-v4lue-7050', Type: 'SecureString' } };
        const notFound = new Error(`ParameterNotFound: ${String(name)}`);
        notFound.name = 'ParameterNotFound';
        throw notFound;
      }),
    },
    secretsManager: { send: vi.fn().mockRejectedValue(new Error('unused')) },
    cloudFormation: { send: () => Promise.reject(new Error('DescribeType unavailable')) },
  }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return { ...actual, CloudFormationClient: vi.fn(() => ({ send: () => Promise.reject(new Error('DescribeType unavailable')) })) };
});
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));
vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { createHmac } = await import('node:crypto');
  class FakeKMSClient {
    async send(command: { input: { Message: Uint8Array } }): Promise<unknown> {
      return {
        KeyId: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
        Mac: new Uint8Array(createHmac('sha256', 'local-hmac-key-7050').update(command.input.Message).digest()),
      };
    }
    destroy(): void {}
  }
  return { ...actual, KMSClient: FakeKMSClient };
});

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { DeployEngine } = await import('../../../src/deployment/deploy-engine.js');
const { DiffCalculator } = await import('../../../src/analyzer/diff-calculator.js');
const { buildDiffTree, diffTreeToJson, renderDiffTree } = await import('../../../src/cli/commands/diff-recursive.js');
const { renderApprovalRequest } = await import('../../../src/cli/commands/require-approval.js');
const { SECURITY_TABLE_WITHHELD } = await import('../../../src/cli/commands/diff-recursive/passed-secret-display.js');
const { getLogger } = await import('../../../src/utils/logger.js');
type DiffTreeNode = import('../../../src/cli/commands/diff-recursive/types.js').DiffTreeNode;

const NESTED = 'AWS::CloudFormation::Stack';
const TEMPLATE_URL = 'https://s3.amazonaws.com/bucket/child.json';
const PIN_TOKEN = '{{resolve:ssm-secure:/app/pin}}';
const tokenOf = (big: string) => (big === BIG ? '{{resolve:ssm-secure:/app/big}}' : '{{resolve:ssm-secure:/app/big2}}');
/** The parent's spelling of `X`: its TEXT holds the pin, so no spelling is certified. */
const rowSource = (big: string) => ({
  TemplateURL: TEMPLATE_URL,
  Parameters: { X: { 'Fn::Join': [':', [`x${PIN}`, tokenOf(big)]] }, Y: PIN_TOKEN },
});

/** Child readers of `X`: plain leaves, a replace-on-change name, and an IAM statement. */
const READS: Record<string, unknown> = {
  Ref: { Ref: 'X' },
  Select: { 'Fn::Select': [0, { 'Fn::Split': [':', { Ref: 'X' }] }] },
  Split: { 'Fn::Split': [':', { Ref: 'X' }] },
  Join: { 'Fn::Join': ['-', { 'Fn::Split': [':', { Ref: 'X' }] }] },
};
const CHILD_TEMPLATE = {
  Parameters: { X: { Type: 'String' }, Y: { Type: 'String' } },
  Resources: {
    ...Object.fromEntries(
      Object.entries(READS).map(([shape, node]) => [
        `Leaf${shape}`,
        { Type: 'AWS::SQS::Queue', Properties: { QueueName: `leaf-${shape.toLowerCase()}`, Value: node } },
      ])
    ),
    // A name read from `X`: its change is a replacement (the destructive list).
    Named: { Type: 'AWS::SQS::Queue', Properties: { QueueName: { Ref: 'X' } } },
    // A statement built from `X`: the `broadening` table prints resolved values.
    Pol: {
      Type: 'AWS::IAM::Policy',
      Properties: {
        PolicyName: 'p',
        Roles: ['r'],
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: { 'Fn::Sub': 'arn:aws:s3:::${X}' } }],
        },
      },
    },
  },
};
const IDS = Object.keys(CHILD_TEMPLATE.Resources);

function contextFor(bag: RecordedSecretValues) {
  return {
    template: { Parameters: {}, Resources: {} } as CloudFormationTemplate,
    resources: {},
    parameters: {},
    conditions: {},
    recordedSecretValues: bag,
  };
}

/** The parent row's deploy pass: its bag (`X` marked sub-floor), the value passed, and the row it persists. */
async function parentRow(big: string) {
  const bag: RecordedSecretValues = new Map();
  const source = rowSource(big);
  const resolved = (await new IntrinsicFunctionResolver('us-east-1').resolve(
    structuredClone(source),
    contextFor(bag) as never
  )) as { Parameters: Record<string, unknown> };
  const value = `x${PIN}:${big}`;
  expect(resolved.Parameters['X']).toBe(value);
  recordNestedStackParameterExpressions(bag, NESTED, resolved, source);
  // Premise: the parent marked `X` `sub-floor` with no certified spelling.
  expect(attributionRefusedParameters.get(bag)?.get('X')).toBe('sub-floor');
  const persisted = redactSecretsForState(structuredClone(resolved), bag, source, TEMPLATE_DERIVED_RULES, true);
  return { bag, value, persisted: persisted as Record<string, unknown> };
}

const captured: string[] = [];
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const dir = mkdtempSync(join(tmpdir(), 'cdkd-7050-render-'));
writeFileSync(join(dir, 'child.json'), JSON.stringify(CHILD_TEMPLATE));

beforeEach(() => {
  resetAccountInfoCache();
  for (const method of consoleMethods) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    });
  }
  getLogger().setLevel('debug');
});
afterEach(() => {
  captured.length = 0;
  getLogger().setLevel('info');
  vi.restoreAllMocks();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const isResolverLine = (line: string) => line.includes('[IntrinsicFunctionResolver]');

/** The text outside every `{{resolve:...}}` span. */
const outsideSpans = (text: string) => text.split(/\{\{resolve:[^}]+\}\}/).join('\u0000');

/** Every place a printed text exposes a secret: the pin outside a span, or a plaintext above the floor. */
function leaks(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => outsideSpans(line).includes(PIN) || line.includes(BIG) || line.includes(BIG2));
}

type Level = 'any-change' | 'destructive' | 'broadening';

/** The child's deploy, printing everything it would print. */
async function deployChild(records: Record<string, ResourceState>, big: string, level: Level) {
  const { bag, value } = await parentRow(big);
  const state = { version: 11, stackName: 'Parent~Child', region: 'us-east-1', resources: records, outputs: {}, lastModified: 0 };
  const provider = {
    // A fresh id per create: a replacement's create-first meets no existing name.
    create: vi.fn(async (id: string) => ({ physicalId: `pid-${id}-${big === BIG ? 1 : 2}`, attributes: {} })),
    update: vi.fn(async (id: string) => ({ physicalId: `pid-${id}`, attributes: {} })),
    delete: vi.fn(async () => undefined),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const approvals: string[] = [];
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state: structuredClone(state), etag: 'e0' }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
      loadRetainedRecord: vi.fn().mockResolvedValue(null),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([IDS]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      dryRun: false,
      parameters: { X: value, Y: PIN },
      inheritedSecrets: bag,
      parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
      passedParameterClasses: new Map([
        ['X', 'secret'],
        ['Y', 'secret'],
      ]),
      requireApproval: level,
      approveDeployment: async (request: Parameters<typeof renderApprovalRequest>[0]) => {
        approvals.push(renderApprovalRequest(request));
        return true;
      },
    } as never,
    'us-east-1'
  );
  let thrown: unknown;
  await engine.deploy('Parent~Child', structuredClone(CHILD_TEMPLATE) as never).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter((a): a is StackState => typeof a === 'object' && a !== null && 'resources' in a);
  const printed = [...approvals, ...captured, thrown instanceof Error ? thrown.message : ''];
  captured.length = 0;
  return {
    thrown,
    approvals,
    printed: printed.filter((line) => !isResolverLine(line)).join('\n'),
    resolverLines: printed.filter(isResolverLine).join('\n'),
    records: saved[saved.length - 1]?.resources ?? {},
    calls: [...provider.create.mock.calls, ...provider.update.mock.calls].map((call) => String(call[0])),
  };
}

describe("the child's deploy prints no sub-floor text of a parameter with no certified spelling (#7050)", () => {
  for (const level of ['any-change', 'destructive', 'broadening'] as const) {
    it(`--require-approval ${level}: create, move, and same-value redeploy`, async () => {
      const created = await deployChild({}, BIG, level);
      expect(created.thrown).toBeUndefined();
      expect(leaks(created.printed), created.printed).toEqual([]);
      expect(leaks(created.resolverLines), created.resolverLines).toEqual([]);
      expect(created.resolverLines).toMatch(/Resolved Fn::Select: index \*\*\* resolved to \*\*\*/);
      for (const id of IDS) expect(leaks(JSON.stringify(created.records[id] ?? {})), id).toEqual([]);

      // The parent's value moved: a real change, shown and executed.
      const moved = await deployChild(created.records, BIG2, level);
      expect(moved.thrown).toBeUndefined();
      expect(leaks(moved.printed), moved.printed).toEqual([]);
      expect(leaks(moved.resolverLines), moved.resolverLines).toEqual([]);
      expect(moved.calls.sort()).toEqual([...IDS].sort());
      expect(moved.approvals.length, moved.printed).toBe(1);
      // Still shown as the change it is, its value masked: the replacement
      // line, and the security change (its table withheld).
      expect(moved.printed).toMatch(
        /Property QueueName of AWS::SQS::Queue requires replacement \(from \*\*\* to \*\*\*\)/
      );
      if (level === 'broadening') expect(moved.approvals[0]).toContain(SECURITY_TABLE_WITHHELD);
      else expect(moved.approvals[0]).toContain('Parent~Child: AWS::SQS::Queue Named will be replaced');

      // The same value again: no phantom change.
      const same = await deployChild(moved.records, BIG2, level);
      expect(same.thrown).toBeUndefined();
      expect(same.calls).toEqual([]);
      expect(same.approvals).toEqual([]);
      expect(leaks(same.printed), same.printed).toEqual([]);
      expect(leaks(same.resolverLines), same.resolverLines).toEqual([]);
      // The same-value redeploy prints the diff pass's lines (go-to-k/cdkd#7077).
      expect(same.resolverLines).toMatch(/Resolved Fn::Select: index \*\*\* resolved to \*\*\*/);
    });
  }
});

describe('cdkd diff prints no sub-floor text of a parameter with no certified spelling (#7050)', () => {
  async function deployedStates(): Promise<Record<string, StackState>> {
    const { persisted } = await parentRow(BIG);
    const created = await deployChild({}, BIG, 'any-change');
    expect(created.thrown).toBeUndefined();
    const stack = (name: string, resources: Record<string, ResourceState>) =>
      ({ stackName: name, region: 'us-east-1', version: 17, lastModified: 0, outputs: {}, resources }) as StackState;
    return {
      Parent: stack('Parent', {
        Child: { physicalId: 'p', resourceType: NESTED, properties: persisted, attributes: {}, dependencies: [] } as never,
      }),
      'Parent~Child': stack('Parent~Child', created.records),
    };
  }

  async function securityTables(node: DiffTreeNode): Promise<string[]> {
    const own = (await node.securityDiff?.())?.rendered ?? '';
    const below = await Promise.all(node.children.map(securityTables));
    return [own, ...below.flat()];
  }

  for (const recursive of [false, true]) {
    for (const big of [BIG, BIG2]) {
      const label = `${recursive ? '--recursive' : 'non-recursive'}, ${big === BIG ? 'unchanged' : 'moved'} value`;
      it(`text and --json (${label})`, async () => {
        const stored = await deployedStates();
        captured.length = 0;
        const root = await buildDiffTree({
          stackName: 'Parent',
          displayName: 'Parent',
          region: 'us-east-1',
          template: {
            Resources: {
              Child: { Type: NESTED, Metadata: { 'aws:asset:path': 'child.json' }, Properties: rowSource(big) },
            },
          } as never,
          parameters: {},
          nestedTemplates: { Child: join(dir, 'child.json') },
          recursive,
          stateBackend: {
            getState: async (name: string) => (stored[name] ? { state: structuredClone(stored[name]), etag: 'e' } : null),
          } as never,
          diffCalculator: new DiffCalculator(),
          isNestedChild: false,
        } as never);
        const lines: string[] = [];
        renderDiffTree(root, true, (line) => lines.push(line));
        const printed = [
          ...lines,
          JSON.stringify(diffTreeToJson(root)),
          ...(await securityTables(root)),
          // The resolver's lines too (go-to-k/cdkd#7077).
          ...captured,
        ].join('\n');
        expect(leaks(printed), printed).toEqual([]);
        if (recursive) {
          const child = root.children[0]!;
          // The moved value is a real change on every reader; the unchanged
          // one is shown as a change too (the diff cannot prove it), never hidden.
          for (const id of IDS) expect(child.changes.get(id)?.changeType, id).not.toBe('NO_CHANGE');
        }
      });
    }
  }
});
