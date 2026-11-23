/**
 * The static page is a fallback written at build time. The console stores the
 * published child in Cloudflare KV; this one public GET lets Yuet's saved
 * image, text and link appear without waiting for a rebuild. Nothing here
 * writes or reads auth.
 */
const root = document.querySelector('[data-child], .child');
const id = root?.dataset.id;
const text = document.querySelector('[data-child-text], .child__text');
const link = document.querySelector('[data-child-link], .child__media');
const image = document.querySelector('[data-child-image], .child__media img');

function showText(value) {
  if (!text) return;
  const copy = String(value || '').trim();
  text.textContent = copy;
  text.hidden = !copy;
}

function showImage(src, alt) {
  if (!image || !link) return;
  const source = String(src || '').trim();
  if (!source) {
    image.hidden = true;
    link.hidden = true;
    return;
  }
  image.src = source;
  image.alt = String(alt || '');
  image.hidden = false;
  link.hidden = false;
}

function showLink(url) {
  if (!link) return;
  const href = String(url || '').trim();
  if (/^https?:\/\//i.test(href)) link.href = href;
  else link.removeAttribute('href');
}

if (image) {
  image.addEventListener('error', () => {
    image.hidden = true;
    if (link) link.hidden = true;
  });
  image.loading = 'eager';
}

// Published workbench pages are rendered server-side by
// functions/target/[id].js. This script never calls /api (Access blocks it).
