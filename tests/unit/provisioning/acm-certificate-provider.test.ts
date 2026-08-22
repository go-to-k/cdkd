import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  AddTagsToCertificateCommand,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
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

// Hoisted so tests can read what the provider actually PRINTED. The validation
// CNAMEs are user-facing output that nothing else observes, and since a failed
// create now deletes the certificate, that output is the user's only copy of
// them -- so it needs a fence like any other behaviour.
const loggerSpy = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = { ...loggerSpy, child: vi.fn().mockReturnThis() };
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
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

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
    // The token store is module-global and keyed by (scope, region, stack,
    // logical id), so without this a token left in flight by one test would be
    // handed to the next one creating the same logical id -- which is exactly
    // what the "fresh token after a success" test must be able to see.
    resetIdempotencyTokensForTests();
    loggerSpy.info.mockClear();
    loggerSpy.warn.mockClear();
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

    it.each(['FAILED', 'INACTIVE', 'REVOKED', 'EXPIRED'] as const)(
      'throws when status is terminal: %s',
      async (status) => {
        process.env['CDKD_NO_WAIT'] = '';
        mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
        mockSend.mockResolvedValueOnce({ Certificate: { Status: status } });

        await expect(
          provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
            DomainName: 'example.com',
            ValidationMethod: 'DNS',
          })
        ).rejects.toThrow(new RegExp(status));
      }
    );

    it('throws "did not reach ISSUED" when polling cap exhausts', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      // maxPollAttempts=10 was set in beforeEach. Feed PENDING_VALIDATION 11+ times.
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      for (let i = 0; i < 12; i++) {
        mockSend.mockResolvedValueOnce({
          Certificate: { Status: 'PENDING_VALIDATION', DomainValidationOptions: [] },
        });
      }

      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
          DomainName: 'example.com',
          ValidationMethod: 'DNS',
        })
      ).rejects.toThrow(/did not reach ISSUED/);
    });
  });

  // Issue #2169: before this, a create whose ISSUED wait failed threw the ARN
  // away inside a message string. The certificate stayed in AWS with nothing
  // naming it -- absent from state, so `cdkd destroy` could not reach it -- and
  // every retry requested another one.
  describe('create: a failed create leaves no certificate behind (#2169)', () => {
    /** Primes RequestCertificate + enough PENDING polls to exhaust the cap. */
    function primeTimeout(): void {
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      for (let i = 0; i < 10; i++) {
        mockSend.mockResolvedValueOnce({
          Certificate: { Status: 'PENDING_VALIDATION', DomainValidationOptions: [] },
        });
      }
    }
    const PROPS = { DomainName: 'example.com', ValidationMethod: 'DNS' };

    it('deletes the certificate it requested when the ISSUED wait exhausts', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      primeTimeout();
      mockSend.mockResolvedValueOnce({}); // DeleteCertificate

      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
      ).rejects.toThrow(/did not reach ISSUED/);

      const deletes = callsOfType(DeleteCertificateCommand);
      expect(deletes).toHaveLength(1);
      expect(deletes[0].input.CertificateArn).toBe(ARN);
    });

    it('deletes it when the wait ends on a terminal status too', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'VALIDATION_TIMED_OUT' } });
      mockSend.mockResolvedValueOnce({}); // DeleteCertificate

      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
      ).rejects.toThrow(/VALIDATION_TIMED_OUT/);

      expect(callsOfType(DeleteCertificateCommand)[0].input.CertificateArn).toBe(ARN);
    });

    it('carries the requested ARN out on the error as physicalId, not only in the message', async () => {
      // The reporter's own ask. Kept even though the certificate is now
      // deleted: `physicalId` is the machine-readable half of the answer, and
      // the one field that still names the certificate when the cleanup
      // FAILED. (It is not consumed by any generic failed-CREATE handling --
      // the only reader in the repo is `cleanupFailedCreateRemnant`, which is
      // Cloud-Control-only.)
      process.env['CDKD_NO_WAIT'] = '';
      primeTimeout();
      mockSend.mockResolvedValueOnce({});

      const error = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as ProvisioningError).physicalId).toBe(ARN);
      expect((error as ProvisioningError).resourceType).toBe(
        'AWS::CertificateManager::Certificate'
      );
      // The wait's OWN message must survive untouched. Without this, reverting
      // `waitForCertificateIssued` to a plain `Error` still passes everything
      // above: the outer catch would wrap it into a `ProvisioningError` that is
      // still the right class, still carries this `physicalId`, and still
      // contains "did not reach ISSUED" as a substring. This is the only
      // assertion that tells the pass-through apart from the re-wrap.
      expect((error as Error).message).not.toMatch(/^Failed to create ACM certificate/);
    });

    it('carries the ARN on a NON-cdkd failure after the request too', async () => {
      // The assertion above only exercises the pass-through branch: the wait's
      // own error is already a `ProvisioningError` carrying the ARN, so it
      // would pass even if `create()`'s own wrap still dropped it (which it
      // did before #2169). This drives a RAW AWS failure after
      // `RequestCertificate` has answered, which is the only path through that
      // wrap.
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      mockSend.mockRejectedValueOnce(new Error('DescribeCertificate exploded'));
      mockSend.mockResolvedValueOnce({}); // DeleteCertificate

      const error = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
        .catch((e: unknown) => e);

      expect((error as Error).message).toMatch(/Failed to create ACM certificate MyCert/);
      expect((error as ProvisioningError).physicalId).toBe(ARN);
      // ...and the certificate that raw failure left behind is still retired.
      expect(callsOfType(DeleteCertificateCommand)[0].input.CertificateArn).toBe(ARN);
    });

    it('deletes NOTHING when the failure happened before AWS returned an ARN', async () => {
      // Polarity twin. A rejected RequestCertificate created no certificate, so
      // a cleanup here would be a delete aimed at nothing -- or, with a
      // different id source, at something else.
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockRejectedValueOnce(new Error('InvalidDomainValidationOptionsException'));

      const error = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
        .catch((e: unknown) => e);

      expect(callsOfType(DeleteCertificateCommand)).toHaveLength(0);
      expect((error as ProvisioningError).physicalId).toBeUndefined();
    });

    it('does not delete anything when the create SUCCEEDS', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'ISSUED' } });

      const result = await provider.create(
        'MyCert',
        'AWS::CertificateManager::Certificate',
        PROPS
      );

      expect(result.physicalId).toBe(ARN);
      expect(callsOfType(DeleteCertificateCommand)).toHaveLength(0);
    });

    it('surfaces the survivor when the cleanup delete itself fails', async () => {
      // A cleanup that cannot retire the certificate must say so IN the error
      // the user sees -- a warn line alone is the thing they scroll past -- and
      // must not replace the original diagnosis.
      process.env['CDKD_NO_WAIT'] = '';
      primeTimeout();
      mockSend.mockRejectedValueOnce(new Error('ThrottlingException'));

      const message = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
        .catch((e: unknown) => (e as Error).message);

      expect(message).toMatch(/did not reach ISSUED/);
      expect(message).toMatch(/could NOT be deleted/);
      expect(message).toContain(`aws acm delete-certificate --certificate-arn ${ARN}`);
    });

    it('appends the survivor note on the NON-cdkd path too', async () => {
      // The other polarity of the survivor test: that one drives the wait's own
      // `ProvisioningError` (the pass-through arm), this one drives a raw AWS
      // failure through `create()`'s own wrap. They are different concatenation
      // sites and only one of them was covered.
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      mockSend.mockRejectedValueOnce(new Error('DescribeCertificate exploded'));
      mockSend.mockRejectedValueOnce(new Error('ThrottlingException'));

      const error = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
        .catch((e: unknown) => e);

      expect((error as Error).message).toMatch(/Failed to create ACM certificate MyCert/);
      expect((error as Error).message).toMatch(/could NOT be deleted/);
      expect((error as ProvisioningError).physicalId).toBe(ARN);
    });

    it('keeps the raw AWS cleanup error OUT of the thrown message', async () => {
      // `isRetryableTransientError` substring-matches the THROWN message against
      // the transient-error table, so an AWS cleanup error carrying one of those
      // phrases would re-classify a terminal create failure as retryable — and
      // the engine would then re-enter `create()`. `does not exist` is a real
      // entry in that table.
      process.env['CDKD_NO_WAIT'] = '';
      primeTimeout();
      mockSend.mockRejectedValueOnce(new Error('The bucket does not exist'));

      const message = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
        .catch((e: unknown) => (e as Error).message);

      expect(message).toMatch(/could NOT be deleted/);
      expect(message).not.toContain('does not exist');
    });

    it('releases the token when the cleanup found the certificate already gone', async () => {
      // Same hazard as the successful-delete case: the certificate is not there,
      // so a retry answered with that ARN would be answered with nothing.
      process.env['CDKD_NO_WAIT'] = '';
      primeTimeout();
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      );
      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
      ).rejects.toThrow();

      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      process.env['CDKD_NO_WAIT'] = 'true';
      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS);

      const tokens = callsOfType(RequestCertificateCommand).map(
        (c) => c.input.IdempotencyToken as string
      );
      expect(tokens[1]).not.toBe(tokens[0]);
    });

    it('recognises a not-found that kept its NAME but lost its SDK class', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      primeTimeout();
      const wrapped = new Error('Could not find certificate');
      wrapped.name = 'ResourceNotFoundException';
      mockSend.mockRejectedValueOnce(wrapped);

      const message = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
        .catch((e: unknown) => (e as Error).message);

      // Positive marker first: a bare negative assertion passes under ANY
      // unrelated early failure, so it has to be pinned to the run that
      // actually reached the cleanup.
      expect(message).toMatch(/did not reach ISSUED/);
      expect(message).not.toMatch(/could NOT be deleted/);
    });

    it('treats a not-found on the cleanup as already gone, with no survivor note', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      primeTimeout();
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      );

      const message = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
        .catch((e: unknown) => (e as Error).message);

      expect(message).toMatch(/did not reach ISSUED/);
      expect(message).not.toMatch(/could NOT be deleted/);
    });

    it('prints the validation CNAMEs on a LATER poll when the first one has none yet', async () => {
      // The first `DescribeCertificate` fires seconds after `RequestCertificate`
      // and ACM commonly answers it with `DomainValidationOptions` that have no
      // `ResourceRecord` yet. Latching on the CALL rather than on having
      // printed a record meant the header went out with nothing under it and
      // every later poll was suppressed -- so the CNAMEs were never shown.
      // Survivable while the certificate outlived the deploy; a dead end now
      // that a failed create deletes it.
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      // Poll 1: options present, ResourceRecord absent.
      mockSend.mockResolvedValueOnce({
        Certificate: {
          Status: 'PENDING_VALIDATION',
          DomainValidationOptions: [{ DomainName: 'example.com', ValidationMethod: 'DNS' }],
        },
      });
      // Poll 2: AWS has filled it in.
      mockSend.mockResolvedValueOnce({
        Certificate: {
          Status: 'PENDING_VALIDATION',
          DomainValidationOptions: [
            {
              DomainName: 'example.com',
              ValidationMethod: 'DNS',
              ResourceRecord: { Type: 'CNAME', Name: '_abc.example.com.', Value: '_def.acm.aws.' },
            },
          ],
        },
      });
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'ISSUED' } });

      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS);

      const printed = loggerSpy.info.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('_abc.example.com.');
      expect(printed).toContain('_def.acm.aws.');
      // ...and the record-less poll printed no bare header claiming otherwise.
      const headers = loggerSpy.info.mock.calls.filter((c) =>
        String(c[0]).includes('Add the following DNS records')
      );
      expect(headers).toHaveLength(1);
    });

    it('keeps printing until EVERY domain has its record, not just the first', async () => {
      // A SAN certificate gets one DomainValidationOptions entry per domain and
      // ACM fills their ResourceRecords independently. Latching after any
      // successful print shows domain A's CNAME and hides domain B's forever --
      // the same dead end one level down, and unrecoverable now that the
      // certificate is deleted.
      process.env['CDKD_NO_WAIT'] = '';
      const recordFor = (d: string) => ({
        DomainName: d,
        ValidationMethod: 'DNS',
        ResourceRecord: { Type: 'CNAME', Name: `_x.${d}.`, Value: `_y.${d}.acm.aws.` },
      });
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      // Poll 1: only the apex has a record.
      mockSend.mockResolvedValueOnce({
        Certificate: {
          Status: 'PENDING_VALIDATION',
          DomainValidationOptions: [
            recordFor('example.com'),
            { DomainName: 'www.example.com', ValidationMethod: 'DNS' },
          ],
        },
      });
      // Poll 2: AWS has filled in the SAN too.
      mockSend.mockResolvedValueOnce({
        Certificate: {
          Status: 'PENDING_VALIDATION',
          DomainValidationOptions: [recordFor('example.com'), recordFor('www.example.com')],
        },
      });
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'ISSUED' } });

      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS);

      const printed = loggerSpy.info.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('_x.example.com.');
      expect(printed).toContain('_x.www.example.com.');
    });

    it('does not re-print the same records on every poll', async () => {
      // The other half of dropping the latch: identical content must not be
      // repeated once per 10s poll.
      process.env['CDKD_NO_WAIT'] = '';
      const opts = {
        Status: 'PENDING_VALIDATION',
        DomainValidationOptions: [
          {
            DomainName: 'example.com',
            ValidationMethod: 'DNS',
            ResourceRecord: { Type: 'CNAME', Name: '_abc.example.com.', Value: '_def.acm.aws.' },
          },
        ],
      };
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      mockSend.mockResolvedValueOnce({ Certificate: opts });
      mockSend.mockResolvedValueOnce({ Certificate: opts });
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'ISSUED' } });

      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS);

      const headers = loggerSpy.info.mock.calls.filter((c) =>
        String(c[0]).includes('Add the following DNS records')
      );
      expect(headers).toHaveLength(1);
    });

    it('prints nothing for an EMAIL validation with no addresses yet', async () => {
      // The old printer emitted `confirmation email sent to: <none>`, which
      // counted as "something was shown" and closed the latch over a domain
      // that had nothing to show.
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      mockSend.mockResolvedValueOnce({
        Certificate: {
          Status: 'PENDING_VALIDATION',
          DomainValidationOptions: [{ DomainName: 'example.com', ValidationMethod: 'EMAIL' }],
        },
      });
      mockSend.mockResolvedValueOnce({
        Certificate: {
          Status: 'PENDING_VALIDATION',
          DomainValidationOptions: [
            {
              DomainName: 'example.com',
              ValidationMethod: 'EMAIL',
              ValidationEmails: ['admin@example.com'],
            },
          ],
        },
      });
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'ISSUED' } });

      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS);

      const printed = loggerSpy.info.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).not.toContain('<none>');
      expect(printed).toContain('admin@example.com');
    });

    it('says records were NOT printed when AWS never published any', async () => {
      // The certificate is deleted on the way out, so "add the records printed
      // above" is actively misleading when nothing was printed.
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      for (let i = 0; i < 10; i++) {
        mockSend.mockResolvedValueOnce({
          Certificate: {
            Status: 'PENDING_VALIDATION',
            DomainValidationOptions: [{ DomainName: 'example.com', ValidationMethod: 'DNS' }],
          },
        });
      }
      mockSend.mockResolvedValueOnce({});

      const message = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
        .catch((e: unknown) => (e as Error).message);

      expect(message).toMatch(/had not published this certificate's validation records/);
      expect(message).not.toMatch(/printed above/);
      // ...and it still names the real lever for waiting longer.
      expect(message).toContain('CDKD_ACM_POLL_ATTEMPTS');
    });

    it('puts the cleanup reason in the warn, since the thrown note omits it', async () => {
      // The note says "the reason is in the warning above", so that warn is
      // load-bearing rather than decorative.
      process.env['CDKD_NO_WAIT'] = '';
      primeTimeout();
      mockSend.mockRejectedValueOnce(new Error('ThrottlingException: slow down'));

      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
      ).rejects.toThrow();

      const warned = loggerSpy.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain(ARN);
      expect(warned).toContain('ThrottlingException: slow down');
    });

    it('leaves the OLD certificate alone when a REPLACEMENT create fails', async () => {
      // `update()` re-creates through this same `create()`, so its cleanup
      // retires the NEW certificate only. The claim that the old one survives
      // rests on `this.create(...)` sitting OUTSIDE update()'s try -- a future
      // refactor that wrapped it would delete the old certificate silently,
      // which is the failure this pins.
      process.env['CDKD_NO_WAIT'] = '';
      const OLD_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/old-one';
      primeTimeout();
      mockSend.mockResolvedValueOnce({}); // DeleteCertificate for the NEW cert

      await expect(
        provider.update(
          'MyCert',
          OLD_ARN,
          'AWS::CertificateManager::Certificate',
          { DomainName: 'new.example.com', ValidationMethod: 'DNS' },
          { DomainName: 'old.example.com', ValidationMethod: 'DNS' }
        )
      ).rejects.toThrow();

      const deleted = callsOfType(DeleteCertificateCommand).map(
        (c) => c.input.CertificateArn as string
      );
      expect(deleted).toEqual([ARN]);
      expect(deleted).not.toContain(OLD_ARN);
    });

    it('sends an IdempotencyToken ACM will accept (\w+, <= 32 chars)', async () => {
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });

      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
        DomainName: 'example.com',
      });

      const token = callsOfType(RequestCertificateCommand)[0].input.IdempotencyToken as string;
      // ACM's documented constraints: `Pattern: \w+`, `Maximum length of 32`.
      // The helper's DEFAULT spelling is `cdkd-<hex>`, whose hyphen is not in
      // `\w` -- so this asserts the narrower charset was actually asked for,
      // and would fail on the default.
      expect(token).toMatch(/^\w{1,32}$/);
    });

    it('re-uses one token across retries of a create, and mints a fresh one once the certificate is gone', async () => {
      // Attempt 1 fails at the request itself -- the shape that mints a second
      // certificate when the failure was a 5xx whose request had landed.
      mockSend.mockRejectedValueOnce(new Error('503 Service Unavailable'));
      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
          DomainName: 'example.com',
        })
      ).rejects.toThrow(/503/);

      // Attempt 2 (what the engine's withRetry does) must send the SAME token,
      // so ACM answers with the certificate attempt 1 may already have made.
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
        DomainName: 'example.com',
      });

      // A later create of the same logical id must NOT be answered with that
      // certificate.
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
        DomainName: 'example.com',
      });

      const tokens = callsOfType(RequestCertificateCommand).map(
        (c) => c.input.IdempotencyToken as string
      );
      expect(tokens).toHaveLength(3);
      expect(tokens[0]).toBe(tokens[1]);
      expect(tokens[2]).not.toBe(tokens[1]);
    });

    it('retires the token when the cleanup deleted the certificate, so a retry is not handed a deleted ARN', async () => {
      // ACM answers a repeat of the same token within an hour with the SAME
      // certificate. Once cleanup has deleted it, reusing the token would hand
      // the next attempt an ARN that no longer exists.
      process.env['CDKD_NO_WAIT'] = '';
      primeTimeout();
      mockSend.mockResolvedValueOnce({}); // DeleteCertificate succeeds
      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
      ).rejects.toThrow();

      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      process.env['CDKD_NO_WAIT'] = 'true';
      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS);

      const tokens = callsOfType(RequestCertificateCommand).map(
        (c) => c.input.IdempotencyToken as string
      );
      expect(tokens[1]).not.toBe(tokens[0]);
    });

    it('KEEPS the token when the cleanup could not delete, so the retry is answered with the survivor', async () => {
      // The opposite polarity of the test above, and the reason the release is
      // conditional rather than unconditional: the certificate is still there,
      // so being handed that same one is the outcome we want.
      process.env['CDKD_NO_WAIT'] = '';
      primeTimeout();
      mockSend.mockRejectedValueOnce(new Error('ThrottlingException'));
      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS)
      ).rejects.toThrow();

      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      process.env['CDKD_NO_WAIT'] = 'true';
      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', PROPS);

      const tokens = callsOfType(RequestCertificateCommand).map(
        (c) => c.input.IdempotencyToken as string
      );
      expect(tokens[1]).toBe(tokens[0]);
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

    // Issue #1922: the in-use rejection is the reported real-world failure.
    // Before #1819 gave update() an outcome channel this was a bare
    // logger.warn and the deploy exited 0 with the old certificate alive and
    // out of state.
    it('reports partial when the old certificate is still in use', async () => {
      const newArn = 'arn:aws:acm:us-east-1:123456789012:certificate/new';
      mockSend.mockResolvedValueOnce({ CertificateArn: newArn }); // create
      // AWS's OWN wording, not a phrase invented to match the classifier: ACM
      // says `Certificate <arn> is in use.` with the class in `name`.
      const inUse = new Error(`Certificate ${ARN} is in use.`);
      inUse.name = 'ResourceInUseException';
      mockSend.mockRejectedValueOnce(inUse); // delete refused

      const result = await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', SubjectAlternativeNames: ['www.example.com'] },
        { DomainName: 'example.com', SubjectAlternativeNames: ['api.example.com'] }
      );

      // The row itself still succeeded — the new certificate exists and is
      // what state must point at.
      expect(result.wasReplaced).toBe(true);
      expect(result.physicalId).toBe(newArn);
      // ...but the old one survived, and the reason names it, because state
      // now points at the new ARN and nothing else downstream knows the old.
      expect(result.outcome).toBe('partial');
      expect(result.reason).toContain(ARN);
      // Asserted on wording ONLY the classifier produces. The raw SDK message
      // also contains "still in use", so a looser assertion here passes even
      // with the classifier disabled -- it would be testing the error text
      // rather than the branch.
      expect(result.reason).toContain('is still in use by another resource and was not deleted');
      expect(result.reason).not.toContain('could not be deleted');
    });

    // The classifier's two arms are pinned INDEPENDENTLY. With one input
    // carrying both signals they mask each other -- removing either still
    // passes because the other catches it, which is how the first version of
    // this suite left the whole classifier deletable.
    it('detects in-use from the CAUSE CHAIN when the message says nothing', async () => {
      const newArn = 'arn:aws:acm:us-east-1:123456789012:certificate/new';
      mockSend.mockResolvedValueOnce({ CertificateArn: newArn });
      // Name only. `delete()` wraps this in a ProvisioningError, so the class
      // sits one level down -- the sole signal, visible only to the cause walk.
      const inUse = new Error('Operation cannot be completed at this time.');
      inUse.name = 'ResourceInUseException';
      mockSend.mockRejectedValueOnce(inUse);

      const result = await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', SubjectAlternativeNames: ['www.example.com'] },
        { DomainName: 'example.com', SubjectAlternativeNames: ['api.example.com'] }
      );

      expect(result.outcome).toBe('partial');
      expect(result.reason).toContain('is still in use by another resource and was not deleted');
    });

    it('detects in-use from the MESSAGE when the SDK class was lost', async () => {
      const newArn = 'arn:aws:acm:us-east-1:123456789012:certificate/new';
      mockSend.mockResolvedValueOnce({ CertificateArn: newArn });
      // A re-thrown error that kept AWS's text but lost the class: nothing to
      // walk to, so only the message arm can classify it.
      mockSend.mockRejectedValueOnce(new Error(`Certificate ${ARN} is in use.`));

      const result = await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', SubjectAlternativeNames: ['www.example.com'] },
        { DomainName: 'example.com', SubjectAlternativeNames: ['api.example.com'] }
      );

      expect(result.outcome).toBe('partial');
      expect(result.reason).toContain('is still in use by another resource and was not deleted');
    });

    // The #1778 SKIP class: a non-throwing "I did not address this resource",
    // which sails straight past the catch. Every producer's throw arm was
    // tested and this one was not, at all three providers.
    it('reports partial when the inner delete SKIPS rather than throws', async () => {
      const newArn = 'arn:aws:acm:us-east-1:123456789012:certificate/new';
      mockSend.mockResolvedValueOnce({ CertificateArn: newArn });
      vi.spyOn(provider, 'delete').mockResolvedValue({
        outcome: 'skipped',
        reason: 'malformed physicalId in state — no delete issued',
      });

      const result = await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', SubjectAlternativeNames: ['www.example.com'] },
        { DomainName: 'example.com', SubjectAlternativeNames: ['api.example.com'] }
      );

      expect(result.outcome).toBe('partial');
      // Prefixed with the OLD arn: the skip's own reason does not carry it, and
      // state now points at the replacement.
      expect(result.reason).toContain(ARN);
      expect(result.reason).toContain('no delete issued');
    });

    it('reports partial with the raw cause for a non-in-use delete failure', async () => {
      const newArn = 'arn:aws:acm:us-east-1:123456789012:certificate/new';
      mockSend.mockResolvedValueOnce({ CertificateArn: newArn });
      mockSend.mockRejectedValueOnce(new Error('AccessDeniedException: no acm:DeleteCertificate'));

      const result = await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', SubjectAlternativeNames: ['www.example.com'] },
        { DomainName: 'example.com', SubjectAlternativeNames: ['api.example.com'] }
      );

      expect(result.outcome).toBe('partial');
      expect(result.reason).toContain('AccessDeniedException');
      // Not misreported as the in-use case, whose remediation is different.
      expect(result.reason).not.toContain('still in use');
    });

    // The polarity that keeps the channel honest: a replacement whose delete
    // succeeds must NOT carry an outcome, or every clean replacement would be
    // counted and rendered as a partial.
    it('reports no outcome when the old certificate is deleted cleanly', async () => {
      const newArn = 'arn:aws:acm:us-east-1:123456789012:certificate/new';
      mockSend.mockResolvedValueOnce({ CertificateArn: newArn });
      mockSend.mockResolvedValueOnce({}); // delete succeeds

      const result = await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', SubjectAlternativeNames: ['www.example.com'] },
        { DomainName: 'example.com', SubjectAlternativeNames: ['api.example.com'] }
      );

      expect(result.wasReplaced).toBe(true);
      expect(result.outcome).toBeUndefined();
      expect(result.reason).toBeUndefined();
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

    it('skips UpdateCertificateOptions when CT / Export did not change (tags-only update)', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        {
          DomainName: 'example.com',
          CertificateTransparencyLoggingPreference: 'ENABLED',
          Tags: [{ Key: 'a', Value: '1' }],
        },
        {
          DomainName: 'example.com',
          CertificateTransparencyLoggingPreference: 'ENABLED',
          Tags: [{ Key: 'a', Value: '0' }],
        }
      );

      expect(callsOfType(UpdateCertificateOptionsCommand)).toHaveLength(0);
      expect(callsOfType(AddTagsToCertificateCommand)).toHaveLength(1);
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

    it('omits CT / Export from the snapshot when AWS Options is undefined', async () => {
      mockSend.mockResolvedValueOnce({
        Certificate: {
          DomainName: 'example.com',
          KeyAlgorithm: 'RSA_2048',
          // No `Options` field at all.
        },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });

      const result = await provider.readCurrentState(
        ARN,
        'MyCert',
        'AWS::CertificateManager::Certificate'
      );

      expect(result).toBeDefined();
      expect(result!['DomainName']).toBe('example.com');
      expect(result!['KeyAlgorithm']).toBe('RSA_2048');
      // Neither CT nor Export are emitted — important for drift comparator
      // not to fire false drift on a cert deployed without Options.
      expect('CertificateTransparencyLoggingPreference' in result!).toBe(false);
      expect('CertificateExport' in result!).toBe(false);
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

    it('returns null without any AWS call when no override is supplied (no aws:cdk:path tag walk)', async () => {
      // The aws:cdk:path tag walk is gone (issue #1134): AWS rejects
      // aws:-prefixed tag writes, so the tag never exists on a real resource.
      // With no explicit override the provider resolves nothing and returns
      // null immediately — the import flow relies on --resource / CFn lookup.
      const result = await provider.import!(makeInput());
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
