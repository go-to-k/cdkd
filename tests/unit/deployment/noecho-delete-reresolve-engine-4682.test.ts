import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import {
  SECRET_MASK,
  passedNoEchoParametersOf,
  recordNoEchoParameterFreshValue,
  recordPassedNoEchoParameters,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { NoEchoDeleteValues } from '../../../src/deployment/noecho-delete-reresolution.js';
import {
  maskedInputFingerprint,
  maskedPropertyFingerprint,
  parameterInputsFor,
} from '../../../src/deployment/masked-property-fingerprints.js';
import { getLogger } from '../../../src/utils/logger.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

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

vi.mock('../../../src/utils/aws-clients.js', async () => {
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    getAwsClients: () => ({
      cloudFormation: {
        send: vi.fn((command: { input?: { TypeName?: string } }) => {
          const paths = CREATE_ONLY_PATHS_SNAPSHOT.get(command.input?.TypeName ?? '');
          if (paths === undefined) {
            return Promise.reject(
              Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
                name: 'AccessDeniedException',
                $metadata: { httpStatusCode: 403 },
              })
            );
          }
          return Promise.resolve({
            Schema: JSON.stringify({
              createOnlyProperties: paths.map((path) => `/properties/${path.join('/')}`),
              writeOnlyProperties: [],
            }),
          });
        }),
      },
      sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    }),
  };
});

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

/**
 * go-to-k/cdkd#4682, the deploy half: a replacement deleting the OLD record of
 * a resource still in the template hands the delete today's values at the
 * record's NoEcho coordinates (a custom resource sends them instead of
 * skipping); a template REMOVAL hands none, so the skip stays. A nested child
 * re-resolves a parameter its parent filled from a NoEcho value.
 */
const STACK = 'noecho-4682-stack';
const REGION = 'us-east-1';
const VALUE = 'deploy-noecho-display-4682';

describe('DeployEngine: NoEcho values on a replacement delete (go-to-k/cdkd#4682)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  const logger = getLogger() as unknown as Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn().mockResolvedValue({
        physicalId: 'arn:aws:sns:us-east-1:123456789012:new-name',
        attributes: {},
      }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
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
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun: false, captureObservedState: false, ...options } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const CR = 'Custom::Seed';
  const TOKEN_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:h';

  function state(resourceType = CR): StackState {
    return {
      version: 11 as never,
      region: REGION,
      stackName: STACK,
      resources: {
        Topic: {
          physicalId: 'arn:aws:sns:us-east-1:123456789012:old-name',
          resourceType,
          properties: {
            ...(resourceType === CR ? { ServiceToken: TOKEN_ARN } : {}),
            TopicName: 'old-name',
            DisplayName: SECRET_MASK,
          },
          attributes: {},
          dependencies: [],
          noEchoLeaves: [['DisplayName']],
          provisionedBy: 'sdk',
        },
      },
      outputs: {},
      lastModified: 0,
    };
  }

  function templateOf(
    properties: Record<string, unknown>,
    parameters: Record<string, unknown> = {
      Secret: { Type: 'String', NoEcho: true, Default: VALUE },
    },
    resourceType = CR
  ): CloudFormationTemplate {
    return {
      Parameters: parameters,
      Resources: { Topic: { Type: resourceType, Properties: properties } },
    } as CloudFormationTemplate;
  }

  /** `--recreate-via-sdk-provider Topic`: a replacement of a resource still in the template. */
  const recreate = {
    recreateTargets: {
      stackName: STACK,
      viaCcApi: new Set<string>(),
      viaSdkProvider: new Set(['Topic']),
    },
  };

  function topicDeleteContext(): Record<string, unknown> {
    const del = provider.delete!.mock.calls.filter((c) => c[0] === 'Topic');
    expect(del).toHaveLength(1);
    return del[0]![4] as Record<string, unknown>;
  }

  function nothingPersistedOrLoggedCarries(value: string): void {
    expect(JSON.stringify(stateBackend.saveState!.mock.calls)).not.toContain(value);
    expect(JSON.stringify(stateBackend.appendRollbackJournalSegment!.mock.calls)).not.toContain(
      value
    );
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(JSON.stringify(logger[level]!.mock.calls)).not.toContain(value);
    }
  }

  it("re-resolves a custom resource's NoEcho coordinate on a replacement while it is still in the template", async () => {
    stateBackend.getState!.mockResolvedValue({ state: state(), etag: 'etag-old' });
    await makeEngine(recreate).deploy(
      STACK,
      templateOf({ ServiceToken: TOKEN_ARN, TopicName: 'old-name', DisplayName: { Ref: 'Secret' } })
    );

    const context = topicDeleteContext();
    expect(context['recordedNoEchoLeaves']).toEqual([['DisplayName']]);
    const values = context['noEchoDeleteValues'] as NoEchoDeleteValues;
    expect(values.leaves).toEqual([{ coordinate: ['DisplayName'], value: VALUE }]);
    expect(values.maskSecrets(`x ${VALUE}`)).toBe(`x ${SECRET_MASK}`);
    // The OLD record is what the delete is handed: still masked.
    expect(provider.delete!.mock.calls.find((c) => c[0] === 'Topic')![3]).toMatchObject({
      DisplayName: SECRET_MASK,
    });
    nothingPersistedOrLoggedCarries(VALUE);
  });

  it("hands NO values to a replacement of a type whose delete does not read them (an SNS topic)", async () => {
    stateBackend.getState!.mockResolvedValue({
      state: state('AWS::SNS::Topic'),
      etag: 'etag-old',
    });
    await makeEngine().deploy(
      STACK,
      templateOf(
        { TopicName: 'new-name', DisplayName: { Ref: 'Secret' } },
        undefined,
        'AWS::SNS::Topic'
      )
    );
    const context = topicDeleteContext();
    expect(context['recordedNoEchoLeaves']).toEqual([['DisplayName']]);
    expect(context).not.toHaveProperty('noEchoDeleteValues');
  });

  it('hands NO values to the delete of a resource the template removed (the skip stays)', async () => {
    stateBackend.getState!.mockResolvedValue({ state: state(), etag: 'etag-old' });
    const template = {
      Parameters: { Secret: { Type: 'String', NoEcho: true, Default: VALUE } },
      Resources: {
        Other: { Type: 'AWS::SNS::Topic', Properties: { DisplayName: { Ref: 'Secret' } } },
      },
    } as CloudFormationTemplate;
    await makeEngine().deploy(STACK, template);

    const context = topicDeleteContext();
    expect(context['recordedNoEchoLeaves']).toEqual([['DisplayName']]);
    expect(context).not.toHaveProperty('noEchoDeleteValues');
  });

  it('re-resolves, in a nested child, a parameter its parent filled from a NoEcho value', async () => {
    stateBackend.getState!.mockResolvedValue({ state: state(), etag: 'etag-old' });
    const inherited: RecordedSecretValues = new Map();
    recordNoEchoParameterFreshValue(VALUE, inherited);
    recordPassedNoEchoParameters(
      inherited,
      { ChildSecret: { Ref: 'ParentSecret' } },
      { parameters: new Set(['ParentSecret']) }
    );
    await makeEngine({
      ...recreate,
      parameters: { ChildSecret: VALUE },
      inheritedSecrets: inherited,
      passedNoEchoParameters: passedNoEchoParametersOf(inherited),
      parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: REGION },
    }).deploy(
      STACK,
      // Declared PLAIN in the child: only the parent knows it is NoEcho.
      templateOf(
        { ServiceToken: TOKEN_ARN, TopicName: 'old-name', DisplayName: { Ref: 'ChildSecret' } },
        { ChildSecret: { Type: 'String' } }
      )
    );

    const values = topicDeleteContext()['noEchoDeleteValues'] as NoEchoDeleteValues;
    expect(values.leaves).toEqual([{ coordinate: ['DisplayName'], value: VALUE }]);
    nothingPersistedOrLoggedCarries(VALUE);
  });

  it.each([
    ['delivers the value while the INPUT fingerprint equals the one this deploy stamps', 'today'],
    ["refuses it when the property's resolved non-secret INPUT moved since the deploy (#4543)", 'stale'],
  ])('%s', async (_label, which) => {
    const recorded = state();
    const parameters = {
      Secret: { Type: 'String', NoEcho: true, Default: VALUE },
      Host: { Type: 'String', Default: 'host-today' },
    };
    const node = { 'Fn::Join': [':', [{ Ref: 'Host' }, { Ref: 'Secret' }]] };
    const template = templateOf(
      { ServiceToken: TOKEN_ARN, TopicName: 'old-name', DisplayName: node },
      parameters
    );
    const text = maskedPropertyFingerprint(node);
    // What a deploy with `Host` = `host` stamps: the engine's own parameter
    // classes, no resource read (the node reads none).
    const stamped = async (host: string): Promise<string> =>
      (await maskedInputFingerprint(node, {
        template,
        parameterInput: parameterInputsFor({ template, values: { Secret: VALUE, Host: host } })
          .parameterInput,
        resolve: () => Promise.reject(new Error('no resource read')),
      }))!;
    recorded.resources['Topic']!.maskedPropertyFingerprints = { DisplayName: text };
    recorded.resources['Topic']!.maskedPropertyInputFingerprints = {
      DisplayName: await stamped(which === 'today' ? 'host-today' : 'host-before'),
    };
    stateBackend.getState!.mockResolvedValue({ state: recorded, etag: 'etag-old' });
    await makeEngine(recreate).deploy(STACK, template);
    if (which === 'today') {
      const values = topicDeleteContext()['noEchoDeleteValues'] as NoEchoDeleteValues;
      expect(values.leaves).toEqual([
        { coordinate: ['DisplayName'], value: `host-today:${VALUE}` },
      ]);
    } else {
      expect(topicDeleteContext()).not.toHaveProperty('noEchoDeleteValues');
    }
  });
  // go-to-k/cdkd#2007: every replacement delete hands the provider the bag
  // this deploy resolved, as `maskSecrets` AND as the printing bag its own
  // log lines go through; the delete of a template-removed record, which
  // resolved nothing for it, hands neither. `KEY` sits in a property no name
  // rule reads, so no derived-name registry (go-to-k/cdkd#3869) knows it.
  describe('the delete masker (go-to-k/cdkd#2007)', () => {
    const KEY = 'deploy-noecho-key-2007';
    const params = {
      Secret: { Type: 'String', NoEcho: true, Default: VALUE },
      KeySecret: { Type: 'String', NoEcho: true, Default: KEY },
    };
    let printed: string[];
    beforeEach(() => {
      printed = [];
      provider.delete!.mockImplementation((logicalId: string) => {
        if (logicalId === 'Topic') {
          printed.push((currentLogLineMasker() ?? ((t: string) => t))(`line ${KEY}`));
        }
        return Promise.resolve(undefined);
      });
    });

    function expectMasked(): void {
      const mask = topicDeleteContext()['maskSecrets'] as (text: string) => string;
      expect(mask(`x ${KEY}`)).toBe(`x ${SECRET_MASK}`);
      expect(printed).toEqual([`line ${SECRET_MASK}`]);
    }

    it('on a recreate (`--recreate-via-sdk-provider`)', async () => {
      stateBackend.getState!.mockResolvedValue({ state: state(), etag: 'etag-old' });
      await makeEngine(recreate).deploy(
        STACK,
        templateOf(
          { ServiceToken: TOKEN_ARN, TopicName: 'old-name', KmsMasterKeyId: { Ref: 'KeySecret' } },
          params
        )
      );
      expectMasked();
    });

    it('on a replacement created before the old copy is deleted', async () => {
      stateBackend.getState!.mockResolvedValue({
        state: state('AWS::SNS::Topic'),
        etag: 'etag-old',
      });
      await makeEngine().deploy(
        STACK,
        templateOf(
          { TopicName: 'new-name', KmsMasterKeyId: { Ref: 'KeySecret' } },
          params,
          'AWS::SNS::Topic'
        )
      );
      expectMasked();
    });

    it('on a `--replace` delete-first, after a name-idempotent create returned the old copy', async () => {
      stateBackend.getState!.mockResolvedValue({
        state: state('AWS::SNS::Topic'),
        etag: 'etag-old',
      });
      provider.create!.mockResolvedValue({
        physicalId: 'arn:aws:sns:us-east-1:123456789012:old-name',
        attributes: {},
      });
      await makeEngine({ replace: true }).deploy(
        STACK,
        templateOf(
          { TopicName: 'old-name', FifoTopic: true, KmsMasterKeyId: { Ref: 'KeySecret' } },
          params,
          'AWS::SNS::Topic'
        )
      );
      expectMasked();
    });

    it('on the update-failure fallback replacement', async () => {
      stateBackend.getState!.mockResolvedValue({ state: state(), etag: 'etag-old' });
      provider.update!.mockRejectedValue(new ResourceUpdateNotSupportedError(CR, 'Topic'));
      await makeEngine({ replace: true }).deploy(
        STACK,
        templateOf(
          { ServiceToken: TOKEN_ARN, TopicName: 'changed', KmsMasterKeyId: { Ref: 'KeySecret' } },
          params
        )
      );
      expectMasked();
    });

    // A name the registry of secret-named records holds (go-to-k/cdkd#3869)
    // but no bag of this deploy does: the old copy was named from a secret
    // reference that has since rotated. Every replacement arm.
    const ROTATED = 'rotated-away-name-2007';
    const ROTATED_ARN = `arn:aws:sns:us-east-1:123456789012:${ROTATED}`;
    function rotatedRecord(resourceType: string): StackState {
      const recorded = state(resourceType);
      recorded.resources['Topic']!.physicalId = ROTATED_ARN;
      recorded.resources['Topic']!.properties = {
        ...(resourceType === CR ? { ServiceToken: TOKEN_ARN } : {}),
        TopicName: '{{resolve:secretsmanager:topic-name:SecretString:::}}',
        DisplayName: SECRET_MASK,
      };
      return recorded;
    }
    it.each([
      [
        'a replacement created before the old copy is deleted',
        async () => {
          stateBackend.getState!.mockResolvedValue({
            state: rotatedRecord('AWS::SNS::Topic'),
            etag: 'etag-old',
          });
          await makeEngine().deploy(
            STACK,
            templateOf({ TopicName: 'new-name' }, params, 'AWS::SNS::Topic')
          );
        },
      ],
      [
        'a `--replace` delete-first',
        async () => {
          stateBackend.getState!.mockResolvedValue({
            state: rotatedRecord('AWS::SNS::Topic'),
            etag: 'etag-old',
          });
          provider.create!.mockResolvedValue({ physicalId: ROTATED_ARN, attributes: {} });
          await makeEngine({ replace: true }).deploy(
            STACK,
            templateOf({ TopicName: 'new-name', FifoTopic: true }, params, 'AWS::SNS::Topic')
          );
        },
      ],
      [
        'a recreate',
        async () => {
          stateBackend.getState!.mockResolvedValue({ state: rotatedRecord(CR), etag: 'etag-old' });
          await makeEngine(recreate).deploy(
            STACK,
            templateOf({ ServiceToken: TOKEN_ARN, TopicName: 'new-name' }, params)
          );
        },
      ],
      [
        'the update-failure fallback replacement',
        async () => {
          stateBackend.getState!.mockResolvedValue({ state: rotatedRecord(CR), etag: 'etag-old' });
          provider.update!.mockRejectedValue(new ResourceUpdateNotSupportedError(CR, 'Topic'));
          await makeEngine({ replace: true }).deploy(
            STACK,
            templateOf({ ServiceToken: TOKEN_ARN, TopicName: 'changed' }, params)
          );
        },
      ],
    ])("masks the old copy's rotated secret-derived name on %s", async (_label, run) => {
      await run();
      const del = provider.delete!.mock.calls.filter((c) => c[0] === 'Topic');
      expect(del.map((c) => c[1])).toEqual([ROTATED_ARN]);
      const mask = (del[0]![4] as Record<string, unknown>)['maskSecrets'] as (t: string) => string;
      expect(mask(`x ${ROTATED}`)).not.toContain(ROTATED);
    });

    // A template-dropped record resolves nothing this deploy, so its masker is
    // the derived-name registry alone: the record's secret-derived name, never
    // a value of a resource it no longer reads.
    it("on the delete of a resource the template removed: the record's own secret-derived name only", async () => {
      stateBackend.getState!.mockResolvedValue({
        state: rotatedRecord('AWS::SNS::Topic'),
        etag: 'etag-old',
      });
      await makeEngine().deploy(STACK, {
        Parameters: params,
        Resources: {
          Other: { Type: 'AWS::SNS::Topic', Properties: { KmsMasterKeyId: { Ref: 'KeySecret' } } },
        },
      } as CloudFormationTemplate);
      const mask = topicDeleteContext()['maskSecrets'] as (text: string) => string;
      expect(mask).toBeTypeOf('function');
      expect(mask(`x ${ROTATED}`)).not.toContain(ROTATED);
      expect(mask(`x ${KEY}`)).toBe(`x ${KEY}`);
      expect(printed).toEqual([`line ${KEY}`]);
    });
  });

  it('delivers the value on the update-failure fallback replacement (`--replace` after an unsupported update)', async () => {
    stateBackend.getState!.mockResolvedValue({ state: state(), etag: 'etag-old' });
    provider.update!.mockRejectedValue(new ResourceUpdateNotSupportedError(CR, 'Topic'));
    await makeEngine({ replace: true }).deploy(
      STACK,
      templateOf({ ServiceToken: TOKEN_ARN, TopicName: 'changed', DisplayName: { Ref: 'Secret' } })
    );
    const values = topicDeleteContext()['noEchoDeleteValues'] as NoEchoDeleteValues;
    expect(values.leaves).toEqual([{ coordinate: ['DisplayName'], value: VALUE }]);
    nothingPersistedOrLoggedCarries(VALUE);
  });
});
