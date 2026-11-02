import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 2 ** 16;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, length: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const maxmem = 128 * n * r * 2;
    scrypt(password, salt, length, { N: n, r, p, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Parameters live in the stored string, so they can be raised without invalidating old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await derive(
    password,
    Buffer.from(salt, 'base64url'),
    Number(n),
    Number(r),
    Number(p),
    expected.length,
  );
  return timingSafeEqual(actual, expected);
}

/** Verified against when the email is unknown, so login timing does not reveal which emails exist. */
export const DUMMY_HASH = await hashPassword(randomBytes(32).toString('hex'));
