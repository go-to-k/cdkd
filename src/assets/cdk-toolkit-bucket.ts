import { AssetError } from '../utils/error-handler.js';
import { displaySafe } from '../utils/display-safe.js';
import { ambientClientDefaults } from '../utils/ambient-client-defaults.js';
import { cdkdRemedy, proseQuoted } from '../utils/pasteable-command.js';

/**
 * The toolkit stack does not exist or has no `BucketName` output — the one
 * lookup failure a caller may fall back from. Every other failure (access
 * denied, throttling) is a plain `AssetError` and must not be read as "no
 * toolkit stack".
 */
export class CdkToolkitBucketMissingError extends AssetError {
  constructor(message: string) {
    super(message);
    this.name = 'CdkToolkitBucketMissingError';
    Object.setPrototypeOf(this, CdkToolkitBucketMissingError.prototype);
  }
}

/** CDK CLI `DEFAULT_TOOLKIT_STACK_NAME`. */
export const CDK_TOOLKIT_STACK_NAME = 'CDKToolkit';

/**
 * The CDK bootstrap bucket the CDK CLI publishes legacy file assets to: the
 * toolkit stack's `BucketName` output. Read from CloudFormation because a
 * legacy stack names no bucket (unlike a modern manifest), and the output is
 * right for a custom qualifier and a custom `--toolkit-bucket-name` alike.
 */
export async function lookupCdkToolkitBucket(region: string, accountId: string): Promise<string> {
  const { CloudFormationClient, DescribeStacksCommand } =
    await import('@aws-sdk/client-cloudformation');
  const client = new CloudFormationClient({ ...ambientClientDefaults(), region });
  const remedy =
    `Run ${proseQuoted(`cdk bootstrap aws://${accountId}/${region}`)}, or ` +
    `${proseQuoted(cdkdRemedy('cdkd bootstrap'))} to publish them to cdkd-owned asset storage instead.`;
  try {
    let bucket: string | undefined;
    try {
      const response = await client.send(
        new DescribeStacksCommand({ StackName: CDK_TOOLKIT_STACK_NAME })
      );
      bucket = response.Stacks?.[0]?.Outputs?.find(
        (o) => o.OutputKey === 'BucketName'
      )?.OutputValue;
    } catch (error) {
      const message = (error as { message?: string }).message ?? '';
      if (!/does not exist/.test(message)) {
        throw new AssetError(
          `Could not read the ${CDK_TOOLKIT_STACK_NAME} stack in ${displaySafe(region)} to find ` +
            `the asset bucket for LegacyStackSynthesizer assets: ${displaySafe(message)}`,
          error instanceof Error ? error : undefined
        );
      }
    }
    if (!bucket) {
      throw new CdkToolkitBucketMissingError(
        `This stack uses LegacyStackSynthesizer assets, so it needs the ${CDK_TOOLKIT_STACK_NAME} ` +
          `stack's asset bucket in ${displaySafe(region)}, and none was found. ${remedy}`
      );
    }
    return bucket;
  } finally {
    client.destroy();
  }
}
