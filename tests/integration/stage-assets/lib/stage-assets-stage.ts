import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A stack whose assets are declared INSIDE a `cdk.Stage`.
 *
 * `cdk synth` stages every asset into the APP's output directory, while a
 * Stage's own asset manifest is written to `cdk.out/assembly-<Stage>/`. So
 * upstream emits `source.path` / `source.directory` of `../asset.<hash>` for
 * a Stage — a shape NO other fixture in this repo produces, and the one that
 * broke when cdkd's assembly-path containment check (issue
 * [#3489](https://github.com/go-to-k/cdkd/issues/3489)) measured containment
 * against the manifest's own directory instead of the app's outdir.
 *
 * Both asset kinds are present because each takes a different publisher:
 * the ZIP Lambda goes through `FileAssetPublisher` (`source.path`) and the
 * container Lambda through `DockerAssetPublisher` (`source.directory`). A
 * regression in either base refuses the deploy outright with a
 * "hand-modified assembly" message, so simply deploying is the assertion;
 * the markers below prove the right bytes were published and wired.
 */
export class StageAssetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // FILE asset -> FileAssetPublisher, manifest `source.path: "../asset.<hash>"`
    const zipFn = new lambda.Function(this, 'ZipFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda-src')),
      timeout: cdk.Duration.seconds(30),
    });

    // DOCKER asset -> DockerAssetPublisher, manifest `source.directory: "../asset.<hash>"`
    //
    // PIN the build platform AND the Lambda architecture, and keep them
    // MATCHING, for the same reason `tests/integration/docker-image-asset/`
    // does: with no `platform:` CDK emits no `source.platform`, and cdkd then
    // builds for the HOST architecture. On an arm64 host that pushes an arm64
    // image to a Lambda that defaults to x86_64, which fails at invoke with
    // `Runtime.InvalidEntrypoint: ProcessSpawnFailed` — so Phase 2's marker
    // never appears and this fixture reports a containment failure it did not
    // have. `public.ecr.aws/lambda/nodejs:20` is multi-arch.
    const image = new ecr_assets.DockerImageAsset(this, 'Img', {
      directory: path.join(__dirname, '..', 'docker'),
      platform: ecr_assets.Platform.LINUX_ARM64,
    });
    const imageFn = new lambda.DockerImageFunction(this, 'ImageFn', {
      code: lambda.DockerImageCode.fromEcr(image.repository, { tagOrDigest: image.imageTag }),
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
    });

    new cdk.CfnOutput(this, 'ZipFnName', { value: zipFn.functionName });
    new cdk.CfnOutput(this, 'ImageFnName', { value: imageFn.functionName });
  }
}

/** The Stage wrapper — this is what makes the asset paths relative-upward. */
export class StageAssetsStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props?: cdk.StageProps) {
    super(scope, id, props);
    new StageAssetsStack(this, 'Stack');
  }
}
