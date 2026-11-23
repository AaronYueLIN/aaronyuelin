/**
 * Runtime texture infrastructure: tier choice, deferred GLB loading, sampling.
 *
 * The build writes `/assets/glb/<name>.<tier>.<sha256-prefix>.glb` and embeds
 * a small JSON manifest in index.html. That manifest is the only place the
 * runtime learns the hashed URLs; nothing here guesses a filename.
 *
 * Rules this module enforces:
 *   • canvas DPR is capped at 2 (same ceiling as the reference site), never
 *     lowered to hide texture cost;
 *   • the 4K tier is used on capable desktop displays, the derived 2K tier on
 *     phones / low-memory / save-data / small-GPU devices;
 *   • a failed load is logged and rethrown — there is no fake ball, no blank
 *     texture and no placeholder geometry;
 *   • the room loads before the ball, so a large ball GLB cannot delay the
 *     first room frame.
 */

import * as THREE from './three.js?v=2026.11.23-r10';
import { fetchTransport, legacyTransport } from './glb-transport.js?v=2026.11.23-r10';

export const DPR_CAP = 2;
const MANIFEST_ID = 'texture-manifest';
const DEFAULT_TIMEOUT = 60_000;

const state = {
  manifest: null,
  tier: null,
  reason: '',
  facts: null,
  tiers: null,
  loads: [],
  errors: [],
  sampling: null,
};

if (typeof window !== 'undefined') globalThis.__textureInfra = state;

/** Read the inline build manifest once. */
function readManifest() {
  if (state.manifest) return state.manifest;
  if (typeof document === 'undefined') return null;
  const element = document.getElementById(MANIFEST_ID);
  if (!element) return null;
  try {
    state.manifest = JSON.parse(element.textContent || '{}');
  } catch (error) {
    state.errors.push({ label: 'manifest', message: String(error?.message ?? error) });
    console.error('[texture-infra] inline manifest is not valid JSON', error);
    state.manifest = null;
  }
  return state.manifest;
}

function deviceFacts(renderer) {
  const navigatorRef = globalThis.navigator ?? {};
  const connection = navigatorRef.connection ?? {};
  return {
    dpr: Math.min(Number(globalThis.devicePixelRatio) || 1, DPR_CAP),
    deviceMemory: Number(navigatorRef.deviceMemory) || 0,
    hardwareConcurrency: Number(navigatorRef.hardwareConcurrency) || 0,
    saveData: Boolean(connection.saveData),
    effectiveType: String(connection.effectiveType || ''),
    coarsePointer: Boolean(globalThis.matchMedia?.('(pointer: coarse)')?.matches),
    maxTextureSize: Number(renderer?.capabilities?.maxTextureSize) || 0,
  };
}

/**
 * Choose a tier from the URLs the build actually shipped.
 * @param {Record<string,string>} tiers
 * @param {ReturnType<typeof deviceFacts>} facts
 */
export function selectTier(tiers, facts) {
  const has4k = Boolean(tiers?.['4k']);
  const has2k = Boolean(tiers?.['2k']);
  const hasBase = Boolean(tiers?.base);
  if (!has4k) return { tier: has2k ? '2k' : hasBase ? 'base' : null, reason: 'no authored 4K tier' };
  if (!has2k && !hasBase) return { tier: '4k', reason: 'only the authored 4K tier exists' };

  if (facts.saveData) return { tier: '2k', reason: 'Save-Data is on' };
  if (facts.maxTextureSize && facts.maxTextureSize < 4096) {
    return { tier: has2k ? '2k' : 'base', reason: `GPU max texture size ${facts.maxTextureSize}` };
  }
  if (/^(slow-)?2g$|^3g$/.test(facts.effectiveType)) {
    return { tier: has2k ? '2k' : 'base', reason: `network ${facts.effectiveType}` };
  }
  if (facts.deviceMemory && facts.deviceMemory <= 4) {
    return { tier: has2k ? '2k' : 'base', reason: `${facts.deviceMemory} GB device memory` };
  }
  if (facts.hardwareConcurrency && facts.hardwareConcurrency <= 4) {
    return { tier: has2k ? '2k' : 'base', reason: `${facts.hardwareConcurrency} logical cores` };
  }
  if (facts.coarsePointer) {
    return { tier: has2k ? '2k' : 'base', reason: 'coarse pointer (phone/tablet)' };
  }
  if (facts.dpr < 1.5) {
    return { tier: has2k ? '2k' : 'base', reason: `DPR ${facts.dpr} does not need 4K` };
  }
  if (facts.deviceMemory && facts.deviceMemory < 8) {
    return { tier: has2k ? '2k' : 'base', reason: `${facts.deviceMemory} GB device memory` };
  }
  return { tier: '4k', reason: 'capable desktop display' };
}

/**
 * Resolve one logical asset to a hashed URL and record the chosen tier.
 * `fallbackUrl` is the build-rewritten primary URL, used when the manifest is
 * absent (e.g. serving prototype/site directly).
 */
export function resolveAsset(name, fallbackUrl, renderer) {
  const manifest = readManifest();
  const tiers = manifest?.tiers?.[name] ?? null;
  if (!tiers) {
    state.tier = state.tier ?? 'fallback';
    return { url: fallbackUrl, tier: 'fallback', reason: 'no inline manifest', facts: deviceFacts(renderer), tiers: null };
  }
  const facts = deviceFacts(renderer);
  const forced = typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('tier')
    : null;
  const choice = forced && tiers[forced]
    ? { tier: forced, reason: `?tier=${forced}` }
    : selectTier(tiers, facts);
  if (!choice.tier) throw new Error(`no usable texture tier for ${name}`);
  state.tier = choice.tier;
  state.reason = choice.reason;
  state.facts = facts;
  state.tiers = tiers;
  if (typeof document !== 'undefined') document.documentElement.dataset.textureTier = choice.tier;
  return { url: tiers[choice.tier] || fallbackUrl, tier: choice.tier, reason: choice.reason, facts, tiers };
}

function describeError(error) {
  return String(error?.message ?? error);
}

async function fetchBuffer(url, { label, timeoutMs, priority, onProgress } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException(`timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'default',
      credentials: 'same-origin',
      priority: priority || 'auto',
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const total = Number(response.headers.get('content-length')) || 0;
    if (!response.body || typeof onProgress !== 'function') return await response.arrayBuffer();
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      chunks.push(chunk);
      received += chunk.byteLength;
      onProgress({ label, received, total });
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged.buffer;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch a self-contained GLB with byte progress, timeout and bounded retries,
 * then parse it with the same GLTFLoader the site already ships.
 */
export async function loadGlb(loader, url, {
  label = 'GLB',
  timeoutMs = DEFAULT_TIMEOUT,
  retries = 1,
  priority = 'auto',
  onProgress = null,
} = {}) {
  const started = performance.now();
  let buffer = null;
  let lastError = null;
  const progress = onProgress ?? (() => {
    let last = 0;
    return (event) => {
      const now = performance.now();
      if (event.received < event.total && now - last < 100) return;
      last = now;
      window.dispatchEvent(new CustomEvent('texture-progress', { detail: event }));
    };
  })();

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const key = String(url).split(/[?#]/)[0].split('/').pop();
      const transport = readManifest()?.transport?.[key] ?? legacyTransport(url);
      buffer = await fetchTransport(url, transport, fetchBuffer, { label, timeoutMs, priority, onProgress: progress });
      break;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status) || 0;
      const retryable = !status || status >= 500;
      if (!retryable || attempt >= retries) break;
      console.warn(`[texture-infra] ${label}: attempt ${attempt + 1} failed (${describeError(error)}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  if (!buffer) {
    const report = { label, url, message: describeError(lastError), at: Date.now() };
    state.errors.push(report);
    console.error(`[texture-infra] ${label} failed; no substitute will be shown:`, lastError);
    window.dispatchEvent(new CustomEvent('texture-error', { detail: report }));
    throw lastError;
  }

  const fetchedAt = performance.now();
  let gltf;
  try {
    // `url` may be a root-relative path; resolve it against the document
    // before deriving the loader's base path.
    const base = typeof location !== 'undefined'
      ? new URL('.', new URL(url, location.href)).href
      : '';
    gltf = await loader.parseAsync(buffer, base);
  } catch (error) {
    const report = { label, url, message: describeError(error), at: Date.now(), stage: 'parse' };
    state.errors.push(report);
    console.error(`[texture-infra] ${label} parsed with errors; no substitute will be shown:`, error);
    window.dispatchEvent(new CustomEvent('texture-error', { detail: report }));
    throw error;
  }

  const load = {
    label,
    url,
    bytes: buffer.byteLength,
    ms: Math.round(performance.now() - started),
    fetchMs: Math.round(fetchedAt - started),
    parseMs: Math.round(performance.now() - fetchedAt),
    attempt: Math.min(retries + 1, state.loads.filter((entry) => entry.label === label).length + 1),
  };
  state.loads.push(load);
  if (typeof document !== 'undefined') document.documentElement.dataset.textureLoaded = label;
  return { gltf, ...load };
}

/**
 * Apply crisp sampling to every PBR map on a loaded tree:
 * max anisotropy, trilinear mipmaps, and the correct colour space. This is
 * what keeps a 4K leather map sharp at grazing angles instead of blurring.
 */
export function applyTextureSampling(root, renderer) {
  const maxAnisotropy = Math.max(1, Number(renderer?.capabilities?.getMaxAnisotropy?.() || 1));
  const slots = {
    map: THREE.SRGBColorSpace,
    emissiveMap: THREE.SRGBColorSpace,
    normalMap: THREE.NoColorSpace,
    roughnessMap: THREE.NoColorSpace,
    metalnessMap: THREE.NoColorSpace,
    aoMap: THREE.NoColorSpace,
    displacementMap: THREE.NoColorSpace,
  };
  let textures = 0;
  let materials = 0;
  root?.traverse((object) => {
    if (!object.isMesh) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (!material) continue;
      materials += 1;
      for (const [slot, colorSpace] of Object.entries(slots)) {
        const texture = material[slot];
        if (!texture?.isTexture) continue;
        texture.anisotropy = maxAnisotropy;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.colorSpace = colorSpace;
        texture.needsUpdate = true;
        textures += 1;
      }
    }
  });
  state.sampling = { textures, materials, maxAnisotropy };
  return state.sampling;
}

/** Wait for the room frame to compose before starting the ball download. */
export function afterFirstPaint() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    }
    setTimeout(finish, 120);
  });
}
