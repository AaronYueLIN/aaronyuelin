/**
 * Page renderer: page JSON -> HTML string. Isomorphic (browser, Node,
 * Workers). The public route /p/<slug>/ and the console's live preview both
 * call this, with page-kit/page.css, so the preview is the published page.
 *
 * Page JSON (schema 1):
 *   { schema: 1, slug, title, description, updatedAt,
 *     blocks: [{ id, type: 'link' | 'image' | 'text', data }] }
 *   link  data: { url, title, description, siteName, domain, image, favicon }
 *   image data: { src, alt, caption }
 *   text  data: { html }            (sanitized again here)
 */
import { escapeHtml, sanitizeRichText, safeHref } from './sanitize.js';
import { fontStyle, isFontId } from './fonts.js';

const e = escapeHtml;

/** Only self-hosted images render on the public site (CSP img-src 'self'). */
export function safeImageSrc(src, { allowBlob = false } = {}) {
  const value = String(src ?? '').trim();
  if (/^\/(media|assets|thumbs|uploads)\/[^\s"'<>]+$/.test(value) && !value.includes('..')) return value;
  if (allowBlob && /^(blob:|data:image\/(png|jpeg|webp|gif);base64,)/.test(value)) return value;
  return '';
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function sourceBadge(data, opts) {
  const domain = data.domain || domainOf(data.url);
  const name = String(data.siteName || '').trim();
  const icon = safeImageSrc(data.favicon, opts);
  const letter = (name || domain || '?').trim().charAt(0).toUpperCase();
  const iconHtml = icon
    ? `<img class="pk-source__icon" src="${e(icon)}" alt="" width="16" height="16" loading="lazy" decoding="async">`
    : `<span class="pk-source__icon pk-source__icon--letter" aria-hidden="true">${e(letter)}</span>`;
  const label = name && name.toLowerCase() !== domain.toLowerCase()
    ? `<span class="pk-source__name">${e(name)}</span><span class="pk-source__domain">${e(domain)}</span>`
    : `<span class="pk-source__name">${e(domain || name)}</span>`;
  return `<span class="pk-source">${iconHtml}${label}</span>`;
}

export function renderLink(data = {}, opts = {}) {
  const href = /^https?:\/\//i.test(String(data.url || '')) ? safeHref(data.url) : '';
  if (!href) return opts.preview ? '<div class="pk-empty">Paste a link to make a card.</div>' : '';
  const image = safeImageSrc(data.image, opts);
  const title = String(data.title || '').trim() || domainOf(href) || href;
  const desc = String(data.description || '').trim();
  return `<a class="pk-link${image ? '' : ' pk-link--noimage'}" href="${e(href)}" target="_blank" rel="noopener noreferrer">`
    + (image ? `<span class="pk-link__media"><img src="${e(image)}" alt="" loading="lazy" decoding="async"></span>` : '')
    + '<span class="pk-link__body">'
    + `<span class="pk-link__title">${e(title)}</span>`
    + (desc ? `<span class="pk-link__desc">${e(desc)}</span>` : '')
    + sourceBadge(data, opts)
    + '</span></a>';
}

export function renderImage(data = {}, opts = {}) {
  const src = safeImageSrc(data.src, opts);
  if (!src) return opts.preview ? '<div class="pk-empty">Add an image.</div>' : '';
  const caption = String(data.caption || '').trim();
  const size = Number(data.width) > 0 && Number(data.height) > 0
    ? ` width="${Math.round(data.width)}" height="${Math.round(data.height)}"` : '';
  return `<figure class="pk-figure"><img src="${e(src)}" alt="${e(data.alt || '')}"${size} loading="lazy" decoding="async">`
    + (caption ? `<figcaption>${e(caption)}</figcaption>` : '')
    + '</figure>';
}

export function renderText(data = {}, opts = {}) {
  const html = sanitizeRichText(data.html);
  if (!html) return opts.preview ? '<div class="pk-empty">Write something.</div>' : '';
  const font = isFontId(data.font) ? ` style="${e(fontStyle(data.font))}"` : '';
  return `<div class="pk-text"${font}>${html}</div>`;
}

const RENDERERS = { link: renderLink, image: renderImage, text: renderText };

export function renderBlock(block, opts = {}) {
  const render = RENDERERS[block?.type];
  if (!render) return '';
  const inner = render(block.data || {}, opts);
  if (!inner) return '';
  const id = String(block.id || '').replace(/[^a-z0-9-]/gi, '');
  return `<section class="pk-block pk-block--${block.type}"${id ? ` data-block="${id}"` : ''}>${inner}</section>`;
}

/** The page body (header + blocks). `opts.preview` shows empty-state hints. */
export function renderPage(page = {}, opts = {}) {
  const title = String(page.title || '').trim();
  const description = String(page.description || '').trim();
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  return `<article class="pk-page" data-font="${e(isFontId(page.font) ? page.font : 'instrument')}" style="${e(fontStyle(page.font))}">`
    + ((title || description) ? '<header class="pk-head">'
      + (title ? `<h1 class="pk-title">${e(title)}</h1>` : '')
      + (description ? `<p class="pk-lede">${e(description)}</p>` : '')
      + '</header>' : '')
    + `<div class="pk-blocks">${blocks.map((block) => renderBlock(block, opts)).join('')}</div>`
    + '</article>';
}

/** A full standalone HTML document for /p/<slug>/. */
export function renderDocument(page = {}, { canonical = '', siteName = 'Aaron' } = {}) {
  const title = String(page.title || page.slug || 'Page').trim();
  const description = String(page.description || '').trim();
  return `<!doctype html>
<html lang="${e(page.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${e(title)} — ${e(siteName)}</title>
${description ? `<meta name="description" content="${e(description)}">\n` : ''}${canonical ? `<link rel="canonical" href="${e(canonical)}">\n` : ''}<meta name="color-scheme" content="light">
<meta name="theme-color" content="#ffffff">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/page-kit/page.css">
</head>
<body class="pk-body">
<main class="pk-main">
${renderPage(page)}
</main>
</body>
</html>
`;
}
