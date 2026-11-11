/**
 * Secret skips for the bot loader and the same rules the box-export helper copies.
 * Callers log counts only. Never log file contents or matched substrings.
 */

const SECRET_NAME = /(?:^|\/)(?:\.env(?:\.|$)|auth\.json$|id_rsa|[^/]*token[^/]*|[^/]*secret[^/]*|[^/]*credential[^/]*|[^/]*\.pem$|[^/]*\.key$)/i;

const SECRET_CONTENT = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bghp_[A-Za-z0-9]{16,}/,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}/,
];

export function isSecretFileName(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  return SECRET_NAME.test(base);
}

export function contentHasSecret(text: string): boolean {
  return SECRET_CONTENT.some((pattern) => pattern.test(text));
}

/** Strip secret-shaped substrings before anything is written to a log. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_CONTENT) out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'), '[redacted]');
  return out;
}
