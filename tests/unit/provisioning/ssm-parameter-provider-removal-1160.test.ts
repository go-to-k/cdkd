/**
 * Issue #1160 (absent-field removal), AWS::SSM::Parameter slice.
 *
 * A real CloudFormation A/B (us-east-1) removed `Description`,
 * `AllowedPattern`, `Tier: Advanced`, `DataType: aws:ec2:image` and an
 * `Expiration` policy from
 * deployed parameters: CloudFormation called `PutParameter` and every field
 * kept its value. `update()` already omits a removed field from its
 * `PutParameter` overwrite, so the type declares no reset and opts into
 * `removalHandledInUpdate` with every property. These tests pin that the
 * opt-in covers the whole schema (so a removal of any of them stays silent),
 * that a removed field never reaches the wire, and that a property outside
 * the set would be named by the caller's warning.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { PutParameterCommand } from '@aws-sdk/client-ssm';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    // `update()` builds the `Arn` attribute through `getAccountInfo`.
    sts: { send: () => Promise.resolve({ Account: '111122223333' }) },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';

const TYPE = 'AWS::SSM::Parameter';
const NAME = '/cdkd/removal';

/** The CloudFormation schema's writable properties, from the committed fixture. */
function schemaWritableProperties(): string[] {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../fixtures/cfn-schemas/AWS-SSM-Parameter.json', import.meta.url),
      'utf8'
    )
  ) as { properties: string[]; readOnlyProperties: string[] };
  return fixture.properties.filter((p) => !fixture.readOnlyProperties.includes(p)).sort();
}

/** The input of every PutParameter sent, in order. */
function putInputs(): PutParameterCommand['input'][] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((cmd) => cmd instanceof PutParameterCommand)
    .map((cmd) => (cmd as PutParameterCommand).input);
}

const FULL = {
  Name: NAME,
  Type: 'String',
  Value: 'hello',
  Description: 'desc',
  AllowedPattern: '^[a-z]+$',
  Tier: 'Advanced',
  DataType: 'aws:ec2:image',
  Policies: '[{"Type":"Expiration","Version":"1.0","Attributes":{"Timestamp":"2030-01-01T00:00:00.000Z"}}]',
};

const BARE = { Name: NAME, Type: 'String', Value: 'hello' };

describe('SSMParameterProvider removal on update (#1160)', () => {
  let provider: SSMParameterProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SSMParameterProvider();
  });

  /** The deploy engine's path: the caller prepares, then calls update(). */
  async function deployUpdate(
    desired: Record<string, unknown>,
    previous: Record<string, unknown>
  ): Promise<{ unhandled: readonly string[]; injected: readonly string[] }> {
    const removal = prepareRemovalForUpdate(provider, TYPE, desired, previous);
    await provider.update('Param', NAME, TYPE, removal.properties, previous, removal.context);
    return { unhandled: removal.unhandled, injected: removal.injected };
  }

  it('opts into removalHandledInUpdate with every writable schema property', () => {
    expect([...(provider.removalHandledInUpdate.get(TYPE) ?? [])].sort()).toEqual(
      schemaWritableProperties()
    );
  });

  it('declares no reset: CloudFormation keeps every removed field', () => {
    expect(
      (provider as { removalDefaults?: ReadonlyMap<string, unknown> }).removalDefaults
    ).toBeUndefined();
  });

  it('keeps removed Description / AllowedPattern / Tier / DataType / Policies, unwarned', async () => {
    const { unhandled, injected } = await deployUpdate({ ...BARE }, { ...FULL });

    expect(unhandled).toEqual([]);
    expect(injected).toEqual([]);
    const puts = putInputs();
    expect(puts).toHaveLength(1);
    // Only the declared fields go out: an omitted field is what keeps the
    // stored value under `Overwrite: true` (measured, as CloudFormation does).
    expect(puts[0]).toEqual({ Name: NAME, Type: 'String', Value: 'hello', Overwrite: true });
  });

  it('still sends every field the template declares', async () => {
    await deployUpdate({ ...FULL, Description: 'changed' }, { ...FULL });

    expect(putInputs()[0]).toMatchObject({
      Description: 'changed',
      AllowedPattern: '^[a-z]+$',
      Tier: 'Advanced',
      DataType: 'aws:ec2:image',
      Policies: FULL.Policies,
      Overwrite: true,
    });
  });

  it('names a removed property outside the handled set in the caller warning', () => {
    const removal = prepareRemovalForUpdate(
      provider,
      TYPE,
      { ...BARE },
      { ...BARE, Description: 'desc', NotInSchema: 'x' }
    );

    expect(removal.unhandled).toEqual(['NotInSchema']);
  });
});
