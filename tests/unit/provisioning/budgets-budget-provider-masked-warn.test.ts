import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #2178 — the RUNTIME twin of `scripts/check-provider-secret-mask.ts` for
 * `BudgetsBudgetProvider`.
 *
 * `toSdkDate` quotes the offending `TimePeriod` member back at the user from
 * TWO refusals, and `properties` arrives RESOLVED, so a
 * `{{resolve:secretsmanager:...}}` scalar in that position is already plaintext
 * by the time either fires. The critic proves the `maskDeep(...)` wrap is
 * present; only a run proves the masker that reaches it is not the identity
 * function. `not.toContain(SECRET_PLAINTEXT)` is the assertion an identity
 * masker fails.
 */

const mockSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-budgets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-budgets')>();
  return {
    ...actual,
    BudgetsClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: mockStsSend } }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { BudgetsBudgetProvider } from '../../../src/provisioning/providers/budgets-budget-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const TYPE = 'AWS::Budgets::Budget';

/** Distinctive, >= 8 chars, and a substring of nothing else in the refusal. */
const SECRET_PLAINTEXT = 'budgets2178-timeperiod-plaintext';

function maskSecrets(): (text: string) => string {
  const bag: RecordedSecretValues = new Map([
    [SECRET_PLAINTEXT, '{{resolve:secretsmanager:budgets/period:SecretString:v::}}'],
  ]);
  return createSecretMasker(bag);
}

/**
 * The secret at a NESTED string leaf, not as the top-level scalar: `maskDeep`
 * walks leaves, so a top-level-only fixture would still pass against a walk
 * that never descends.
 */
const NESTED_BAD = { nested: { bad: SECRET_PLAINTEXT } };
const MASKED_RENDERING = JSON.stringify({ nested: { bad: SECRET_MASK } });
const RAW_RENDERING = JSON.stringify({ nested: { bad: SECRET_PLAINTEXT } });

function budgetProps(start: unknown): Record<string, unknown> {
  return {
    Budget: {
      BudgetName: 'issue2178-budget',
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: '100', Unit: 'USD' },
      TimePeriod: { Start: start },
    },
  };
}

async function refusalMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the TimePeriod refusal, but the call resolved');
}

describe('BudgetsBudgetProvider TimePeriod refusals mask the resolved value (issue #2178)', () => {
  let provider: BudgetsBudgetProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockStsSend.mockReset();
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    mockSend.mockResolvedValue({});
    provider = new BudgetsBudgetProvider();
  });

  it('masks the resolved secret in the create() "expected a date string" refusal', async () => {
    const message = await refusalMessage(
      provider.create('MyBudget', TYPE, budgetProps(NESTED_BAD), { maskSecrets: maskSecrets() })
    );

    // Non-vacuity first: the refusal fired and still quotes the value.
    expect(message).toContain('expected a date string or epoch timestamp');
    expect(message).toContain(MASKED_RENDERING);
    expect(message).toContain(SECRET_MASK);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  // The SECOND refusal in the same helper. Only a STRING reaches it (anything
  // else is refused by the arm above), so the secret is necessarily the whole
  // value here — which is the arm `maskSecretsInText` covers at ANY length.
  it('masks the resolved secret in the "is not a parseable date" refusal', async () => {
    const message = await refusalMessage(
      provider.create('MyBudget', TYPE, budgetProps(SECRET_PLAINTEXT), {
        maskSecrets: maskSecrets(),
      })
    );

    expect(message).toContain('is not a parseable date');
    expect(message).toContain(`"${SECRET_MASK}"`);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  it('masks the resolved secret in the update() refusal', async () => {
    const message = await refusalMessage(
      provider.update('MyBudget', 'issue2178-budget', TYPE, budgetProps(NESTED_BAD), {}, {
        maskSecrets: maskSecrets(),
      })
    );

    expect(message).toContain('expected a date string or epoch timestamp');
    expect(message).toContain(MASKED_RENDERING);
    expect(message).not.toContain(SECRET_PLAINTEXT);
  });

  // THE CONTROL. Without a case where the plaintext survives, every assertion
  // above is equally satisfied by a refusal that dropped the value.
  it('leaves the plaintext INTACT when no context is supplied — the control', async () => {
    const message = await refusalMessage(
      provider.create('MyBudget', TYPE, budgetProps(NESTED_BAD))
    );

    expect(message).toContain('expected a date string or epoch timestamp');
    expect(message).toContain(RAW_RENDERING);
    expect(message).toContain(SECRET_PLAINTEXT);
    expect(message).not.toContain(SECRET_MASK);
  });

  it('leaves the plaintext INTACT for a context that carries no masker', async () => {
    const message = await refusalMessage(
      provider.create('MyBudget', TYPE, budgetProps(NESTED_BAD), { replayingState: true })
    );

    expect(message).toContain(SECRET_PLAINTEXT);
  });

  it('does not mangle a non-secret value when a masker IS supplied', async () => {
    const message = await refusalMessage(
      provider.create('MyBudget', TYPE, budgetProps({ nested: { bad: 'not-a-date-at-all' } }), {
        maskSecrets: maskSecrets(),
      })
    );

    expect(message).toContain('not-a-date-at-all');
    expect(message).not.toContain(SECRET_MASK);
  });
});
