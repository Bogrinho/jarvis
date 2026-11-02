// Small, safe markdown renderer for AI replies.
// renderMarkdown(text, h) -> array of nodes built only through h(tag, props, ...children);
// text always travels as plain string children, so nothing the AI writes is ever parsed as HTML.
// Supported: paragraphs, # headings (as bold lines), **bold**, *italic*, `code`, fenced code blocks,
// "-"/"*" and "1." lists, [text](http/https url). Everything else stays literal text.

const FENCE_OPEN = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d{1,9}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const INLINE = /`([^`\n]+)`|\*\*([^*\n](?:[^\n]*?[^*\s])?)\*\*|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/;

function safeUrl(raw) {
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

function inline(text, h) {
  const out = [];
  let last = 0;
  const re = new RegExp(INLINE.source, 'g'); // own instance: inline() recurses
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, code, bold, italic, label, url] = m;
    if (code !== undefined) out.push(h('code', {}, code));
    else if (bold !== undefined) out.push(h('b', {}, ...inline(bold, h)));
    else if (italic !== undefined) out.push(h('i', {}, ...inline(italic, h)));
    else {
      const href = safeUrl(url);
      if (href) out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...inline(label, h)));
      else out.push(...inline(label, h)); // unsafe scheme: keep only the words
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Lines of one paragraph/list item, separated by <br>.
function lines(list, h) {
  const out = [];
  list.forEach((l, i) => {
    if (i) out.push(h('br', {}));
    out.push(...inline(l, h));
  });
  return out;
}

export function renderMarkdown(text, h) {
  if (typeof text !== 'string' || text === '') return [];
  const src = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(h('p', {}, ...lines(para, h)));
    para = [];
  };

  for (let i = 0; i < src.length;) {
    const line = src[i];

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flush();
      const body = [];
      i++;
      const close = new RegExp(`^\\s*${fence[1]}\\s*$`);
      while (i < src.length && !close.test(src[i])) body.push(src[i++]);
      i++; // closing fence (or past the end while a reply is still streaming)
      const props = fence[2] ? { class: 'code', 'data-lang': fence[2] } : { class: 'code' };
      out.push(h('pre', props, h('code', {}, body.join('\n'))));
      continue;
    }

    const kind = BULLET.test(line) ? 'ul' : ORDERED.test(line) ? 'ol' : null;
    if (kind) {
      flush();
      const re = kind === 'ul' ? BULLET : ORDERED;
      const items = [];
      while (i < src.length) {
        const l = src[i];
        const m = re.exec(l);
        if (m) items.push([m[1]]);
        else if (/^\s{2,}\S/.test(l) && !FENCE_OPEN.test(l) && !BULLET.test(l) && !ORDERED.test(l)) items[items.length - 1].push(l.trim());
        else break;
        i++;
      }
      out.push(h(kind, {}, ...items.map((it) => h('li', {}, ...lines(it, h)))));
      continue;
    }

    const head = HEADING.exec(line);
    if (head) {
      flush();
      out.push(h('p', { class: 'md-h' }, h('b', {}, ...inline(head[1], h))));
      i++;
      continue;
    }

    if (line.trim() === '') flush();
    else para.push(line);
    i++;
  }
  flush();
  return out;
}
