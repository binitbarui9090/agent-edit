import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';

export const storageEnvSchema = z.object({
  S3_ENDPOINT: z.url(),
  S3_PUBLIC_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});
export type StorageEnv = z.infer<typeof storageEnvSchema>;

export interface StoredPart {
  partNumber: number;
  size: number;
  etag: string;
}

const PART_URL_TTL_SECONDS = 60 * 60;
const SIGN_WINDOW_MS = 60 * 60 * 1000;
const READ_URL_TTL_SECONDS = 3 * 60 * 60;

function isNotFound(err: unknown): boolean {
  const { name, $metadata } = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    name === 'NoSuchUpload' ||
    name === 'NoSuchKey' ||
    name === 'NotFound' ||
    $metadata?.httpStatusCode === 404
  );
}

export function originalKey(projectId: string, mediaId: string): string {
  return `originals/${projectId}/${mediaId}/source`;
}

export function derivedKey(projectId: string, mediaId: string, file: string): string {
  return `derived/${projectId}/${mediaId}/${file}`;
}

export function renderKey(projectId: string, renderId: string, file: string): string {
  return `renders/${projectId}/${renderId}/${file}`;
}

export function mediaPrefixes(projectId: string, mediaId: string): string[] {
  return [`originals/${projectId}/${mediaId}/`, `derived/${projectId}/${mediaId}/`];
}

/** Keys are always generated here, never from user input such as the file name. */
export class Storage {
  private readonly s3: S3Client;
  private readonly signer: S3Client;
  readonly bucket: string;

  constructor(env: StorageEnv) {
    const base: S3ClientConfig = {
      region: env.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
      // Default checksums add parameters to presigned URLs that browsers then fail to satisfy.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    this.bucket = env.S3_BUCKET;
    this.s3 = new S3Client({ ...base, endpoint: env.S3_ENDPOINT });
    this.signer = new S3Client({ ...base, endpoint: env.S3_PUBLIC_ENDPOINT });
  }

  async ensureBucket(allowedOrigins: string[]): Promise<void> {
    try {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
    }
    await this.s3.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: allowedOrigins,
              AllowedMethods: ['PUT', 'GET', 'HEAD'],
              AllowedHeaders: ['*'],
              // Without this the browser cannot read a part's ETag.
              ExposeHeaders: ['ETag', 'Content-Range', 'Accept-Ranges', 'Content-Length'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  }

  async ping(): Promise<void> {
    await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const { UploadId } = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!UploadId) throw new Error('Storage returned no upload id');
    return UploadId;
  }

  signPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return getSignedUrl(
      this.signer,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: PART_URL_TTL_SECONDS },
    );
  }

  /** Null means the multipart upload no longer exists: completed or aborted. */
  async listParts(key: string, uploadId: string): Promise<StoredPart[] | null> {
    const parts: StoredPart[] = [];
    let marker: string | undefined;
    try {
      do {
        const page = await this.s3.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            size: part.Size ?? 0,
            etag: part.ETag ?? '',
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    return parts;
  }

  async completeMultipart(key: string, uploadId: string, parts: StoredPart[]): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: etag })),
        },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await this.s3.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async objectSize(key: string): Promise<number | null> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return head.ContentLength ?? 0;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Signing against a floored clock keeps the URL identical within the window, so refetching the
   * media list does not defeat the browser cache and reload every thumbnail. Each URL stays valid
   * for at least two hours.
   */
  signRead(key: string, now = Date.now()): Promise<string> {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: READ_URL_TTL_SECONDS,
      signingDate: new Date(Math.floor(now / SIGN_WINDOW_MS) * SIGN_WINDOW_MS),
    });
  }

  /** A link that downloads rather than plays. The name is restricted, since it comes from a user. */
  signDownload(key: string, fileName: string): Promise<string> {
    const safe = fileName.replace(/[^\w. -]+/g, '_').slice(0, 120) || 'download';
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safe}"`,
      }),
      { expiresIn: READ_URL_TTL_SECONDS },
    );
  }

  async uploadText(key: string, body: string, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async downloadToFile(key: string, path: string, signal?: AbortSignal): Promise<void> {
    const { Body } = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      signal ? { abortSignal: signal } : {},
    );
    if (!(Body instanceof Readable)) throw new Error('Storage returned no readable body');
    await pipeline(Body, createWriteStream(path), signal ? { signal } : {});
  }

  /** Streams from disk and switches to multipart as needed, so proxy size is not a limit. */
  async uploadFile(key: string, path: string, contentType: string): Promise<number> {
    const { size } = await stat(path);
    await new Upload({
      client: this.s3,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentType: contentType,
      },
      partSize: 16 * 1024 * 1024,
      queueSize: 2,
    }).done();
    return size;
  }

  /** Removes the bucket and everything in it. Only tests call this. */
  async deleteBucket(): Promise<void> {
    await this.deletePrefix('');
    await this.s3.send(new DeleteBucketCommand({ Bucket: this.bucket }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length > 0) {
        await this.s3.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}
