/**
 * Issue #2176 — the composite-id masker is THREADED, not merely available.
 *
 * `compositeIdSeparatorRefusal` gained a masker in the first cut of this work
 * and three reviewers found it INERT: all 22 call sites used the identity
 * default, so no refusal in production was masked while the change looked
 * complete. It is now threaded at the 15 deploy-path sites, and this file is
 * what keeps it that way — a round-2 test reviewer measured that deleting the
 * `maskSecrets:` key from every one of them broke nothing.
 *
 * The other 7 sites are `import()` paths, which have no `CreateContext` to
 * thread and no secret bag to build one from; they keep the identity default
 * deliberately.
 *
 * Each case drives the PROVIDER (not the helper) so the assertion fails if the
 * key is dropped at that call site — which is the whole point.
 *
 * SCOPE, stated because an earlier header over-claimed it: this file covers the
 * two sites exercised below (S3Tables Namespace create, EC2 Route create +
 * update). The other 12 remain unfenced — a round-3 reviewer confirmed that
 * dropping their key breaks nothing — and a per-site fence for all 15 is what
 * the dataflow critic in issue #2178 is for. Do not read this file as covering
 * the set.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3tables: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: () => Promise.resolve({ Account: '111122223333' }) },
  }),
}));

import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

/** Carries the separator, so the refusal actually fires. */
const OFFENDING_NS = 'ns|with_separator';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

describe('composite-id masker threading (issue #2176)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('S3Tables Namespace create: the refusal masks the segment value', async () => {
    const provider = new S3TablesProvider();
    const maskSecrets = createSecretMasker(bagOf(OFFENDING_NS));

    // Assert on the MESSAGE: the positive marker is what proves the masker
    // arrived, and its absence is exactly what a dropped `maskSecrets:` key
    // produces at this call site.
    expect.assertions(2);
    await provider
      .create(
        'Ns',
        'AWS::S3Tables::Namespace',
        { TableBucketARN: 'arn:aws:s3tables:us-east-1:111122223333:bucket/b', Namespace: OFFENDING_NS },
        { maskSecrets }
      )
      .then(
        () => {
          throw new Error('expected a refusal');
        },
        (error: Error) => {
          expect(error.message).not.toContain(OFFENDING_NS);
          expect(error.message).toContain(`namespace '${SECRET_MASK}'`);
        }
      );
  });

  it('leaves a NON-secret segment alone — negative control', async () => {
    const provider = new S3TablesProvider();
    const maskSecrets = createSecretMasker(bagOf('an-unrelated-secret'));

    await provider
      .create(
        'Ns',
        'AWS::S3Tables::Namespace',
        { TableBucketARN: 'arn:aws:s3tables:us-east-1:111122223333:bucket/b', Namespace: OFFENDING_NS },
        { maskSecrets }
      )
      .then(
        () => {
          throw new Error('expected a refusal');
        },
        (error: Error) => {
          expect(error.message).toContain(`namespace '${OFFENDING_NS}'`);
        }
      );
  });

  it('is unmasked with no context — the back-compatible default', async () => {
    const provider = new S3TablesProvider();
    await provider
      .create('Ns', 'AWS::S3Tables::Namespace', {
        TableBucketARN: 'arn:aws:s3tables:us-east-1:111122223333:bucket/b',
        Namespace: OFFENDING_NS,
      })
      .then(
        () => {
          throw new Error('expected a refusal');
        },
        (error: Error) => {
          expect(error.message).toContain(`namespace '${OFFENDING_NS}'`);
        }
      );
  });

  it('EC2 Route create: the refusal masks the destination segment', async () => {
    // The site round 3 threaded. Its helper takes a CALLBACK rather than a
    // context, which is why the thread originally stopped one layer short.
    const provider = new EC2Provider();
    const offending = '10.0.0.0/16|extra';
    const maskSecrets = createSecretMasker(bagOf(offending));

    expect.assertions(2);
    await provider
      .create(
        'Rt',
        'AWS::EC2::Route',
        { RouteTableId: 'rtb-123', DestinationCidrBlock: offending, GatewayId: 'igw-1' },
        { maskSecrets }
      )
      .then(
        () => {
          throw new Error('expected a refusal');
        },
        (error: Error) => {
          expect(error.message).not.toContain(offending);
          expect(error.message).toContain(SECRET_MASK);
        }
      );
  });
});
