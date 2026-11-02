const SAMPLE_BYTES = 1024 * 1024;

/**
 * Identifies a file by its content, so choosing it again after a reload finds the same upload even
 * if it was renamed. Sampling both ends keeps this instant on a multi-hour file.
 */
export async function fingerprintFile(file: File): Promise<string> {
  const head = file.slice(0, SAMPLE_BYTES);
  const tail = file.slice(Math.max(0, file.size - SAMPLE_BYTES));
  const data = await new Blob([String(file.size), head, tail]).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
