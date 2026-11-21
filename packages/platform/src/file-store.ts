import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Durable storage for files exchanged with partners (eligibility feeds, batch files, exports).
 * Locally it is a directory; in Azure the same interface is backed by Blob Storage with immutability.
 * Files are hashed while they are written, so a file is identified by its SHA-256 without a second read.
 */
export interface StoredFile {
  key: string;
  sizeBytes: number;
  sha256: string;
}

export interface FileStore {
  put(key: string, body: Readable, maxBytes: number): Promise<StoredFile>;
  read(key: string): Readable;
  remove(key: string): Promise<void>;
}

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,250}$/;

export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The file is larger than ${maxBytes} bytes`);
    this.name = 'FileTooLargeError';
  }
}

export class LocalFileStore implements FileStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!KEY.test(key) || key.includes('..')) throw new Error(`Invalid storage key: ${key}`);
    const full = resolve(join(this.root, ...key.split('/')));
    if (!full.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  }

  async put(key: string, body: Readable, maxBytes: number): Promise<StoredFile> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}.${randomUUID()}.partial`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) return done(new FileTooLargeError(maxBytes));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(partial, { flags: 'wx' }));
      await rename(partial, target);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    return { key, sizeBytes: (await stat(target)).size, sha256: hash.digest('hex') };
  }

  read(key: string): Readable {
    return createReadStream(this.path(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
