// Format facts for the git wire codecs. Every numeric literal that encodes a format rule lives here, next to the
// spec it comes from, so a parser cannot drift by "fixing" an off-by-one in a local guard. Other modules import
// these names. This file is the only place those literals may appear.
/* oxlint-disable no-magic-numbers -- definitions of the format facts; mutating one is a behavior change */

/** SHA-1 object id width. gitformat-pack(5): object names in packs are 20 bytes. */
export const OID_BYTES = 20;
/** Hex digits in a SHA-1 object name. Two hex chars per byte. */
export const OID_HEX_CHARS = OID_BYTES * 2;
/** SHA-256 object names, rejected: gitprotocol-v2 object-format. */
export const SHA256_HEX_CHARS = 64;

/** One byte, and the mask that keeps one. */
export const BYTE_VALUES = 256;
export const BYTE_MASK = 255;

/** Big-endian uint32 shifts. gitformat-pack(5) network order for version and object count. */
export const BE32_SHIFTS = Object.freeze([24, 16, 8, 0]);
export const UINT32_BYTES = 4;

// ---- tree (gitobject layout; fsck.c fsck_tree) ----
/** Space between mode and name. */
export const TREE_MODE_SEP = 0x20;
/** NUL between name and object id. */
export const TREE_NUL = 0x00;
/** Canonical modes git writes. `40000` is the tree mode with the leading zero stripped. */
export const MODE_BLOB = '100644';
export const MODE_EXEC = '100755';
export const MODE_LINK = '120000';
export const MODE_TREE = '40000';
export const MODE_COMMIT = '160000';
/**
 * Shortest well-framed entry: one octal mode digit, the separating space, one name byte, NUL, and the object id.
 * git's tree-walk rejects anything shorter (`too-short tree object`).
 */
export const TREE_MODE_MIN_DIGITS = 1;
export const TREE_NAME_MIN_BYTES = 1;
export const TREE_ENTRY_OVERHEAD = TREE_MODE_MIN_DIGITS + 1 + TREE_NAME_MIN_BYTES + 1;
export const TREE_ENTRY_MIN = TREE_ENTRY_OVERHEAD + OID_BYTES;

// ---- pkt-line (gitprotocol-common(5)) ----
/** Hex digits of the length prefix. The length counts those digits. */
export const PKT_LEN_HEX = 4;
export const PKT_HEX_BASE = 16;
/** `0000` flush, `0001` delim, `0002` response-end. Length 3 is not a pkt-line. */
export const PKT_FLUSH = 0;
export const PKT_DELIM = 1;
export const PKT_RESPONSE_END = 2;
export const PKT_LEN_INVALID = 3;
/** Smallest data pkt-line: the 4 hex digits and an empty payload. */
export const PKT_DATA_MIN = PKT_LEN_HEX;
/** gitprotocol-common(5): pkt-line length must be ≤ 65520. Payload budget is that minus the length prefix. */
export const PKT_MAX_SIZE = 65520;
export const PKT_MAX_PAYLOAD = PKT_MAX_SIZE - PKT_LEN_HEX;
/** Nibble width when decoding the hex length. Shifts of the four hex digits, high digit first. */
export const NIBBLE_BITS = 4;
export const PKT_LEN_SHIFTS = Object.freeze([NIBBLE_BITS * 3, NIBBLE_BITS * 2, NIBBLE_BITS, 0]);

// ---- pack (gitformat-pack(5)) ----
/** ASCII `PACK`. */
export const PACK_SIGNATURE = Object.freeze([0x50, 0x41, 0x43, 0x4b]);
export const PACK_VERSION = 2;
/** 4 signature + 4 version + 4 object count. */
export const PACK_HEADER_BYTES = 12;
/** Trailer is the SHA-1 of every preceding byte. */
export const PACK_TRAILER_BYTES = OID_BYTES;
/** Object type codes. 0 and 5 are reserved. */
export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;
export const OBJ_TYPE_SHIFT = 4;
export const OBJ_TYPE_MASK = 7;
/** Low nibble of the first header byte is the size; later bytes carry 7 bits. MSB continues. */
export const OBJ_SIZE_FIRST_MASK = 0x0f;
export const OBJ_SIZE_NEXT_MASK = 0x7f;
export const OBJ_CONTINUE = 0x80;
export const OBJ_SIZE_FIRST_BASE = 16;
export const OBJ_SIZE_NEXT_BASE = 128;
export const VARINT_BITS = 7;

// ---- delta (gitformat-pack(5) "Deltified representation"; patch-delta.c DELTA_SIZE_MIN) ----
/** git rejects a delta shorter than 4 bytes. */
export const DELTA_SIZE_MIN = 4;
/** Copy instruction: high bit set. Insert length is 1..127. Opcode 0 is reserved. */
export const DELTA_COPY = 0x80;
export const DELTA_INSERT_MAX = 127;
/** Copy size of 0 means 0x10000. */
export const DELTA_COPY_MAX = 0x10000;
export const DELTA_COPY_OFF1 = 0x01;
export const DELTA_COPY_OFF2 = 0x02;
export const DELTA_COPY_OFF3 = 0x04;
export const DELTA_COPY_OFF4 = 0x08;
export const DELTA_COPY_LEN1 = 0x10;
export const DELTA_COPY_LEN2 = 0x20;
export const DELTA_COPY_LEN3 = 0x40;
/** Width of one byte. The next little-endian or offset byte sits this many bits higher. */
export const BYTE_SHIFT = 8;
export const DELTA_OFF_SHIFT = BYTE_SHIFT;
/** Second and third offset/length bytes sit 16 bits up (two groups of DELTA_OFF_SHIFT). */
export const DELTA_BYTE2_SHIFT = DELTA_OFF_SHIFT * 2;
export const DELTA_OFF4_FACTOR = 0x1000000;

// ---- sideband (gitprotocol-pack(5) side-band-64k; gitprotocol-v2(5) packfile section) ----
export const SIDEBAND_PACK = 1;
export const SIDEBAND_PROGRESS = 2;
export const SIDEBAND_ERROR = 3;
export const SIDEBAND_CHANNEL_BYTES = 1;

/** gitprotocol-v2(5): the client's `Git-Protocol: version=2` and the `version 2` advertisement line. */
export const PROTOCOL_V2 = 2;

// ---- ident timezone (fsck.c fsck_ident, FSCK_MSG_BAD_TIMEZONE) ----
/**
 * Digits after the `+` or `-` of a commit or tag ident timezone (`+0530`). The zone is that sign,
 * these digits, and then the newline. git does not range-check the hour or the minute: `+9999` and
 * `+1560` are well-formed. A non-digit, a shorter or longer run, a missing sign, or any trailing byte
 * is "bad time zone".
 */
export const IDENT_TZ_DIGITS = 4;
/**
 * Caller-supplied offsets only. fsck_ident does not range-check (`+9999` is a well-formed zone on the wire;
 * checkIdent stays that loose). A caller is held to the offsets civil time uses: −12:00 (Etc/GMT+12) through
 * +14:00 (Pacific/Kiritimati), minutes 00..59, and the extreme hours only on the hour.
 */
export const IDENT_TZ_HOUR_MIN = -12;
export const IDENT_TZ_HOUR_MAX = 14;
export const IDENT_TZ_MINUTE_MAX = 59;

// ---- commit headers (Documentation/gitformat-commit; commit.c commit_tree_extended) ----
// commit-tree writes exactly one tree, then zero or more parent lines, then one author, one committer,
// then an optional encoding, then other headers (gpgsig, mergetag — mergetag may repeat). A second
// single-valued header is not a commit git would write. git's parser is first-wins for tree and encoding
// and fsck still accepts some of those objects; ply rejects them.
export const COMMIT_HEADER_TREE = 'tree';
export const COMMIT_HEADER_PARENT = 'parent';
export const COMMIT_HEADER_AUTHOR = 'author';
export const COMMIT_HEADER_COMMITTER = 'committer';
export const COMMIT_HEADER_ENCODING = 'encoding';
/** The order commit_tree_extended emits. parent and encoding are optional; the others are not. */
export const COMMIT_HEADER_ORDER = Object.freeze([
  COMMIT_HEADER_TREE, COMMIT_HEADER_PARENT, COMMIT_HEADER_AUTHOR, COMMIT_HEADER_COMMITTER, COMMIT_HEADER_ENCODING,
]);
/** Headers that appear at most once. parent is not in this list; mergetag is an extra header and may repeat. */
export const COMMIT_SINGLE_HEADERS = /* @__PURE__ */ Object.freeze([
  COMMIT_HEADER_TREE, COMMIT_HEADER_AUTHOR, COMMIT_HEADER_COMMITTER, COMMIT_HEADER_ENCODING,
]);

// ---- tag headers (builtin/tag.c) ----
// An annotated tag is object, type, tag, tagger, then optional extras (gpgsig). All four are single-valued.
// git is first-wins for a repeated tagger and fsck accepts it; ply rejects the repeat.
export const TAG_HEADER_OBJECT = 'object';
export const TAG_HEADER_TYPE = 'type';
export const TAG_HEADER_TAG = 'tag';
export const TAG_HEADER_TAGGER = 'tagger';
export const TAG_HEADER_ORDER = Object.freeze([
  TAG_HEADER_OBJECT, TAG_HEADER_TYPE, TAG_HEADER_TAG, TAG_HEADER_TAGGER,
]);
/** Every header builtin/tag.c writes is single-valued. */
export const TAG_SINGLE_HEADERS = TAG_HEADER_ORDER;

/**
 * Phase after the first header the writer would not emit (gpgsig, mergetag, a space-continuation,
 * anything else). A header key cannot be this: splitHeaders has already split on newlines.
 * The parser stores that phase as the header-order length, which is past every structural index.
 */
export const HEADER_PHASE_EXTRA = '\n';

/**
 * `parent` is the only optional commit header between two required ones, so `author` may follow
 * `tree` with exactly this many headers skipped (commit.c commit_tree_extended). A tag has nothing
 * optional in the middle, and the skip does not apply when no header may repeat.
 */
export const HEADER_SKIP_OPTIONAL = 1;

// ---- zlib / deflate (RFC 1950, RFC 1951) ----
export const ZLIB_HEADER_BYTES = 2;
export const ZLIB_CM_DEFLATE = 8;
export const ZLIB_CM_MASK = 0x0f;
export const ZLIB_FDICT = 0x20;
export const ZLIB_HEADER_MOD = 31;
export const ADLER_BYTES = 4;
export const ADLER_MOD = 65521;
/** Adler-32 stores the sum `b` in the high 16 bits. RFC 1950 §2.2. */
export const ADLER_SHIFT = 16;
export const DEFLATE_BFINAL_BITS = 1;
export const DEFLATE_BTYPE_BITS = 2;
export const DEFLATE_STORED = 0;
export const DEFLATE_FIXED = 1;
export const DEFLATE_DYNAMIC = 2;
export const DEFLATE_STORED_HEADER_BYTES = 4;
/** One's complement of the stored-block length is 16 bits. RFC 1951 §3.2.4. */
export const DEFLATE_STORED_LEN_MASK = 0xffff;
export const DEFLATE_MAX_BITS = 15;
export const DEFLATE_BIT_TABLE = 16;
export const DEFLATE_LITERALS = 256;
export const DEFLATE_EOB = 256;
export const DEFLATE_LENGTH_BASE = 257;
export const DEFLATE_LENGTH_CODES = 29;
export const DEFLATE_HLIT_BASE = 257;
export const DEFLATE_HLIT_BITS = 5;
export const DEFLATE_HDIST_BASE = 1;
export const DEFLATE_HDIST_BITS = 5;
export const DEFLATE_HCLEN_BASE = 4;
export const DEFLATE_HCLEN_BITS = 4;
export const DEFLATE_HLIT_MAX = 286;
export const DEFLATE_HDIST_MAX = 30;
export const DEFLATE_CODELEN_CODES = 19;
export const DEFLATE_CODELEN_BITS = 3;
export const DEFLATE_REPEAT_PREV = 16;
export const DEFLATE_REPEAT_ZERO3 = 17;
export const DEFLATE_REPEAT_ZERO11 = 18;
export const DEFLATE_REPEAT16_BASE = 3;
export const DEFLATE_REPEAT16_BITS = 2;
export const DEFLATE_REPEAT17_BASE = 3;
export const DEFLATE_REPEAT17_BITS = 3;
export const DEFLATE_REPEAT18_BASE = 11;
export const DEFLATE_REPEAT18_BITS = 7;

/** `2 ** shift` for a size-varint group. Defined once so the base is not recopied at each call site. */
export const varintScale = shift => 2 ** shift;
