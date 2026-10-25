// Minimal markdown for README text. The source is escaped first, so raw HTML stays text.
import { escapeHtml } from './escape.ts';

function inline(escaped: string): string {
  let out = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  return out;
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flushPara = () => {
    if (!para.length) return;
    blocks.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<ul>${list.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      flushPara();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level + 2}>${inline(escapeHtml(heading[2]))}</h${level + 2}>`);
      continue;
    }
    const item = /^[-*] (.+)$/.exec(line);
    if (item?.[1]) {
      flushPara();
      list.push(escapeHtml(item[1]));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(escapeHtml(line.trim()));
  }
  if (code) blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushPara();
  flushList();
  return blocks.join('');
}
