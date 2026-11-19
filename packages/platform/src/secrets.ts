import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Envelope encryption for secrets stored in the database (for example webhook signing secrets).
 * AES-256-GCM with a key-encryption key identified by `keyId`, so keys can be rotated: old
 * ciphertexts keep their key ID and remain readable while new ones use the active key.
 * Locally the key comes from the environment; in Azure it comes from Key Vault.
 */
export class SecretBox {
  private readonly keys: Map<string, Buffer>;

  constructor(
    keys: Record<string, string>,
    private readonly activeKeyId: string,
  ) {
    this.keys = new Map(
      Object.entries(keys).map(([id, b64]) => {
        const key = Buffer.from(b64, 'base64');
        if (key.length !== 32) throw new Error(`Secret key ${id} must be 32 bytes (base64).`);
        return [id, key];
      }),
    );
    if (!this.keys.has(activeKeyId))
      throw new Error(`Active secret key ${activeKeyId} is not loaded.`);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox {
    const id = env.SECRETS_KEK_ID;
    const key = env.SECRETS_KEK;
    if (!id || !key) throw new Error('SECRETS_KEK_ID and SECRETS_KEK must be set.');
    return new SecretBox({ [id]: key }, id);
  }

  /** `aad` binds the ciphertext to its record (for example the subscription ID). */
  seal(plaintext: string, aad: string): { ciphertext: string; keyId: string } {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext: Buffer.concat([iv, tag, ct]).toString('base64'), keyId: this.activeKeyId };
  }

  open(ciphertext: string, keyId: string, aad: string): string {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`Secret key ${keyId} is not loaded.`);
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}

export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}
