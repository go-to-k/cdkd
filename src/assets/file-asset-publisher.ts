import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { FileAsset } from '../types/assets.js';
import { resolveFileAssetSourcePath } from './asset-manifest-loader.js';
import { displaySafe } from '../utils/display-safe.js';
import { getLogger } from '../utils/logger.js';
import { awsClientDefaults } from '../utils/aws-client-defaults.js';

/**
 * Publishes file assets to S3
 *
 * Handles:
 * - Placeholder resolution (${AWS::AccountId}, ${AWS::Region})
 * - Existence check (skip if already uploaded)
 * - ZIP packaging for directory assets
 * - Direct file upload for single files
 */
export class FileAssetPublisher {
  private logger = getLogger().child('FileAssetPublisher');

  /**
   * Publish a file asset to S3
   *
   * @param assetHash Asset hash (ID)
   * @param asset File asset definition
   * @param cdkOutputDir CDK output directory (cdk.out)
   * @param accountId AWS account ID
   * @param region AWS region
   *
   * There is deliberately NO `profile` parameter. It was unused, and being
   * OPTIONAL and last it let a pre-go-to-k/cdkd#3532 call
   * `(…, accountId, region, profile)` keep compiling with the profile NAME
   * bound to `assetOutdir` — the required bound catches a DROP, not a SWAP,
   * so the parameter that made the swap expressible is gone instead.
   */
  async publish(
    assetHash: string,
    asset: FileAsset,
    cdkOutputDir: string,
    accountId: string,
    region: string,
    /**
     * The app's outdir; see `resolveFileAssetSourcePath` (go-to-k/cdkd#3489).
     *
     * REQUIRED, and positioned BEFORE the optional `_profile` so omitting it
     * is a type error. `FileAssetNodeData.assetOutdir` is itself required, so
     * the production caller cannot drop it — but leaving this entry point
     * optional kept the drop expressible one layer out, which is the exact
     * defect the resolver's own required parameter was made to stop.
     */
    assetOutdir: string
  ): Promise<void> {
    // Containment FIRST, before any S3 client exists and before the
    // already-exists short-circuit below (issue go-to-k/cdkd#3489). Two
    // reasons it cannot sit next to the upload it guards: `objectExists`
    // sends a signed HeadObject to a bucket the SAME hostile manifest names,
    // so a check below it leaks one authenticated request to the attacker's
    // bucket; and that check `continue`s on a hit, which skipped the
    // containment check ENTIRELY whenever the object already existed, making
    // the refusal depend on remote state.
    // The SINK clause names where the bytes actually go. `publish` is the one
    // caller of this resolver that uploads, and it is the one that knows the
    // destinations — which the manifest chose, so naming them is the point:
    // "cdkd will upload it" tells the user nothing they can act on, while
    // "to s3://<bucket>/<key>" is the bucket they can recognise as not theirs.
    const destinations = Object.values(asset.destinations)
      .map(
        (d) =>
          `s3://${this.resolvePlaceholders(d.bucketName, accountId, region)}/` +
          `${this.resolvePlaceholders(d.objectKey, accountId, region)}`
      )
      .map((u) => displaySafe(u));
    const sourcePath = resolveFileAssetSourcePath(
      cdkOutputDir,
      asset,
      assetOutdir,
      // A manifest may write `destinations: {}`, and then nothing is uploaded
      // at all — "upload it to " with nothing after it would be worse than
      // the generic clause.
      destinations.length > 0
        ? `package that path and upload it to ${destinations.join(', ')}`
        : 'package that path, though this manifest names no destination for it'
    );

    // Process each destination
    for (const [, dest] of Object.entries(asset.destinations)) {
      const bucketName = this.resolvePlaceholders(dest.bucketName, accountId, region);
      const objectKey = this.resolvePlaceholders(dest.objectKey, accountId, region);
      const destRegion = dest.region
        ? this.resolvePlaceholders(dest.region, accountId, region)
        : region;

      this.logger.debug(
        `Publishing file asset ${asset.displayName || assetHash} → s3://${bucketName}/${objectKey}`
      );

      const client = new S3Client({ ...awsClientDefaults(), region: destRegion });

      try {
        // Check if already exists
        if (await this.objectExists(client, bucketName, objectKey)) {
          this.logger.debug(`Asset already exists, skipping: s3://${bucketName}/${objectKey}`);
          continue;
        }

        if (asset.source.packaging === 'zip') {
          // ZIP packaging: create zip archive and upload
          await this.uploadZip(client, sourcePath, bucketName, objectKey);
        } else {
          // Direct file upload
          await this.uploadFile(client, sourcePath, bucketName, objectKey);
        }

        this.logger.debug(`✅ Published: s3://${bucketName}/${objectKey}`);
      } finally {
        client.destroy();
      }
    }
  }

  /**
   * Check if an S3 object exists
   */
  private async objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      const err = error as {
        name?: string;
        message?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      // Provide helpful error for common issues
      const statusCode = err.$metadata?.httpStatusCode;
      if (statusCode === 301 || err.name === 'PermanentRedirect') {
        throw new Error(
          `S3 bucket '${bucket}' is in a different region. ` +
            `Use --region to specify the correct region, or check asset manifest destination.`
        );
      }
      throw new Error(
        `Failed to check S3 object s3://${bucket}/${key}: ${err.name || 'UnknownError'}: ${err.message || String(error)}`
      );
    }
  }

  /**
   * Upload a single file to S3
   */
  private async uploadFile(
    client: S3Client,
    filePath: string,
    bucket: string,
    key: string
  ): Promise<void> {
    const stat = statSync(filePath);
    const stream = createReadStream(filePath);

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: stream,
        ContentLength: stat.size,
      })
    );
  }

  /**
   * Create ZIP archive and upload to S3
   */
  private async uploadZip(
    client: S3Client,
    dirPath: string,
    bucket: string,
    key: string
  ): Promise<void> {
    // archiver v8 is native ESM and dropped the `archiver(format, options)`
    // factory: the per-format archives are classes now, so the entry point
    // exposes no default export to call.
    const { ZipArchive } = await import('archiver');

    // Collect all archive data into a buffer before uploading
    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const archive = new ZipArchive({ zlib: { level: 9 } });

      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      // Check if dirPath is a file or directory
      const stat = statSync(dirPath);
      if (stat.isDirectory()) {
        archive.directory(dirPath, false);
      } else {
        archive.file(dirPath, { name: basename(dirPath) });
      }

      // `finalize()` rejects on a module error, and `_onModuleError` ALSO
      // emits 'error'. Discarding the promise left that rejection unhandled
      // even though the outer promise was already settling.
      archive.finalize().catch(reject);
    });

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
      })
    );
  }

  /**
   * Replace placeholders in destination values
   */
  private resolvePlaceholders(
    value: string,
    accountId: string,
    region: string,
    partition = 'aws'
  ): string {
    return value
      .replace(/\$\{AWS::AccountId\}/g, accountId)
      .replace(/\$\{AWS::Region\}/g, region)
      .replace(/\$\{AWS::Partition\}/g, partition);
  }
}
