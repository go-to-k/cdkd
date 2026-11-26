/**
 * `cdkd scrub` repairs a record a pre-#6303 cdkd wrote: the generated username
 * `postgres` spliced into the template's own literal as its reference
 * (`engine aurora-{{resolve:...}}ql`). Drives `scrubStack` and the REAL
 * resolver; the reference is assembled with `Fn::Join` over a `Ref` to the
 * secret, as CDK synthesizes `secretValueFromJson`.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:DbSecret-abc';
const REF = `{{resolve:secretsmanager:${ARN}:SecretString:username::}}`;
const LITERAL = 'engine aurora-postgresql';
const MANGLED = `engine aurora-${REF}ql`;

vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    secretsManager: {
      send: vi.fn(async () => ({
        SecretString: JSON.stringify({ username: 'postgres', password: 'pw-123456' }),
      })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return { SecretString: JSON.stringify({ username: 'postgres', password: 'pw-123456' }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

async function scrub(description: string, templateDescription = LITERAL) {
  const template = {
    Resources: {
      DbSecret: { Type: 'AWS::SecretsManager::Secret', Properties: { Description: 'db' } },
      Param: {
        Type: 'AWS::SSM::Parameter',
        Properties: {
          Type: 'String',
          Value: {
            'Fn::Join': [
              '',
              ['{{resolve:secretsmanager:', { Ref: 'DbSecret' }, ':SecretString:username::}}'],
            ],
          },
          Description: templateDescription,
        },
      },
    },
    Outputs: {},
  } as unknown as CloudFormationTemplate;
  const state = {
    version: 11,
    region: 'us-east-1',
    stackName: 'S',
    resources: {
      DbSecret: {
        physicalId: ARN,
        resourceType: 'AWS::SecretsManager::Secret',
        properties: { Description: 'db' },
        attributes: {},
        dependencies: [],
      },
      Param: {
        physicalId: 'CFN-Param-x',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Type: 'String', Value: REF, Description: description },
        observedProperties: { Type: 'String', Value: REF, Description: description },
        attributes: {},
        dependencies: ['DbSecret'],
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const saveState = vi.fn().mockResolvedValue('etag-2');
  const result = await scrubStack(
    { stackName: 'S', template } as never,
    'us-east-1',
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
      saveState,
      purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn().mockResolvedValue([]),
    } as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as never,
    { dryRun: false, logger } as never
  );
  const saved = saveState.mock.calls.at(-1)?.[2] as StackState | undefined;
  return { result, saved };
}

describe('cdkd scrub of a pre-#6303 record (#6303)', () => {
  it('rewrites the mangled literal back to the template literal, in both bags', async () => {
    const { saved } = await scrub(MANGLED);
    expect(saved).toBeDefined();
    const param = saved!.resources['Param']!;
    expect(param.properties['Description']).toBe(LITERAL);
    expect(param.observedProperties?.['Description']).toBe(LITERAL);
    expect(param.properties['Value']).toBe(REF);
  });

  it('a clean record keeps its literal: the second walk does not undo the positioning', async () => {
    const { saved } = await scrub(LITERAL);
    const param = saved?.resources['Param'];
    expect(param?.properties['Description'] ?? LITERAL).toBe(LITERAL);
    expect(param?.observedProperties?.['Description'] ?? LITERAL).toBe(LITERAL);
  });

  it('a literal EQUAL to the secret is kept, in both bags (#7037)', async () => {
    const { saved } = await scrub('postgres', 'postgres');
    const param = saved?.resources['Param'];
    expect(param?.properties['Description'] ?? 'postgres').toBe('postgres');
    expect(param?.observedProperties?.['Description'] ?? 'postgres').toBe('postgres');
  });

  it('a pre-#7037 record holding the reference for that literal takes the literal (#7037)', async () => {
    const { saved } = await scrub(REF, 'postgres');
    expect(saved).toBeDefined();
    const param = saved!.resources['Param']!;
    expect(param.properties['Description']).toBe('postgres');
    expect(param.observedProperties?.['Description']).toBe('postgres');
    expect(param.properties['Value']).toBe(REF);
  });

  it('a template edited since the deploy does not license the repair', async () => {
    const { saved } = await scrub(MANGLED, 'engine aurora-mysql');
    expect(saved?.resources['Param']?.properties['Description'] ?? MANGLED).toBe(MANGLED);
  });
});
