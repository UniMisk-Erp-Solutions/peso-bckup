/**
 * Truncate a filename for mobile display while preserving the file extension.
 * Full filename is always available via the title attribute of the element.
 *
 * @param filename  Original filename, e.g. "Screenshot_20260702_Chrome.jpg"
 * @param maxBaseChars  Maximum length of the base name (before extension)
 * @returns Truncated display string, e.g. "Screenshot_20260702_…Chrome.jpg"
 */
export function truncateFilenameForMobile(filename: string, maxBaseChars: number): string {
  const lastDot = filename.lastIndexOf(".");
  const base = lastDot !== -1 ? filename.slice(0, lastDot) : filename;
  const ext = lastDot !== -1 ? filename.slice(lastDot) : "";
  if (base.length <= maxBaseChars) return filename;
  return `${base.slice(0, maxBaseChars)}…${ext}`;
}
