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
import { RedshiftClient } from '@aws-sdk/client-redshift';
import { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { ACMClient } from '@aws-sdk/client-acm';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { awsClientDefaults, type AwsClientDefaults } from './aws-client-defaults.ts';

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
/**
 * {@link canonicalizeRegion}'s body, inlined.
 *
 * This module may NOT import it AS `./aws-partition.js` —
 * `scripts/audit-provider-coverage.ts` runs under `node` with native type
 * stripping and imports this file as `'../src/utils/aws-clients.ts'`, and Node
 * resolves relative specifiers LITERALLY: it does not rewrite `.js` to `.ts`
 * the way TypeScript does at emit time. So a `./aws-partition.js` import here
 * is fine for the bundle and fails the script with `ERR_MODULE_NOT_FOUND`
 * (which is exactly how this was found — 32 `gen-nested-key-coverage` cases
 * went red on the first cut of issue #2065).
 *
 * A relative import IS allowed, spelled `.ts` — which resolves under both, and
 * which `rewriteRelativeImportExtensions` emits as `.js`. `./aws-client-defaults.ts`
 * is the first one under `src/` (issue #2388); the spelling is established in
 * `scripts/` and `tests/`. The constraint is TRANSITIVE, so it binds every
 * module reachable from here, not just this file's own imports. Inlining
 * `foldRegion` is kept anyway: it is one line, and the alternative is a module
 * in that closure existing solely to hold it.
 *
 * `tests/unit/utils/aws-clients-region-fold.test.ts` fences BOTH halves: that
 * this stays byte-equivalent to `canonicalizeRegion` over a table of spellings,
 * and that every relative import reachable from this file resolves under
 * literal resolution.
 */
function foldRegion(region: string): string {
  return region.toLowerCase();
}

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
  private redshiftClient?: RedshiftClient;
  private elastiCacheClient?: ElastiCacheClient;
  private acmClient?: ACMClient;
  private lambdaMicrovmsClient?: LambdaMicrovmsClient;
  private config: AwsClientConfig;

  constructor(config: AwsClientConfig = {}) {
    // Fold the region here as well as at the CLI boundary (issue #2065). This
    // is defense in depth, not the primary fix: `src/cli/region-options.ts`
    // folds `--region` / `AWS_REGION` per command, and this catches the paths
    // that boundary cannot see - a LIBRARY caller constructing `AwsClients`
    // directly (which never runs the CLI's handlers at all), and any future
    // call site that reads a region from somewhere new. What it buys is that
    // `client.config.region()` is canonical for every CONFIGURED bag, which is
    // the source the six provider ARN builders in issue #1881 interpolate raw.
    //
    // Double-folding is a no-op, and this cannot hide a raw spelling from a
    // consumer that wants one: nothing reads `configuredRegion` expecting the
    // user's exact case (`intrinsic-function-resolver.ts` already compares it
    // THROUGH `canonicalizeRegion`), and the one consumer that does want the
    // raw spelling - the bootstrap marker's second probe - takes it as a
    // string argument, never from a client.
    this.config = {
      ...config,
      ...(config.region !== undefined && { region: foldRegion(config.region) }),
    };
  }

  private get clientOptions(): {
    region?: string;
    profile?: string;
    // Widened beyond `AwsClientConfig['credentials']`: the proxied path
    // supplies a PROVIDER (a function the SDK calls and memoizes), not a
    // literal key bag.
    credentials?:
      | NonNullable<AwsClientConfig['credentials']>
      | NonNullable<AwsClientDefaults['credentials']>;
    requestHandler?: NonNullable<AwsClientDefaults['requestHandler']>;
  } {
    // `awsClientDefaults()` FIRST, so an explicit `credentials` below still
    // wins — see the spread-order note in `aws-client-defaults.ts`. It returns
    // `{}` unless a proxy variable is set, so the unproxied path is unchanged.
    return {
      ...awsClientDefaults({ profile: this.config.profile }),
      ...(this.config.region && { region: this.config.region }),
      ...(this.config.profile && { profile: this.config.profile }),
      ...(this.config.credentials && { credentials: this.config.credentials }),
    };
  }

  /**
   * The region this instance was EXPLICITLY configured with, or `undefined`.
   *
   * Deliberately reads only `config.region` and consults NO environment
   * variable, which is the opposite of what an earlier revision did and the
   * difference matters (issue #1957). An env read here is not merely
   * incomplete, it is UNSTABLE in the one direction that is dangerous: the SDK
   * memoizes a region-less client's region at its first resolution
   * (`@smithy/node-config-provider`'s `loadConfig` wraps the provider chain in
   * `memoize`), while `deploy.ts`'s `switchRegion` keeps mutating
   * `process.env.AWS_REGION` per stack and restores it in each stack's
   * `finally`. So an env-derived answer can report region X for a client that
   * long ago pinned itself to region P — letting a caller conclude "these
   * clients already point at my region" and use the WRONG ones, which is worse
   * than not knowing.
   *
   * When this returns `undefined` the region is not merely unknown to us, it is
   * NOT YET DECIDED — and that is the important part. {@link clientOptions}
   * omits `region` entirely in that case, so each service client resolves and
   * MEMOIZES its own region independently, at its own first construction, from
   * an environment `deploy.ts`'s `switchRegion` is actively mutating. The
   * members of one region-less bag can therefore disagree with each other:
   * `ssm` can pin `us-west-2` and `secretsManager` pin `us-east-1` a moment
   * later, because the getters are lazy and each samples a different instant.
   *
   * So there is deliberately NO method here that reports "the region of these
   * clients" for an unconfigured instance. An earlier revision had one — it
   * asked `this.ssm.config.region()` — and it was unsound for exactly this
   * reason: it measured ONE member of a bag whose members need not agree, and
   * the caller then reused the whole bag on the strength of it. A caller that
   * needs a region it can rely on must build a CONFIGURED bag
   * ({@link withRegion} always sets `region`, so every member of a derived bag
   * agrees by construction).
   */
  get configuredRegion(): string | undefined {
    return this.config.region || undefined;
  }

  /**
   * The CREDENTIAL half of this instance's configuration — `profile` plus any
   * explicitly supplied `credentials` — deliberately WITHOUT `region`.
   *
   * This is the half that must survive a region override. Note what it is and
   * is NOT worth: `--profile` ALSO reaches a freshly constructed client through
   * the environment, because `src/cli/program.ts` sets `process.env.AWS_PROFILE`
   * in a `preAction` hook for every command — so carrying `profile` here is
   * belt-and-braces rather than the thing standing between a user and the wrong
   * account. What genuinely has no environment path is an explicit
   * `credentials` object: nothing exports it, so a sibling built without it
   * falls back to the default chain. The same is true of any library caller
   * that constructs `AwsClients` directly and therefore never runs the CLI's
   * `preAction` hook. `--role-arn` needs nothing carried at all —
   * `applyRoleArnIfSet` exports `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
   * `AWS_SESSION_TOKEN` into the process environment.
   *
   * The `credentials` object is CLONED rather than aliased: the returned bag is
   * handed to every derived sibling, and sharing one mutable object would let a
   * caller reach through it and rewrite the ambient instance's credentials.
   */
  get credentialConfig(): Omit<AwsClientConfig, 'region'> {
    return {
      ...(this.config.profile && { profile: this.config.profile }),
      ...(this.config.credentials && { credentials: { ...this.config.credentials } }),
    };
  }

  /**
   * Derive a sibling bound to `region`, carrying this instance's credential
   * configuration (see {@link credentialConfig}) and overriding ONLY the region.
   *
   * Used by {@link IntrinsicFunctionResolver} to pin a dynamic-reference lookup
   * (`{{resolve:secretsmanager:...}}` / `{{resolve:ssm:...}}`) to the stack's own
   * region instead of whichever region the process-global singleton happens to
   * hold at that moment (issue #1957). The returned instance owns its own lazily
   * constructed clients and its own `destroy()`; it is NOT registered as the
   * global, so nothing else in the process can observe it.
   */
  withRegion(region: string): AwsClients {
    return new AwsClients({ ...this.credentialConfig, region });
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
   * Get Redshift client
   */
  getRedshiftClient(): RedshiftClient {
    if (!this.redshiftClient) {
      this.redshiftClient = new RedshiftClient({
        ...this.clientOptions,
      });
    }
    return this.redshiftClient;
  }

  /**
   * Convenience getter for Redshift client
   */
  get redshift(): RedshiftClient {
    return this.getRedshiftClient();
  }

  /**
   * Get ElastiCache client
   */
  getElastiCacheClient(): ElastiCacheClient {
    if (!this.elastiCacheClient) {
      this.elastiCacheClient = new ElastiCacheClient({
        ...this.clientOptions,
      });
    }
    return this.elastiCacheClient;
  }

  /**
   * Convenience getter for ElastiCache client
   */
  get elastiCache(): ElastiCacheClient {
    return this.getElastiCacheClient();
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
    this.redshiftClient?.destroy();
    this.elastiCacheClient?.destroy();
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
