/** Path slug compatible with gbrain's markdown slugify for ASCII names. */

export function slugifySegment(segment: string): string {
  return segment
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `Hello World.md` -> `hello-world`. Directories stay. `.md` is stripped. */
export function slugFromRelative(relativePosix: string): string {
  const without = relativePosix.replace(/\\/g, '/').replace(/\.md$/i, '');
  return without.split('/').map(slugifySegment).filter(Boolean).join('/');
}
