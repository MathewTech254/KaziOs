import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs/promises";
import { FileType } from "@kazios/types";

export interface StoredFile {
  key: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
  bucket: string;
  path: string;
}

export interface UploadOptions {
  filename: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  folder?: string;
}

export interface StorageProvider {
  upload(file: UploadOptions): Promise<StoredFile>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  getUrl(key: string): Promise<string>;
}

export class LocalStorageProvider implements StorageProvider {
  private basePath: string;
  private baseUrl: string;

  constructor(config: { basePath: string; baseUrl: string }) {
    this.basePath = config.basePath;
    this.baseUrl = config.baseUrl;
  }

  async upload(file: UploadOptions): Promise<StoredFile> {
    const key = `${file.folder || "uploads"}/${randomUUID()}_${file.filename}`;
    const fullPath = path.join(this.basePath, key);

    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, file.buffer);

    return {
      key,
      url: `${this.baseUrl}/files/${key}`,
      filename: file.filename,
      size: file.size,
      mimeType: file.mimeType,
      bucket: path.basename(this.basePath),
      path: key,
    };
  }

  async download(key: string): Promise<Buffer> {
    const fullPath = path.join(this.basePath, key);
    return fs.readFile(fullPath);
  }

  async delete(key: string): Promise<void> {
    const fullPath = path.join(this.basePath, key);
    await fs.unlink(fullPath).catch(() => {});
  }

  async getUrl(key: string): Promise<string> {
    return `${this.baseUrl}/files/${key}`;
  }
}

export class S3StorageProvider implements StorageProvider {
  private bucket: string;
  private baseUrl: string;
  private s3: any;

  constructor(config: { bucket: string; endpoint?: string; accessKey: string; secretKey: string; region?: string; baseUrl: string }) {
    this.bucket = config.bucket;
    this.baseUrl = config.baseUrl;
    const { S3Client } = require("@aws-sdk/client-s3");
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      region: config.region || "us-east-1",
    });
  }

  async upload(file: UploadOptions): Promise<StoredFile> {
    const key = `${file.folder || "uploads"}/${randomUUID()}_${file.filename}`;
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimeType,
      })
    );
    return {
      key,
      url: `${this.baseUrl}/${this.bucket}/${key}`,
      filename: file.filename,
      size: file.size,
      mimeType: file.mimeType,
      bucket: this.bucket,
      path: key,
    };
  }

  async download(key: string): Promise<Buffer> {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async getUrl(key: string): Promise<string> {
    return `${this.baseUrl}/${this.bucket}/${key}`;
  }
}

export function detectFileType(mimeType: string): FileType {
  if (mimeType.startsWith("image/")) return FileType.IMAGE;
  if (mimeType === "application/pdf") return FileType.PDF;
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return FileType.SPREADSHEET;
  if (mimeType.includes("presentation")) return FileType.PRESENTATION;
  if (mimeType.startsWith("text/")) return FileType.DOCUMENT;
  if (["application/zip", "application/x-tar", "application/gzip"].includes(mimeType))
    return FileType.ARCHIVE;
  if (mimeType.includes("officedocument")) return FileType.DOCUMENT;
  return FileType.OTHER;
}

export const ALLOWED_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "text/plain",
];

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
