/**
 * The hand-offs `computeStackDiff` makes to the steps split out of it
 * (go-to-k/cdkd#5835): each value the caller passes to, or takes back from,
 * `bindParametersAndConditions`, `previewOrphanSplice` and
 * `outputChangesAfterResolutionFailure` that no other suite reads.
 *
 * Each case is a behaviour the one-function shape already had, measured
 * through `computeStackDiff` with the real resolver; a hand-off wired to a
 * wrong or stale value turns it red.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
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

// The resolver builds its CloudFormation fallback client directly, so the SDK
// is mocked: `ListExports` serves nothing unless a case says otherwise.
const cfnSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({ send: cfnSend })),
  };
});

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  maskedInputFingerprint,
  maskedPropertyFingerprint,
  parameterInputsFor,
} from '../../../src/deployment/masked-property-fingerprints.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const SSM = 'AWS::SSM::Parameter';
const REGION = 'us-east-1';

function res(properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'pid', resourceType: SSM, properties, attributes: {}, dependencies: [] };
}

function st(resources: Record<string, ResourceState>, extra: Partial<StackState> = {}): StackState {
  return {
    stackName: 'S',
    region: REGION,
    resources,
    outputs: {},
    version: 10,
    lastModified: 0,
    ...extra,
  };
}

/**
 * A backend holding one producer, `Producer`, whose record is region-less, so
 * the export scan reads it in the RESOLVER's region: only a resolver built for
 * this diff's region, over this backend, finds the export.
 */
function producerBackend(env: string): S3StateBackend {
  const producer = st({}, { stackName: 'Producer', outputs: { SharedEnv: env } });
  return {
    listStacks: async () => [{ stackName: 'Producer' }],
    getState: async (stackName: string, region: string) =>
      stackName === 'Producer' && region === REGION ? { state: producer, etag: 'e' } : null,
  } as unknown as S3StateBackend;
}

describe('condition evaluation reads through the diff resolver and state backend', () => {
  // `IsProd` reads another stack's export. Its verdict is known only when the
  // condition pass gets this diff's resolver (its region) AND state backend.
  const template: CloudFormationTemplate = {
    Conditions: { IsProd: { 'Fn::Equals': [{ 'Fn::ImportValue': 'SharedEnv' }, 'prod'] } },
    Resources: {
      R: { Type: SSM, Properties: { Type: 'String', Value: { 'Fn::If': ['IsProd', 'p', 'd'] } } },
    },
  };

  it('takes the TRUE branch of a condition over an export the backend serves', async () => {
    const { changes, conditions } = await computeStackDiff(
      st({ R: res({ Type: 'String', Value: 'p' }) }),
      template,
      REGION,
      'S',
      producerBackend('prod'),
      new DiffCalculator()
    );
    expect(conditions).toEqual({ IsProd: true });
    expect(changes.get('R')!.changeType).toBe('NO_CHANGE');
  });

  it('takes the FALSE branch when the export says otherwise (control)', async () => {
    const { changes, conditions } = await computeStackDiff(
      st({ R: res({ Type: 'String', Value: 'p' }) }),
      template,
      REGION,
      'S',
      producerBackend('dev'),
      new DiffCalculator()
    );
    expect(conditions).toEqual({ IsProd: false });
    expect(changes.get('R')!.changeType).toBe('UPDATE');
  });
});

describe('condition evaluation and the resource diff share ONE resolver', () => {
  // The resolver memoizes the CloudFormation `ListExports` listing per
  // instance, so the condition pass and the resource diff read ONE snapshot of
  // the exports. A second resolver for either pass would list them again, and
  // a listing that moved in between would branch on one value and compare
  // another.
  const template: CloudFormationTemplate = {
    Conditions: { IsProd: { 'Fn::Equals': [{ 'Fn::ImportValue': 'CfnEnv' }, 'prod'] } },
    Resources: {
      R: {
        Type: SSM,
        Properties: {
          Type: 'String',
          Value: { 'Fn::If': ['IsProd', { 'Fn::ImportValue': 'CfnEnv' }, 'none'] },
        },
      },
    },
  };

  it('lists the exports once, and diffs the resource at the value the condition read', async () => {
    let listings = 0;
    cfnSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'ListExportsCommand') {
        listings += 1;
        return { Exports: [{ Name: 'CfnEnv', Value: listings === 1 ? 'prod' : 'dev' }] };
      }
      throw Object.assign(new Error('Stack does not exist'), { name: 'ValidationError' });
    });
    const backend = {
      listStacks: async () => [],
      getState: async () => null,
    } as unknown as S3StateBackend;
    try {
      const { changes, conditions } = await computeStackDiff(
        st({ R: res({ Type: 'String', Value: 'prod' }) }),
        template,
        REGION,
        'S',
        backend,
        new DiffCalculator()
      );
      expect(conditions).toEqual({ IsProd: true });
      expect(changes.get('R')!.changeType).toBe('NO_CHANGE');
      expect(listings).toBe(1);
    } finally {
      cfnSend.mockReset();
    }
  });
});

describe('an unbound parameter is an unknown masked input (go-to-k/cdkd#4543)', () => {
  // A list value the parent row hands over is not a user-provided SCALAR, so
  // `P` (no `Default`) fails to bind while the raw list still reaches the
  // merged parameters. Only the unbound set keeps it out of the comparison.
  const VALUE = {
    'Fn::Base64': {
      'Fn::Join': [
        '',
        ['b=', { 'Fn::Join': [',', { Ref: 'P' }] }, ';pw=', '{{resolve:secretsmanager:app-pw}}'],
      ],
    },
  };
  const template: CloudFormationTemplate = {
    Parameters: { P: { Type: 'CommaDelimitedList' } },
    Resources: { R: { Type: SSM, Properties: { Name: 'n', Type: 'String', Value: VALUE } } },
  };

  it('does not compare the fingerprint of a property reading it', async () => {
    const fingerprint = await maskedInputFingerprint(VALUE, {
      template,
      parameterInput: parameterInputsFor({ template, values: { P: ['one'] } }).parameterInput,
      resolve: () => Promise.reject(new Error('no node to resolve')),
    });
    expect(fingerprint).toBeDefined();
    const state = st({
      R: {
        ...res({ Name: 'n', Type: 'String', Value: '***' }),
        maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(VALUE) },
        maskedPropertyInputFingerprints: { Value: fingerprint! },
      },
    });
    const backend = { getState: async () => null } as unknown as S3StateBackend;
    const { changes } = await computeStackDiff(
      state,
      template,
      REGION,
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { P: ['two'] }, previewMaskedInputs: true }
    );
    expect(changes.get('R')!.changeType).toBe('NO_CHANGE');
  });
});

describe("the no-change merge's carried-alias verdict reads the Outputs pass's bag (go-to-k/cdkd#4657)", () => {
  // `Piece` splits the `NoEcho` value, so the Outputs pass records its first
  // piece as a log-only needle. `Leaky` fails to resolve, so the merge carries
  // its stored alias, which spells that piece: only the Outputs pass's bag
  // holds it (the seed holds the WHOLE value, which the alias does not contain).
  const PIECE = 'alphaPieceOne';
  const ALIAS = `exp-${PIECE}`;
  const template = {
    Parameters: { Pw: { Type: 'String', NoEcho: true, Default: `${PIECE},betaPieceTwo` } },
    Resources: { A: { Type: SSM, Properties: { Type: 'String', Value: 'x' } } },
    Outputs: {
      Piece: { Value: { 'Fn::Select': [0, { 'Fn::Split': [',', { Ref: 'Pw' }] }] } },
      Leaky: { Value: { 'Fn::GetAtt': ['Missing', 'Arn'] }, Export: { Name: ALIAS } },
    },
  } as unknown as CloudFormationTemplate;

  it('refuses to carry the alias, so the preview shows it leaving', async () => {
    const state = st(
      { A: res({ Type: 'String', Value: 'x' }) },
      { outputs: { Piece: '***', Leaky: 'v', [ALIAS]: 'v' }, exportNames: [ALIAS] }
    );
    const backend = { getState: async () => null } as unknown as S3StateBackend;
    const { outputChanges } = await computeStackDiff(
      state,
      template,
      REGION,
      'S',
      backend,
      new DiffCalculator()
    );
    expect(outputChanges.map((c) => `${c.changeType} ${c.name}`)).toContain(`REMOVE ${ALIAS}`);
  });
});

describe('the rollback-orphan preview reads the CONDITION-PRUNED template (go-to-k/cdkd#2943)', () => {
  it('hands previewOrphanAdoption the template without a condition-false resource', async () => {
    const seen: CloudFormationTemplate[] = [];
    const template: CloudFormationTemplate = {
      Conditions: { Off: { 'Fn::Equals': ['on', 'off'] } },
      Resources: {
        Kept: { Type: SSM, Properties: { Type: 'String', Value: 'k' } },
        Gated: { Type: SSM, Condition: 'Off', Properties: { Type: 'String', Value: 'g' } },
      },
    };
    const state = st(
      {},
      { orphans: [{ logicalId: 'Kept', state: res({ Type: 'String', Value: 'k' }) }] as never }
    );
    const backend = { getState: async () => null } as unknown as S3StateBackend;
    await computeStackDiff(state, template, REGION, 'S', backend, new DiffCalculator(), {
      previewOrphanAdoption: async (_state, effectiveTemplate) => {
        seen.push(effectiveTemplate);
        return { adopted: {}, refusals: [] };
      },
    });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!.Resources ?? {})).toEqual(['Kept']);
  });
});
