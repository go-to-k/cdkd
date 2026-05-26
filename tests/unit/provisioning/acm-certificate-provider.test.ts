import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  AddTagsToCertificateCommand,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RemoveTagsFromCertificateCommand,
  RequestCertificateCommand,
  ResourceNotFoundException,
  UpdateCertificateOptionsCommand,
} from '@aws-sdk/client-acm';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    acm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';

const ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/abc123';

function callsOfType(klass: { new (...args: any[]): any }): any[] {
  return mockSend.mock.calls
    .filter((call) => call[0].constructor.name === klass.name)
    .map((call) => call[0]);
}

describe('ACMCertificateProvider', () => {
  let provider: ACMCertificateProvider;
  let originalNoWait: string | undefined;
  let originalPollAttempts: string | undefined;
  let originalPollInterval: string | undefined;

  beforeEach(() => {
    mockSend.mockReset();
    originalNoWait = process.env['CDKD_NO_WAIT'];
    originalPollAttempts = process.env['CDKD_ACM_POLL_ATTEMPTS'];
    originalPollInterval = process.env['CDKD_ACM_POLL_INTERVAL_MS'];
    // Fast polling so the poll-loop tests don't burn wall-clock.
    process.env['CDKD_ACM_POLL_ATTEMPTS'] = '10';
    process.env['CDKD_ACM_POLL_INTERVAL_MS'] = '50';
    // Default to --no-wait so create() tests don't enter the poll loop unless
    // they explicitly disable.
    process.env['CDKD_NO_WAIT'] = 'true';
    provider = new ACMCertificateProvider();
  });

  afterEach(() => {
    process.env['CDKD_NO_WAIT'] = originalNoWait ?? '';
    process.env['CDKD_ACM_POLL_ATTEMPTS'] = originalPollAttempts ?? '';
    process.env['CDKD_ACM_POLL_INTERVAL_MS'] = originalPollInterval ?? '';
    if (!originalNoWait) delete process.env['CDKD_NO_WAIT'];
    if (!originalPollAttempts) delete process.env['CDKD_ACM_POLL_ATTEMPTS'];
    if (!originalPollInterval) delete process.env['CDKD_ACM_POLL_INTERVAL_MS'];
  });

  describe('create', () => {
    it('requests a certificate with the minimal property set and returns the ARN as physicalId', async () => {
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });

      const result = await provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
        DomainName: 'example.com',
      });

      expect(result.physicalId).toBe(ARN);
      expect(result.attributes).toEqual({ Arn: ARN, CertificateArn: ARN });
      const req = callsOfType(RequestCertificateCommand)[0].input;
      expect(req.DomainName).toBe('example.com');
      expect(req.ValidationMethod).toBeUndefined();
    });

    it('forwards every supported property to RequestCertificate', async () => {
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });

      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
        DomainName: 'example.com',
        ValidationMethod: 'DNS',
        SubjectAlternativeNames: ['www.example.com', 'api.example.com'],
        DomainValidationOptions: [{ DomainName: 'example.com', ValidationDomain: 'example.com' }],
        KeyAlgorithm: 'RSA_2048',
        CertificateTransparencyLoggingPreference: 'ENABLED',
        CertificateExport: 'ENABLED',
        Tags: [{ Key: 'env', Value: 'test' }],
      });

      const req = callsOfType(RequestCertificateCommand)[0].input;
      expect(req.ValidationMethod).toBe('DNS');
      expect(req.SubjectAlternativeNames).toEqual(['www.example.com', 'api.example.com']);
      expect(req.DomainValidationOptions).toEqual([
        { DomainName: 'example.com', ValidationDomain: 'example.com' },
      ]);
      expect(req.KeyAlgorithm).toBe('RSA_2048');
      expect(req.Options).toEqual({
        CertificateTransparencyLoggingPreference: 'ENABLED',
        Export: 'ENABLED',
      });
      expect(req.Tags).toEqual([{ Key: 'env', Value: 'test' }]);
    });

    it('strips CDK-only HostedZoneId from DomainValidationOptions (ACM SDK rejects it)', async () => {
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });

      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
        DomainName: 'example.com',
        DomainValidationOptions: [
          { DomainName: 'example.com', HostedZoneId: 'Z123', ValidationDomain: 'example.com' },
        ],
      });

      const req = callsOfType(RequestCertificateCommand)[0].input;
      expect(req.DomainValidationOptions).toEqual([
        { DomainName: 'example.com', ValidationDomain: 'example.com' },
      ]);
    });

    it('throws when DomainName is missing', async () => {
      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', {})
      ).rejects.toThrow(/DomainName is required/);
    });

    it('polls until ISSUED when --no-wait is not set', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      // First poll: PENDING_VALIDATION (logs validation options).
      mockSend.mockResolvedValueOnce({
        Certificate: {
          Status: 'PENDING_VALIDATION',
          DomainValidationOptions: [
            {
              DomainName: 'example.com',
              ValidationMethod: 'DNS',
              ResourceRecord: { Name: '_x.example.com.', Type: 'CNAME', Value: '_y.acm-validations.aws.' },
            },
          ],
        },
      });
      // Second poll: ISSUED.
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'ISSUED' } });

      const result = await provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
        DomainName: 'example.com',
        ValidationMethod: 'DNS',
      });

      expect(result.physicalId).toBe(ARN);
      const describes = callsOfType(DescribeCertificateCommand);
      expect(describes).toHaveLength(2);
    });

    it('throws on terminal validation failure (VALIDATION_TIMED_OUT)', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      mockSend.mockResolvedValueOnce({
        Certificate: { Status: 'VALIDATION_TIMED_OUT' },
      });

      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
          DomainName: 'example.com',
          ValidationMethod: 'DNS',
        })
      ).rejects.toThrow(/VALIDATION_TIMED_OUT/);
    });
  });

  describe('update', () => {
    it('updates CertificateTransparencyLoggingPreference in place', async () => {
      mockSend.mockResolvedValue({});

      const result = await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        {
          DomainName: 'example.com',
          CertificateTransparencyLoggingPreference: 'DISABLED',
        },
        { DomainName: 'example.com', CertificateTransparencyLoggingPreference: 'ENABLED' }
      );

      expect(result.wasReplaced).toBe(false);
      expect(result.physicalId).toBe(ARN);
      const updates = callsOfType(UpdateCertificateOptionsCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0].input.Options).toEqual({
        CertificateTransparencyLoggingPreference: 'DISABLED',
      });
    });

    it('replaces the certificate when DomainName changes (DomainName is immutable)', async () => {
      const newArn = 'arn:aws:acm:us-east-1:123456789012:certificate/new';
      // create() RequestCertificate
      mockSend.mockResolvedValueOnce({ CertificateArn: newArn });
      // delete() DeleteCertificate
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        { DomainName: 'new.example.com', ValidationMethod: 'DNS' },
        { DomainName: 'example.com', ValidationMethod: 'DNS' }
      );

      expect(result.wasReplaced).toBe(true);
      expect(result.physicalId).toBe(newArn);
      expect(callsOfType(DeleteCertificateCommand)).toHaveLength(1);
    });

    it('replaces on SubjectAlternativeNames change', async () => {
      const newArn = 'arn:aws:acm:us-east-1:123456789012:certificate/new';
      mockSend.mockResolvedValueOnce({ CertificateArn: newArn });
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', SubjectAlternativeNames: ['www.example.com'] },
        { DomainName: 'example.com', SubjectAlternativeNames: ['api.example.com'] }
      );

      expect(result.wasReplaced).toBe(true);
    });

    it('diffs and applies tag changes', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        {
          DomainName: 'example.com',
          Tags: [{ Key: 'env', Value: 'prod' }],
        },
        {
          DomainName: 'example.com',
          Tags: [{ Key: 'env', Value: 'staging' }, { Key: 'owner', Value: 'alice' }],
        }
      );

      const added = callsOfType(AddTagsToCertificateCommand)[0].input;
      expect(added.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
      const removed = callsOfType(RemoveTagsFromCertificateCommand)[0].input;
      expect(removed.Tags).toEqual([{ Key: 'owner' }]);
    });
  });

  describe('delete', () => {
    it('calls DeleteCertificate with the ARN', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyCert', ARN, 'AWS::CertificateManager::Certificate');

      const dels = callsOfType(DeleteCertificateCommand);
      expect(dels).toHaveLength(1);
      expect(dels[0].input.CertificateArn).toBe(ARN);
    });

    it('treats ResourceNotFoundException as idempotent success', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ $metadata: {}, message: 'gone' })
      );

      await provider.delete('MyCert', ARN, 'AWS::CertificateManager::Certificate');
    });
  });

  describe('getAttribute', () => {
    it('returns the ARN for Arn / CertificateArn', async () => {
      expect(
        await provider.getAttribute(ARN, 'AWS::CertificateManager::Certificate', 'Arn')
      ).toBe(ARN);
      expect(
        await provider.getAttribute(ARN, 'AWS::CertificateManager::Certificate', 'CertificateArn')
      ).toBe(ARN);
    });
    it('returns undefined for unknown attributes', async () => {
      expect(
        await provider.getAttribute(ARN, 'AWS::CertificateManager::Certificate', 'DomainName')
      ).toBeUndefined();
    });
  });

  describe('readCurrentState', () => {
    it('fetches DescribeCertificate + ListTagsForCertificate', async () => {
      mockSend.mockResolvedValueOnce({
        Certificate: {
          DomainName: 'example.com',
          SubjectAlternativeNames: ['www.example.com'],
          KeyAlgorithm: 'RSA_2048',
          Options: { CertificateTransparencyLoggingPreference: 'ENABLED', Export: 'DISABLED' },
        },
      });
      mockSend.mockResolvedValueOnce({
        Tags: [
          { Key: 'env', Value: 'prod' },
          { Key: 'aws:cdk:path', Value: 'Stack/MyCert' },
        ],
      });

      const result = await provider.readCurrentState(
        ARN,
        'MyCert',
        'AWS::CertificateManager::Certificate'
      );

      expect(result).toBeDefined();
      expect(result!['DomainName']).toBe('example.com');
      expect(result!['SubjectAlternativeNames']).toEqual(['www.example.com']);
      expect(result!['KeyAlgorithm']).toBe('RSA_2048');
      expect(result!['CertificateTransparencyLoggingPreference']).toBe('ENABLED');
      expect(result!['CertificateExport']).toBe('DISABLED');
      // aws:* tag filtered out.
      expect(result!['Tags']).toEqual([{ Key: 'env', Value: 'prod' }]);
    });

    it('returns undefined when the certificate is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ $metadata: {}, message: 'gone' })
      );
      expect(
        await provider.readCurrentState(ARN, 'MyCert', 'AWS::CertificateManager::Certificate')
      ).toBeUndefined();
    });
  });

  describe('getDriftUnknownPaths', () => {
    it('declares ValidationMethod and DomainValidationOptions as drift-unknown', () => {
      expect(provider.getDriftUnknownPaths('AWS::CertificateManager::Certificate')).toEqual([
        'ValidationMethod',
        'DomainValidationOptions',
      ]);
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyCert',
        resourceType: 'AWS::CertificateManager::Certificate',
        cdkPath: 'MyStack/MyCert',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {} as Record<string, unknown>,
        ...overrides,
      };
    }

    it('verifies an explicit ARN override via DescribeCertificate', async () => {
      mockSend.mockResolvedValueOnce({ Certificate: { CertificateArn: ARN } });
      const result = await provider.import!(makeInput({ knownPhysicalId: ARN }));
      expect(result).toEqual({
        physicalId: ARN,
        attributes: { Arn: ARN, CertificateArn: ARN },
      });
    });

    it('refuses a knownPhysicalId that is not an ARN', async () => {
      await expect(
        provider.import!(makeInput({ knownPhysicalId: 'just-a-name' }))
      ).rejects.toThrow(/must be an ARN/);
    });

    it('returns null when an ARN override does not exist on AWS', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ $metadata: {}, message: 'gone' })
      );
      const result = await provider.import!(makeInput({ knownPhysicalId: ARN }));
      expect(result).toBeNull();
    });

    it('falls back to cdkPath tag lookup when no override is supplied', async () => {
      mockSend.mockResolvedValueOnce({
        CertificateSummaryList: [
          { CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/other' },
          { CertificateArn: ARN },
        ],
      });
      // First candidate's tags: no match.
      mockSend.mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'Other/X' }] });
      // Second candidate's tags: match.
      mockSend.mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyCert' }],
      });

      const result = await provider.import!(makeInput());
      expect(result?.physicalId).toBe(ARN);
    });

    it('returns null when no certificate matches the cdkPath', async () => {
      mockSend.mockResolvedValueOnce({
        CertificateSummaryList: [
          { CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/other' },
        ],
      });
      mockSend.mockResolvedValueOnce({ Tags: [{ Key: 'aws:cdk:path', Value: 'Other/X' }] });
      const result = await provider.import!(makeInput());
      expect(result).toBeNull();
    });
  });
});

// Reference imports the test asserts via constructor.name so import elision
// does not drop them.
void ListCertificatesCommand;
