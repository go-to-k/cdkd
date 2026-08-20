import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The segment-rebuild's "scanned token not found in the leaf it was scanned
 * from" arm must FAIL CLOSED (issue
 * [#2057](https://github.com/go-to-k/cdkd/issues/2057) review round 2).
 *
 * The arm is unreachable while the tokens come from a scan of the same string,
 * so it is a guard against a future scanner change — and the direction it fails
 * in is the whole point. It used to hand the leaf back to the STACK's resolver,
 * which would send a token whose foreign region is already KNOWN to the wrong
 * region: issue #2057 verbatim, reintroduced inside the guard against it.
 *
 * Reaching it needs the scanner to disagree with the leaf, so this file — and
 * only this file — mocks `dynamicReferenceTokens` to report a token the leaf
 * does not contain. Kept separate because that mock is module-wide and would
 * change the meaning of every other test in the main file.
 */

const { extraToken } = vi.hoisted(() => ({
  extraToken: { value: '' as string },
}));

vi.mock('../../../src/deployment/secret-redaction.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/secret-redaction.js')>();
  return {
    ...actual,
    dynamicReferenceTokens: (value: string): string[] => {
      const real = actual.dynamicReferenceTokens(value);
      return extraToken.value ? [...real, extraToken.value] : real;
    },
  };
});

// Pass-through retry so the revert arm does not sleep through a real backoff.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

const mockSMSend = vi.fn(async () => ({ SecretString: JSON.stringify({ password: 'p' }) }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: mockSMSend }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

const CONSUMER_REGION = 'ap-northeast-1';
const PRODUCER_REGION = 'eu-west-1';
const IDP_TYPE = 'AWS::Cognito::UserPoolIdentityProvider';
/** Foreign ARN — its `named-region` verdict is what selects the rebuild path. */
const FOREIGN_ARN_EXPR = `{{resolve:secretsmanager:arn:aws:secretsmanager:${PRODUCER_REGION}:111122223333:secret:x-AbCdEf:SecretString:password}}`;

const logLines: string[] = [];
const recordingLogger = {
  debug: (): void => {},
  info: (...a: unknown[]): void => void logLines.push(a.map(String).join(' ')),
  warn: (...a: unknown[]): void => void logLines.push(a.map(String).join(' ')),
  error: (...a: unknown[]): void => void logLines.push(a.map(String).join(' ')),
  setLevel: (): void => {},
  child: (): unknown => recordingLogger,
} as unknown as RollbackExecutorContext['logger'];

function res(properties: Record<string, unknown>): ResourceState {
  return {
    physicalId: 'phys-B',
    resourceType: IDP_TYPE,
    properties,
    attributes: {},
    dependencies: [],
  };
}

beforeEach(() => {
  mockSMSend.mockClear();
  logLines.length = 0;
  extraToken.value = '';
  resetAccountInfoCache();
});

describe('a scanned token missing from its own leaf is REFUSED, not resolved locally', () => {
  it('throws ROLLBACK_SECRET_TOKEN_SCAN_MISMATCH instead of falling back to the stack region', async () => {
    // A token the leaf does not contain, appended by the mocked scanner.
    extraToken.value = '{{resolve:secretsmanager:ghost:SecretString:pw}}';
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx: RollbackExecutorContext = {
      region: CONSUMER_REGION,
      logger: recordingLogger,
      providerRegistry: {
        getProviderFor: () => ({ provider: { update } }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: () => {},
    };
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: res({ Secret: FOREIGN_ARN_EXPR }),
      },
    ];
    const state: Record<string, ResourceState> = { Idp: res({ Secret: 'other' }) };

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(result.failures).toBe(1);
    expect(update).not.toHaveBeenCalled();
    const failure = logLines.find((l) => l.includes('Rollback failed for Idp'));
    expect(failure).toContain('could not locate a scanned dynamic reference');
    expect(failure).toContain(CONSUMER_REGION);
  });

  it('resolves normally when the scanner and the leaf agree (the arm is not always-on)', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys-B' });
    const ctx: RollbackExecutorContext = {
      region: CONSUMER_REGION,
      logger: recordingLogger,
      providerRegistry: {
        getProviderFor: () => ({ provider: { update } }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: () => {},
    };
    const ops: CompletedOperation[] = [
      {
        logicalId: 'Idp',
        changeType: 'UPDATE',
        resourceType: IDP_TYPE,
        physicalId: 'phys-B',
        previousState: res({ Secret: FOREIGN_ARN_EXPR }),
      },
    ];
    const state: Record<string, ResourceState> = { Idp: res({ Secret: 'other' }) };

    const result = await replayRollback(ops, state, 'Consumer', ctx);

    expect(result.failures).toBe(0);
    expect(update).toHaveBeenCalled();
  });
});
