/**
 * go-to-k/cdkd#4583: a certificate RequestCertificate returned, left behind
 * because the failed create's own cleanup could not delete it, is named on the
 * thrown error for the failed-CREATE journal -- and only then.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeleteCertificateCommand } from '@aws-sdk/client-acm';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    acm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const child = { ...l, child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ ...l, child: () => child }) };
});

import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::CertificateManager::Certificate';
const ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/abc123';
const PROPS = { DomainName: 'example.com', ValidationMethod: 'DNS' };

function deleteCalls(): unknown[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof DeleteCertificateCommand);
}

async function failedCreate(props: Record<string, unknown> = PROPS): Promise<unknown> {
  return new ACMCertificateProvider().create('MyCert', TYPE, props).then(
    () => {
      throw new Error('create unexpectedly succeeded');
    },
    (e: unknown) => e
  );
}

describe('ACMCertificateProvider.create — created-before-failure mark (#4583)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    mockSend.mockReset();
    resetIdempotencyTokensForTests();
    saved = {
      CDKD_NO_WAIT: process.env['CDKD_NO_WAIT'],
      CDKD_ACM_POLL_ATTEMPTS: process.env['CDKD_ACM_POLL_ATTEMPTS'],
      CDKD_ACM_POLL_INTERVAL_MS: process.env['CDKD_ACM_POLL_INTERVAL_MS'],
    };
    delete process.env['CDKD_NO_WAIT'];
    process.env['CDKD_ACM_POLL_ATTEMPTS'] = '2';
    process.env['CDKD_ACM_POLL_INTERVAL_MS'] = '1';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('marks the ARN when the wait ends terminal and the cleanup delete FAILS (pass-through arm)', async () => {
    mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
    mockSend.mockResolvedValueOnce({ Certificate: { Status: 'VALIDATION_TIMED_OUT' } });
    mockSend.mockRejectedValueOnce(new Error('AccessDenied'));

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MyCert', TYPE)).toBe(ARN);
  });

  it('marks the ARN when a raw failure follows the request and the cleanup FAILS (wrap arm)', async () => {
    mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
    mockSend.mockRejectedValueOnce(new Error('DescribeCertificate exploded'));
    mockSend.mockRejectedValueOnce(new Error('AccessDenied'));

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/Failed to create ACM certificate MyCert/);
    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MyCert', TYPE)).toBe(ARN);
  });

  it('does not mark when the cleanup delete succeeded (pass-through arm)', async () => {
    mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
    mockSend.mockResolvedValueOnce({ Certificate: { Status: 'VALIDATION_TIMED_OUT' } });
    mockSend.mockResolvedValueOnce({});

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MyCert', TYPE)).toBeUndefined();
  });

  it('does not mark when the cleanup delete succeeded (wrap arm)', async () => {
    mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
    mockSend.mockRejectedValueOnce(new Error('DescribeCertificate exploded'));
    mockSend.mockResolvedValueOnce({});

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MyCert', TYPE)).toBeUndefined();
  });

  it("does not mark RequestCertificate's own failure", async () => {
    mockSend.mockRejectedValueOnce(new Error('LimitExceededException'));

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(0);
    expect(createdBeforeFailure(error, 'MyCert', TYPE)).toBeUndefined();
  });

  it('does not mark the pre-flight refusal of a missing DomainName', async () => {
    const error = await failedCreate({});

    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MyCert', TYPE)).toBeUndefined();
  });
});
