// SSH signatures for commits (PROTOCOL.sshsig, as `ssh-keygen -Y sign -n git` / `git commit -S` with gpg.format=ssh
// produce them), with Ed25519 through WebCrypto — available in Workers and node ≥ 20 — and no dependency.
//
// The signed message is the commit object exactly as it would be stored *without* the gpgsig header; the gpgsig header
// is then inserted after `committer` (where git puts it), its continuation lines prefixed by a space. Pure except
// crypto.subtle.sign; verified by `git verify-commit` with an allowed-signers file in test/sign.test.js.
import { thrown as fail } from './errors.js';
import { te, concat, decodeBytes, encodeBytes } from './bytes.js';
import { COMMIT_HEADER_COMMITTER, COMMIT_HEADER_ENCODING } from './format.js';

const u32 = (n: number): Uint8Array => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const sshString = (b: string | Uint8Array): Uint8Array => { const bytes: Uint8Array = typeof b === 'string' ? te.encode(b) : b; return concat([u32(bytes.length), bytes]); };
const b64 = (bytes: Uint8Array): string => btoa(String.fromCodePoint(...bytes));
const MAGIC = te.encode('SSHSIG');
const KEY_TYPE = 'ssh-ed25519';

// Public key in OpenSSH wire form and in authorized_keys form (`ssh-ed25519 AAAA…`), from the raw 32-byte key.
export type SshPublicKey = { readonly wire: Uint8Array; readonly line: string };
export const sshPublicKey = (raw32: Uint8Array): SshPublicKey => { const wire: Uint8Array = concat([sshString(KEY_TYPE), sshString(raw32)]); return { wire, line: `${KEY_TYPE} ${b64(wire)}` }; };

export function armor(blob: Uint8Array): string {
  const s = b64(blob);
  const lines: string[] = []; for (let i = 0; i < s.length; i += 70) lines.push(s.slice(i, i + 70));
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join('\n')}\n-----END SSH SIGNATURE-----\n`;
}

// A signer from a WebCrypto Ed25519 key pair. `publicKeyRaw` is the 32-byte raw public key (exportKey('raw')).
export type Signer = {
  readonly kind: 'ssh-ed25519';
  readonly publicKeyLine: string;
  sign(message: Uint8Array<ArrayBuffer>, namespace?: string): Promise<string>;
};
export type SignerKey = { readonly privateKey: CryptoKey; readonly publicKeyRaw: Uint8Array };

export function ed25519Signer({ privateKey, publicKeyRaw }: SignerKey): Signer {
  const pub = sshPublicKey(publicKeyRaw);
  return {
    kind: KEY_TYPE, publicKeyLine: pub.line,
    async sign(message: Uint8Array<ArrayBuffer>, namespace = 'git'): Promise<string> {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-512', message));
      const toSign: Uint8Array<ArrayBuffer> = concat([MAGIC, sshString(namespace), sshString(''), sshString('sha512'), sshString(h)]);
      const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, toSign));
      const blob: Uint8Array = concat([MAGIC, u32(1), sshString(pub.wire), sshString(namespace), sshString(''), sshString('sha512'), sshString(concat([sshString(KEY_TYPE), sshString(sig)]))]);
      return armor(blob);
    },
  };
}


// Pure: splice a gpgsig header into an encoded commit. commit_tree_extended writes encoding, then gpgsig.
// The signature goes after encoding when that header is present, otherwise immediately after committer.
export function withGpgsig(commitBytes: Uint8Array, signatureText: string): Uint8Array<ArrayBuffer> {
  // decodeBytes/encodeBytes: a Latin-1 message or ident goes back out as its own bytes, and so is what was signed (#43)
  const text: string = decodeBytes(commitBytes);
  const nl = text.indexOf('\n\n');
  const headers = (nl < 0 ? text : text.slice(0, nl)).split('\n');
  let i = headers.findIndex(l => l.startsWith(`${COMMIT_HEADER_COMMITTER} `));
  if (i < 0) throw fail('bad_request', 'commit has no committer line');
  if ((headers[i + 1] ?? '').startsWith(`${COMMIT_HEADER_ENCODING} `)) i++;
  // the gpgsig header: the armored signature, its continuation lines prefixed by a space
  headers.splice(i + 1, 0, `gpgsig ${signatureText.replace(/\n$/u, '').split('\n').join('\n ')}`);
  return encodeBytes(headers.join('\n') + (nl < 0 ? '\n' : text.slice(nl)), 'commit');
}

// Sign an encoded (unsigned) commit: returns the signed commit bytes. The message signed is the unsigned commit.
export async function signCommit(commitBytes: Uint8Array<ArrayBuffer>, signer: Signer, namespace = 'git'): Promise<Uint8Array<ArrayBuffer>> {
  return withGpgsig(commitBytes, await signer.sign(commitBytes, namespace));
}

// Convenience for node/tests: a fresh Ed25519 key pair as a signer.
export type GeneratedSigner = { readonly signer: Signer; readonly keyPair: CryptoKeyPair; readonly publicKeyRaw: Uint8Array };
export async function generateSigner(): Promise<GeneratedSigner> {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { signer: ed25519Signer({ privateKey: kp.privateKey, publicKeyRaw }), keyPair: kp, publicKeyRaw };
}
