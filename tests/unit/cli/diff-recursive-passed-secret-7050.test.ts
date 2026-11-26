/**
 * go-to-k/cdkd#7050 review: `cdkd diff --recursive` over a nested child whose
 * masked create-only key reads a parameter the parent passed as a secret. The
 * preview holds no passed-secret value MACs and, for a child, no input
 * fingerprints (`previewMaskedInputs` is off), so it cannot prove the key
 * unchanged. It must never HIDE a move behind the mask: it shows the key as a
 * change (display only), whether or not the value moved, while the deploy
 * decides with its MACs. Measured on a record the child's engine wrote.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  recordNestedStackParameterExpressions,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { redactSecretsForState } from '../../../src/deployment/secret-redaction/redact-state.js';
import { TEMPLATE_DERIVED_RULES } from '../../../src/deployment/secret-redaction/rules.js';

const logSpies = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { setLevel: vi.fn(), ...logSpies, child: () => fns };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        if (command.input?.Name === '/app/a' || command.input?.Name === '/app/b') {
          return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        }
        const e = new Error('ParameterNotFound');
        e.name = 'ParameterNotFound';
        throw e;
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
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));
vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { createHmac } = await import('node:crypto');
  class FakeKMSClient {
    async send(command: { input: { Message: Uint8Array } }): Promise<unknown> {
      return {
        KeyId: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
        Mac: new Uint8Array(createHmac('sha256', 'k').update(command.input.Message).digest()),
      };
    }
    destroy(): void {}
  }
  return { ...actual, KMSClient: FakeKMSClient };
});

const { IntrinsicFunctionResolver } = await import('../../../src/deployment/intrinsic-function-resolver.js');
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { buildDiffTree } from '../../../src/cli/commands/diff-recursive.js';
import type { StackState } from '../../../src/types/state.js';

/** The parent's row: `X` joins a sub-floor secret (`Sep`, the text `W` resolves to) with a reference. */
const ROW = {
  TemplateURL: 'https://s3.amazonaws.com/bucket/child.json',
  Parameters: {
    X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', '{{resolve:ssm-secure:/app/a}}']] },
    W: '{{resolve:ssm-secure:/app/b}}',
  },
};

async function parentRow(sep: string) {
  const bag: RecordedSecretValues = new Map();
  const source = structuredClone(ROW);
  const context = {
    template: { Parameters: { Sep: { Type: 'String' } }, Resources: {} } as CloudFormationTemplate,
    resources: {},
    parameters: { Sep: sep },
    conditions: {},
    recordedSecretValues: bag,
  };
  const resolved = (await new IntrinsicFunctionResolver('us-east-1').resolve(source, context as never)) as {
    Parameters: Record<string, unknown>;
  };
  recordNestedStackParameterExpressions(bag, 'AWS::CloudFormation::Stack', resolved, source);
  const redacted = redactSecretsForState(structuredClone(resolved), bag, source, TEMPLATE_DERIVED_RULES, true);
  return { bag, value: String(resolved.Parameters['X']), redacted, source };
}

const childTpl = {
  Parameters: { X: { Type: 'String' }, W: { Type: 'String' } },
  Resources: { Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'mysql', DBName: { Ref: 'X' }, BackupRetentionPeriod: 1 } } },
};

async function deployChild(opts: Record<string, unknown>) {
  const state = { version: 11, stackName: 'Parent~Child', region: 'us-east-1', resources: {}, outputs: {}, lastModified: 0 } as StackState;
  const provider = {
    create: vi.fn(async () => ({ physicalId: 'new', attributes: {} })),
    update: vi.fn(),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    { buildGraph: vi.fn().mockReturnValue({}), getExecutionLevels: vi.fn().mockReturnValue([['Db']]), getDirectDependencies: vi.fn().mockReturnValue([]) } as never,
    new DiffCalculator(),
    { getProvider: vi.fn().mockReturnValue(provider), getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }), getRegisteredTypes: vi.fn().mockReturnValue([]), validateResourceTypes: vi.fn(), validateResourceProperties: vi.fn() } as never,
    opts as never,
    'us-east-1'
  );
  await engine.deploy('Parent~Child', childTpl as never);
  const saved = saveState.mock.calls.flat().filter((a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object));
  return saved[saved.length - 1]!.resources['Db']!;
}

describe('cdkd diff: a passed-secret child key it cannot prove (#7050 review)', () => {
  it('is shown as a change, unchanged or moved, never treated as unchanged', async () => {
    const { bag, value, redacted, source } = await parentRow('q7');
    const db = await deployChild({
      dryRun: false,
      parameters: { X: value, W: 'q7' },
      inheritedSecrets: bag,
      parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
      passedParameterClasses: new Map([['X', 'secret'], ['W', 'secret']]),
    });
    expect(db.properties['DBName']).toBe('***');
    expect(Object.keys(db.noEchoValueMacs ?? {})).toEqual(['DBName']);
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-passed-secret-'));
    writeFileSync(join(dir, 'child.json'), JSON.stringify(childTpl));
    // `q7`: the parent's values as deployed; `zz`: the passed value moved.
    try {
    for (const sep of ['q7', 'zz']) {
      const states: Record<string, StackState> = {
        Parent: { stackName: 'Parent', region: 'us-east-1', version: 17, lastModified: 0, outputs: {}, resources: { Child: { physicalId: 'p', resourceType: 'AWS::CloudFormation::Stack', properties: redacted as never, attributes: {}, dependencies: [] } } } as StackState,
        'Parent~Child': { stackName: 'Parent~Child', region: 'us-east-1', version: 17, lastModified: 0, outputs: {}, resources: { Db: db } } as StackState,
      };
      logSpies.warn.mockClear();
      const root = await buildDiffTree({
        stackName: 'Parent',
        displayName: 'Parent',
        region: 'us-east-1',
        template: { Parameters: { Sep: { Type: 'String' } }, Resources: { Child: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'child.json' }, Properties: source } } } as never,
        parameters: { Sep: sep },
        nestedTemplates: { Child: join(dir, 'child.json') },
        recursive: true,
        stateBackend: { getState: async (n: string) => (states[n] ? { state: states[n], etag: 'e' } : null) } as never,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      } as never);
      const row = root.children[0]?.changes.get('Db');
      expect(row?.changeType, `Sep ${sep}`).toBe('UPDATE');
      expect((row?.propertyChanges ?? []).map((pc) => [pc.path, pc.oldValue])).toEqual([['DBName', '***']]);
      // Never the deploy's "treated as unchanged" warnings: nothing is hidden.
      expect(
        logSpies.warn.mock.calls.map((call) => String(call[0])).filter((line) => /treated as unchanged/.test(line))
      ).toEqual([]);
    }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
