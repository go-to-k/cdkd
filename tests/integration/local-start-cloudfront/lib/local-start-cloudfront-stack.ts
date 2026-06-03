import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Static-site distribution fixture for `cdkd local start-cloudfront`:
 *
 *   - An S3 bucket populated by a `BucketDeployment` of `../site`
 *     (`index.html`, `foo/index.html`, `404.html`) — the local source
 *     cdk-local resolves to serve the origin.
 *   - A `viewer-request` CloudFront Function that rewrites an extension-less
 *     path to `<path>/index.html` (e.g. `/foo` -> `/foo/index.html`) and a
 *     trailing-slash path to `<path>index.html`.
 *   - A `viewer-response` CloudFront Function that stamps an `x-cdkd-fixture`
 *     header so the integ can assert the response function ran.
 *   - `DefaultRootObject: index.html` and a `403 -> /404.html (200)` custom
 *     error response (the SPA fallback for a missing key behind an
 *     OAC-fronted private bucket).
 */
export class LocalStartCloudFrontStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'site'))],
      destinationBucket: bucket,
    });

    const rewrite = new cloudfront.Function(this, 'RewriteFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          '  var uri = request.uri;',
          "  if (uri.endsWith('/')) {",
          "    request.uri = uri + 'index.html';",
          "  } else if (!uri.split('/').pop().includes('.')) {",
          "    request.uri = uri + '/index.html';",
          '  }',
          '  return request;',
          '}',
        ].join('\n')
      ),
    });

    const stampHeader = new cloudfront.Function(this, 'StampFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var response = event.response;',
          "  response.headers['x-cdkd-fixture'] = { value: 'start-cloudfront' };",
          '  return response;',
          '}',
        ].join('\n')
      ),
    });

    new cloudfront.Distribution(this, 'SiteDist', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        functionAssociations: [
          { function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          { function: stampHeader, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
        ],
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/404.html' },
      ],
    });
  }
}
