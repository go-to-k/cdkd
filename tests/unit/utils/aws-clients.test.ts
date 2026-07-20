import { describe, expect, it } from 'vite-plus/test';
import { AwsClients } from '../../../src/utils/aws-clients.js';

describe('AwsClients', () => {
  it('passes the configured profile to every AWS SDK client', () => {
    const profile = 'haruki-default';
    const clients = new AwsClients({ region: 'ap-northeast-1', profile });

    try {
      expect(clients.s3.config.profile).toBe(profile);
      expect(clients.cloudControl.config.profile).toBe(profile);
      expect(clients.iam.config.profile).toBe(profile);
      expect(clients.sqs.config.profile).toBe(profile);
      expect(clients.sns.config.profile).toBe(profile);
      expect(clients.lambda.config.profile).toBe(profile);
      expect(clients.ec2.config.profile).toBe(profile);
      expect(clients.sts.config.profile).toBe(profile);
      expect(clients.dynamoDB.config.profile).toBe(profile);
      expect(clients.cloudFormation.config.profile).toBe(profile);
      expect(clients.apiGateway.config.profile).toBe(profile);
      expect(clients.eventBridge.config.profile).toBe(profile);
      expect(clients.secretsManager.config.profile).toBe(profile);
      expect(clients.ssm.config.profile).toBe(profile);
      expect(clients.cloudFront.config.profile).toBe(profile);
      expect(clients.acm.config.profile).toBe(profile);
      expect(clients.cloudWatch.config.profile).toBe(profile);
      expect(clients.cloudWatchLogs.config.profile).toBe(profile);
      expect(clients.bedrockAgentCoreControl.config.profile).toBe(profile);
    } finally {
      clients.destroy();
    }
  });
});
