import { S3Client } from '@aws-sdk/client-s3';
import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { IAMClient } from '@aws-sdk/client-iam';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SNSClient } from '@aws-sdk/client-sns';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { STSClient } from '@aws-sdk/client-sts';
import { EC2Client } from '@aws-sdk/client-ec2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { ACMClient } from '@aws-sdk/client-acm';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';

/**
 * AWS client configuration
 */
export interface AwsClientConfig {
  region?: string;
  profile?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

/**
 * AWS clients manager
 */
export class AwsClients {
  private s3Client?: S3Client;
  private cloudControlClient?: CloudControlClient;
  private iamClient?: IAMClient;
  private sqsClient?: SQSClient;
  private snsClient?: SNSClient;
  private lambdaClient?: LambdaClient;
  private stsClient?: STSClient;
  private ec2Client?: EC2Client;
  private dynamoDBClient?: DynamoDBClient;
  private cloudFormationClient?: CloudFormationClient;
  private apiGatewayClient?: APIGatewayClient;
  private eventBridgeClient?: EventBridgeClient;
  private secretsManagerClient?: SecretsManagerClient;
  private ssmClient?: SSMClient;
  private cloudFrontClient?: CloudFrontClient;
  private cloudWatchClient?: CloudWatchClient;
  private cloudWatchLogsClient?: CloudWatchLogsClient;
  private bedrockAgentCoreControlClient?: BedrockAgentCoreControlClient;
  private acmClient?: ACMClient;
  private lambdaMicrovmsClient?: LambdaMicrovmsClient;
  private config: AwsClientConfig;

  constructor(config: AwsClientConfig = {}) {
    this.config = config;
  }

  private get clientOptions(): Pick<AwsClientConfig, 'region' | 'profile' | 'credentials'> {
    return {
      ...(this.config.region && { region: this.config.region }),
      ...(this.config.profile && { profile: this.config.profile }),
      ...(this.config.credentials && { credentials: this.config.credentials }),
    };
  }

  /**
   * Get S3 client
   *
   * Note: If region and credentials are not provided, AWS SDK will use:
   * 1. Environment variables (AWS_REGION, AWS_ACCESS_KEY_ID, etc.)
   * 2. AWS credentials file (~/.aws/credentials)
   * 3. IAM role (if running on EC2/ECS/Lambda)
   */
  getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        ...this.clientOptions,
        // Suppress "Are you using a Stream of unknown length" warning
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });
    }
    return this.s3Client;
  }

  /**
   * Get Cloud Control API client
   *
   * Note: If region and credentials are not provided, AWS SDK will use:
   * 1. Environment variables (AWS_REGION, AWS_ACCESS_KEY_ID, etc.)
   * 2. AWS credentials file (~/.aws/credentials)
   * 3. IAM role (if running on EC2/ECS/Lambda)
   */
  getCloudControlClient(): CloudControlClient {
    if (!this.cloudControlClient) {
      this.cloudControlClient = new CloudControlClient({
        ...this.clientOptions,
      });
    }
    return this.cloudControlClient;
  }

  /**
   * Get IAM client
   *
   * Note: IAM is a global service, but we accept region for consistency.
   * If not specified, defaults to us-east-1.
   */
  getIAMClient(): IAMClient {
    if (!this.iamClient) {
      this.iamClient = new IAMClient({
        ...this.clientOptions,
        region: this.config.region || 'us-east-1',
      });
    }
    return this.iamClient;
  }

  /**
   * Convenience getter for S3 client
   */
  get s3(): S3Client {
    return this.getS3Client();
  }

  /**
   * Convenience getter for Cloud Control client
   */
  get cloudControl(): CloudControlClient {
    return this.getCloudControlClient();
  }

  /**
   * Convenience getter for IAM client
   */
  get iam(): IAMClient {
    return this.getIAMClient();
  }

  /**
   * Get SQS client
   */
  getSQSClient(): SQSClient {
    if (!this.sqsClient) {
      this.sqsClient = new SQSClient({
        ...this.clientOptions,
      });
    }
    return this.sqsClient;
  }

  /**
   * Convenience getter for SQS client
   */
  get sqs(): SQSClient {
    return this.getSQSClient();
  }

  /**
   * Get SNS client
   */
  getSNSClient(): SNSClient {
    if (!this.snsClient) {
      this.snsClient = new SNSClient({
        ...this.clientOptions,
      });
    }
    return this.snsClient;
  }

  /**
   * Convenience getter for SNS client
   */
  get sns(): SNSClient {
    return this.getSNSClient();
  }

  /**
   * Get Lambda client
   */
  getLambdaClient(): LambdaClient {
    if (!this.lambdaClient) {
      this.lambdaClient = new LambdaClient({
        ...this.clientOptions,
      });
    }
    return this.lambdaClient;
  }

  /**
   * Convenience getter for Lambda client
   */
  get lambda(): LambdaClient {
    return this.getLambdaClient();
  }

  /**
   * Get EC2 client
   */
  getEC2Client(): EC2Client {
    if (!this.ec2Client) {
      this.ec2Client = new EC2Client({
        ...this.clientOptions,
      });
    }
    return this.ec2Client;
  }

  /**
   * Convenience getter for EC2 client
   */
  get ec2(): EC2Client {
    return this.getEC2Client();
  }

  /**
   * Get STS client
   */
  getSTSClient(): STSClient {
    if (!this.stsClient) {
      this.stsClient = new STSClient({
        ...this.clientOptions,
      });
    }
    return this.stsClient;
  }

  /**
   * Convenience getter for STS client
   */
  get sts(): STSClient {
    return this.getSTSClient();
  }

  /**
   * Get DynamoDB client
   */
  getDynamoDBClient(): DynamoDBClient {
    if (!this.dynamoDBClient) {
      this.dynamoDBClient = new DynamoDBClient({
        ...this.clientOptions,
      });
    }
    return this.dynamoDBClient;
  }

  /**
   * Convenience getter for DynamoDB client
   */
  get dynamoDB(): DynamoDBClient {
    return this.getDynamoDBClient();
  }

  /**
   * Get CloudFormation client
   */
  getCloudFormationClient(): CloudFormationClient {
    if (!this.cloudFormationClient) {
      this.cloudFormationClient = new CloudFormationClient({
        ...this.clientOptions,
      });
    }
    return this.cloudFormationClient;
  }

  /**
   * Convenience getter for CloudFormation client
   */
  get cloudFormation(): CloudFormationClient {
    return this.getCloudFormationClient();
  }

  /**
   * Get API Gateway client
   */
  getAPIGatewayClient(): APIGatewayClient {
    if (!this.apiGatewayClient) {
      this.apiGatewayClient = new APIGatewayClient({
        ...this.clientOptions,
      });
    }
    return this.apiGatewayClient;
  }

  /**
   * Convenience getter for API Gateway client
   */
  get apiGateway(): APIGatewayClient {
    return this.getAPIGatewayClient();
  }

  /**
   * Get EventBridge client
   */
  getEventBridgeClient(): EventBridgeClient {
    if (!this.eventBridgeClient) {
      this.eventBridgeClient = new EventBridgeClient({
        ...this.clientOptions,
      });
    }
    return this.eventBridgeClient;
  }

  /**
   * Convenience getter for EventBridge client
   */
  get eventBridge(): EventBridgeClient {
    return this.getEventBridgeClient();
  }

  /**
   * Get Secrets Manager client
   */
  getSecretsManagerClient(): SecretsManagerClient {
    if (!this.secretsManagerClient) {
      this.secretsManagerClient = new SecretsManagerClient({
        ...this.clientOptions,
      });
    }
    return this.secretsManagerClient;
  }

  /**
   * Convenience getter for Secrets Manager client
   */
  get secretsManager(): SecretsManagerClient {
    return this.getSecretsManagerClient();
  }

  /**
   * Get SSM client
   */
  getSSMClient(): SSMClient {
    if (!this.ssmClient) {
      this.ssmClient = new SSMClient({
        ...this.clientOptions,
      });
    }
    return this.ssmClient;
  }

  /**
   * Convenience getter for SSM client
   */
  get ssm(): SSMClient {
    return this.getSSMClient();
  }

  /**
   * Get CloudFront client
   */
  getCloudFrontClient(): CloudFrontClient {
    if (!this.cloudFrontClient) {
      this.cloudFrontClient = new CloudFrontClient({
        ...this.clientOptions,
      });
    }
    return this.cloudFrontClient;
  }

  /**
   * Convenience getter for CloudFront client
   */
  get cloudFront(): CloudFrontClient {
    return this.getCloudFrontClient();
  }

  /**
   * Get ACM client
   *
   * ACM is region-scoped. The client uses the configured AWS region so the
   * deploy engine's per-stack region resolution carries through. CloudFront
   * users must place their certificate stack in `us-east-1`.
   */
  getACMClient(): ACMClient {
    if (!this.acmClient) {
      this.acmClient = new ACMClient({
        ...this.clientOptions,
      });
    }
    return this.acmClient;
  }

  /**
   * Convenience getter for ACM client
   */
  get acm(): ACMClient {
    return this.getACMClient();
  }

  /**
   * Get Lambda MicroVMs client.
   *
   * Backs `AWS::Lambda::MicrovmImage` (`LambdaMicrovmImageProvider`). This is
   * the dedicated `lambda-microvms` service, NOT `@aws-sdk/client-lambda` —
   * the MicroVM image / MicroVM run APIs live in their own service model.
   * Region-scoped: MicroVM images and their code-artifact S3 buckets must be
   * in the same region.
   */
  getLambdaMicrovmsClient(): LambdaMicrovmsClient {
    if (!this.lambdaMicrovmsClient) {
      this.lambdaMicrovmsClient = new LambdaMicrovmsClient({
        ...this.clientOptions,
      });
    }
    return this.lambdaMicrovmsClient;
  }

  /**
   * Convenience getter for Lambda MicroVMs client
   */
  get lambdaMicrovms(): LambdaMicrovmsClient {
    return this.getLambdaMicrovmsClient();
  }

  /**
   * Get CloudWatch client
   */
  getCloudWatchClient(): CloudWatchClient {
    if (!this.cloudWatchClient) {
      this.cloudWatchClient = new CloudWatchClient({
        ...this.clientOptions,
      });
    }
    return this.cloudWatchClient;
  }

  /**
   * Convenience getter for CloudWatch client
   */
  get cloudWatch(): CloudWatchClient {
    return this.getCloudWatchClient();
  }

  /**
   * Get CloudWatch Logs client
   */
  getCloudWatchLogsClient(): CloudWatchLogsClient {
    if (!this.cloudWatchLogsClient) {
      this.cloudWatchLogsClient = new CloudWatchLogsClient({
        ...this.clientOptions,
      });
    }
    return this.cloudWatchLogsClient;
  }

  /**
   * Convenience getter for CloudWatch Logs client
   */
  get cloudWatchLogs(): CloudWatchLogsClient {
    return this.getCloudWatchLogsClient();
  }

  /**
   * Get BedrockAgentCoreControl client
   */
  getBedrockAgentCoreControlClient(): BedrockAgentCoreControlClient {
    if (!this.bedrockAgentCoreControlClient) {
      this.bedrockAgentCoreControlClient = new BedrockAgentCoreControlClient({
        ...this.clientOptions,
      });
    }
    return this.bedrockAgentCoreControlClient;
  }

  /**
   * Convenience getter for BedrockAgentCoreControl client
   */
  get bedrockAgentCoreControl(): BedrockAgentCoreControlClient {
    return this.getBedrockAgentCoreControlClient();
  }

  /**
   * Destroy all clients
   */
  destroy(): void {
    this.s3Client?.destroy();
    this.cloudControlClient?.destroy();
    this.iamClient?.destroy();
    this.sqsClient?.destroy();
    this.snsClient?.destroy();
    this.lambdaClient?.destroy();
    this.stsClient?.destroy();
    this.ec2Client?.destroy();
    this.dynamoDBClient?.destroy();
    this.cloudFormationClient?.destroy();
    this.apiGatewayClient?.destroy();
    this.eventBridgeClient?.destroy();
    this.secretsManagerClient?.destroy();
    this.ssmClient?.destroy();
    this.cloudFrontClient?.destroy();
    this.cloudWatchClient?.destroy();
    this.cloudWatchLogsClient?.destroy();
    this.bedrockAgentCoreControlClient?.destroy();
    this.acmClient?.destroy();
    this.lambdaMicrovmsClient?.destroy();
  }
}

/**
 * Global AWS clients instance
 */
let globalClients: AwsClients | null = null;

/**
 * Get or create global AWS clients
 */
export function getAwsClients(config?: AwsClientConfig): AwsClients {
  if (!globalClients) {
    globalClients = new AwsClients(config);
  }
  return globalClients;
}

/**
 * Set global AWS clients instance
 */
export function setAwsClients(clients: AwsClients): void {
  globalClients = clients;
}

/**
 * Reset global AWS clients (useful for testing)
 */
export function resetAwsClients(): void {
  globalClients?.destroy();
  globalClients = null;
}
