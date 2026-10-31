// The ref-name space (#73): the shapes of a ref name ply is handed, as a product, with real git as the oracle on every
// cell. A name is "refs/" + 1–3 components, each drawn from COMPONENTS (the shapes git v2.50.0 refs.c
// check_refname_component() and check_or_sanitize_refname() decide on: "..", "@{", a leading ".", a trailing ".", a
// ".lock" suffix, a lone "@", an empty component, a forbidden byte, and their harmless neighbours), plus a sweep of
// every code point U+0001–U+00FF inside one component. Three questions per cell, each asked of git, never of a rule
// written here:
//   format   `git check-ref-format <name>` (check_refname_format(name, 0)): validateRef must agree
//   create   a real `git receive-pack` answering a create of the name: "funny refname" or not
//            (receive-pack.c update(): check_refname_format(name + 5, 0)): validatePushRef(name, false) must agree
//   delete   the same for a delete (check_refname_format(name + 5, REFNAME_ALLOW_ONELEVEL)): validatePushRef(name, true)
// Names that cannot be framed (NUL, LF) are not cells: validateRef refuses them before anything (validateWire's rule).
export const COMPONENTS = [
  { tag: 'a', s: 'a', why: 'a plain component' },
  { tag: '@', s: '@', why: 'a lone @: refused only as the whole name (check_or_sanitize_refname), so refs/@ is funny to receive-pack' },
  { tag: '@a', s: '@a', why: '@ not followed by {' },
  { tag: '@{a', s: '@{a', why: '"@{" (reflog syntax)' },
  { tag: '{a', s: '{a', why: '{ after a component boundary: "@/{a" is not "@{"' },
  { tag: '.', s: '.', why: 'a component that is a lone dot (starts with .)' },
  { tag: '..', s: '..', why: '".." (range syntax)' },
  { tag: '.a', s: '.a', why: 'a component starting with .' },
  { tag: 'a.', s: 'a.', why: 'a trailing dot: refused only at the end of the whole name' },
  { tag: 'a.lock', s: 'a.lock', why: 'a component ending .lock' },
  { tag: 'a.lockb', s: 'a.lockb', why: '.lock not at the end' },
  { tag: '-a', s: '-a', why: 'a leading dash (check-ref-format accepts it; only branch names refuse it)' },
  { tag: 'empty', s: '', why: 'an empty component ("//", a trailing "/")' },
  { tag: 'ctl', s: 'a\x01', why: 'an ASCII control character' },
  { tag: 'sp', s: 'a b', why: 'a space' },
  { tag: 'u', s: 'é', why: 'non-ASCII (UTF-8 bytes are disposition 0)' },
];
export const DEPTHS = [1, 2, 3];

// every cell: { id, name }
export function cells() {
  const out = [];
  const go = (depth, parts, tags) => {
    if (parts.length === depth) { out.push({ id: `shape/${depth}/${tags.join(',')}`, name: `refs/${parts.join('/')}` }); return; }
    for (const c of COMPONENTS) go(depth, [...parts, c.s], [...tags, c.tag]);
  };
  for (const d of DEPTHS) go(d, [], []);
  // one code point inside a component, in a name that is otherwise valid at every depth rule
  for (let cp = 1; cp <= 0xff; cp++) if (cp !== 0x0a) out.push({ id: `char/U+${cp.toString(16).padStart(4, '0')}`, name: `refs/heads/a${String.fromCharCode(cp)}b` });
  return out;
}
