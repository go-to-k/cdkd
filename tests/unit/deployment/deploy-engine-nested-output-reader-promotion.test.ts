/**
 * A parent resource reading a nested child's `Outputs.<Key>` is re-provisioned
 * when that output moves, and ONLY then (issue
 * [#3631](https://github.com/go-to-k/cdkd/issues/3631)), driven through
 * `DeployEngine.deploy` with the REAL `DiffCalculator`, `DagBuilder` and
 * `IntrinsicFunctionResolver`.
 *
 * The diff cannot know which outputs a child deploy will move, so it promotes
 * every reader of an updated nested stack; the fix is sound only because the
 * engine re-resolves a promoted reader against the IN-FLIGHT `Child` row (the
 * attributes `NestedStackProvider.update` returned) and skips the provider call
 * when the resolved bag equals the record. The calculator-level suite
 * (`tests/unit/analyzer/diff-calculator-nested-output-promotion.test.ts`)
 * proves the promotion; this file proves both halves of that claim — the moved
 * output reaches the reader's `update()`, the unmoved one issues none.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const logged = vi.hoisted(() => ({ debug: [] as string[] }));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn((message: string) => {
      logged.debug.push(message);
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

// The calculator's create-only lookup (`DescribeType`) fails fast, as in the
// analyzer suites (issue #2081): registry-only classification.
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

const STACK = 'nested-reader-stack';
const REGION = 'us-east-1';
const CHILD_ARN = `arn:cdkd-local:${REGION}:123456789012:nested-stack/${STACK}/Child`;

const template: CloudFormationTemplate = {
  Resources: {
    // The child's template moved (its asset hash is in the URL), so the row
    // takes an in-place UPDATE; its outputs are decided by the child deploy.
    Child: {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'https://s3.amazonaws.com/assets/child-v2.json' },
    },
    MovedReader: {
      Type: 'AWS::SSM::Parameter',
      Properties: {
        Name: '/app/moved',
        Type: 'String',
        Value: { 'Fn::GetAtt': ['Child', 'Outputs.Moved'] },
      },
    },
    StaticReader: {
      Type: 'AWS::SSM::Parameter',
      Properties: {
        Name: '/app/static',
        Type: 'String',
        Value: { 'Fn::GetAtt': ['Child', 'Outputs.Static'] },
      },
    },
  },
};

function priorState(): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Child: {
        physicalId: CHILD_ARN,
        resourceType: 'AWS::CloudFormation::Stack',
        properties: { TemplateURL: 'https://s3.amazonaws.com/assets/child-v1.json' },
        observedProperties: { TemplateURL: 'https://s3.amazonaws.com/assets/child-v1.json' },
        attributes: { 'Outputs.Moved': 'moved-v1', 'Outputs.Static': 'static-v1' },
        dependencies: [],
      },
      MovedReader: {
        physicalId: '/app/moved',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/moved', Type: 'String', Value: 'moved-v1' },
        observedProperties: { Name: '/app/moved', Type: 'String', Value: 'moved-v1' },
        attributes: {},
        dependencies: ['Child'],
      },
      StaticReader: {
        physicalId: '/app/static',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/static', Type: 'String', Value: 'static-v1' },
        observedProperties: { Name: '/app/static', Type: 'String', Value: 'static-v1' },
        attributes: {},
        dependencies: ['Child'],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

describe('DeployEngine - readers of a moved nested output (issue #3631)', () => {
  let provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    logged.debug.length = 0;
    provider = {
      create: vi.fn(),
      // The nested stack's update returns the child's NEW outputs — `Moved`
      // moved, `Static` did not — the way `NestedStackProvider.update` does.
      update: vi.fn((logicalId: string, physicalId: string) =>
        Promise.resolve(
          logicalId === 'Child'
            ? {
                physicalId,
                wasReplaced: false,
                attributes: { 'Outputs.Moved': 'moved-v2', 'Outputs.Static': 'static-v1' },
              }
            : { physicalId, wasReplaced: false }
        )
      ),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: priorState(), etag: 'etag-old' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false },
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  function updateCallFor(logicalId: string): unknown[] | undefined {
    return provider.update.mock.calls.find((c) => c[0] === logicalId);
  }

  it('updates the reader of the MOVED output with the value the child deploy returned', async () => {
    await makeEngine().deploy(STACK, template);

    expect(updateCallFor('Child')).toBeDefined();
    const moved = updateCallFor('MovedReader');
    expect(moved).toBeDefined();
    // (logicalId, physicalId, resourceType, properties, previousProperties)
    expect((moved![3] as Record<string, unknown>)['Value']).toBe('moved-v2');

    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['MovedReader']?.properties?.['Value']).toBe('moved-v2');
  });

  // A `NoEcho` custom resource's value persists as the mask (issue #2274), and
  // the in-run recovery can hand the plaintext back only when the child
  // re-invoked the handler THIS run. Here it did not (the child changed
  // elsewhere), so the child's output — and the `Child` row — still read `***`.
  // A promoted reader's UPDATE arm resolves its WHOLE bag and refuses a read of
  // the mask before the no-change skip, failing a deploy that used to leave the
  // reader alone; so a reader with a masked read anywhere is not promoted. The
  // mixed shapes are the ones a per-ATTRIBUTE exclusion let through: an
  // unmasked output in the same reader promoted it.
  const secretReaderShapes: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    [
      'reading only the masked output',
      { Value: { 'Fn::GetAtt': ['Child', 'Outputs.Secret'] } },
      { Value: '***' },
    ],
    [
      'reading a masked and an unmasked output in ONE property',
      {
        Value: {
          'Fn::Join': [
            '-',
            [
              { 'Fn::GetAtt': ['Child', 'Outputs.Static'] },
              { 'Fn::GetAtt': ['Child', 'Outputs.Secret'] },
            ],
          ],
        },
      },
      { Value: 'static-v1-***' },
    ],
    [
      'reading a masked and an unmasked output in TWO properties',
      {
        Value: { 'Fn::GetAtt': ['Child', 'Outputs.Secret'] },
        Description: { 'Fn::GetAtt': ['Child', 'Outputs.Static'] },
      },
      { Value: '***', Description: 'static-v1' },
    ],
  ];

  it.each(secretReaderShapes)(
    'does not refuse the deploy over a reader %s the child did not re-mint',
    async (_shape, readerProps, recordedProps) => {
      const state = priorState();
      state.resources['Child']!.attributes = {
        ...state.resources['Child']!.attributes,
        'Outputs.Secret': '***',
      };
      const recorded = { Name: '/app/secret', Type: 'String', ...recordedProps };
      state.resources['SecretReader'] = {
        physicalId: '/app/secret',
        resourceType: 'AWS::SSM::Parameter',
        properties: recorded,
        observedProperties: recorded,
        attributes: {},
        dependencies: ['Child'],
      };
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      provider.update.mockImplementation((logicalId: string, physicalId: string) =>
        Promise.resolve(
          logicalId === 'Child'
            ? {
                physicalId,
                wasReplaced: false,
                attributes: {
                  'Outputs.Moved': 'moved-v2',
                  'Outputs.Static': 'static-v1',
                  'Outputs.Secret': '***',
                },
              }
            : { physicalId, wasReplaced: false }
        )
      );
      const withSecretReader: CloudFormationTemplate = {
        Resources: {
          ...template.Resources,
          SecretReader: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Name: '/app/secret', Type: 'String', ...readerProps },
          },
        },
      };

      await makeEngine().deploy(STACK, withSecretReader);

      expect(updateCallFor('SecretReader')).toBeUndefined();
      // NOT promoted, rather than promoted and skipped: the skip is what
      // go-to-k/cdkd#3662 changes, and the refusal sits in front of it today.
      expect(logged.debug).not.toContain(
        'Skipping SecretReader: no actual changes after intrinsic function resolution'
      );
      // The unmasked sibling in the same deploy is still carried.
      expect((updateCallFor('MovedReader')![3] as Record<string, unknown>)['Value']).toBe(
        'moved-v2'
      );
    }
  );

  it('issues NO provider call for the reader of an output the child deploy did not move', async () => {
    await makeEngine().deploy(STACK, template);

    // Promoted by the diff like its sibling, then dropped by the engine's
    // re-resolve-and-skip. The skip line is what separates this from a reader
    // that was never promoted, which issues no call either.
    expect(logged.debug).toContain(
      'Skipping StaticReader: no actual changes after intrinsic function resolution'
    );
    expect(updateCallFor('StaticReader')).toBeUndefined();
    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['StaticReader']?.properties?.['Value']).toBe('static-v1');
  });
});
