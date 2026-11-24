/**
 * Issue [#2610] site 4: `CognitoUserPoolProvider`'s immutable-Schema refusal
 * advised `cdkd deploy --replace --force-stateful-recreation` without checking
 * whether the pool carries `DeletionProtection: ACTIVE`, which no deploy-side
 * flag can clear.
 *
 * The refusal fires before the first write (go-to-k/cdkd#6375), so the pool
 * AWS holds still carries the RECORDED `DeletionProtection`, whatever the
 * desired bag declares. Both directions are pinned, and so is "nothing sent".
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn(() => ({
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
    child: vi.fn(function (this: unknown) { return this; }),
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
import { UNNAMEABLE_ID_CLAUSE } from '../../../src/provisioning/replacement-protection-advice.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';
import { buildProgram } from '../../../src/cli/program.js';
import {
  setPasteableRunFlags,
  setPasteableVerbFlags,
} from '../../../src/utils/pasteable-run-context.js';

const TYPE = 'AWS::Cognito::UserPool';
const POOL_ID = 'us-east-1_ABCdef123';

/**
 * Drive the immutable-Schema refusal. The removal of an existing custom
 * attribute is the cheapest trigger: `AddCustomAttributes` can only ADD.
 */
async function schemaRefusal(
  extraDesired: Record<string, unknown>,
  extraPrevious: Record<string, unknown>,
  poolId: string = POOL_ID
): Promise<string> {
  const provider = new CognitoUserPoolProvider();
  try {
    await provider.update(
      'Pool',
      poolId,
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
    // The refusal issues no call; an empty response keeps a regression that
    // sends one from failing for an unrelated reason.
    mockSend.mockResolvedValue({});
  });

  it('is a stateful type, so the advice keeps --force-stateful-recreation', () => {
    expect(STATEFUL_TYPES.has(TYPE)).toBe(true);
  });

  it('names the deletion-protection dead end when the RECORDED bag holds ACTIVE', async () => {
    const message = await schemaRefusal({}, { DeletionProtection: 'ACTIVE' });
    expect(message).toContain('DeletionProtection: ACTIVE');
    expect(message).toContain('cdkd deploy has no --remove-protection flag');
    expect(message).toContain(`--user-pool-id ${POOL_ID} --deletion-protection INACTIVE`);
    // The one-liner is not safe to paste alone: it omits every other member,
    // and UpdateUserPool RESETS some omitted members (AutoVerifiedAttributes,
    // measured). The caveat must sit OUTSIDE the backticks — prose inside a
    // pasteable span is the same defect class this issue is about.
    expect(message).toContain(
      'Note UpdateUserPool resets some members a call omits (self sign-up, Lambda triggers, advanced security, AutoVerifiedAttributes and a customer-managed KeyConfiguration among them)'
    );
    expect(message).toContain('send your complete pool configuration');
    // Every retired spelling, pinned as absent. The first was AWS's own blanket
    // wording, which the provider's measured ledger (`readLiveMfaConfiguration`)
    // shows holds field by field. The second was a self-contradiction:
    // "full-replace API" IS the blanket claim. The third predates issue
    // go-to-k/cdkd#2675, which measured the field: DeletionProtection does NOT
    // reset on omission.
    expect(message).not.toContain('RESETS every member the request omits');
    expect(message).not.toContain('full-replace API');
    expect(message).not.toContain('unmeasured for DeletionProtection');
    const spans = message.match(/`([^`]+)`/g) ?? [];
    expect(spans.some((s) => s.includes('omitted member'))).toBe(false);
    expect(message).toContain('cdkd deploy --replace --force-stateful-recreation');
  });

  it('routes a planted pool id through the gate: withheld, and nothing runs when pasted (go-to-k/cdkd#4205)', async () => {
    const messages: Array<[string, string]> = [];
    for (const { label, value } of PASTE_PAYLOADS) {
      const message = await schemaRefusal({}, { DeletionProtection: 'ACTIVE' }, `${POOL_ID}${value}`);
      expect(message, label).toContain(UNNAMEABLE_ID_CLAUSE);
      expect(message, label).not.toContain('update-user-pool');
      messages.push([label, message]);
    }
    withPasteDir((dir) => {
      for (const [label, message] of messages) expect(spansThatRun(message, dir), label).toEqual([]);
    });
  }, 120_000);

  it('reads the RECORDED bag when the desired value is absent', async () => {
    const message = await schemaRefusal({}, { DeletionProtection: 'ACTIVE' });
    expect(message).toContain('DeletionProtection: ACTIVE');
  });

  it('a desired INACTIVE was never sent, so a recorded ACTIVE still governs', async () => {
    const message = await schemaRefusal(
      { DeletionProtection: 'INACTIVE' },
      { DeletionProtection: 'ACTIVE' }
    );
    expect(message).toContain('DeletionProtection: ACTIVE');
    expect(message).toContain('cdkd deploy has no --remove-protection flag');
  });

  it('a desired ACTIVE was never sent, so an unprotected record keeps the short advice', async () => {
    const message = await schemaRefusal({ DeletionProtection: 'ACTIVE' }, {});
    expect(message).not.toContain('--remove-protection');
    expect(message).toContain(
      'AWS::Cognito::UserPool is a stateful type, so re-run with cdkd deploy --replace --force-stateful-recreation'
    );
  });

  it("carries the run's --aws-emulator, so a pasted remedy stays off real AWS (go-to-k/cdkd#6245)", async () => {
    buildProgram();
    setPasteableRunFlags({ awsEmulator: 'https://127.0.0.1:9493' });
    try {
      const message = await schemaRefusal({}, {});
      expect(message).toContain(
        're-run with cdkd deploy --replace --force-stateful-recreation --aws-emulator=https://127.0.0.1:9493 to recreate it'
      );
    } finally {
      setPasteableRunFlags({});
      setPasteableVerbFlags(undefined);
    }
  });

  it('keeps the short advice when nothing declares protection', async () => {
    const message = await schemaRefusal({}, {});
    expect(message).not.toContain('--remove-protection');
    expect(message).not.toContain('update-user-pool');
  });

  it('refuses before the first write, in every DeletionProtection arm (go-to-k/cdkd#6375)', async () => {
    const arms: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ DeletionProtection: 'ACTIVE' }, {}],
      [{ DeletionProtection: 'INACTIVE' }, { DeletionProtection: 'ACTIVE' }],
      [{}, { DeletionProtection: 'ACTIVE' }],
      [{}, {}],
    ];
    for (const [desired, previous] of arms) {
      mockSend.mockClear();
      const message = await schemaRefusal(desired, previous);
      expect(message).toContain('Nothing was applied to the user pool.');
      expect(mockSend).not.toHaveBeenCalled();
    }
  });
});
