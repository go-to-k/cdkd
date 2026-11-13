import { awsEndpointOverrideActive } from '../utils/aws-client-defaults.js';
import { displayIdent } from '../utils/display-safe.js';
import { AssetError } from '../utils/error-handler.js';

/**
 * Refuse a Docker image asset under `--aws-emulator` (go-to-k/cdkd#6138),
 * BEFORE any build or push. Up to AWS Emulator 1.0.322, ECR handed out a
 * repository URI on the real `<account>.dkr.ecr.<region>.amazonaws.com` host,
 * so a push would leave this machine for real AWS — the one thing the flag
 * rules out. From 1.0.338 the URI is local (`127.0.0.1:<port>/<repo>`), but
 * the emulator's registry refuses the push itself (blob upload and manifest
 * PUT answer 405, aws/aws-emulator#250). Lift this once a fixed emulator
 * accepts pushes (go-to-k/cdk-local#936). No-op without the flag.
 */
export function refuseDockerAssetUnderAwsEmulator(assetName: string): void {
  if (!awsEndpointOverrideActive()) return;
  throw new AssetError(
    `--aws-emulator: Docker image asset ${displayIdent(assetName)} cannot be published to ` +
      'AWS Emulator: its ECR registry does not accept image pushes yet (and before 1.0.338 its ' +
      'repository URI named the real amazonaws.com registry, so a push would reach real AWS). ' +
      'Docker image assets (container Lambda functions, ECS ' +
      'task images) are not supported under --aws-emulator; deploy only stacks without them.'
  );
}
