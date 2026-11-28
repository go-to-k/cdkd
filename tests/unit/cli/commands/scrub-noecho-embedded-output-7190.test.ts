/**
 * `cdkd scrub` over a stack output that EMBEDS a `NoEcho` value (found by the
 * #7190 integ): the output keeps the template's literal text around the mask
 * (`token=***;`), as a deploy's value scan persists it, instead of being
 * masked whole. Masking it whole made the next `cdkd diff` report a change
 * the deploy never makes. An older binary's plaintext is masked the same way.
 * Through `scrubStack` and the REAL resolver.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import { noEchoOutputsComparison } from '../../../../src/deployment/secret-redaction.js';

vi.mock('../../../../src/utils/logger.js', () => {
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

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: vi.fn() },
  }),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SHORT = 'q~7';

function template(outputs: Record<string, unknown>): CloudFormationTemplate {
  return {
    Parameters: { Short: { Type: 'String', NoEcho: true, Default: SHORT } },
    Resources: {
      Tok: { Type: 'AWS::CloudFormation::CustomResource', Properties: { ServiceToken: 'arn' } },
    },
    Outputs: outputs,
  } as unknown as CloudFormationTemplate;
}

const JOIN = { 'Fn::Join': ['', ['token=', { 'Fn::GetAtt': ['Tok', 'Token'] }, ';']] };

function stateWith(outputs: Record<string, unknown>): StackState {
  return {
    version: 18 as never,
    region: 'us-east-1',
    stackName: 'EmbeddedOutputStack',
    resources: {
      Tok: {
        physicalId: 'tok-1',
        resourceType: 'AWS::CloudFormation::CustomResource',
        properties: { ServiceToken: 'arn' },
        attributes: { Token: '***' },
        noEchoAttributeNames: ['Token'],
      },
    },
    outputs,
    lastModified: 0,
  };
}

describe('cdkd scrub - an output embedding a NoEcho value keeps its literal text (#7190)', () => {
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  const lockManager = {
    acquireLockWithRetry: vi.fn(async () => undefined),
    releaseLock: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-2'),
      purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn().mockResolvedValue([]),
    };
  });

  async function scrub(
    state: StackState,
    tpl: CloudFormationTemplate
  ): Promise<StackState | undefined> {
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-1' });
    await scrubStack(
      { stackName: 'EmbeddedOutputStack', template: tpl } as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      { dryRun: false, logger: logger as never }
    );
    const call = stateBackend['saveState']!.mock.calls.at(-1);
    return call ? (call[2] as StackState) : undefined;
  }

  it('leaves an output already in the exact form alone, and the diff is clean', async () => {
    const tpl = template({ Emb: { Value: JOIN } });
    const state = stateWith({ Emb: 'token=***;' });
    const saved = await scrub(state, tpl);
    // Nothing to repair, so nothing is written.
    expect(saved).toBeUndefined();
    const outputs = state.outputs;
    expect(outputs['Emb']).toBe('token=***;');
    // The diff's own comparison, against what the template resolves to.
    const compare = noEchoOutputsComparison(
      { Emb: JOIN },
      {
        parameters: new Set(['Short']),
        attributeIsNoEcho: (id, attribute) => id === 'Tok' && attribute === 'Token',
      }
    );
    const { current, desired } = compare(outputs, { Emb: 'token=***;' });
    expect(current!['Emb']).toEqual(desired['Emb']);
  });

  it('masks an older plaintext embedding a short NoEcho attribute as token=***;', async () => {
    const saved = await scrub(stateWith({ Emb: `token=${SHORT};` }), template({ Emb: { Value: JOIN } }));
    expect(saved!.outputs['Emb']).toBe('token=***;');
  });

  it('masks an older plaintext embedding a short NoEcho parameter (Fn::Sub) as token=***;', async () => {
    const saved = await scrub(
      stateWith({ Emb: `token=${SHORT};` }),
      template({ Emb: { Value: { 'Fn::Sub': 'token=${Short};' } } })
    );
    expect(saved!.outputs['Emb']).toBe('token=***;');
  });

  it('keeps a pseudo parameter in the clear and masks every other part', async () => {
    const saved = await scrub(
      stateWith({ Emb: `us-east-1/${SHORT}` }),
      template({ Emb: { Value: { 'Fn::Sub': '${AWS::Region}/${Short}' } } })
    );
    expect(saved!.outputs['Emb']).toBe('us-east-1/***');
  });

  it('masks whole a stored value the template text does not match', async () => {
    const saved = await scrub(stateWith({ Emb: `x${SHORT}` }), template({ Emb: { Value: JOIN } }));
    expect(saved!.outputs['Emb']).toBe('***');
  });

  it('masks whole an output that reads the value directly', async () => {
    const saved = await scrub(
      stateWith({ Emb: SHORT }),
      template({ Emb: { Value: { Ref: 'Short' } } })
    );
    expect(saved!.outputs['Emb']).toBe('***');
  });
});
