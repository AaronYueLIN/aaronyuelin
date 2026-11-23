/**
 * Allow-list HTML sanitizer for text blocks. Runs unchanged in the browser,
 * in Node and in Cloudflare Workers (no DOM needed).
 *
 * Kept:   p h2 h3 strong em b(i→strong/em) a[href] ul ol li br blockquote
 * Dropped with content: script style iframe object embed template textarea
 *         select svg math noscript head title
 * Every other tag is removed but its text is kept. All attributes except a
 * safe href are dropped. Output is balanced.
 */

const ALLOWED = new Set(['p', 'h2', 'h3', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'br', 'blockquote']);
const RENAME = { b: 'strong', i: 'em', h1: 'h2', h4: 'h3', h5: 'h3', h6: 'h3', div: 'p' };
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'template', 'textarea', 'select',
  'svg', 'math', 'noscript', 'head', 'title', 'frame', 'frameset', 'canvas', 'video', 'audio',
]);
const VOID = new Set(['br']);
const BLOCK = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'blockquote']);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };

export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);?/gi, (match, body) => {
    const key = body.toLowerCase();
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return Object.hasOwn(NAMED, key) ? NAMED[key] : match;
  });
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** http(s), mailto, tel, same-site absolute paths and #anchors only. */
export function safeHref(raw) {
  // Strip control characters and whitespace browsers ignore inside schemes.
  const value = decodeEntities(String(raw ?? '')).replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  if (!value) return '';
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  if (/^\/(?!\/)/.test(value) || /^#[\w-]*$/.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return '';
  return '';
}

function attr(attrs, name) {
  const re = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`=<]+)))?/g;
  let match;
  while ((match = re.exec(attrs))) {
    if (match[1].toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return null;
}

export function sanitizeRichText(input, { maxLength = 40000 } = {}) {
  let html = String(input ?? '');
  if (html.length > maxLength * 2) html = html.slice(0, maxLength * 2);
  html = html.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<![^>]*>/g, '').replace(/<\?[^>]*>/g, '');

  const out = [];
  const stack = [];
  let dropping = null;
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)|(<)/g;
  let match;
  while ((match = token.exec(html))) {
    const [, closing, rawName, attrs, text, stray] = match;
    if (dropping) {
      if (rawName && closing && rawName.toLowerCase() === dropping) dropping = null;
      continue;
    }
    if (text !== undefined || stray !== undefined) {
      out.push(escapeHtml(decodeEntities(text ?? stray)));
      continue;
    }
    let name = rawName.toLowerCase();
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !/\/\s*$/.test(attrs)) dropping = name;
      continue;
    }
    name = RENAME[name] || name;
    if (!ALLOWED.has(name)) continue;
    if (closing) {
      const index = stack.lastIndexOf(name);
      if (index === -1) continue;
      while (stack.length > index) out.push(`</${stack.pop()}>`);
      continue;
    }
    if (VOID.has(name)) { out.push('<br>'); continue; }
    if (BLOCK.has(name)) {
      // Block elements cannot live inside inline ones or <p>; close those first.
      while (stack.length && !['ul', 'ol', 'blockquote', 'li'].includes(stack[stack.length - 1])) out.push(`</${stack.pop()}>`);
    }
    if (name === 'li') {
      const listIndex = Math.max(stack.lastIndexOf('ul'), stack.lastIndexOf('ol'));
      if (listIndex === -1) { name = 'p'; }
      else while (stack.length > listIndex + 1) out.push(`</${stack.pop()}>`);
    }
    if (name === 'a') {
      while (stack.includes('a')) out.push(`</${stack.pop()}>`);
      const href = safeHref(attr(attrs, 'href'));
      if (!href) { stack.push('a'); out.push('<a>'); continue; }
      const external = /^https?:/i.test(href);
      out.push(`<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer nofollow" target="_blank"' : ''}>`);
      stack.push('a');
      continue;
    }
    out.push(`<${name}>`);
    stack.push(name);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  let result = out.join('')
    .replace(/<a>([\s\S]*?)<\/a>/g, '$1')
    .replace(/<(p|h2|h3|strong|em|li|blockquote)>\s*<\/\1>/g, '')
    .replace(/<(ul|ol)>\s*<\/\1>/g, '')
    .trim();
  if (result.length > maxLength) result = sanitizeRichText(result.slice(0, maxLength), { maxLength: maxLength * 2 });
  return result;
}

/** Plain text from rich HTML, for descriptions and search snippets. */
export function richTextToPlain(html) {
  return decodeEntities(String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h2|h3|li|blockquote)>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
