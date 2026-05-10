import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Fixture stack for `cdkd local invoke` Lambda Layers integ test
 * (PR 6 of #224, issue #232).
 *
 * One Lambda + three layers, exercising:
 *   - **Multiple distinct layers stack at /opt** — `util-counters` lives
 *     only in the `Counters` layer; the handler `require()`s it and
 *     gets back the expected output.
 *   - **AWS "last layer wins" on file collision** — `util-greetings`
 *     lives in BOTH the `GreetingsA` and `GreetingsB` layers under the
 *     same path `/opt/nodejs/node_modules/util-greetings/index.js`. The
 *     function declares `Layers: [GreetingsA, GreetingsB, Counters]`,
 *     so the GreetingsB version wins. cdkd implements this on the
 *     host: every layer is `cpSync({recursive: true, force: true})`'d
 *     into a fresh tmpdir IN ORDER — later layers overwrite earlier
 *     files — and the merged tmpdir is bind-mounted at `/opt:ro`.
 *     (Docker rejects multiple `-v ...:/opt:ro` entries at the same
 *     target — bind mounts are NOT layered the way the OCI image
 *     stack is — so we cannot rely on overlay layering here.)
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only.
 */
export class LocalInvokeLayersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const greetingsA = new lambda.LayerVersion(this, 'GreetingsA', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../layers/greetings-a')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Layer A — exports greet() that returns a from-layer-A: prefix',
    });

    const greetingsB = new lambda.LayerVersion(this, 'GreetingsB', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../layers/greetings-b')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Layer B — same path as A but returns a from-layer-B: prefix (last-wins)',
    });

    const counters = new lambda.LayerVersion(this, 'Counters', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../layers/counters')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Layer C — disjoint path; proves multi-layer stacking',
    });

    new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      // Order is load-bearing: GreetingsB declared after GreetingsA, so
      // GreetingsB wins on the shared `util-greetings` path.
      layers: [greetingsA, greetingsB, counters],
      timeout: cdk.Duration.seconds(10),
    });
  }
}
