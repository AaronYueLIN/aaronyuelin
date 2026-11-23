/** Lossless GLB transport only. No geometry, texture, tier or render changes.
 * The inline release manifest lists exact raw / gzip chunk URLs and lengths.
 * Use at most two concurrent chunks; parse the original bytes only after all
 * chunks have succeeded. Browsers without native gzip retain the raw path.
 */
// Keep old documents compatible during a rolling release. These are the
// already-published raw chunk layouts, not a lower-resolution substitute.
const LEGACY_BYTES = {
  'football.4k.b022e4b93a8701be.glb': 69412728,
  'football.2k.f1c81dd2887afb1d.glb': 40270300,
  'room-goal.4k.3988b0da4c17eaf0.glb': 33070672,
};
export function legacyTransport(url) {
  const rawUrl = String(url).split(/[?#]/)[0];
  const bytes = LEGACY_BYTES[rawUrl.split('/').pop()];
  if (!bytes) return null;
  const size = 24 * 1024 * 1024;
  return { bytes, raw: Array.from({ length: Math.ceil(bytes / size) }, (_, i) => ({
    url: `${rawUrl}.part${String(i).padStart(2, '0')}`,
    bytes: Math.min(size, bytes - i * size),
    decodedBytes: Math.min(size, bytes - i * size),
  })) };
}

export function supportsGzip() {
  try { return typeof DecompressionStream === 'function' && Boolean(new DecompressionStream('gzip')); }
  catch { return false; }
}

export async function fetchTransport(url, transport, fetchBuffer, options = {}, gzipAvailable = supportsGzip()) {
  if (!transport) return fetchBuffer(url, options);
  const compressed = gzipAvailable && transport.gzip?.length > 0;
  const parts = compressed ? transport.gzip : transport.raw;
  if (!Array.isArray(parts) || !parts.length) throw new Error('GLB transport has no parts');
  const total = parts.reduce((n, part) => n + part.bytes, 0);
  const progress = new Array(parts.length).fill(0);
  const output = new Array(parts.length);
  let next = 0;
  let failure = null;
  async function worker() {
    while (!failure) {
      const i = next++;
      if (i >= parts.length) return;
      const part = parts[i];
      try {
        const bytes = await fetchBuffer(part.url, {
          ...options,
          onProgress(event) {
            progress[i] = event.received;
            options.onProgress?.({ label: options.label, received: progress.reduce((a, b) => a + b, 0), total });
          },
        });
        if (bytes.byteLength !== part.bytes) throw new Error(`GLB transport size mismatch: ${part.url}`);
        const decoded = compressed
          ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
          : bytes;
        if (decoded.byteLength !== part.decodedBytes) throw new Error(`GLB decoded size mismatch: ${part.url}`);
        output[i] = new Uint8Array(decoded);
        progress[i] = part.bytes;
        options.onProgress?.({ label: options.label, received: progress.reduce((a, b) => a + b, 0), total });
      } catch (error) { failure ??= error; }
    }
  }
  // allSettled semantics: do not retry while a previous attempt is in flight.
  await Promise.all(Array.from({ length: Math.min(2, parts.length) }, worker));
  if (failure) throw failure;
  const length = output.reduce((n, bytes) => n + bytes.byteLength, 0);
  if (length !== transport.bytes) throw new Error('GLB reconstructed size mismatch');
  const merged = new Uint8Array(length);
  let offset = 0;
  for (let i = 0; i < output.length; i++) {
    merged.set(output[i], offset);
    offset += output[i].byteLength;
    output[i] = null;
  }
  return merged.buffer;
}
