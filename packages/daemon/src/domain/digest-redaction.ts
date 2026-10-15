// digest-redaction.ts — redact secrets from reducer fields that carry raw
// command or tool-result text before they are stored in session_digests.
//
// Reuses the shared transcript patterns (sk-, ghp_, Bearer, long base64) and
// adds key=value style patterns they miss. The extra patterns live here, not
// in transcript-redaction.ts, so the shared list stays byte-equivalent to the
// CLI list. Each pattern keeps the flag / variable name and replaces only the
// secret value, so the digest stays useful.

import { redactTranscriptContent } from "./transcript-redaction.js";

const REDACTED = "[REDACTED]";
const VALUE = `"[^"]*"|'[^']*'|\\S+`;

const KEY_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // --token X, --password=X, --api-key X, --client-secret X
  [new RegExp(`(--(?:[a-z]+-)*(?:token|password|passwd|api-?key|secret)(?:=|\\s+))(?:${VALUE})`, "gi"), `$1${REDACTED}`],
  // Authorization: Bearer X / Basic X / raw value (to end of line or quote)
  [/(\bAuthorization:\s*)[^\r\n"']+/gi, `$1${REDACTED}`],
  // export FOO_KEY=..., FOO_TOKEN=..., FOO_SECRET=..., PASSWORD=...
  [new RegExp(`(\\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\\s*=\\s*)(?:${VALUE})`, "g"), `$1${REDACTED}`],
  // scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]+(@)/gi, `$1${REDACTED}$2`],
];

export function redactDigestString(text: string): string {
  let out = text;
  for (const [pattern, replacement] of KEY_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return redactTranscriptContent(out);
}

/**
 * Deep-walk a JSON-like value and redact every string leaf. Keys, numbers,
 * booleans and null are returned unchanged; structure is preserved.
 */
export function redactDigestValue<T>(value: T): T {
  if (typeof value === "string") return redactDigestString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDigestValue(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDigestValue(v);
    }
    return out as T;
  }
  return value;
}
