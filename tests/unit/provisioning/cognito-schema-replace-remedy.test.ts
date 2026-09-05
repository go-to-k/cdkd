/**
 * Issue [#2610] site 4: `CognitoUserPoolProvider`'s immutable-Schema refusal
 * advised `cdkd deploy --replace --force-stateful-recreation` without checking
 * whether the pool carries `DeletionProtection: ACTIVE`, which no deploy-side
 * flag can clear.
 *
 * This site is the module header's one exception to "read the RECORDED bag":
 * `UpdateUserPool` runs BEFORE the schema refusal, so at refusal time AWS holds
 * the DESIRED value — and the gate up there is a truthiness test, so an absent
 * desired value leaves the recorded one standing. Both halves are pinned.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import { STATEFUL_TYPES } from '../../../src/provisioning/stateful-types.js';

const TYPE = 'AWS::Cognito::UserPool';
const POOL_ID = 'us-east-1_ABCdef123';

/**
 * Drive the immutable-Schema refusal. The removal of an existing custom
 * attribute is the cheapest trigger: `AddCustomAttributes` can only ADD.
 */
async function schemaRefusal(
  extraDesired: Record<string, unknown>,
  extraPrevious: Record<string, unknown>
): Promise<string> {
  const provider = new CognitoUserPoolProvider();
  try {
    await provider.update(
      'Pool',
      POOL_ID,
      TYPE,
      { PoolName: 'pool', Schema: [], ...extraDesired },
      {
        PoolName: 'pool',
        Schema: [{ Name: 'custom:tier', AttributeDataType: 'String' }],
        ...extraPrevious,
      }
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected update() to refuse, but it resolved');
}

describe('Cognito UserPool immutable-Schema refusal (site 4)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    // Everything before the refusal must succeed; the refusal itself issues no
    // call, so an unconditional empty response is enough.
    mockSend.mockResolvedValue({});
  });

  it('is a stateful type, so the advice keeps --force-stateful-recreation', () => {
    expect(STATEFUL_TYPES.has(TYPE)).toBe(true);
  });

  it('names the deletion-protection dead end when the DESIRED bag declares ACTIVE', async () => {
    const message = await schemaRefusal({ DeletionProtection: 'ACTIVE' }, {});
    expect(message).toContain('DeletionProtection: ACTIVE');
    expect(message).toContain('cdkd deploy has no --remove-protection flag');
    expect(message).toContain(`--user-pool-id '${POOL_ID}' --deletion-protection INACTIVE`);
    // The one-liner would wipe the pool: UpdateUserPool is a full replace.
    expect(message).toContain('RESETS every member the request omits');
    expect(message).toContain('cdkd deploy --replace --force-stateful-recreation');
  });

  it('falls back to the RECORDED bag when the desired value is absent', async () => {
    // Absent desired => `if (properties['DeletionProtection'])` never sends it
    // => AWS still holds what the record says.
    const message = await schemaRefusal({}, { DeletionProtection: 'ACTIVE' });
    expect(message).toContain('DeletionProtection: ACTIVE');
  });

  it('honours a desired INACTIVE over a recorded ACTIVE — UpdateUserPool already sent it', async () => {
    const message = await schemaRefusal(
      { DeletionProtection: 'INACTIVE' },
      { DeletionProtection: 'ACTIVE' }
    );
    expect(message).not.toContain('--remove-protection');
    expect(message).toContain(
      'AWS::Cognito::UserPool is a stateful type, so re-run with cdkd deploy --replace --force-stateful-recreation'
    );
  });

  it('keeps the short advice when nothing declares protection', async () => {
    const message = await schemaRefusal({}, {});
    expect(message).not.toContain('--remove-protection');
    expect(message).not.toContain('update-user-pool');
  });

  it('proves the premise: UpdateUserPool really ran before the refusal', async () => {
    await schemaRefusal({ DeletionProtection: 'ACTIVE' }, {});
    const sent = mockSend.mock.calls.map(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name
    );
    expect(sent).toContain('UpdateUserPoolCommand');
  });
});
