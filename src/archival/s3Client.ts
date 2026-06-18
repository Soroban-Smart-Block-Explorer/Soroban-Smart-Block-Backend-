import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}),
});

export const ARCHIVE_BUCKET = process.env.ARCHIVE_S3_BUCKET ?? 'soroban-xdr-archive';

export async function uploadToS3(key: string, body: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: ARCHIVE_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/json',
    StorageClass: (process.env.ARCHIVE_S3_STORAGE_CLASS as any) ?? 'STANDARD_IA',
  }));
}

export async function downloadFromS3(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: ARCHIVE_BUCKET, Key: key }));
  return res.Body!.transformToString();
}
