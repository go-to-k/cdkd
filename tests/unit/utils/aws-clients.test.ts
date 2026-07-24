import { describe, expect, it } from 'vite-plus/test';
import { AwsClients } from '../../../src/utils/aws-clients.js';

describe('AwsClients', () => {
  it('passes the configured profile to every AWS SDK client', () => {
    const profile = 'test-profile';
    const clients = new AwsClients({ region: 'ap-northeast-1', profile });
    const factoryNames = Object.getOwnPropertyNames(AwsClients.prototype).filter((name) =>
      /^get[A-Z].*Client$/.test(name)
    );

    try {
      expect(factoryNames.length).toBeGreaterThanOrEqual(20);

      for (const name of factoryNames) {
        const client = (
          clients as unknown as Record<string, () => { config: { profile?: string } }>
        )[name]();
        expect(client.config.profile, `client factory "${name}"`).toBe(profile);
      }
    } finally {
      clients.destroy();
    }
  });
});
