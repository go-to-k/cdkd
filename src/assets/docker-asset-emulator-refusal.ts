import { awsEndpointOverrideActive } from '../utils/aws-client-defaults.js';
import { displayIdent } from '../utils/display-safe.js';
import { AssetError } from '../utils/error-handler.js';

/**
 * Refuse a Docker image asset under `--aws-emulator` (go-to-k/cdkd#6138),
 * BEFORE any build or push. ECR on AWS Emulator hands out a repository URI
 * on the real `<account>.dkr.ecr.<region>.amazonaws.com` host while serving
 * the registry itself at the emulator's endpoint, behind the emulator's own
 * CA, which the Docker daemon does not trust. A push to the URI would leave
 * this machine for real AWS — the one thing the flag rules out — and a push
 * to the endpoint fails TLS verification. No-op without the flag.
 */
export function refuseDockerAssetUnderAwsEmulator(assetName: string): void {
  if (!awsEndpointOverrideActive()) return;
  throw new AssetError(
    `--aws-emulator: Docker image asset ${displayIdent(assetName)} cannot be published to ` +
      'AWS Emulator: its ECR repository URI names the real amazonaws.com registry, so a ' +
      'push would reach real AWS. Docker image assets (container Lambda functions, ECS ' +
      'task images) are not supported under --aws-emulator; deploy only stacks without them.'
  );
}
