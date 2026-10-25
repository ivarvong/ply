import type { PackMap } from './packmap.ts';

export type FilterName = 'tree:0' | 'blob:none';

export type ServerInfo = {
  agent: string;
  protocol: number;
  objectFormat: string;
  caps: string[];
  fetchFeatures: string[];
  filterAdvertised: boolean;
};

export type CommitInfo = {
  oid: string;
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: string;
  authorTz: string;
  message: string;
  signed: boolean;
};

export type TreeEntry = { name: string; mode: string; oid: string; type: string };

export type BranchInfo = { name: string; oid: string; head: boolean };

export type TraceBar = {
  name: string;
  startMs: number;
  durMs: number;
  status: 'ok' | 'error';
  httpStatus: number | null;
  bytes: number | null;
  cache: string;
  lines: string[];
  packWant: string | null;
  packFilter: FilterName | null;
};

export type TraceModel = {
  bars: TraceBar[];
  totalMs: number;
  cfRay: string;
  requestId: string;
};

export type RepoHeader = {
  host: string;
  repoPath: string;
  ref: string;
  commit: string;
  treeHref: string;
  server: ServerInfo;
};

export type Loaded =
  | {
      kind: 'tree';
      header: RepoHeader;
      path: string;
      commit: CommitInfo;
      log: CommitInfo[];
      logStopped: boolean;
      branches: BranchInfo[];
      branchesTruncated: number;
      entries: TreeEntry[];
      entriesTruncated: number;
    }
  | {
      kind: 'file';
      header: RepoHeader;
      path: string;
      mode: string;
      blob: string;
      size: number;
      note: 'text' | 'binary' | 'too-big' | 'submodule';
      text: string | null;
    }
  | { kind: 'raw'; filename: string; bytes: Uint8Array; size: number }
  | {
      kind: 'pack';
      header: RepoHeader;
      want: string;
      filterRequested: FilterName;
      filterHonoured: FilterName;
      map: PackMap;
      offset: number | null;
      askedOfsDelta: true;
      askedThinPack: false;
    };

export type RateDecision = { ok: boolean; remaining: number; retryAfterMs: number };

export type RateNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { admit(bucket: string, now: number, limit: number, windowMs: number): Promise<RateDecision> | RateDecision };
};

export type ViewerEnv = {
  VIEWER_RATE?: RateNamespace;
  /** Comma-separated exact hostnames appended to the built-in allowlist. Wildcards are ignored. */
  VIEWER_EXTRA_HOSTS?: string;
  VIEWER_RATE_PER_MIN?: string;
  VIEWER_PACK_RATE_PER_MIN?: string;
  PACK_CACHE?: string;
};
