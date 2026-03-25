import { S3Client } from '@aws-sdk/client-s3';
import { CloudControlClient } from '@aws-sdk/client-cloudcontrol';
import { IAMClient } from '@aws-sdk/client-iam';

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
   * Destroy all clients
   */
  destroy(): void {
    this.s3Client?.destroy();
    this.cloudControlClient?.destroy();
    this.iamClient?.destroy();
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
