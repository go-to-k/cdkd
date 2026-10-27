import {
  ACCOUNT,
  TAG_THROWS,
  createOnlyOf,
  setOutputOverrides,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';

/**
 * The batch-8 ACM wire cases (#3723): `AWS::CertificateManager::Certificate`,
 * served by `ACMCertificateProvider`.
 *
 * create() polls DescribeCertificate until ISSUED (acm-certificate-provider.ts:1030-1047).
 * The arm answers the first poll PENDING_VALIDATION with the DNS validation
 * record of `example.com`, then ISSUED: that first poll is where a
 * `DomainValidationOptions[].HostedZoneId` is delivered, as Route 53
 * ChangeResourceRecordSets (:1092-1102, :1165-1198). The suite running these
 * cases sets `CDKD_ACM_POLL_INTERVAL_MS=0`, so the poll does not sleep.
 *
 * `RequestCertificate`'s `IdempotencyToken` is cdkd's own
 * (`acquireIdempotencyToken`, :349-355) and changes per successful create, so
 * the suite pins it (`sdk-wire-coverage-8.test.ts`).
 */

const CERT_ARN = `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/c1`;
const PCA_ARN = `arn:aws:acm-pca:us-east-1:${ACCOUNT}:certificate-authority/ca1`;

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

/** The first poll of each call PENDING_VALIDATION with example.com's record, then ISSUED. */
function armPendingThenIssued(): void {
  let polls = 0;
  setOutputOverrides({
    DescribeCertificateCommand: () => {
      polls += 1;
      if (polls > 1) return { Certificate: { CertificateArn: CERT_ARN, Status: 'ISSUED' } };
      return {
        Certificate: {
          CertificateArn: CERT_ARN,
          Status: 'PENDING_VALIDATION',
          DomainValidationOptions: [
            {
              DomainName: 'example.com',
              ValidationMethod: 'DNS',
              ResourceRecord: {
                Name: '_v.example.com.',
                Type: 'CNAME',
                Value: '_r.acm.aws.',
              },
            },
          ],
        },
      };
    },
  });
}

const DOMAIN_REQUIRED: Throw = {
  why: 'create() refuses a missing DomainName before any call (acm-certificate-provider.ts:271-278)',
  says: /DomainName is required/,
};

export const ACM_CASES: TypeCase[] = [
  {
    resourceType: 'AWS::CertificateManager::Certificate',
    provider: () => new ACMCertificateProvider(),
    physicalId: CERT_ARN,
    // CertificateTransparencyLoggingPreference and Tags are updated in place;
    // ValidationMethod is not create-only in the schema, but update() replaces
    // the certificate through create() when it changes
    // (acm-certificate-provider.ts:633-637); the rest is create-only.
    createOnly: createOnlyOf('AWS::CertificateManager::Certificate'),
    arm: armPendingThenIssued,
    exempt: {},
    targets: [
      {
        path: ['Tags', 0],
        command: 'RemoveTagsFromCertificateCommand',
        names: 'k1',
        notNames: 'k2',
      },
      {
        path: ['Tags', 1],
        command: 'RemoveTagsFromCertificateCommand',
        names: 'k2',
        notNames: 'k1',
      },
    ],
    bags: [
      {
        name: 'a DNS-validated public certificate',
        bag: {
          DomainName: 'example.com',
          ValidationMethod: 'DNS',
          SubjectAlternativeNames: ['www.example.com', 'api.example.com'],
          DomainValidationOptions: [
            {
              DomainName: 'example.com',
              ValidationDomain: 'example.com',
              HostedZoneId: 'Z123',
            },
          ],
          // Not the CloudFormation default ENABLED, so dropping it would
          // deploy another preference.
          CertificateTransparencyLoggingPreference: 'DISABLED',
          // Not the CloudFormation default DISABLED.
          CertificateExport: 'ENABLED',
          KeyAlgorithm: 'EC_prime256v1',
          Tags: TAGS,
        },
        expectedRemovalThrows: {
          'create:DomainName': DOMAIN_REQUIRED,
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
        },
      },
      {
        name: 'a private-CA certificate',
        bag: {
          DomainName: 'internal.example.com',
          CertificateAuthorityArn: PCA_ARN,
          KeyAlgorithm: 'RSA_2048',
        },
        expectedRemovalThrows: {
          'create:DomainName': DOMAIN_REQUIRED,
        },
      },
    ],
  },
];
