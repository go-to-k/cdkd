/**
 * `S3BucketProvider` sends `CreateBucket` through its OWN `S3Client` (issue
 * go-to-k/cdkd#4639). A suite whose S3 double is the shared client its
 * `getAwsClients` mock hands out installs this as the `S3Client` constructor,
 * so the create reaches that same double:
 *
 *   vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
 *     ...(await import('./s3-create-client-forward.js')).forwardedS3Client(),
 *   }));
 *
 * The shared client is looked up at SEND time, through the suite's own
 * (mocked) `getAwsClients`, so a suite that swaps its double between cases is
 * followed. Reached by a dynamic import from the hoisted factory, so this module
 * imports nothing from `src/` at load.
 */
import { vi } from 'vite-plus/test';

interface SharedS3 {
  send: (...args: unknown[]) => unknown;
}

/** The `S3Client` export a suite's `@aws-sdk/client-s3` mock spreads in. */
export function forwardedS3Client(): { S3Client: unknown } {
  return {
    S3Client: vi.fn().mockImplementation((cfg?: { region?: string }) => ({
      config: { region: () => Promise.resolve(cfg?.region) },
      send: async (...args: unknown[]) => {
        const { getAwsClients } = await import('../../../src/utils/aws-clients.js');
        return (getAwsClients().s3 as unknown as SharedS3).send(...args);
      },
    })),
  };
}
