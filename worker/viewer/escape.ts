/** Escape every character that could break out of HTML text or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeFilename(name: string): string {
  const base = name.split('/').pop() ?? 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return cleaned || 'file';
}

export function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + '\n…';
}
