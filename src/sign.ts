// SSH signatures for commits (PROTOCOL.sshsig, as `ssh-keygen -Y sign -n git` / `git commit -S` with gpg.format=ssh
// produce them), with Ed25519 through WebCrypto — available in Workers and node ≥ 20 — and no dependency.
//
// The signed message is the commit object exactly as it would be stored *without* the gpgsig header; the gpgsig header
// is then inserted after `committer` (where git puts it), its continuation lines prefixed by a space. Pure except
// crypto.subtle.sign; verified by `git verify-commit` with an allowed-signers file in test/sign.test.js.
import { callbackFailed, fail } from './errors.js';
import type { ErrorOf } from './errors.js';
import type { Result } from './result.js';
import { err } from './result.js';
import { te, bufferSource, concat, decodeBytes, encodeBytes } from './bytes.js';
import { COMMIT_HEADER_COMMITTER, COMMIT_HEADER_ENCODING } from './format.js';
import { atOr } from './absent.js';

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
  // namespace: 'git' when none is given (ssh-keygen -Y sign -n git)
  sign(message: Uint8Array, ...namespace: [] | [string]): Promise<string>;
};
// WebCrypto's key, named through the one thing every supported lib declares: the global `crypto` and the key its
// `subtle.sign` takes. The type names `CryptoKey` and `CryptoKeyPair` are DOM-lib names a Node consumer with lib ES2022
// + @types/node does not have, and the global `CryptoKey` value exists only from @types/node 24 (20 and 22 declare
// `crypto` alone), so neither can appear in the declarations. test/dist-types.test.js compiles them on each.
type WebCryptoKey = Parameters<typeof crypto.subtle.sign>[1];
type WebCryptoKeyPair = { privateKey: WebCryptoKey; publicKey: WebCryptoKey };
export type SignerKey = { readonly privateKey: WebCryptoKey; readonly publicKeyRaw: Uint8Array };

export function ed25519Signer({ privateKey, publicKeyRaw }: SignerKey): Signer {
  const pub = sshPublicKey(publicKeyRaw);
  return {
    kind: KEY_TYPE, publicKeyLine: pub.line,
    async sign(message: Uint8Array, ...given: [] | [string]): Promise<string> {
      const [namespace = 'git'] = given;
      const h = new Uint8Array(await crypto.subtle.digest('SHA-512', bufferSource(message)));
      const toSign: Uint8Array<ArrayBuffer> = concat([MAGIC, sshString(namespace), sshString(''), sshString('sha512'), sshString(h)]);
      const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, toSign));
      const blob: Uint8Array = concat([MAGIC, u32(1), sshString(pub.wire), sshString(namespace), sshString(''), sshString('sha512'), sshString(concat([sshString(KEY_TYPE), sshString(sig)]))]);
      return armor(blob);
    },
  };
}


// Pure: splice a gpgsig header into an encoded commit. commit_tree_extended writes encoding, then gpgsig.
// The signature goes after encoding when that header is present, otherwise immediately after committer.
export function withGpgsig(commitBytes: Uint8Array, signatureText: string): Result<Uint8Array<ArrayBuffer>, ErrorOf<'bad_request'>> {
  // decodeBytes/encodeBytes: a Latin-1 message or ident goes back out as its own bytes, and so is what was signed (#43)
  const text: string = decodeBytes(commitBytes);
  const nl = text.indexOf('\n\n');
  // The header lines end at the blank line or, in a commit with no body section, at its final newline. Everything
  // from there on goes back out as it came in: the object without its gpgsig header is the object that was signed.
  const noBodyEnd = text.endsWith('\n') ? text.length - 1 : text.length;
  const headEnd = nl < 0 ? noBodyEnd : nl;
  const headers = text.slice(0, headEnd).split('\n');
  let i = headers.findIndex(l => l.startsWith(`${COMMIT_HEADER_COMMITTER} `));
  if (i < 0) return fail('bad_request', 'commit has no committer line');
  if (atOr(headers, i + 1, '').startsWith(`${COMMIT_HEADER_ENCODING} `)) i++;
  // the gpgsig header: the armored signature, its continuation lines prefixed by a space
  headers.splice(i + 1, 0, `gpgsig ${signatureText.replace(/\n$/u, '').split('\n').join('\n ')}`);
  return encodeBytes(headers.join('\n') + text.slice(headEnd), 'commit');
}

// Sign an encoded (unsigned) commit: the signed commit bytes. The message signed is the unsigned commit. The signer is
// the caller's: what it throws or rejects with (or a signature that is not a string) is an Err naming 'signer' with the
// thrown value as `cause`, never a throw. Callers sign while building the commit, before the push request exists.
export async function signCommit(commitBytes: Uint8Array, signer: Signer, namespace = 'git'): Promise<Result<Uint8Array<ArrayBuffer>, ErrorOf<'bad_request'>>> {
  let signature: unknown;
  try { signature = await signer.sign(commitBytes, namespace); } catch (e) { return err(callbackFailed('signer', e)); }
  if (typeof signature !== 'string') return fail('bad_request', 'caller-supplied signer returned a signature that is not a string', { what: 'signer', got: typeof signature });
  return withGpgsig(commitBytes, signature);
}

// Convenience for node/tests: a fresh Ed25519 key pair as a signer.
export type GeneratedSigner = { readonly signer: Signer; readonly keyPair: WebCryptoKeyPair; readonly publicKeyRaw: Uint8Array };
export async function generateSigner(): Promise<GeneratedSigner> {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { signer: ed25519Signer({ privateKey: kp.privateKey, publicKeyRaw }), keyPair: kp, publicKeyRaw };
}
