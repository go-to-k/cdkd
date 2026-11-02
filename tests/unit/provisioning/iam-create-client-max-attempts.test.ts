import { IAMClient } from '@aws-sdk/client-iam';
import { describe, expect, it } from 'vite-plus/test';
import { IamCreateClientCache } from '../../../src/provisioning/providers/iam-create-client.js';
import { IAM_MAX_ATTEMPTS } from '../../../src/utils/iam-max-attempts.js';

// The create client is built apart from the shared IAM client, so the attempts
// pinned on the shared one (aws-clients.test.ts) do not cover it.
describe('IamCreateClientCache', () => {
  it('gives the create client more SDK attempts than the default, as the shared client has', async () => {
    const shared = new IAMClient({ region: 'eu-west-1' });
    try {
      const client = await new IamCreateClientCache(() => shared).get();
      expect(client).not.toBe(shared);
      expect(await client.config.maxAttempts()).toBe(IAM_MAX_ATTEMPTS);
      expect(IAM_MAX_ATTEMPTS).toBeGreaterThan(3);
      client.destroy();
    } finally {
      shared.destroy();
    }
  });
});
