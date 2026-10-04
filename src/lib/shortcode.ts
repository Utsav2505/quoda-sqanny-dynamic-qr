const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate a random base62 short code using a cryptographically secure RNG.
 * Rejection sampling keeps the distribution uniform (256 % 62 !== 0).
 */
export function genShortCode(len = 7): string {
  const out: string[] = [];
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length; // 248
  while (out.length < len) {
    const buf = new Uint8Array(len - out.length);
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= max) continue; // reject to avoid modulo bias
      out.push(ALPHABET[byte % ALPHABET.length]);
      if (out.length === len) break;
    }
  }
  return out.join("");
}

/**
 * Generate a short code guaranteed not to collide with an existing
 * qr_codes.short_code.
 *
 * The probe is a pre-flight SELECT, so it cannot be the thing that makes the
 * result correct: two creators can both find a free code and both try to insert
 * it. `short_code` is UNIQUE, so the loser's INSERT raises SQLITE_CONSTRAINT —
 * which used to escape as an unhandled 500 on the last step of the claim wizard.
 *
 * So uniqueness is enforced by the database and this function is the retry loop
 * around it: try, and on a constraint violation draw again. The caller gets a
 * free code or an exhausted-attempts error, never a collision.
 */
export async function ensureUniqueShortCode(
  db: D1Database,
  len = 7,
  insert?: (code: string) => Promise<void>,
): Promise<string> {
  const maxAttempts = 1000;
  for (let i = 0; i < maxAttempts; i++) {
    const code = genShortCode(len);
    if (insert) {
      try {
        await insert(code);
        return code;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        continue;
      }
    }

    const existing = await db
      .prepare("SELECT 1 FROM qr_codes WHERE short_code = ? LIMIT 1")
      .bind(code)
      .first<{ 1: number }>();
    if (!existing) return code;
  }
  throw new Error("ensureUniqueShortCode: exhausted attempts finding a free code");
}

/**
 * Whether an error is a UNIQUE/PK constraint failure.
 *
 * Matched on the message rather than a typed error, because D1 surfaces the
 * SQLite code as text on the error and there is no exported error class to
 * instanceof against. The pattern is narrow enough that an unrelated failure
 * will not be mistaken for a collision and silently retried.
 */
function isUniqueViolation(err: unknown): boolean {
  const message =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(message);
}
