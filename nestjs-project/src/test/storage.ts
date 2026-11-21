import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

const bucket = process.env.STORAGE_BUCKET ?? 'streamtube';

const client = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
  region: process.env.STORAGE_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY ?? 'streamtube',
    secretAccessKey: process.env.STORAGE_SECRET_KEY ?? 'streamtube-secret',
  },
});

export async function cleanStorage(prefix: string): Promise<void> {
  const uploads = await client.send(
    new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }),
  );
  for (const upload of uploads.Uploads ?? []) {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.Key,
        UploadId: upload.UploadId,
      }),
    );
  }

  const objects = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
  );
  if (objects.Contents?.length) {
    const { Errors } = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
      }),
    );
    if (Errors?.length) {
      const keys = Errors.map(({ Key }) => Key).join(', ');
      throw new Error(`Could not delete test objects: ${keys}`);
    }
  }
}
