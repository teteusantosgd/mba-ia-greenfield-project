import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  NoSuchUpload,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { InvalidPartsError, UploadNotFoundError } from './storage.errors';

// Codes S3 uses to refuse the part list of a CompleteMultipartUpload.
// EntityTooSmall: a part other than the last one is under 5 MiB.
const INVALID_PARTS_ERRORS = [
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
];

export interface StoredPart {
  partNumber: number;
  size: number;
  etag: string;
}

interface SignDownloadOptions {
  expiresIn: number;
  disposition?: string;
  // URLs read by the worker must point at the internal endpoint.
  internal?: boolean;
}

@Injectable()
export class StorageService {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    const credentials = {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    };
    this.internalClient = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials,
    });
    // Presigned URLs are bound to the host they were signed for, so the ones
    // handed to the browser need a client configured with the public host.
    this.publicClient = new S3Client({
      endpoint: config.publicEndpoint,
      region: config.region,
      forcePathStyle: true,
      credentials,
    });
    this.bucket = config.bucket;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return UploadId!;
  }

  signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    size: number,
    expiresIn: number,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: size,
    });
    return getSignedUrl(this.publicClient, command, {
      expiresIn,
      signableHeaders: new Set(['content-length']),
    });
  }

  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: string | undefined;

    try {
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber!,
            size: part.Size!,
            etag: part.ETag!,
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (error) {
      if (error instanceof NoSuchUpload) throw new UploadNotFoundError(key);
      throw error;
    }

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: StoredPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      if (error instanceof NoSuchUpload) throw new UploadNotFoundError(key);
      if (
        error instanceof S3ServiceException &&
        INVALID_PARTS_ERRORS.includes(error.name)
      ) {
        throw new InvalidPartsError(key);
      }
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async getObjectSize(key: string): Promise<number | null> {
    try {
      const { ContentLength } = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return ContentLength ?? 0;
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  signDownload(key: string, options: SignDownloadOptions): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: options.disposition,
    });
    const client = options.internal ? this.internalClient : this.publicClient;
    return getSignedUrl(client, command, { expiresIn: options.expiresIn });
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
}
