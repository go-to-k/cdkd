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
    // handed to the next one that creates the same logical id -- which is
    // exactly what the "fresh token after a success" test must be able to see.
    resetIdempotencyTokensForTests();
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

  // Issue #2169: a create that fails AFTER RequestCertificate returned leaves a
  // real certificate in AWS. These fence the two halves that keep it from being
  // lost -- the report that lets the engine record it, and the ARN on the way
  // out -- plus the idempotency token that stops an in-process retry minting a
  // second one.
  describe('create: a certificate that outlives its failed create (#2169)', () => {
    const CERT_ATTRS = { Arn: ARN, CertificateArn: ARN };

    it('reports the ARN to the engine as soon as RequestCertificate returns, BEFORE the wait', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      const reported: Array<[string, Record<string, unknown> | undefined]> = [];
      // Records what had been reported by the time the FIRST poll ran. A report
      // deferred to the end of create() would leave this empty, and would be
      // lost entirely to an outer `--resource-timeout` abort.
      let reportedBeforeFirstPoll: number | undefined;
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      mockSend.mockImplementationOnce(() => {
        reportedBeforeFirstPoll = reported.length;
        return Promise.resolve({ Certificate: { Status: 'ISSUED' } });
      });

      await provider.create(
        'MyCert',
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', ValidationMethod: 'DNS' },
        { reportMaterialized: (id, attrs) => reported.push([id, attrs]) }
      );

      expect(reportedBeforeFirstPoll).toBe(1);
      expect(reported).toEqual([[ARN, CERT_ATTRS]]);
    });

    it('reports the ARN even though the ISSUED wait then times out', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      const reported: Array<[string, Record<string, unknown> | undefined]> = [];
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      for (let i = 0; i < 10; i++) {
        mockSend.mockResolvedValueOnce({
          Certificate: { Status: 'PENDING_VALIDATION', DomainValidationOptions: [] },
        });
      }

      await expect(
        provider.create(
          'MyCert',
          'AWS::CertificateManager::Certificate',
          { DomainName: 'example.com', ValidationMethod: 'DNS' },
          { reportMaterialized: (id, attrs) => reported.push([id, attrs]) }
        )
      ).rejects.toThrow(/did not reach ISSUED/);

      expect(reported).toEqual([[ARN, CERT_ATTRS]]);
    });

    it('carries the ARN on the poll-cap-exhausted error as physicalId, not only in the message', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      for (let i = 0; i < 10; i++) {
        mockSend.mockResolvedValueOnce({
          Certificate: { Status: 'PENDING_VALIDATION', DomainValidationOptions: [] },
        });
      }

      const error = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', {
          DomainName: 'example.com',
          ValidationMethod: 'DNS',
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as ProvisioningError).physicalId).toBe(ARN);
      expect((error as ProvisioningError).logicalId).toBe('MyCert');
      expect((error as ProvisioningError).resourceType).toBe(
        'AWS::CertificateManager::Certificate'
      );
    });

    it('carries the ARN on the terminal-status error as physicalId', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'VALIDATION_TIMED_OUT' } });

      const error = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', {
          DomainName: 'example.com',
          ValidationMethod: 'DNS',
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as ProvisioningError).physicalId).toBe(ARN);
    });

    // The failure message makes a PROMISE about cleanup, and the promise is
    // only true when a report channel exists to put the certificate in state.
    // A create with no channel -- the replacement inside `update()`, a
    // `drift --revert` -- must not tell the user `cdkd destroy` covers it.
    it('promises cdkd cleanup ONLY when the engine can record the certificate', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      const primePolls = (): void => {
        mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
        for (let i = 0; i < 10; i++) {
          mockSend.mockResolvedValueOnce({
            Certificate: { Status: 'PENDING_VALIDATION', DomainValidationOptions: [] },
          });
        }
      };
      const props = { DomainName: 'example.com', ValidationMethod: 'DNS' };

      primePolls();
      const reported = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', props, {
          reportMaterialized: () => {},
        })
        .catch((e: unknown) => (e as Error).message);

      mockSend.mockReset();
      primePolls();
      const unreported = await provider
        .create('MyCert', 'AWS::CertificateManager::Certificate', props)
        .catch((e: unknown) => (e as Error).message);

      expect(reported).toContain("recorded in this stack's state");
      expect(reported).not.toContain('NOT tracking');

      expect(unreported).toContain('NOT tracking');
      // Names the exact retirement command, since cdkd will not issue it.
      expect(unreported).toContain(`aws acm delete-certificate --certificate-arn ${ARN}`);
      expect(unreported).not.toContain("recorded in this stack's state");
    });

    it('sends an IdempotencyToken ACM will accept (\\w+, <= 32 chars)', async () => {
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

    it('re-uses the same IdempotencyToken across retries of one create, and a fresh one after a success', async () => {
      // Attempt 1 fails at the request itself -- the shape that mints a second
      // certificate when the failure was a 5xx whose request had landed.
      mockSend.mockRejectedValueOnce(new Error('503 Service Unavailable'));
      await expect(
        provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
          DomainName: 'example.com',
        })
      ).rejects.toThrow(/503/);

      // Attempt 2 (what the engine's withRetry does) succeeds.
      mockSend.mockResolvedValueOnce({ CertificateArn: ARN });
      await provider.create('MyCert', 'AWS::CertificateManager::Certificate', {
        DomainName: 'example.com',
      });

      // A LATER create of the same logical id -- e.g. a `--replace` re-create --
      // must not be answered with the certificate the previous one produced.
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

  // Issue #2169: once a failed create's certificate is in state, the NEXT
  // deploy reaches update() instead of create(). These fence that the re-run
  // reaches the same verdict the create would have.
  describe('update: resuming the ISSUED wait for an adopted certificate (#2169)', () => {
    it('waits for a PENDING_VALIDATION certificate and succeeds once it is ISSUED', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      // No tag / options change, so the only calls are the status probe and
      // then the resumed wait's polls.
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'PENDING_VALIDATION' } });
      mockSend.mockResolvedValueOnce({
        Certificate: { Status: 'PENDING_VALIDATION', DomainValidationOptions: [] },
      });
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'ISSUED' } });

      const result = await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', ValidationMethod: 'DNS' },
        { DomainName: 'example.com', ValidationMethod: 'DNS' }
      );

      expect(result.physicalId).toBe(ARN);
      expect(result.wasReplaced).toBe(false);
      expect(callsOfType(DescribeCertificateCommand)).toHaveLength(3);
    });

    it('fails the update when the adopted certificate is still not issued', async () => {
      process.env['CDKD_NO_WAIT'] = '';
      mockSend.mockResolvedValueOnce({ Certificate: { Status: 'PENDING_VALIDATION' } });
      for (let i = 0; i < 10; i++) {
        mockSend.mockResolvedValueOnce({
          Certificate: { Status: 'PENDING_VALIDATION', DomainValidationOptions: [] },
        });
      }

      const error = await provider
        .update(
          'MyCert',
          ARN,
          'AWS::CertificateManager::Certificate',
          { DomainName: 'example.com', ValidationMethod: 'DNS' },
          { DomainName: 'example.com', ValidationMethod: 'DNS' }
        )
        .catch((e: unknown) => e);

      // The wait's own message survives -- not re-wrapped behind a generic
      // "Failed to update ACM certificate".
      expect((error as Error).message).toMatch(/did not reach ISSUED/);
      expect((error as ProvisioningError).physicalId).toBe(ARN);
    });

    // The gate is PENDING_VALIDATION specifically, not "anything but ISSUED":
    // an ordinary update of an expired / revoked certificate succeeded before
    // #2169 and must keep succeeding, since `waitForCertificateIssued` treats
    // those as terminal failures.
    it.each(['ISSUED', 'EXPIRED', 'REVOKED', 'INACTIVE'] as const)(
      'does not wait when the certificate status is %s',
      async (status) => {
        process.env['CDKD_NO_WAIT'] = '';
        mockSend.mockResolvedValueOnce({ Certificate: { Status: status } });

        const result = await provider.update(
          'MyCert',
          ARN,
          'AWS::CertificateManager::Certificate',
          { DomainName: 'example.com', ValidationMethod: 'DNS' },
          { DomainName: 'example.com', ValidationMethod: 'DNS' }
        );

        expect(result.physicalId).toBe(ARN);
        // Exactly one DescribeCertificate: the status probe. A resumed wait
        // would add at least one more.
        expect(callsOfType(DescribeCertificateCommand)).toHaveLength(1);
      }
    );

    it('skips the status probe entirely under CDKD_NO_WAIT', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';

      await provider.update(
        'MyCert',
        ARN,
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', ValidationMethod: 'DNS' },
        { DomainName: 'example.com', ValidationMethod: 'DNS' }
      );

      expect(callsOfType(DescribeCertificateCommand)).toHaveLength(0);
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
