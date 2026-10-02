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

  // go-to-k/cdkd#4355: the standalone-ingress Authorize is classified per send,
  // which holds only while this client retries nothing inside the SDK.
  it('builds ec2SingleSend as a separate EC2 client with SDK retries off, destroyed with the rest', async () => {
    const clients = new AwsClients({ region: 'us-east-1' });
    const single = clients.ec2SingleSend;
    const regular = clients.ec2;
    let destroyed = 0;
    const realDestroy = single.destroy.bind(single);
    single.destroy = () => {
      destroyed += 1;
      realDestroy();
    };
    try {
      expect(single).not.toBe(regular);
      expect(clients.ec2SingleSend).toBe(single);
      expect(await single.config.maxAttempts()).toBe(1);
      expect(await regular.config.maxAttempts()).toBeGreaterThan(1);
    } finally {
      clients.destroy();
    }
    expect(destroyed).toBe(1);
  });
});
