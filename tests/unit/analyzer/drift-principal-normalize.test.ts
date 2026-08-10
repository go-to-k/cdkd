import { describe, it, expect, vi } from 'vite-plus/test';
import {
  canonicalizePrincipalUniqueIds,
  collectPrincipalArns,
  collectPrincipalUniqueIds,
  rewritePrincipalUniqueIds,
} from '../../../src/analyzer/drift-principal-normalize.js';

/**
 * Issue #1515: AWS renders an IAM principal inside a resource policy either as
 * its ARN or as its `AROA…` / `AIDA…` unique id, substituting the unique id
 * when the principal is transiently unresolvable and re-rendering the ARN once
 * it resolves. The deploy-time capture stores whichever form came back, so the
 * two sides of a later drift comparison can hold two spellings of ONE
 * principal — permanent phantom drift that `--revert` cannot clear, because
 * AWS re-canonicalizes on write.
 *
 * The fixture is the live shape from the 2026-08-10 `drift-revert` run: the
 * CDK `autoDeleteObjects` custom-resource role, created concurrently with the
 * bucket policy that references it.
 */
const ROLE_ARN =
  'arn:aws:iam::123456789012:role/CdkdDriftRevertExample-CustomS3AutoDeleteObjectsCustomR-30ff9234';
const ROLE_UNIQUE_ID = 'AROAXXXJN2LNV2SMSFATO';

const policy = (principal: unknown): Record<string, unknown> => ({
  Bucket: 'my-bucket',
  PolicyDocument: {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: principal },
        Action: 's3:GetBucket*',
        Resource: 'arn:aws:s3:::my-bucket',
      },
    ],
  },
});

const resolverFor = (
  pairs: Record<string, string>
): ((arn: string) => Promise<string | undefined>) =>
  vi.fn(async (arn: string) => pairs[arn]);

describe('drift principal unique-id canonicalization (issue #1515)', () => {
  describe('shape detection', () => {
    it('finds a unique id and an ARN at a Principal.AWS position', () => {
      expect(collectPrincipalUniqueIds(policy(ROLE_UNIQUE_ID))).toEqual(new Set([ROLE_UNIQUE_ID]));
      expect(collectPrincipalArns(policy(ROLE_ARN))).toEqual(new Set([ROLE_ARN]));
    });

    it('reads the array form and the bare-string form of Principal', () => {
      expect(collectPrincipalUniqueIds(policy([ROLE_UNIQUE_ID, ROLE_ARN]))).toEqual(
        new Set([ROLE_UNIQUE_ID])
      );
      expect(
        collectPrincipalUniqueIds({
          Statement: [{ Principal: ROLE_UNIQUE_ID }, { NotPrincipal: { AWS: [ROLE_UNIQUE_ID] } }],
        })
      ).toEqual(new Set([ROLE_UNIQUE_ID]));
    });

    it('ignores an id-looking string that is NOT at a principal position', () => {
      // A unique id inside a Condition is not interchangeable with the ARN
      // there — AWS compares those values literally.
      const value = {
        Statement: [
          {
            Principal: { Service: 's3.amazonaws.com' },
            Condition: { StringEquals: { 'aws:userId': ROLE_UNIQUE_ID } },
          },
        ],
      };
      expect(collectPrincipalUniqueIds(value).size).toBe(0);
    });

    it('ignores non-IAM principal members and non-role ARNs', () => {
      expect(
        collectPrincipalArns({
          Statement: [
            { Principal: { Service: 'lambda.amazonaws.com', CanonicalUser: 'abc123' } },
            { Principal: { AWS: 'arn:aws:sts::123456789012:assumed-role/Foo/session' } },
            { Principal: { AWS: '*' } },
          ],
        })
      ).toEqual(new Set());
    });
  });

  describe('rewrite', () => {
    it('swaps only the proven unique id, leaving every sibling value alone', () => {
      const rewritten = rewritePrincipalUniqueIds(
        {
          Statement: [
            { Principal: { AWS: [ROLE_UNIQUE_ID, 'AROAOTHERPRINCIPAL1'] } },
            { Principal: { Service: 's3.amazonaws.com' } },
            { Condition: { StringEquals: { 'aws:userId': ROLE_UNIQUE_ID } } },
          ],
        },
        new Map([[ROLE_UNIQUE_ID, ROLE_ARN]])
      ) as { Statement: Array<Record<string, Record<string, unknown>>> };

      expect(rewritten.Statement[0]?.['Principal']?.['AWS']).toEqual([
        ROLE_ARN,
        'AROAOTHERPRINCIPAL1',
      ]);
      expect(rewritten.Statement[1]?.['Principal']?.['Service']).toBe('s3.amazonaws.com');
      expect(rewritten.Statement[2]?.['Condition']?.['StringEquals']).toEqual({
        'aws:userId': ROLE_UNIQUE_ID,
      });
    });
  });

  describe('canonicalization across the two comparison sides', () => {
    it('makes the two spellings of one principal compare equal', async () => {
      const { baseline, aws } = await canonicalizePrincipalUniqueIds(
        policy(ROLE_UNIQUE_ID),
        policy(ROLE_ARN),
        resolverFor({ [ROLE_ARN]: ROLE_UNIQUE_ID })
      );

      expect(baseline).toEqual(aws);
    });

    it('normalizes in the reverse direction too, since the race is symmetric', async () => {
      // Run 1 of the live fixture captured the ARN and read back the unique
      // id; run 2 was the other way round. Normalizing one side only is the
      // mistake drift-normalize.ts's header already records.
      const { baseline, aws } = await canonicalizePrincipalUniqueIds(
        policy(ROLE_ARN),
        policy(ROLE_UNIQUE_ID),
        resolverFor({ [ROLE_ARN]: ROLE_UNIQUE_ID })
      );

      expect(baseline).toEqual(aws);
    });

    it('still reports a REAL principal change — the id belongs to another role', async () => {
      const other =
        'arn:aws:iam::123456789012:role/CdkdDriftRevertExample-SomeoneElse-abcdef12';
      const { baseline, aws } = await canonicalizePrincipalUniqueIds(
        policy(ROLE_UNIQUE_ID),
        policy(other),
        resolverFor({ [other]: 'AROADIFFERENTROLE99' })
      );

      expect(baseline).not.toEqual(aws);
    });

    it('leaves both sides untouched when the principal cannot be resolved', async () => {
      // The deleted-role case (AWS keeps the unique id forever) and the
      // missing-iam:GetRole case both land here. Reporting the drift is the
      // safe direction — this pass may only remove a PROVEN-equal difference.
      const before = policy(ROLE_UNIQUE_ID);
      const { baseline, aws } = await canonicalizePrincipalUniqueIds(
        before,
        policy(ROLE_ARN),
        resolverFor({})
      );

      expect(baseline).toEqual(before);
      expect(aws).toEqual(policy(ROLE_ARN));
    });

    it('makes NO resolver call when no unique id is present', async () => {
      const resolve = resolverFor({ [ROLE_ARN]: ROLE_UNIQUE_ID });
      const { baseline, aws } = await canonicalizePrincipalUniqueIds(
        policy(ROLE_ARN),
        policy(ROLE_ARN),
        resolve
      );

      expect(resolve).not.toHaveBeenCalled();
      expect(baseline).toEqual(aws);
    });

    it('makes NO resolver call when a unique id has no candidate ARN opposite it', async () => {
      const resolve = resolverFor({ [ROLE_ARN]: ROLE_UNIQUE_ID });
      await canonicalizePrincipalUniqueIds(
        policy(ROLE_UNIQUE_ID),
        policy(ROLE_UNIQUE_ID),
        resolve
      );

      expect(resolve).not.toHaveBeenCalled();
    });

    it('returns the ORIGINAL objects untouched on the short-circuit paths', async () => {
      // Identity matters: the drift command feeds the result straight into the
      // comparator, and a needless deep copy per resource would be pure cost.
      const baselineIn = policy(ROLE_ARN);
      const awsIn = policy(ROLE_ARN);
      const { baseline, aws } = await canonicalizePrincipalUniqueIds(
        baselineIn,
        awsIn,
        resolverFor({})
      );

      expect(baseline).toBe(baselineIn);
      expect(aws).toBe(awsIn);
    });
  });
});
