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

  constructor(private config: AwsClientConfig = {}) {}

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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        region: this.config.region || 'us-east-1',
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
   * Get CloudWatch client
   */
  getCloudWatchClient(): CloudWatchClient {
    if (!this.cloudWatchClient) {
      this.cloudWatchClient = new CloudWatchClient({
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
        ...(this.config.region && { region: this.config.region }),
        ...(this.config.credentials && { credentials: this.config.credentials }),
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
