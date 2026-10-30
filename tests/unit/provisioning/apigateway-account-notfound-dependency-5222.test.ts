/**
 * go-to-k/cdkd#5222: the API Gateway Account is a per-region singleton, so a
 * `NotFoundException` from the delete's `UpdateAccount` names something else
 * and the CloudWatch role ARN is still set. The wrap carries the class, which
 * satisfies the "already deleted" classifiers' `NotFoundException` needle, so
 * it must be marked not gone: they check `isMarkedNotGone` first (#5228), and
 * the mark leaves retryability to the retry classifiers.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NotFoundException } from '@aws-sdk/client-api-gateway';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';

const TYPE = 'AWS::ApiGateway::Account';

async function deleteAccountFailing(error: Error): Promise<Error> {
  mockSend.mockRejectedValueOnce(error);
  return new ApiGatewayProvider().delete('ApiAccount', 'ApiAccount', TYPE).then(
    () => {
      throw new Error('expected the delete to fail');
    },
    (e: unknown) => e as Error
  );
}

describe('API Gateway Account delete: a NotFoundException is not "already deleted" (#5222)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks the wrap not gone when UpdateAccount answers NotFoundException', async () => {
    const failure = await deleteAccountFailing(
      new NotFoundException({ message: 'Invalid resource identifier specified', $metadata: {} })
    );

    expect(mockSend.mock.calls[0]![0].constructor.name).toBe('UpdateAccountCommand');
    // The premise: the class reaches the message and carries the needle.
    expect(failure.message).toContain('Failed to delete API Gateway Account ApiAccount');
    expect(failure.message).toContain('NotFoundException');
    expect(isMarkedNotGone(failure)).toBe(true);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it('leaves a non-NotFound failure retryable (negative control)', async () => {
    const failure = await deleteAccountFailing(
      Object.assign(new Error('Too Many Requests'), {
        name: 'TooManyRequestsException',
        $fault: 'client',
        $metadata: { httpStatusCode: 429 },
      })
    );

    expect(failure.message).toContain('TooManyRequestsException');
    expect(isMarkedNotGone(failure)).toBe(false);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });
});
