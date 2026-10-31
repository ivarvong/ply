// SSH signatures for commits (PROTOCOL.sshsig, as `ssh-keygen -Y sign -n git` / `git commit -S` with gpg.format=ssh
// produce them), with Ed25519 through WebCrypto — available in Workers and node ≥ 20 — and no dependency.
//
// The signed message is the commit object exactly as it would be stored *without* the gpgsig header; the gpgsig header
// is then inserted after `committer` (where git puts it), its continuation lines prefixed by a space. Pure except
// crypto.subtle.sign; verified by `git verify-commit` with an allowed-signers file in test/sign.test.js.
import { thrown as fail } from './errors.ts';
import { te, concat, decodeBytes, encodeBytes } from './bytes.js';
import { COMMIT_HEADER_COMMITTER, COMMIT_HEADER_ENCODING } from './format.js';

const u32 = n => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const sshString = b => { const bytes = typeof b === 'string' ? te.encode(b) : b; return concat([u32(bytes.length), bytes]); };
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const MAGIC = te.encode('SSHSIG');

// Public key in OpenSSH wire form and in authorized_keys form (`ssh-ed25519 AAAA…`), from the raw 32-byte key.
export const sshPublicKey = raw32 => { const wire = concat([sshString('ssh-ed25519'), sshString(raw32)]); return { wire, line: `ssh-ed25519 ${b64(wire)}` }; };

// A signer from a WebCrypto Ed25519 key pair. `publicKeyRaw` is the 32-byte raw public key (exportKey('raw')).
export function ed25519Signer({ privateKey, publicKeyRaw }) {
  const pub = sshPublicKey(publicKeyRaw);
  return {
    kind: 'ssh-ed25519', publicKeyLine: pub.line,
    async sign(message, namespace = 'git') {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-512', message));
      const toSign = concat([MAGIC, sshString(namespace), sshString(''), sshString('sha512'), sshString(h)]);
      const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, toSign));
      const blob = concat([MAGIC, u32(1), sshString(pub.wire), sshString(namespace), sshString(''), sshString('sha512'), sshString(concat([sshString('ssh-ed25519'), sshString(sig)]))]);
      return armor(blob);
    },
  };
}

export function armor(blob) {
  const s = b64(blob);
  const lines = []; for (let i = 0; i < s.length; i += 70) lines.push(s.slice(i, i + 70));
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join('\n')}\n-----END SSH SIGNATURE-----\n`;
}

// Pure: splice a gpgsig header into an encoded commit. commit_tree_extended writes encoding, then gpgsig.
// The signature goes after encoding when that header is present, otherwise immediately after committer.
export function withGpgsig(commitBytes, signatureText) {
  // decodeBytes/encodeBytes: a Latin-1 message or ident goes back out as its own bytes, and so is what was signed (#43)
  const text = decodeBytes(commitBytes);
  const nl = text.indexOf('\n\n');
  const headers = (nl < 0 ? text : text.slice(0, nl)).split('\n');
  let i = headers.findIndex(l => l.startsWith(`${COMMIT_HEADER_COMMITTER} `));
  if (i < 0) throw fail('bad_request', 'commit has no committer line');
  if (headers[i + 1]?.startsWith(`${COMMIT_HEADER_ENCODING} `)) i++;
  const sigLines = signatureText.replace(/\n$/, '').split('\n');
  const gpgsig = 'gpgsig ' + sigLines.join('\n ');
  headers.splice(i + 1, 0, gpgsig);
  return encodeBytes(headers.join('\n') + (nl < 0 ? '\n' : text.slice(nl)), 'commit');
}

// Sign an encoded (unsigned) commit: returns the signed commit bytes. The message signed is the unsigned commit.
export async function signCommit(commitBytes, signer, namespace = 'git') {
  return withGpgsig(commitBytes, await signer.sign(commitBytes, namespace));
}

// Convenience for node/tests: a fresh Ed25519 key pair as a signer.
export async function generateSigner() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { signer: ed25519Signer({ privateKey: kp.privateKey, publicKeyRaw }), keyPair: kp, publicKeyRaw };
}
