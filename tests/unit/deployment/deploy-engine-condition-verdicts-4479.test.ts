/**
 * A deploy RECORDS the verdict of each condition `cdkd diff` cannot evaluate
 * (issue [#4479](https://github.com/go-to-k/cdkd/issues/4479)), and the diff
 * reuses it.
 *
 * A nested child receives a secret-fed parameter as PLAINTEXT, with the
 * parent's `plaintext -> expression` map as `inheritedSecrets`. The engine
 * evaluates the condition against the plaintext (the real verdict) and records
 * it with a fingerprint over the parameter's EXPRESSION, which is what the
 * diff receives for it. What is pinned here:
 * - the success path and the no-change path persist the record; `--dry-run`
 *   saves nothing;
 * - the record holds no plaintext, and a top-level stack (no inherited map)
 *   records nothing;
 * - the deploy-side token is BYTE-EQUAL to the one the diff receives through
 *   `resolveChildStackParameters`, proven end to end: the child deployed here
 *   diffs clean against its parent row;
 * - a failed deploy leaves no record (the documented FALSE fallback).
 *
 * The resolver is the REAL one: the verdict and the token must come from the
 * same code the deploy runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { buildDiffTree, treeHasChanges } from '../../../src/cli/commands/diff-recursive.js';
import {
  conditionFingerprint,
  conditionInputsFrom,
  deployConditionInputs,
} from '../../../src/deployment/condition-verdicts.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

/** A live secret fetch is a failure of this file's premise. */
const secretSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: vi.fn().mockImplementation(() => ({
      send: secretSend,
      config: { region: () => Promise.resolve('us-east-1') },
      destroy: () => undefined,
    })),
  };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const SSM = 'AWS::SSM::Parameter';
const NESTED = 'AWS::CloudFormation::Stack';
const PLAINTEXT = 'cdkd-4479-stage-live';
const EXPR = '{{resolve:secretsmanager:app/config-4479:SecretString:stage::}}';
const CHILD = 'Parent~Child';

/** The child as deployed: one slot on a condition over the secret-fed `Stage`. */
const childTemplate = (literal = PLAINTEXT): CloudFormationTemplate => ({
  Parameters: { Stage: { Type: 'String' } },
  Conditions: { IsLive: { 'Fn::Equals': [{ Ref: 'Stage' }, literal] } },
  Resources: {
    Sized: { Type: SSM, Properties: { Type: 'String', Value: { 'Fn::If': ['IsLive', 'big', 'small'] } } },
  },
});

describe('DeployEngine records condition verdicts for cdkd diff (#4479)', () => {
  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    secretSend.mockImplementation(() => {
      throw new Error('no secret fetch: the child receives the plaintext from its parent');
    });
    mockProvider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'sized-phys' }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn(),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    expect(secretSend).not.toHaveBeenCalled();
  });

  function makeEngine(
    options: {
      inherited?: Map<string, string>;
      dryRun?: boolean;
      stage?: string;
      parameters?: Record<string, string>;
    } = {}
  ): DeployEngine {
    return new DeployEngine(
      mockStateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Sized']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      mockDiffCalculator as never,
      {
        getProvider: vi.fn().mockReturnValue(mockProvider),
        getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      {
        dryRun: options.dryRun ?? false,
        parameters: options.parameters ?? { Stage: options.stage ?? PLAINTEXT },
        ...(options.inherited && { inheritedSecrets: options.inherited }),
        parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
      },
      'us-east-1'
    );
  }

  const inherited = () => new Map([[PLAINTEXT, EXPR]]);

  function primeCreate(): void {
    mockDiffCalculator.hasChanges!.mockReturnValue(true);
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Sized',
          {
            logicalId: 'Sized',
            changeType: 'CREATE',
            resourceType: SSM,
            desiredProperties: childTemplate().Resources!['Sized']!.Properties!,
          },
        ],
      ])
    );
  }

  function primeNoChange(state: StackState): void {
    mockStateBackend.getState!.mockResolvedValue({ state, etag: 'etag-old' });
    mockDiffCalculator.hasChanges!.mockReturnValue(false);
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        ['Sized', { logicalId: 'Sized', changeType: 'NO_CHANGE', resourceType: SSM }],
      ])
    );
  }

  /** A deployed child record, observed baseline present so no auto-refresh fires. */
  function deployedState(extra: Partial<StackState> = {}): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: CHILD,
      resources: {
        Sized: {
          physicalId: 'sized-phys',
          resourceType: SSM,
          properties: { Type: 'String', Value: 'big' },
          observedProperties: { Type: 'String', Value: 'big' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      exportNames: [],
      parentStack: 'Parent',
      parentLogicalId: 'Child',
      parentRegion: 'us-east-1',
      lastModified: 0,
      ...extra,
    };
  }

  /** What the diff side computes for the child from the parent's row. */
  const diffSideFingerprint = (template = childTemplate()) =>
    conditionFingerprint(
      template,
      'IsLive',
      conditionInputsFrom({ tokens: { Stage: EXPR }, bound: {} })
    )!.fingerprint;

  it('the success path persists the deployed verdict, fingerprinted over the expression', async () => {
    primeCreate();
    await makeEngine({ inherited: inherited() }).deploy(CHILD, childTemplate());

    expect(mockProvider.create!.mock.calls[0]![2]).toMatchObject({ Value: 'big' });
    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(saved.conditionVerdicts).toEqual({
      IsLive: { verdict: true, fingerprint: diffSideFingerprint() },
    });
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);
  });

  it('records the FALSE verdict a deploy computed when the secret does not match', async () => {
    primeCreate();
    await makeEngine({
      inherited: new Map([['cdkd-4479-stage-other', EXPR]]),
      stage: 'cdkd-4479-stage-other',
    }).deploy(CHILD, childTemplate());
    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(saved.conditionVerdicts?.['IsLive']?.verdict).toBe(false);
  });

  it('a top-level stack (no inherited secrets) records nothing', async () => {
    primeCreate();
    await makeEngine().deploy(CHILD, childTemplate());
    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(saved.conditionVerdicts).toBeUndefined();
  });

  it('the no-change path saves the record when state has none, with no provider call', async () => {
    primeNoChange(deployedState());
    await makeEngine({ inherited: inherited() }).deploy(CHILD, childTemplate());
    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState!.mock.calls[0]![2] as StackState;
    expect(saved.conditionVerdicts?.['IsLive']).toEqual({
      verdict: true,
      fingerprint: diffSideFingerprint(),
    });
    expect(mockProvider.create).not.toHaveBeenCalled();
    expect(mockProvider.update).not.toHaveBeenCalled();
  });

  it('the no-change path does not save when the stored record is already equal', async () => {
    primeNoChange(
      deployedState({
        conditionVerdicts: { IsLive: { verdict: true, fingerprint: diffSideFingerprint() } },
      })
    );
    await makeEngine({ inherited: inherited() }).deploy(CHILD, childTemplate());
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('the no-change path replaces a record whose fingerprint is stale', async () => {
    primeNoChange(
      deployedState({ conditionVerdicts: { IsLive: { verdict: false, fingerprint: 'sha256:old' } } })
    );
    await makeEngine({ inherited: inherited() }).deploy(CHILD, childTemplate());
    const saved = mockStateBackend.saveState!.mock.calls[0]![2] as StackState;
    expect(saved.conditionVerdicts?.['IsLive']?.fingerprint).toBe(diffSideFingerprint());
  });

  it('--dry-run never reaches the no-change save', async () => {
    primeNoChange(deployedState());
    await makeEngine({ inherited: inherited(), dryRun: true }).deploy(CHILD, childTemplate());
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('a failed deploy leaves no record in any state it saves (the documented FALSE fallback)', async () => {
    // Starting from a record, so a save that carried the old one would show.
    mockStateBackend.getState!.mockResolvedValue({
      state: deployedState({
        resources: {},
        conditionVerdicts: { IsLive: { verdict: true, fingerprint: diffSideFingerprint() } },
      }),
      etag: 'etag-old',
    });
    primeCreate();
    mockProvider.create!.mockRejectedValue(new Error('create failed'));
    await expect(
      makeEngine({ inherited: inherited() }).deploy(CHILD, childTemplate())
    ).rejects.toThrow();
    expect(mockStateBackend.saveState!.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockStateBackend.saveState!.mock.calls) {
      expect((call[2] as StackState).conditionVerdicts).toBeUndefined();
    }
  });

  it('a closure over the token and a PLAIN parameter records a fingerprint the diff side reproduces', async () => {
    const mixed: CloudFormationTemplate = {
      Parameters: { Stage: { Type: 'String' }, Env: { Type: 'String', Default: 'dev' } },
      Conditions: {
        IsLive: {
          'Fn::And': [
            { 'Fn::Equals': [{ Ref: 'Stage' }, PLAINTEXT] },
            { 'Fn::Equals': [{ Ref: 'Env' }, 'dev'] },
          ],
        },
      },
      Resources: childTemplate().Resources!,
    };
    primeCreate();
    await makeEngine({ inherited: inherited() }).deploy(CHILD, mixed);
    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    const expected = conditionFingerprint(
      mixed,
      'IsLive',
      conditionInputsFrom({ tokens: { Stage: EXPR }, bound: { Env: 'dev' } })
    )!.fingerprint;
    expect(saved.conditionVerdicts).toEqual({ IsLive: { verdict: true, fingerprint: expected } });
  });

  it('a closure reaching a parent NoEcho value (a log-only needle) records nothing', async () => {
    const withPin: CloudFormationTemplate = {
      Parameters: { Stage: { Type: 'String' }, Pin: { Type: 'String' } },
      Conditions: {
        IsLive: {
          'Fn::And': [
            { 'Fn::Equals': [{ Ref: 'Stage' }, PLAINTEXT] },
            { 'Fn::Equals': [{ Ref: 'Pin' }, 'expected'] },
          ],
        },
      },
      Resources: childTemplate().Resources!,
    };
    const map = inherited();
    recordLogOnlyValue(map, 'pin-4821-zq');
    primeCreate();
    await new DeployEngine(
      mockStateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Sized']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      mockDiffCalculator as never,
      {
        getProvider: vi.fn().mockReturnValue(mockProvider),
        getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      {
        dryRun: false,
        parameters: { Stage: PLAINTEXT, Pin: 'pin-4821-zq' },
        inheritedSecrets: map,
        parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
      },
      'us-east-1'
    ).deploy(CHILD, withPin);
    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(saved.conditionVerdicts).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('pin-4821-zq');
  });

  it('a parameter a state resource of the same logical id shadows is never fingerprinted, and an old record is CLEARED', async () => {
    primeNoChange(
      deployedState({
        resources: {
          ...deployedState().resources,
          Stage: {
            physicalId: 'old-resource',
            resourceType: SSM,
            properties: {},
            attributes: {},
            dependencies: [],
          },
        },
        conditionVerdicts: { IsLive: { verdict: true, fingerprint: diffSideFingerprint() } },
      })
    );
    await makeEngine({ inherited: inherited() }).deploy(CHILD, childTemplate());
    // The no-change save must fire to drop the stored record, and must not
    // carry it.
    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    expect((mockStateBackend.saveState!.mock.calls[0]![2] as StackState).conditionVerdicts).toBeUndefined();
  });

  it('a plain value the PARENT supplied (not the Default) never enters a fingerprint', async () => {
    // A deeper child can receive a short ancestor secret embedded in such a
    // value with no needle naming it, so every parent-supplied plain value
    // is withheld.
    const withPin: CloudFormationTemplate = {
      Parameters: { Stage: { Type: 'String' }, Pin: { Type: 'String', Default: 'none' } },
      Conditions: {
        IsLive: {
          'Fn::And': [
            { 'Fn::Equals': [{ Ref: 'Stage' }, PLAINTEXT] },
            { 'Fn::Equals': [{ Ref: 'Pin' }, 'pin-12'] },
          ],
        },
      },
      Resources: childTemplate().Resources!,
    };
    primeCreate();
    await makeEngine({
      inherited: inherited(),
      parameters: { Stage: PLAINTEXT, Pin: 'pin-12' },
    }).deploy(CHILD, withPin);
    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(saved.conditionVerdicts).toBeUndefined();
  });

  it('a supplied value EQUAL to the Default stays a usable input', async () => {
    const withPin: CloudFormationTemplate = {
      Parameters: { Stage: { Type: 'String' }, Pin: { Type: 'String', Default: 'none' } },
      Conditions: {
        IsLive: {
          'Fn::And': [
            { 'Fn::Equals': [{ Ref: 'Stage' }, PLAINTEXT] },
            { 'Fn::Equals': [{ Ref: 'Pin' }, 'none'] },
          ],
        },
      },
      Resources: childTemplate().Resources!,
    };
    primeCreate();
    await makeEngine({
      inherited: inherited(),
      parameters: { Stage: PLAINTEXT, Pin: 'none' },
    }).deploy(CHILD, withPin);
    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(saved.conditionVerdicts?.['IsLive']?.verdict).toBe(true);
  });

  it('an Fn::If inside a resource a KNOWN-false condition prunes is never recorded', async () => {
    const pruned: CloudFormationTemplate = {
      ...childTemplate(),
      Conditions: { ...childTemplate().Conditions, Never: { 'Fn::Equals': ['a', 'b'] } },
      Resources: {
        Gone: {
          Type: SSM,
          Condition: 'Never',
          Properties: { Type: 'String', Value: { 'Fn::If': ['IsLive', 'x', 'y'] } },
        },
      },
    };
    primeCreate();
    await makeEngine({ inherited: inherited() }).deploy(CHILD, pruned);
    for (const call of mockStateBackend.saveState!.mock.calls) {
      expect((call[2] as StackState).conditionVerdicts).toBeUndefined();
    }
    expect(mockStateBackend.saveState).toHaveBeenCalled();
  });
});

describe('the deploy-side token is byte-equal to what the diff receives (#4479)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-4479-token-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['a whole-value reference', EXPR, PLAINTEXT],
    ['a reference embedded in a literal', `stage-${EXPR}`, `stage-${PLAINTEXT}`],
  ])('%s', async (_label, rowValue, childValue) => {
    // Deploy side: the child holds the plaintext and the parent's map.
    const { tokens } = deployConditionInputs({ Stage: childValue }, new Map([[PLAINTEXT, EXPR]]));
    expect(tokens['Stage']).toBe(rowValue);

    // Diff side, end to end: the parent row passes `rowValue`; the child's
    // record was fingerprinted over the deploy-side token. A clean diff with
    // the verdict reused proves the two spellings are byte-equal.
    const template: CloudFormationTemplate = {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsLive: { 'Fn::Equals': [{ Ref: 'Stage' }, childValue] } },
      Resources: {
        Sized: {
          Type: SSM,
          Properties: { Type: 'String', Value: { 'Fn::If': ['IsLive', 'big', 'small'] } },
        },
      },
    };
    const fingerprint = conditionFingerprint(
      template,
      'IsLive',
      conditionInputsFrom({ tokens, bound: {} })
    )!.fingerprint;
    writeFileSync(join(dir, 'child.json'), JSON.stringify(template));
    const childState: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: CHILD,
      resources: {
        Sized: {
          physicalId: 'p',
          resourceType: SSM,
          properties: { Type: 'String', Value: 'big' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
      conditionVerdicts: { IsLive: { verdict: true, fingerprint } },
    };
    const parentState: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: 'Parent',
      resources: {
        Child: {
          physicalId: 'c',
          resourceType: NESTED,
          properties: { Parameters: { Stage: rowValue } },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    };
    const states: Record<string, StackState> = { Parent: parentState, [CHILD]: childState };
    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { Stage: rowValue } },
          },
        },
      },
      nestedTemplates: { Child: join(dir, 'child.json') },
      recursive: true,
      stateBackend: {
        getState: async (name: string) => (states[name] ? { state: states[name], etag: 'e' } : null),
      } as unknown as S3StateBackend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    expect(root.children[0]!.changes.get('Sized')!.changeType).toBe('NO_CHANGE');
    expect(treeHasChanges(root)).toBe(false);
  });
});
