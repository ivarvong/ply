// The part of the Workers runtime's `cloudflare:sockets` (outbound TCP) that ssh-workers.ts uses; the full declaration is
// in @cloudflare/workers-types, which ply does not depend on.
declare module 'cloudflare:sockets' {
  export type SocketAddress = { readonly hostname: string; readonly port: number };
  export type SocketOptions = { readonly allowHalfOpen?: boolean; readonly secureTransport?: 'off' | 'on' | 'starttls' };
  export type Socket = {
    readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
    readonly writable: WritableStream<Uint8Array>;
    readonly opened: Promise<unknown>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
  };
  export function connect(address: SocketAddress | string, options?: SocketOptions): Socket;
}
