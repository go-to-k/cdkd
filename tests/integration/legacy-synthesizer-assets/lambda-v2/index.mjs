import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

// Version marker: proves which code asset is live.
const MARKER = 'cdkd-legacy-synth-code-v2';
const s3 = new S3Client({});

export const handler = async () => {
  const url = new URL(process.env.DATA_URL);
  const object = await s3.send(
    new GetObjectCommand({ Bucket: url.hostname, Key: url.pathname.slice(1) })
  );
  const data = (await object.Body.transformToString()).trim();
  return { marker: MARKER, dataUrl: process.env.DATA_URL, data };
};
