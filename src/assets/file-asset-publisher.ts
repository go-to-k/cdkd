import { createReadStream, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { FileAsset } from '../types/assets.js';
import { getLogger } from '../utils/logger.js';

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
   * @param profile AWS profile (optional)
   */
  async publish(
    assetHash: string,
    asset: FileAsset,
    cdkOutputDir: string,
    accountId: string,
    region: string,
    _profile?: string
  ): Promise<void> {
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

      const client = new S3Client({
        region: destRegion,
      });

      try {
        // Check if already exists
        if (await this.objectExists(client, bucketName, objectKey)) {
          this.logger.debug(`Asset already exists, skipping: s3://${bucketName}/${objectKey}`);
          continue;
        }

        // Determine source path
        const sourcePath = join(cdkOutputDir, asset.source.path);

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
    // Dynamic import archiver (dev dependency)
    const archiver = await import('archiver');
    const { PassThrough } = await import('node:stream');

    const passThrough = new PassThrough();
    const chunks: Buffer[] = [];

    // Collect archive data into buffer
    passThrough.on('data', (chunk: Buffer) => chunks.push(chunk));

    const archive = archiver.default('zip', { zlib: { level: 9 } });
    archive.pipe(passThrough);

    // Check if dirPath is a file or directory
    const stat = statSync(dirPath);
    if (stat.isDirectory()) {
      archive.directory(dirPath, false);
    } else {
      archive.file(dirPath, { name: basename(dirPath) });
    }

    await archive.finalize();

    // Wait for all data to be collected
    await new Promise<void>((resolve, reject) => {
      passThrough.on('end', resolve);
      passThrough.on('error', reject);
    });

    const body = Buffer.concat(chunks);

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
