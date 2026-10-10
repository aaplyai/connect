import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** A new id: a type prefix and 128 random bits in base32, never sequential (`conn_…`, `inst_…`). */
export function newId(prefix: string): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return `${prefix}_${out}`;
}
