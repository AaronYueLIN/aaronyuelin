/**
 * Client-side fallback renderer: <div data-page-slug="about"></div> plus
 * <script type="module" src="/page-kit/mount.js"></script> fetches the
 * published JSON from /api/pages/<slug> and renders it in place.
 * Also exported for programmatic use: mountPage(element, pageJson).
 */
import { renderPage } from './render.js';

export function mountPage(element, page) {
  element.innerHTML = renderPage(page);
  return element;
}

for (const element of document.querySelectorAll('[data-page-slug]')) {
  const slug = element.dataset.pageSlug;
  fetch(`/api/pages/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => { if (payload?.page) mountPage(element, payload.page); })
    .catch(() => { /* keep whatever static markup is already there */ });
}
