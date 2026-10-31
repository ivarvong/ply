# SPACE.md — the decision spaces

A living document. Each section takes one decision ply makes, defines every axis the decision depends on as a tagged
union of value classes justified from git's source, takes the product, and gives the expected outcome of every cell.
The code is the source of truth: the axes, the product, the renderers and the expected outcome live in
`test/space/<decision>.space.js`, the enumerator runs every cell through ply's real code path, and the generated part
of each section is checked against the code by the test, so the two cannot drift. Fuzzing samples a space; this
enumerates it. Add a decision point as a new section (and a new `test/space/*.space.js`).

## Push outcome

**Decision.** After `push()` has sent the commands and the pack, what may it tell the caller? One of:

| outcome | meaning | code (retry) |
|---|---|---|
| `landed` | every commanded ref was updated | — (resolves) |
| `rejected` | no ref was updated; the reasons are the server's | `cas_conflict` (fresh) when every refusal is a lost compare-and-swap, else `push_rejected` (no) |
| `partial` | a non-atomic multi-ref push: the refs in `landed` were updated, those in `rejected` were not | `push_partial` (no) |
| `ambiguous` | the refs may or may not have moved: read them back first | `ambiguous` (read) |
| `preSend` | ply refused before sending a byte; definite: nothing changed | `bad_request` / `limit_exceeded` (no) |

**Principle.** Once any request byte may have reached the server, a definite answer (`landed`, `rejected`, `partial`)
needs positive evidence in exactly the shape git's receive-pack writes; every other post-send state is `ambiguous`.
Before the request is sent, ply's own refusals are definite. The code is shaped the same way (src/push.js): the wire is
read into a tagged union of stream shapes (`streamStep`: `report` | `broken`), the report into a tagged union of report
shapes (`classifyReport`: `statuses` | `unpackFailed` | `malformed`), and `decideOutcome` is an exhaustive match over
those tags whose only fallthrough is `ambiguous`. Every step is an allowlist.

**git's shape, from the source** (git v2.50.0):

- `builtin/receive-pack.c` `report()` writes `unpack <status>` (`ok` when `unpack_status` is NULL), then for each command
  in request order `ok <ref>` or `ng <ref> <error_string>`, then a flush; `report_v2()` writes the same and adds
  `option refname|old-oid|new-oid|forced-update` lines after an `ok` only for a command a proc-receive hook reported
  (`cmd->report`), repeating `ok <ref>` for each further report of the same command.
- `unpack()` returns one of eight fixed strings (`parse_pack_header`: "eof before pack header was fully read",
  "protocol error (pack signature mismatch detected)", "protocol error (pack version unsupported)", "unknown error in
  parse_pack_header"; "unable to create temporary object directory", "unpack-objects abnormal exit", "index-pack fork
  failed", "index-pack abnormal exit"). `execute_commands()` then marks every command `unpacker error` and returns;
  nothing else sets that string. `cmd_receive_pack()` skips unpack entirely when `delete_only()`, so a delete-only push
  always reports `unpack ok`.
- `execute_commands_atomic()`: a failure inside the transaction marks every other command `atomic push failure` (or
  `atomic transaction failed` / `transaction failed to start`); commands already refused before the transaction
  (`reject_updates_to_hidden`, connectivity, `check_aliased_updates`) are skipped and the rest still commit. So an atomic
  push *can* produce a git-shaped split (observed below: a hidden ref).
- With side-band (`use_sideband`), the report buffer goes out as band-1 packets (`send_sideband`, chunked at
  LARGE_PACKET_MAX), hook and unpack stderr as band 2 (`copy_to_sideband`, also post-receive after the report), empty
  band-1 packets `0005\1` as keepalives while hooks run (`copy_to_sideband`; `use_keepalive` is KEEPALIVE_ALWAYS from
  `execute_commands` on, so keepalives also follow the report during post-receive: observed), and a final outer flush
  (`cmd_receive_pack`: `if (use_sideband) packet_flush(1)`). Without side-band the report's flush is the last byte and
  hook output goes to stderr, not the wire. receive-pack never writes band 3 or `ERR`.
- `send-pack.c` `receive_unpack_status()` / `receive_status()` and `sideband.c` `demultiplex_sideband()`: git's own
  client fails the push on a missing unpack line, an invalid status word, EOF before the flush ("unexpected disconnect"),
  band 3 ("remote error"), or an `ERR` packet (`PACKET_READ_DIE_ON_ERR_PACKET`). It tolerates (warns on) status lines
  for unknown refs and accepts repeated statuses; ply does not: those are not shapes receive-pack writes.

**Equivalences (not axes, with the reason).** *Create* (zero old oid) — `report()` never reads `old_oid`; a create
differs from an update only in the reason text of an `ng`, which is the `ng` payload. *A delete beside an update* —
`delete_only()` is false, so it is the `withPack` class. *Push options* — they change only the request
(`read_push_options`); `check_cert_push_options` can refuse them only for a signed push, which ply never sends; an
invalid option is a `refused` event. *The order of status lines* — receive-pack writes them in request order; ply
matches each line to its ref and does not require the order (a reordering takes more than one byte to make, and every
ref still needs exactly one exact line). *The text of an `ng` reason* — any printable ASCII is accepted (hooks, hosts and
proc-receive choose it); it decides only `cas_conflict` versus `push_rejected` (`rejectionCode`), never landed versus not.

**Judgment calls** (where git's behaviour is clear but the outcome is a choice):

1. *Atomic split.* An atomic push answered with some `ok` and some `ng` is `ambiguous`, even though git can produce it
   (a hidden ref is refused before the transaction and the other refs commit: observed, `hidden ref, atomic`). The
   caller asked for all-or-nothing; ply does not turn that into a partial success, and the read-back shows what landed.
2. *Option lines.* An `ok` followed by `option` lines (proc-receive, report-status-v2) means the server updated something
   other than the commanded ref and oid (`refname`, `new-oid`); ply does not model proc-receive, so it is `ambiguous`.
   Under v1 they are not git's at all.
3. *Unknown unpack failure text.* A non-`ok` unpack status that is not one of git's eight strings is `ambiguous`, even
   with every ref `ng unpacker error`: a server that is not git may word it differently, and the cost is one read.
4. *Anything after the final flush* (a second report, a transport error) is `ambiguous`, although the report before it
   was complete. Over SSH the transport stops at the flush, so this arises only over HTTP.
5. *A connection failure before any response byte* is `ambiguous` even when the request was cut before the pack (the
   server then changes nothing: observed). ply cannot tell how much of the body the server consumed.
6. *A delete-only push answered with an unpack failure* is `ambiguous`: receive-pack never unpacks for it.

**Found while observing.** A delete whose old oid names an object the server does not have is applied regardless:
`update()` warns "allowing deletion of corrupt ref", drops the old oid, deletes, and reports `ok` (observed: `delete
with an unknown old oid`). The report is truthful (`landed`); the compare-and-swap is not. SAFETY.md I22 is narrowed
accordingly.

**Where main (a7a724e) disagreed with the table** (the enumerator run with `PUSH_SPACE_SRC=<git archive a7a724e src>`):
412,008 of 4,331,598 cells.

| cells | table → main | cause |
|---:|---|---|
| 276,312 | ambiguous → `limit_exceeded` (retry: no) | every flood cell: a report-line limit hit after the send kept its pre-send code |
| 19,456 + 1,152 + 192 | ambiguous → rejected / cas_conflict / landed | plain stream with no final flush: main never required the report's flush |
| 14,592 + 864 + 144 | ambiguous → rejected / cas_conflict / landed | side-band report without its own flush inside band 1 |
| 19,456 + 1,152 + 192 | ambiguous → rejected / cas_conflict / landed | a second flush after the final flush |
| 29,184 + 1,728 + 288 | ambiguous → rejected / cas_conflict / landed | band 1 carrying a partial pkt or a second flush after the report's flush |
| 14,592 + 864 + 144 | ambiguous → rejected / cas_conflict / landed | an `ERR` packet before the report (main skipped the line), with any delivery |
| 12,880 | ambiguous → push_rejected | unpack near-miss (`ok*`): issue #33, the ref had moved |
| 12,712 | ambiguous → push_rejected | a git unpack failure beside ref lines that are not all `unpacker error` (incl. `ok`), or for a delete-only push |
| 2,688 + 280 + 168 | ambiguous → rejected / cas_conflict / landed | option lines after `ok` (v1, or v2 proc-receive) |
| 2,128 | ambiguous → push_rejected | `ng <ref> unpacker error` beside `unpack ok`, or beside other statuses |
| 560 + 280 | partial → push_rejected / cas_conflict | non-atomic mixed ok/ng: main said "rejected" while some refs had landed |

Boundary enumeration on main: 2,520 single-bit flips turn a landed cell into `push_rejected` (e.g. `unpack ok` →
`unpack nk`); on the new code: none.

**Enumeration.** `test/space/push-outcome.test.js` runs every cell through `push()` over a fake transport that frames
the bytes as http.js does (no network, no randomness) and asserts the table's outcome; it fails on a cell without an
expected outcome or with a different one, and prints cells explored / total. `test/space/push-outcome-boundary.test.js`
takes the canonical bytes of every definite cell and enumerates every single-bit flip, single-byte deletion, single-byte
insertion from {00 01 02 0a 20 30 6f ff} and truncation; each mutant must be the cell's own outcome or `ambiguous`
(a `cas_conflict` may soften to `push_rejected`, never the reverse). Measured 2026-10-30 (a laptop, 4 workers, other test jobs running alongside):
4,331,598 cells in 32.6 s (the test file, with 65 real-git scenarios, 54 s); 2,772 distinct definite cells,
7,419,600 mutants in 43.3 s, 0 violations. `PUSH_SPACE=quick` (the mutation gate) explores the 19,782 cells with at most
two deviations from git's canonical answer (7 s on one worker).

<!-- push-outcome: generated by scripts/space-md.mjs; do not edit by hand -->

### Axes (tagged unions)

**event** — what else happens around the exchange (14 variants)

- `clean` — nothing else
- `progress` — band 2 before the report (unpack/hook stderr via copy_to_sideband) and after it (post-receive)
- `keepalive` — an empty band-1 packet "0005\1" before and after the report: copy_to_sideband sends it while hooks run (use_keepalive is KEEPALIVE_ALWAYS from execute_commands on, so post-receive too)
- `band3Before` — band 3 before the report: demultiplex_sideband reports "remote error"; receive-pack itself never writes band 3
- `band3After` — band 3 after the report, before the outer flush
- `errPkt` — an "ERR " pkt before the report: packet_read dies (PACKET_READ_DIE_ON_ERR_PACKET in send_pack)
- `dropBeforePack` — the connection fails after the commands, before the pack: the server unpacks nothing ("eof before pack header")
- `dropMidPack` — the connection fails inside the pack: index-pack/unpack-objects fails, nothing is updated
- `dropAfterPack` — the connection fails after the pack, before any response byte: the server may have updated the refs
- `refused` (what="ref") — ply refuses before sending: validateRef refuses the ref name
- `refused` (what="oid") — ply refuses before sending: an old/new oid that is not 40-hex
- `refused` (what="maxRefs") — ply refuses before sending: more commands than limits.maxRefs
- `refused` (what="packBytes") — ply refuses before sending: the built pack exceeds limits.maxPackBytes
- `refused` (what="pushOption") — ply refuses before sending: a push option containing LF

**framing** — how the report is carried (2 variants)

- `plain` — no side-band: report() write_or_die(1, …); hook output goes to stderr, not the wire
- `sideband` — side-band-64k: report pkts + flush inside one band-1 packet (send_sideband), then an outer flush (cmd_receive_pack)

**delivery** — what reaches the client of the framed response (13 variants)

- `complete` — every byte, then end of stream
- `band1Split` — one band-1 packet per inner pkt: send_sideband() chunks at LARGE_PACKET_MAX; the client reassembles band 1 as a stream
- `noFinalFlush` — the stream ends before the final flush: git dies (packet_read: "the remote end hung up") / demultiplex_sideband "unexpected disconnect"
- `noReportFlush` — the report's own flush is missing inside band 1, the outer flush present
- `cutAfterUnpack` — the stream ends cleanly after the unpack line (a cut at a pkt boundary)
- `cutMidPkt` — the stream ends inside the last data pkt
- `trailingPkt` — a second copy of the report after the final flush
- `throwAfter` — every byte, then the transport fails (connection reset after the flush)
- `flood` — 16 extra report lines: exceeds the client's report-line cap
- `trailingFlush` — a second flush after the final flush
- `band1Trailing` (extra="partial") — band 1 carries two more bytes after the report's flush (a pkt cut inside band 1)
- `band1Trailing` (extra="flush") — band 1 carries a second report flush
- `wrongBand` (band=5) — the report on band 5: one bit from band 1 (demultiplex_sideband: "bad band")

**refs** — number of commanded refs (3 variants)

- `one` — single-ref push (the edit pipeline)
- `two` — smallest multi-ref push: first and last ref differ
- `three` — a ref with neighbours on both sides (an interior position)

**commands** — what the commands ask for; decides whether a pack is sent (2 variants)

- `withPack` — some new oid is non-zero: cmd_receive_pack runs unpack_with_sideband()
- `deleteOnly` — every new oid is zero: delete_only() skips unpack, so the status is always "unpack ok"

**atomic** — the atomic capability (2 variants)

- `off` — execute_commands_non_atomic(): one transaction per ref
- `on` — execute_commands_atomic(): one transaction; a failure inside it marks every other command "atomic push failure"

**format** — report-status v1 or v2, and option lines (4 variants)

- `v1` — report(): unpack line, one ok/ng line per command, flush
- `v2` — report_v2() without proc-receive: byte-identical to report()
- `v2Options` — report_v2(): "option forced-update" after each ok, written only for proc-receive reports
- `v1Options` — option lines when report-status-v2 was not negotiated: report() never writes them

**unpack** — the unpack line (6 variants)

- `ok` — report(): "unpack ok" when unpack_status is NULL
- `gitError` (status="unpack-objects abnormal exit") — unpack(): one of git's fixed failure strings (observed with a corrupted pack)
- `absent` — no unpack line: send-pack.c receive_unpack_status fails
- `unreadable` — status bytes 0xff 0xfe: not text
- `nearMiss` (status="ok*") — one flip from "ok" (issue #33): neither "ok" nor a git failure string
- `duplicated` — two "unpack ok" lines: receive_unpack_status reads one; the second is an invalid ref status

**status** — every commanded ref's status (a mixed report overrides one ref, see spread) (10 variants)

- `ok` — report(): "ok <ref>" when cmd->error_string is NULL
- `ngCas` (reason="failed to update ref") — execute_commands_non_atomic(): ref_transaction_commit failed (stale old oid; observed from git 2.50)
- `ngHook` (reason="hook declined") — update(): the update hook refused (observed)
- `ngAtomic` (reason="atomic push failure") — execute_commands_atomic(): the innocent members of a failed atomic push (observed)
- `ngUnpacker` (reason="unpacker error") — execute_commands(): every command, and only when unpack failed
- `missing` — no status line for a commanded ref: report() writes one per command, so never git
- `duplicate` — the ref's "ok" line twice: report() writes one per command; report_v2 repeats "ok" only with option lines (proc-receive)
- `unexpected` — the ref's line names refs/heads/zz, a ref not commanded (send-pack.c receive_status: "unknown ref")
- `unreadable` — the status word is not text (0xff 0xfe): send-pack.c receive_status "invalid ref status"
- `nearMiss` — "ng <ref>" with no reason: report() always writes a reason; send-pack.c would read it as "failed"

**spread** — statuses across refs: uniform, or one ref (at index `at`) differs (31 variants)

- `uniform` — every ref has `status`
- `mixed` — at ∈ {0, 1, 2} × odd ∈ the 10 `status` tags: 30 variants (the odd ref's status overrides `status` for ref `at`)

### Product

Raw product: 14 × 2 × 13 × 3 × 2 × 2 × 4 × 6 × 10 × 31 = **32,497,920** (event × framing × delivery × refs × commands × atomic × format × unpack × status × spread).

| removed | why | raw cells |
|---|---|---:|
| impossible | plain framing has no band 1, 2 or 3 (use_sideband=0: hook output goes to stderr) | 5,535,360 |
| impossible | a delete-only push sends no pack, so it cannot be cut inside or after one, nor refused for its size | 133,920 |
| impossible | one ref cannot be mixed | 2,707,200 |
| impossible | the odd ref index is beyond the commanded refs | 902,400 |
| impossible | a mixed report whose odd status equals the common status is the uniform cell | 451,200 |
| collapsed | no response is read (refused before sending, or the connection failed first): the response axes are irrelevant (framing, delivery, format, unpack, status, spread keep their first variant) | 18,436,242 |

**Cells: 4,331,598.** Expected outcomes: ambiguous 4,326,000, rejected(push_rejected) 3,080, rejected(cas_conflict) 1,456, partial 840, landed 168, preSend(bad_request) 36, preSend(limit_exceeded) 18.

### Observed from git (63 cells; the other 4,331,535 are derived)

- `clean/plain/complete/one/withPack/off/v1/ok/ok/uniform` — all ok one/plain/v1/atomic off
- `clean/plain/complete/one/withPack/on/v1/ok/ok/uniform` — all ok one/plain/v1/atomic on
- `clean/plain/complete/one/withPack/off/v2/ok/ok/uniform` — all ok one/plain/v2/atomic off
- `clean/plain/complete/one/withPack/on/v2/ok/ok/uniform` — all ok one/plain/v2/atomic on
- `clean/sideband/complete/one/withPack/off/v1/ok/ok/uniform` — all ok one/sideband/v1/atomic off
- `clean/sideband/complete/one/withPack/on/v1/ok/ok/uniform` — all ok one/sideband/v1/atomic on
- `clean/sideband/complete/one/withPack/off/v2/ok/ok/uniform` — all ok one/sideband/v2/atomic off
- `clean/sideband/complete/one/withPack/on/v2/ok/ok/uniform` — all ok one/sideband/v2/atomic on
- `clean/plain/complete/two/withPack/off/v1/ok/ok/uniform` — all ok two/plain/v1/atomic off
- `clean/plain/complete/two/withPack/on/v1/ok/ok/uniform` — all ok two/plain/v1/atomic on
- `clean/plain/complete/two/withPack/off/v2/ok/ok/uniform` — all ok two/plain/v2/atomic off
- `clean/plain/complete/two/withPack/on/v2/ok/ok/uniform` — all ok two/plain/v2/atomic on
- `clean/sideband/complete/two/withPack/off/v1/ok/ok/uniform` — all ok two/sideband/v1/atomic off
- `clean/sideband/complete/two/withPack/on/v1/ok/ok/uniform` — all ok two/sideband/v1/atomic on
- `clean/sideband/complete/two/withPack/off/v2/ok/ok/uniform` — all ok two/sideband/v2/atomic off
- `clean/sideband/complete/two/withPack/on/v2/ok/ok/uniform` — all ok two/sideband/v2/atomic on
- `clean/plain/complete/three/withPack/off/v1/ok/ok/uniform` — all ok three/plain/v1/atomic off
- `clean/plain/complete/three/withPack/on/v1/ok/ok/uniform` — all ok three/plain/v1/atomic on
- `clean/plain/complete/three/withPack/off/v2/ok/ok/uniform` — all ok three/plain/v2/atomic off
- `clean/plain/complete/three/withPack/on/v2/ok/ok/uniform` — all ok three/plain/v2/atomic on
- `clean/sideband/complete/three/withPack/off/v1/ok/ok/uniform` — all ok three/sideband/v1/atomic off
- `clean/sideband/complete/three/withPack/on/v1/ok/ok/uniform` — all ok three/sideband/v1/atomic on
- `clean/sideband/complete/three/withPack/off/v2/ok/ok/uniform` — all ok three/sideband/v2/atomic off
- `clean/sideband/complete/three/withPack/on/v2/ok/ok/uniform` — all ok three/sideband/v2/atomic on
- `clean/plain/complete/two/withPack/off/v1/ok/ok/mixed(at=1,odd=ngHook)` — update hook refuses r1 two/plain/v1; hidden ref, non-atomic plain
- `clean/plain/complete/two/withPack/on/v1/ok/ngAtomic(reason=atomic push failure)/mixed(at=1,odd=ngHook)` — update hook refuses r1, atomic two/plain/v1
- `clean/plain/complete/two/withPack/off/v2/ok/ok/mixed(at=1,odd=ngHook)` — update hook refuses r1 two/plain/v2
- `clean/plain/complete/two/withPack/on/v2/ok/ngAtomic(reason=atomic push failure)/mixed(at=1,odd=ngHook)` — update hook refuses r1, atomic two/plain/v2
- `progress/sideband/complete/two/withPack/off/v1/ok/ok/mixed(at=1,odd=ngHook)` — update hook refuses r1 two/sideband/v1
- `progress/sideband/complete/two/withPack/on/v1/ok/ngAtomic(reason=atomic push failure)/mixed(at=1,odd=ngHook)` — update hook refuses r1, atomic two/sideband/v1
- `progress/sideband/complete/two/withPack/off/v2/ok/ok/mixed(at=1,odd=ngHook)` — update hook refuses r1 two/sideband/v2
- `progress/sideband/complete/two/withPack/on/v2/ok/ngAtomic(reason=atomic push failure)/mixed(at=1,odd=ngHook)` — update hook refuses r1, atomic two/sideband/v2
- `clean/plain/complete/three/withPack/off/v1/ok/ok/mixed(at=1,odd=ngHook)` — update hook refuses r1 three/plain/v1
- `clean/plain/complete/three/withPack/on/v1/ok/ngAtomic(reason=atomic push failure)/mixed(at=1,odd=ngHook)` — update hook refuses r1, atomic three/plain/v1
- `clean/plain/complete/three/withPack/off/v2/ok/ok/mixed(at=1,odd=ngHook)` — update hook refuses r1 three/plain/v2
- `clean/plain/complete/three/withPack/on/v2/ok/ngAtomic(reason=atomic push failure)/mixed(at=1,odd=ngHook)` — update hook refuses r1, atomic three/plain/v2
- `progress/sideband/complete/three/withPack/off/v1/ok/ok/mixed(at=1,odd=ngHook)` — update hook refuses r1 three/sideband/v1
- `progress/sideband/complete/three/withPack/on/v1/ok/ngAtomic(reason=atomic push failure)/mixed(at=1,odd=ngHook)` — update hook refuses r1, atomic three/sideband/v1
- `progress/sideband/complete/three/withPack/off/v2/ok/ok/mixed(at=1,odd=ngHook)` — update hook refuses r1 three/sideband/v2
- `progress/sideband/complete/three/withPack/on/v2/ok/ngAtomic(reason=atomic push failure)/mixed(at=1,odd=ngHook)` — update hook refuses r1, atomic three/sideband/v2
- `clean/plain/complete/two/withPack/off/v1/ok/ngHook(reason=hook declined)/uniform` — pre-receive refuses plain
- `clean/plain/complete/one/withPack/off/v1/ok/ngCas(reason=failed to update ref)/uniform` — stale old oid plain
- `clean/plain/complete/two/withPack/off/v1/ok/ok/mixed(at=0,odd=ngCas)` — stale old oid, two refs plain
- `clean/plain/complete/one/withPack/off/v1/gitError(status=unpack-objects abnormal exit)/ngUnpacker(reason=unpacker error)/uniform` — corrupted pack plain
- `clean/plain/complete/two/withPack/on/v1/gitError(status=unpack-objects abnormal exit)/ngUnpacker(reason=unpacker error)/uniform` — corrupted pack, two refs, atomic plain
- `clean/plain/complete/one/deleteOnly/off/v1/ok/ok/uniform` — delete plain; delete with an unknown old oid plain
- `clean/plain/complete/two/deleteOnly/off/v1/ok/ok/mixed(at=1,odd=ngCas)` — delete two, one stale plain
- `clean/plain/complete/two/withPack/on/v1/ok/ok/mixed(at=1,odd=ngHook)` — hidden ref, atomic plain
- `progress/sideband/complete/two/withPack/off/v1/ok/ngHook(reason=hook declined)/uniform` — pre-receive refuses sideband
- `progress/sideband/complete/one/withPack/off/v1/ok/ngCas(reason=failed to update ref)/uniform` — stale old oid sideband
- `progress/sideband/complete/two/withPack/off/v1/ok/ok/mixed(at=0,odd=ngCas)` — stale old oid, two refs sideband
- `progress/sideband/complete/one/withPack/off/v1/gitError(status=unpack-objects abnormal exit)/ngUnpacker(reason=unpacker error)/uniform` — corrupted pack sideband
- `progress/sideband/complete/two/withPack/on/v1/gitError(status=unpack-objects abnormal exit)/ngUnpacker(reason=unpacker error)/uniform` — corrupted pack, two refs, atomic sideband
- `clean/sideband/complete/one/deleteOnly/off/v1/ok/ok/uniform` — delete sideband
- `progress/sideband/complete/two/deleteOnly/off/v1/ok/ok/mixed(at=1,odd=ngCas)` — delete two, one stale sideband
- `progress/sideband/complete/one/deleteOnly/off/v1/ok/ok/uniform` — delete with an unknown old oid sideband
- `clean/sideband/complete/two/withPack/off/v1/ok/ok/mixed(at=1,odd=ngHook)` — hidden ref, non-atomic sideband
- `clean/sideband/complete/two/withPack/on/v1/ok/ok/mixed(at=1,odd=ngHook)` — hidden ref, atomic sideband
- `progress/sideband/complete/two/withPack/off/v1/ok/ok/uniform` — noisy hooks, band 2 before and after the report
- `keepalive/sideband/complete/one/withPack/off/v1/ok/ok/uniform` — slow hooks: keepalives before and after the report
- `dropBeforePack/plain/complete/one/withPack/off/v1/ok/ok/uniform` — connection fails: dropBeforePack
- `dropMidPack/plain/complete/one/withPack/off/v1/ok/ok/uniform` — connection fails: dropMidPack
- `dropAfterPack/plain/complete/one/withPack/off/v1/ok/ok/uniform` — connection fails: dropAfterPack

<!-- push-outcome: end generated -->

## Fsck tree entries

**Decision.** Given the bytes of a tree object (every read path parses one: readFile, listTree, editFile, pushTree,
merge, rebase, checkoutTree; `src/objects.js` parseTree), does ply read it or refuse it (`pack_corrupt`), and what mode
does it report for each entry? Then, given an accepted entry, may checkoutDir write it to disk?

**Principle.** ply reads exactly the trees `git fsck --strict` reports no error for, and reports each entry's mode as
git's tree readers see it (object.h canon_mode on the low 16 bits; `git ls-tree` prints the same). A warning git exits
0 on (INFO under --strict) is decided per msgId below. checkoutDir writes exactly what git's checkout (read-cache.c
verify_path) writes on that platform. The source is git v2.50.0: fsck.c fsck_tree, fsck_finish/fsck_blobs (the
.gitmodules and .gitattributes it collects), verify_ordered; tree-walk.c decode_tree_entry; object.h parse_mode and
canon_mode; utf8.c is_hfs_dot*; path.c is_ntfs_dot*; read-cache.c verify_path/verify_dotfile; compat/mingw.c
is_valid_win32_path.

**git's shape, from the source.**

- *Modes.* parse_mode reads octal digits into an `unsigned int` and stores a `uint16_t`, so only the low 16 bits exist:
  `7100644` and `300644` are 100644 to git, with not even a warning. fsck_tree's switch accepts 100755, 100644, 120000,
  40000, 160000; 100664 only without --strict; anything else is badFilemode, which is INFO, so a warning even under
  --strict. Every other reader canonicalises: a regular file is 100755 if the owner-execute bit is set, else 100644; a
  type git does not know (1, 140000, 200644, 777777) is a gitlink. A leading `0` is zeroPaddedFilemode (WARN).
- *Names.* An empty name never reaches fsck_tree's emptyName: decode_tree_entry refuses it ("empty filename in tree
  entry") and fsck reports badTree. `.git` is refused in every spelling HFS+ or NTFS resolves to it, on every platform:
  ASCII case, NTFS trailing dots and spaces, an NTFS stream (`.git:x`), the short name `git~1` (only ~1: git puts .git
  first), the HFS+ ignorable code points anywhere, an invalid UTF-8 sequence after `.git` (next_hfs_char reads it as the
  end), and the same NTFS spellings after any backslash. A name over 4096 bytes is largePathname.
- *Dotfiles.* `.gitmodules` in any HFS/NTFS spelling (`gitmod~1`, the fallback `gi7eba~N`, even `~1234567`, and after a
  backslash) as a symlink is gitmodulesSymlink (ERROR); as anything else its object is checked in fsck_finish, so a tree
  there is gitmodulesBlob and a gitlink (whose commit is never in the repository) gitmodulesMissing. `.gitattributes`
  likewise (gitattributesBlob, gitattributesMissing; but as a symlink only gitattributesSymlink, INFO). `.gitignore` and
  `.mailmap` as symlinks are INFO.
- *Checkout.* verify_path, with core.protectNTFS on by default everywhere and core.protectHFS on macOS, refuses a subset
  of what fsck --strict refuses, on Linux and macOS: the enumerator checks every accepted (name, mode) with `git read-tree`
  under both protections. On Windows a backslash is a separator and is refused outright, and is_valid_win32_path refuses
  reserved device names, `: < > " | ? *`, controls and a trailing space or period: derived from the source (no git for
  Windows runs here), held by checkoutPathRefusal.

**Judgment calls.**

1. *badFilemode is accepted* and reported canonically. Real repositories carry 100664 from git's first weeks, and git
   checks them out (the enumerator's end-to-end test: `git clone` and checkoutDir of 100600, 100664, 100700, 7100644,
   40755, 1 and 140000 are `diff -r` identical).
2. *A symlinked .gitattributes, .gitignore or .mailmap is accepted* (INFO). merge reads a symlinked .gitattributes as its
   blob, as attr.c read_attr_from_blob does (no mode check).
3. *A .gitmodules or .gitattributes gitlink is refused*, although fsck_finish would accept one whose oid happened to name
   a blob in the repository: ply cannot see the object's type when it parses the tree, and a gitlink's commit is not in
   the repository it points from.
4. *.gitattributes contents over git's caps* (a line of 2048 bytes or more, a blob over 100 MiB) are an fsck error in
   the blob, not the tree; ply never parses blob contents as objects, and where it reads .gitattributes (merge) it
   ignores such a line or blob exactly as attr.c does (`>=`, one byte stricter than fsck's `>` on the size). Checked
   against `git check-attr --source` at 2047, 2048 and 2049 bytes, blob and symlink (FSCK_TREE_LARGE=1 adds 100 MiB - 1,
   100 MiB and 100 MiB + 1; run 2026-10-31, all 9 cells agree).
5. *On Windows checkoutDir refuses (`unsupported`)* a path git for Windows refuses; on Linux a backslash is a name byte
   and is written as git writes it.

**Where main (c2ccba2) and train/1 (77eb2c0) disagreed with the table** (`FSCK_TREE_SRC=<git archive REV src>`): main
5,056 of 24,864 cells, train/1 4,094.

| cells main / train/1 | table → ply | cause |
|---:|---|---|
| 2,922 / 2,874 | refuse → accept | no check for nullSha1, largePathname, gitmodulesSymlink, gitmodulesBlob/Missing, gitattributesBlob/Missing; hasDotgit missed for `.git:x`, `git~1:x`, `.git\xff`, `.git` + an encoded surrogate, `a\.git`, `a\git~1` |
| 72 / 72 | accept → refuse | `git~2` refused as .git (only `git~1` is .git's short name) |
| 836 / 836 | accept, wrong mode | the raw mode returned (100664, 40755, 7100644, 1, ...): readers comparing with `40000` or `100644` saw a different type than git |
| 1,176 / 312 | refuse, under a msgId git did not report | both: `git~2` called a bad name where git refuses the tree for another reason (264), a zero-padded entry with an empty name called zero-padded where git says badTree (48); main also: duplicates called "not sorted" (#34, fixed on train/1) |
| 50 / 0 | names | main: non-UTF-8 names decoded lossily (#43, fixed on train/1) |

**Security.** On main and train/1, checkoutDir wrote a `.gitmodules` symlink (git refuses to check one out: CVE-2018-11235's
class), and on Windows would have written `a\.git\hooks\…` into a nested `.git` and `..\x` outside the target
directory (git for Windows refuses any backslash). Both are refused now: the first by parseTree, the others by validatePath
and checkoutPathRefusal.

**Enumeration.** `test/space/fsck-tree.test.js` builds every cell byte for byte, writes the space as packs (node:zlib,
`git index-pack` without --strict, which judges nothing) and every 40th cell loose with `git hash-object --literally`,
and runs `git fsck --strict` (both streams, exit code, every `error in`/`warning in` line, each pinned to the cell that
owns an oid in it). It fails on any cell where the model's msgIds differ from git's, where ply's verdict differs from the
table, where ply's refusal names no msgId git reported, or where an accepted entry's mode is not canon_mode. Measured
2026-10-31 (laptop, git 2.50.0): 24,864 cells, 31,365 objects, 0 disagreements, about 4 s.

<!-- fsck-tree: generated by scripts/space-md.mjs; do not edit by hand -->

### Axes (tagged unions)

**trigger** — the other entry in the tree, carrying one fsck_tree msgId's trigger (19 variants)

- `alone` — a one-entry tree
- `plain` `100644 m` — an ordinary sibling
- `nullSha1` `100644 n` — is_null_oid
- `fullPathname` `100644 m/n` — strchr(name, '/')
- `emptyName` `100644 ` — an empty name: badTree (decode_tree_entry)
- `malformedMode` `10x644 m` — parse_mode: a non-octal digit, "malformed mode in tree entry": badTree
- `hasDot` `100644 .` — "."
- `hasDotdot` `100644 ..` — ".."
- `hasDotgit` `100644 .git` — is_hfs_dotgit || is_ntfs_dotgit
- `zeroPaddedFilemode` `0100644 m` — the mode's first byte is '0'
- `badFilemode` `100664 m` — S_IFREG|0664 under --strict
- `gitmodulesSymlink` `120000 .gitmodules` — S_ISLNK on a .gitmodules
- `gitmodulesBlob` `40000 .gitmodules` — a .gitmodules that is a tree: fsck_finish "non-blob found at .gitmodules"
- `gitattributesSymlink` `120000 .gitattributes` — S_ISLNK on a .gitattributes (INFO)
- `gitattributesMissing` `160000 .gitattributes` — a .gitattributes gitlink: fsck_finish cannot read the blob
- `gitignoreSymlink` `120000 .gitignore` — S_ISLNK on a .gitignore (INFO)
- `mailmapSymlink` `120000 .mailmap` — S_ISLNK on a .mailmap (INFO)
- `largePathname` `100644 m×4097` — tree_entry_len > 4096
- `duplicateEntries` — the cell's own name again, as 100644: verify_ordered TREE_HAS_DUPS

**mode** — the cell entry's mode bytes: every class fsck_tree's switch and parse_mode tell apart (14 variants)

- `blob` `100644` — S_IFREG|0644: standard
- `exec` `100755` — S_IFREG|0755: standard
- `symlink` `120000` — S_IFLNK: standard
- `tree` `40000` — S_IFDIR: standard
- `gitlink` `160000` — S_IFGITLINK: standard
- `group` `100664` — S_IFREG|0664: "we had a few of these early on"; badFilemode only under --strict
- `private` `100600` — S_IFREG|0600: badFilemode (INFO); canon_mode 100644
- `dir755` `40755` — S_IFDIR|0755: badFilemode; S_ISDIR, so it sorts and reads as a tree
- `gitlinkPerm` `160644` — S_IFGITLINK|0644: badFilemode; canon_mode 160000
- `zeroPadded` `0100644` — a leading 0: zeroPaddedFilemode (WARN), and the value is still 100644
- `zeroPaddedTree` `040000` — the zero-padded tree mode old tools wrote: zeroPaddedFilemode
- `truncated` `7100644` — parse_mode keeps 16 bits: 07100644 & 0xffff is 0100644, a standard mode (no report at all)
- `unknownType` `1` — type bits 0: badFilemode; canon_mode makes it a gitlink
- `allBits` `777777` — 0177777: badFilemode; type 0170000 is no type git knows, so a gitlink

**name** — the cell entry's name bytes: every spelling fsck_tree and verify_path tell apart (48 variants)

- `plain` "a" — an ordinary name
- `dot` "." — hasDot
- `dotdot` ".." — hasDotdot
- `empty` "" — decode_tree_entry: "empty filename in tree entry", so badTree (emptyName is unreachable)
- `slash` "a/b" — fullPathname
- `dotgit` ".git" — hasDotgit
- `DOTGIT` ".GIT" — is_ntfs_dotgit and is_hfs_dotgit fold ASCII case
- `DotGit` ".Git" — mixed case
- `short1` "git~1" — is_ntfs_dotgit: the 8.3 short name of .git
- `SHORT1` "GIT~1" — the short name, upper case
- `short2` "git~2" — not .git: git guarantees .git takes ~1 (path.c), so ~2 is an ordinary name
- `short10` "git~10" — git~1 followed by a digit: an ordinary name
- `trailDot` ".git." — NTFS trims trailing dots
- `trailSpace` ".git " — NTFS trims trailing spaces
- `trailMixed` ".git. ." — dots and spaces, any mix
- `stream` ".git:x" — an NTFS alternate data stream of .git
- `shortStream` "git~1:x" — a stream of the short name
- `dotgitx` ".gitx" — a longer name: ordinary
- `hfsZwnj` ".g\xe2\x80\x8cit" — HFS+ ignores U+200C
- `hfsBom` "\xef\xbb\xbf.git" — HFS+ ignores U+FEFF, also in front
- `hfsLrm` ".git\xe2\x80\x8e" — HFS+ ignores U+200E, also at the end
- `hfsBadTail` ".git\xff" — next_hfs_char reads an invalid sequence as the end of the name: .git
- `hfsSurrogate` ".git\xed\xa0\x80" — a UTF-8-encoded surrogate is invalid to pick_one_utf8_char: the end, so .git
- `badLead` "\xff.git" — invalid UTF-8 before the dot: not .git to HFS, not to NTFS
- `overlongDot` "\xc0\xaegit" — an overlong "." is invalid, never a dot
- `backslash` "a\.git" — fsck_tree reads a backslash as a separator (is_ntfs_dotgit after it) on every platform
- `backslashShort` "a\git~1" — the short name after a backslash
- `backslashDotdot` "..\x" — fsck checks only .git after a backslash: accepted, and `..` on Windows
- `gitmodules` ".gitmodules" — gitmodulesSymlink as a symlink; collected for fsck_finish otherwise
- `GITMODULES` ".GITMODULES" — case
- `gitmodulesTrail` ".gitmodules ." — is_ntfs_dot_generic: trailing spaces and dots
- `gitmodulesStream` ".gitmodules:x" — a stream
- `gitmodulesShort` "gitmod~1" — the 6-character short name, ~1 to ~4
- `gitmodulesShort5` "gitmod~5" — ~5 is past the regular short names, and gitmod is not the fallback prefix: ordinary
- `gitmodulesFallback` "GI7EBA~1" — the fallback short name (hash prefix gi7eba)
- `gitmodulesFallback9` "gi7eba~9" — the fallback allows ~1 to ~9
- `tildeDigits` "~1234567" — is_ntfs_dot_generic's fallback loop takes a leading ~ and digits as every dotfile's short name
- `gitmodulesHfs` ".gitmodu\xe2\x80\x8dles" — HFS+ ignorable inside
- `gitmodulesBackslash` "a\.gitmodules" — is_ntfs_dotgitmodules after a backslash
- `gitattributes` ".gitattributes" — gitattributesSymlink (INFO) as a symlink
- `gitattributesShort` "gi7d29~1" — its fallback short name
- `gitattributesBackslash` "a\.gitattributes" — fsck_tree checks only .gitmodules after a backslash
- `gitignore` ".gitignore" — gitignoreSymlink (INFO)
- `gitignoreShort` "gi250a~1" — its fallback short name
- `mailmap` ".mailmap" — mailmapSymlink (INFO)
- `mailmapShort` "maba30~1" — its fallback short name
- `long4096` "l×4096" — max_tree_entry_len: 4096 bytes is allowed
- `long4097` "l×4097" — largePathname

**position** — the order of the two entries in the tree bytes (the tree is sorted or not as the names fall) (2 variants)

- `cellFirst` — the cell entry, then the trigger entry
- `triggerFirst` — the trigger entry, then the cell entry

### Product

Raw product: 19 × 14 × 48 × 2 = **25,536** (trigger × mode × name × position); a one-entry tree has no order: **24,864 cells**.

Expected: ply accepts 1,350, refuses 23,514. Cells per msgId git reports (a cell can have several):

| msgId | cells |
|---|---:|
| `badFilemode (warning)` | 10,058 |
| `treeNotSorted` | 9,744 |
| `hasDotgit` | 9,184 |
| `zeroPaddedFilemode` | 4,432 |
| `badTree` | 3,150 |
| `gitmodulesBlob` | 2,320 |
| `fullPathname` | 1,792 |
| `hasDot` | 1,792 |
| `hasDotdot` | 1,792 |
| `largePathname` | 1,792 |
| `gitattributesMissing` | 1,726 |
| `gitmodulesSymlink` | 1,660 |
| `duplicateEntries` | 1,568 |
| `gitattributesSymlink (warning)` | 1,429 |
| `gitignoreSymlink (warning)` | 1,429 |
| `mailmapSymlink (warning)` | 1,429 |
| `gitmodulesMissing` | 1,400 |
| `nullSha1` | 1,330 |
| `gitattributesBlob` | 315 |

### Decisions for the warnings git exits 0 on

- `badFilemode` → accept: git reads every such mode through canon_mode (100664 → 100644, 40755 → a tree, an unknown type → a gitlink) and checks it out; real repositories carry 100664 from git's first weeks. ply returns the canonical mode, as `git ls-tree` prints it
- `gitattributesSymlink` → accept: git reads a symlinked .gitattributes from a tree as the blob it is (attr.c read_attr_from_blob has no mode check) and only declines to follow one in a worktree; ply has no worktree, and merge reads it as git merge-tree does
- `gitignoreSymlink` → accept: ply never reads .gitignore
- `mailmapSymlink` → accept: ply never reads .mailmap

<!-- fsck-tree: end generated -->

## Advertisement

**Decision.** What does ply do with what a server says about itself (the v2 capability advertisement, the ls-refs
listing, the receive-pack capability list), and with what ply asks of it (atomic, push options, fetch arguments)? Four
decisions, one space (`test/space/advertisement.space.js`):

| decision | ply entry point | outcome |
|---|---|---|
| `caps` | `discover()` | `ok` with the parsed capabilities, or `unsupported` / `protocol` / `remote_error` / `not_git` / `network` |
| `refs` | `lsRefs()` | `ok` with the refs and HEAD's target, or `protocol` / `unsupported` / `remote_error` |
| `push` | `GitHttp.push` (`pushWithOptions`) | `landed`, or `unsupported` before a byte of the push is sent, or `ambiguous` (push-outcome's rule) |
| `request` | `fetchPack()` | `ok` with the request lines and pack-objects invocation git's own request gets, or `protocol` |

**Principle.** ply proceeds when git proceeds, and gives a typed refusal when git refuses or when a feature ply needs
is absent. Every cell's expected value carries both sides (`git`: ok or refuse; `ply`: the outcome), and
`consistent()` checks the rule on every cell: ply never proceeds where git refuses, and refuses where git proceeds only
for a need it names (`PLY_NEEDS`: v2, the fetch command, sha1).

**git's reading, from the source** (git v2.50.0):

- `connect.c` `process_capabilities_v2` reads capability lines up to a flush and dies "expected flush after
  capabilities" on anything else; over HTTP a pkt after that flush is handed on as the ls-refs response ("invalid
  ls-refs response"). `server_supports_v2` (presence: `key` or `key=…`), `server_feature_v2` (value: the first `key=…`;
  a bare `object-format` is no value, so sha1) and `server_supports_feature` (the first `key`/`key=…` line, its value
  split on whitespace by `parse_feature_value`) all take the **first** matching line. `send_capabilities` dies "unknown
  object format" on a name `hash_algo_by_name` does not know; `get_remote_refs` dies "server doesn't support 'ls-refs'".
- `process_ref_v2` splits a record on every space (a doubled space is an empty field, an empty second field a ref
  named ""), skips an `unborn <name> …` record (it records HEAD's unborn target only for a clone that asked), reads the
  oid with `parse_oid_hex_algop` (either case), keeps `symref-target:` and `peeled:` and skips every other attribute; a
  bad peeled oid or a record of fewer than two fields is "invalid ls-refs response". A name listed twice stays twice in
  the list and `find_ref_by_name` takes the first (observed: `git fetch` of it fetches the first oid).
- `pkt-line.c` `packet_read_with_status` dies "protocol error: bad line length" once a payload is ≥ its buffer,
  `packet_buffer[LARGE_PACKET_MAX]`: it reads payloads up to 65519 bytes.
- `send-pack.c` `send_pack` checks, before sending anything, the repository hash against `object-format` (absent is
  sha1), then `--atomic` against `atomic`, then push options against `push-options`. `builtin/receive-pack.c` honours a
  client's `atomic` / `push-options` only when it advertised them, and dies on commands in another hash.
- `upload-pack.c` `process_args` accepts `no-progress`, `include-tag` and `deepen-relative` unconditionally and `filter`
  only with `uploadpack.allowFilter`; `fetch-pack.c` warns "filtering not recognized by server, ignoring" and fetches
  everything.

**Judgment calls.**

1. *A plain push to a sha256 repository is `ambiguous`.* ply reads the receive-pack advertisement only when the push
   needs a capability (atomic, push options); a plain push saves that round trip, receive-pack dies reading the sha1
   commands and writes no report. Every ply flow reads ls-refs first, which refuses a sha256 listing as `unsupported`.
2. *A filter the server cannot honour is refused* (`protocol`: upload-pack dies on the unexpected `filter` line and the
   stream ends without its flush), where git warns and fetches everything: `fetchObject`'s bounded memory rests on the
   filter it asked for.
3. *v0 / v1 servers, a server without `fetch`, and sha256* are `unsupported` though `git ls-remote` proceeds: ply is
   v2-only, every ply read is ls-refs then fetch, and ply is sha1-only.
4. *Precedence among refusals* in `discover()`: the pkt framing, the protocol, the advertisement's framing, ls-refs and
   fetch present, the object format. git reads the object format only when it sends ls-refs, but every cell where the
   orders differ is a refusal on both sides.

**Found** (each a cell class that disagreed with git on train/1, 77eb2c0; all fixed here):

| # | where | train/1 | git | now |
|---|---|---|---|---|
| 1 | discover: a capability listed twice | the last line wins (sha1 after sha256 proceeds; sha256 after sha1 refuses) | the first wins | the first wins |
| 2 | discover: `object-format` with no `=` | `unsupported` | sha1, proceeds | sha1 |
| 3 | discover: no flush, or a delim, after the capabilities | proceeds | "expected flush after capabilities" | `protocol` |
| 4 | discover: a pkt after the capabilities' flush | read as a capability, proceeds | refuses | `protocol` |
| 5 | discover: no `ls-refs` (or no `fetch`) | proceeds | "server doesn't support 'ls-refs'" | `unsupported` |
| 6 | discover: `ERR` as the first line | `unsupported` | "remote error" | `remote_error` |
| 7 | every pkt-line reader: a payload of 65520–65531 bytes | accepted | "bad line length" | `protocol` |
| 8 | ls-refs: an `unborn …` record | `protocol` | skipped | skipped |
| 9 | ls-refs: an upper-case oid or peeled oid | `protocol` | accepted | accepted, kept lower-case |
| 10 | ls-refs: an empty name (`<oid> `, `<oid>  <name>`) | `protocol` | a ref named "" | a ref named "" |
| 11 | ls-refs: a name listed twice | the last listing | the first | the first |
| 12 | push: `atomic` to a server that does not advertise it | sent; receive-pack ignored it and the refs landed one by one; `landed` | refuses before sending | `unsupported` before sending |
| 13 | push: atomic or push options to a sha256 repository | advertisement read, hash ignored, pushed: `ambiguous` | refuses before sending | `unsupported` before sending |

The request decision found nothing: for each of `no-progress`, its absence, `include-tag`, `deepen-relative` and
`filter`, ply's request lines equal git's own request for the same fetch and upload-pack invokes pack-objects with the
same argv and stdin.

**Enumeration.** `test/space/advertisement.test.js` runs every caps and refs cell through ply's real path
(`createTransport` with an in-process fetch serving the rendered bytes) and compares the table. Observed: a synthetic
smart-HTTP server serves each observed cell's advertisement and ls-refs response and forwards fetch requests to `git
http-backend`; `git ls-remote` judges every caps cell within one deviation of git's default advertisement and every refs
cell, `git fetch` the fetch-feature cells (which features git uses, read from its own requests), `git push` every push
cell against receive-pack configured per cell, and `git fetch` / `git clone` each request cell (its request lines and
upload-pack's pack-objects invocation, captured by `uploadpack.packObjectsHook`). ply runs over real HTTP against the
same server. Six real http-backend configurations (default, `uploadpack.allowFilter=false`, `allowRefInWant` +
`allowSidebandAll`, `lsrefs.unborn=ignore`, `transfer.advertiseSID`, a sha256 repository) advertise exactly what the
renderer writes for their cell. `ADV_SPACE_SRC=<dir>` runs the space against another copy of `src/`.

<!-- advertisement: generated by scripts/space-md.mjs; do not edit by hand -->

### Axes (tagged unions)

**caps protocol** (8) — `v2`, `v0`, `v1`, `err`, `v2service`, `serviceNoFlush`, `html`, `reset`; only `v2` carries the capability axes

**caps (v2)**

- `agent` (3) — the agent capability: `present`, `absent`, `empty`
- `objectFormat` (6) — object-format, read by send_capabilities with server_feature_v2 (needs `=`): `sha1`, `absent`, `sha256`, `unknown`, `bare`, `empty`
- `fetch` (33) — the fetch command and its features: `absent`, `features[]`, `features[shallow wait-for-done filter ref-in-want sideband-all]` (… every subset of the five features: 32 + absent)
- `lsRefs` (3) — the ls-refs command: `unborn`, `plain`, `absent`
- `serverOption` (2) — server-option: `present`, `absent`
- `sessionId` (2) — session-id: `absent`, `present`
- `malformed` (9) — one malformation of the advertisement: `none`, `noLF`, `unknownCap`, `duplicate`, `longMax`, `longOver`, `noFlush`, `delim`, `trailing`

**refs**

- `record` (18) — one record of the listing, added to or changed in HEAD (symref), main, a tag (peeled): `plain`, `unknownAttr`, `unbornHead`, `unbornOther`, `unbornOnly`, `emptySymref`, `emptyPeeled`, `badPeeled`, `upperOid`, `upperPeeled`, `emptyName`, `doubleSpace`, `oidOnly`, `badOid`, `sha256`, `duplicate`, `capsName`, `err`
- `eol` (2) — line ends: `lf`, `none`
- `framing` (6) — the end of the listing: `flush`, `noFlush`, `delim`, `trailing`, `longMax`, `longOver`

**push**

- `request` (4) — what the push asks for: `none`, `atomic`, `options`, `both`
- `atomic` (2) — receive.advertiseAtomic: `on`, `off`
- `options` (2) — receive.advertisePushOptions: `off`, `on`
- `format` (2) — the server repository's hash: `sha1`, `sha256`

**request**

- `flag` (5) — one fetch argument ply can send (fetch.js fetchBody): `noProgress`, `progress`, `includeTag`, `deepenRelative`, `filter`
- `server` (2) — uploadpack.allowFilter: `filterOn`, `filterOff`

### Cells

| decision | cells | observed from git | derived |
|---|---:|---:|---:|
| caps | 64,159 | 59 | 64,100 |
| refs | 216 | 216 | 0 |
| push | 32 | 32 | 0 |
| request | 10 | 10 | 0 |
| **all** | **64,417** | **317** | **64,100** |

<!-- advertisement: end generated -->

## Push ng reasons

The space of git's receive-pack rejection reasons (test/space/push-ng.space.js): every reason git v2.50.0 can write × the failing command's shape × atomic × refs. Each reason's class is data, justified by what a caller can safely do next; the report git writes for each cell is derived from receive-pack.c and checked byte for byte against real git where git can be made to write it (test/space/push-ng.observed.js).

<!-- push-ng: generated by test/space/push-ng.test.js (PUSH_NG_WRITE=1); do not edit by hand -->

Axes: reason(42) × command(8) × atomic(2) × refs(3) × era(2) = 4032 raw; 1057 cells after the impossible ones (192: the reason is written only by the other execute_commands_* (atomic-only or non-atomic-only); 1488: git does not write the reason for this command shape (REASONS[].commands; `gone` is enumerated only with the transaction's own failures, where it changes the text); 176: three commands cannot all carry the reason (REASONS[].three); 20: an aliased update needs a second command (the symref's target); 72: a push whose every command deletes sends no pack: no unpack, nothing to migrate; 1027: the batched transaction changes only the non-atomic commit failure: every other report is the same on both eras, enumerated once (v2.50)).

Observable from real git: **791** cells (git's report byte for byte = the derived one, ply's outcome = the table's, refs agree), each on the git of its era: v2.50 cells on git 2.50 (a laptop), v2.51+ cells on git >= 2.51 (CI: 2.56); a run observes its own era's cells and derives the rest. Derived from receive-pack.c only: **266** (on a run as root, the two permission recipes are derived too).

| reason (receive-pack.c line) | class | ply outcomes over its cells | cells (observed) | what a caller can safely do next |
|---|---|---|---|---|
| `eof before pack header was fully read` (2201) | unpack | rejected(push_rejected) | 38 (38) | the pack never entered the repository and no ref was touched: resending the same pack fails the same way; the caller needs a different pack or a repaired server |
| `protocol error (pack signature mismatch detected)` (2204) | unpack | rejected(push_rejected) | 38 (38) | the pack never entered the repository and no ref was touched: resending the same pack fails the same way; the caller needs a different pack or a repaired server |
| `protocol error (pack version unsupported)` (2207) | unpack | rejected(push_rejected) | 38 (38) | the pack never entered the repository and no ref was touched: resending the same pack fails the same way; the caller needs a different pack or a repaired server |
| `unknown error in parse_pack_header` (2210) | unpack | rejected(push_rejected) | 38 (0) | the pack never entered the repository and no ref was touched: resending the same pack fails the same way; the caller needs a different pack or a repaired server *Derived:* parse_pack_header() returns only the three errors above for a header it read; the default case is unreachable. |
| `unable to create temporary object directory` (2254) | unpack | rejected(push_rejected) | 38 (38) | the pack never entered the repository and no ref was touched: resending the same pack fails the same way; the caller needs a different pack or a repaired server |
| `unpack-objects abnormal exit` (2281) | unpack | rejected(push_rejected) | 38 (38) | the pack never entered the repository and no ref was touched: resending the same pack fails the same way; the caller needs a different pack or a repaired server |
| `index-pack fork failed` (2313) | unpack | rejected(push_rejected) | 38 (0) | the pack never entered the repository and no ref was touched: resending the same pack fails the same way; the caller needs a different pack or a repaired server *Derived:* start_command() failing to fork index-pack cannot be arranged from a request. |
| `index-pack abnormal exit` (2324) | unpack | rejected(push_rejected) | 38 (38) | the pack never entered the repository and no ref was touched: resending the same pack fails the same way; the caller needs a different pack or a repaired server |
| `unpacker error` (1938) | unpack | — | — (a consequence: rides on other cells) | written on every command exactly when unpack failed (execute_commands): the unpack line carries the cause; nothing moved |
| `missing necessary objects` (1777) | rejected | ambiguous, partial, rejected(push_rejected) | 36 (36) | the pack does not complete the new commit's history (set_connectivity_errors); the same pack is refused again, so retrying it is futile; a fresh read does not repair a pack |
| `deny updating a hidden ref` (1825) | rejected | ambiguous, partial, rejected(push_rejected) | 36 (36) | receive.hideRefs covers the ref: the server never lets a client write it, whatever its value |
| `deny deleting a hidden ref` (1823) | rejected | ambiguous, partial, rejected(push_rejected) | 6 (6) | receive.hideRefs covers the ref: the server never lets a client delete it, whatever its value |
| `broken symref` (1684) | rejected | ambiguous, partial, rejected(push_rejected) | 36 (36) | the ref is a symbolic ref the server cannot resolve (a loop): no value of the old oid makes it writable; the repository needs repair |
| `inconsistent aliased update` (1711) | rejected | ambiguous, partial, rejected(push_rejected) | 20 (20) | one push names a symbolic ref and its target with different updates: the request contradicts itself, and resending it is refused again |
| `shallow update not allowed` (2425) | rejected | ambiguous, partial, rejected(push_rejected) | 36 (36) | the pushed history ends at a shallow boundary the server lacks and receive.shallowUpdate is off: the same history is refused again (ply never sends shallow lines; a git client from a shallow clone does) |
| `funny refname` (1481) | rejected | preSend(bad_request) | 10 (10) | the server refuses the ref name itself (check_refname_format(name + 5), one level allowed only for a delete): no retry can succeed, so ply refuses the push before sending a byte (validatePushRef, #73; every name checked against git in test/space/refname.test.js); git's report is still observed byte for byte |
| `branch is currently checked out` (1501) | rejected | partial, rejected(push_rejected) | 28 (28) | receive.denyCurrentBranch refuses the non-bare repository's checked-out branch, whatever its value |
| `bad pack` (1515) | rejected | partial, rejected(push_rejected) | 36 (36) | the new object is not in the repository after unpack (only with the connectivity check skipped): the same pack fails again |
| `deletion prohibited` (1522) | rejected | partial, rejected(push_rejected) | 6 (6) | receive.denyDeletes: branch deletion is off on this server |
| `deletion of the current branch prohibited` (1539) | rejected | partial, rejected(push_rejected) | 4 (4) | receive.denyDeleteCurrent refuses deleting HEAD's branch, whatever its value |
| `Invalid denyDeleteCurrent setting` (1542) | rejected | partial, rejected(push_rejected) | 4 (0) | a server misconfiguration: nothing a client resends can change it *Derived:* parse_deny_action() maps every config value to a handled deny_action, so the switch's default is unreachable. |
| `bad ref` (1562) | cas | partial, rejected(cas_conflict) | 6 (6) | receive.denyNonFastForwards could not parse the old oid the command named: the server does not have it, so the ref is not at it (a stale read of a ref that has since been rewritten): a fresh read names an old oid it has (SAFETY.md I31) |
| `non-fast-forward` (1573) | nff | partial, rejected(not_fast_forward) | 6 (6) | receive.denyNonFastForwards and the new commit does not descend from the old oid the command itself named: that is true of the request whatever the ref's value, so a fresh read of the ref cannot help; only a new commit that descends from it can (it was cas_conflict: rebase's non-fast-forward push looped on it) |
| `hook declined` (1579) | rejected | partial, rejected(push_rejected) | 42 (42) | the update hook refused the ref: server policy, not a race |
| `failed to delete` (1606) | rejected | partial, rejected(push_rejected) | 6 (0) | the ref store would not queue the deletion: deterministic for this name *Derived:* ref_transaction_delete() queues a deletion and fails only on a name refname_is_safe() refuses, which check_refname_format (funny refname) refused first. |
| `shallow error` (1616) | rejected | partial, rejected(push_rejected) | 36 (0) | receive.shallowUpdate is on and the history above the shallow boundary is incomplete (update_shallow_ref): the same pack fails again *Derived:* not arranged: with receive.shallowUpdate=true, a shallow line and a pack lacking a blob above the boundary, git v2.50.0 answered "ok" for one command (the ref moved to a commit whose tree lacks the blob) and, for three, "shallow error" on the first command, then a report without the others' statuses (ply: ambiguous, a missing status). |
| `failed to update ref` (1627) | cas | partial, rejected(cas_conflict) | 36 (0) | the same text as the commit failure below, so the same class (the report cannot tell them apart) *Derived:* ref_transaction_update() queues an update and fails only on a name check_refname_format refuses, which funny refname refused first. |
| `Up-to-date check failed` (1376) | rejected | partial, rejected(push_rejected) | 20 (20) | receive.denyCurrentBranch=updateInstead: update-index --refresh failed in the server's worktree (its index is locked); the push is refused until someone changes the server's worktree |
| `Working directory has unstaged changes` (1388) | rejected | partial, rejected(push_rejected) | 20 (20) | receive.denyCurrentBranch=updateInstead: the server's worktree has unstaged changes; the push is refused until someone changes the server's worktree |
| `Working directory has staged changes` (1402) | rejected | partial, rejected(push_rejected) | 24 (24) | receive.denyCurrentBranch=updateInstead: the server's worktree has staged changes; the push is refused until someone changes the server's worktree |
| `Could not update working tree to new HEAD` (1414) | rejected | partial, rejected(push_rejected) | 24 (24) | receive.denyCurrentBranch=updateInstead: read-tree -u -m could not check out the new commit (an untracked file is in the way); the push is refused until someone changes the server's worktree |
| `push-to-checkout hook declined` (1433) | rejected | partial, rejected(push_rejected) | 24 (24) | receive.denyCurrentBranch=updateInstead: the push-to-checkout hook refused; the push is refused until someone changes the server's worktree |
| `denyCurrentBranch = updateInstead needs a worktree` (1449) | rejected | partial, rejected(push_rejected) | 24 (0) | a server misconfiguration: nothing a client resends can change it *Derived:* update() sets do_update_worktree only for a worktree that is not bare, so update_worktree() never sees a bare one. |
| `failed to update ref` (1874, 2nd site) | cas | partial, rejected(cas_conflict), rejected(push_rejected) | 30 (30) | the ref is not at the old oid the command named (a stale read, a create over an existing ref, a concurrent writer holding the lock): a fresh read and a redo can land. Also written for a D/F conflict (create refs/heads/r0/sub beside refs/heads/r0, observed): a fresh retry is safe but cannot land there, and a caller's retry budget bounds it |
| `atomic transaction failed` (1909) | cas | rejected(cas_conflict) | 15 (15) | an atomic push's single commit failed, which for a stale old oid is git v2.50.0's only report (every ref gets this text, none gets "failed to update ref", observed): the same lost race as above, so a fresh read and a redo can land (it was push_rejected: an atomic CAS loss was never retried) |
| `atomic push failure` (1886) | innocent | — | — (a consequence: rides on other cells) | an atomic push's other members after one command failed inside update(): nothing moved, and the culprit's reason decides the class |
| `transaction failed to start` (1864) | rejected | partial, rejected(push_rejected) | 21 (0) | the server could not open a ref transaction: a server fault, and nothing moved *Derived:* ref_store_transaction_begin() cannot fail in git v2.50.0 (refs.c: it only allocates). |
| `transaction failed to start` (1893, 2nd site) | rejected | rejected(push_rejected) | 21 (0) | the server could not open a ref transaction: a server fault, and nothing moved *Derived:* ref_store_transaction_begin() cannot fail in git v2.50.0 (refs.c: it only allocates). |
| `pre-receive hook declined` (1987) | rejected | rejected(push_rejected) | 42 (42) | the pre-receive hook refused the push: server policy, not a race |
| `unable to migrate objects to permanent storage` (2008) | rejected | rejected(push_rejected) | 38 (38) | the server could not move the received objects out of quarantine (a storage fault): nothing moved, and a retry needs the server repaired |
| `inconsistent push options` (2599) | rejected | rejected(push_rejected) | 42 (0) | the request contradicts its own certificate: resending it is refused again *Derived:* needs a signed push (push-cert) whose push options differ from the request's; ply never sends a push certificate. |
| `fail to run proc-receive hook` (2027) | ambiguous | ambiguous | 6 (6) | the hook could not be run, or did not finish after it was handed the command: it may have acted on the command (a review created) without saying, and the report cannot tell which; read before redoing |
| `proc-receive failed to report status` (1103) | ambiguous | ambiguous | 6 (6) | the hook was handed the command and gave no status for it: it may have acted; read before redoing |
| `failed` (1093) | rejected | ambiguous, partial, rejected(push_rejected) | 6 (6) | the proc-receive hook answered "ng <ref>" with no message: it refused the command, as an update hook does |

git >= 2.51 batched texts (era v2.51+, the non-atomic commit failure):

| text | class | what a caller can safely do next |
|---|---|---|
| `incorrect old value provided` | cas | REF_TRANSACTION_ERROR_INCORRECT_OLD_VALUE: the ref is not at the old oid the command named: a fresh read and a redo can land |
| `reference already exists` | cas | REF_TRANSACTION_ERROR_CREATE_EXISTS: a create lost to another writer's create: a fresh read finds the ref and the redo is an update |
| `reference does not exist` | cas | REF_TRANSACTION_ERROR_NONEXISTENT_REF: the ref was deleted since the read: a fresh read finds it absent (it was push_rejected: git >= 2.51's stale update of a deleted ref was never re-read) |
| `refname conflict` | rejected | REF_TRANSACTION_ERROR_NAME_CONFLICT: a D/F conflict (refs/heads/r0/sub beside refs/heads/r0): no value of the old oid makes the name free; git >= 2.51 tells it apart from a lost race, so ply need not retry it |
| `invalid new value provided` | rejected | a batched rejection that is not a lost race (a bad new value, a symref expectation, a case-only clash, an unclassified failure): resending is refused again |
| `expected symref but found regular ref` | rejected | a batched rejection that is not a lost race (a bad new value, a symref expectation, a case-only clash, an unclassified failure): resending is refused again |
| `reference conflict due to case-insensitive filesystem` | rejected | a batched rejection that is not a lost race (a bad new value, a symref expectation, a case-only clash, an unclassified failure): resending is refused again |
| `unknown failure` | rejected | a batched rejection that is not a lost race (a bad new value, a symref expectation, a case-only clash, an unclassified failure): resending is refused again |

<!-- push-ng: end generated -->

## Ref names

The space of ref names a caller can hand ply (test/space/refname.space.js, #73): `refs/` + 1, 2 or 3 components, each one of 16 shapes (`a`, `@`, `@a`, `@{a`, `{a`, `.`, `..`, `.a`, `a.`, `a.lock`, `a.lockb`, `-a`, the empty component, a control character, a space, non-ASCII), 16 + 256 + 4,096 names, plus one name per code point U+0001–U+00FF inside a component (254, LF excluded: it cannot be framed): **4,622 cells**. Every cell asks real git three questions and ply must give git's answer on every one (test/space/refname.test.js):

| question | git's oracle | ply |
|---|---|---|
| format | `git check-ref-format <name>` (refs.c check_refname_format(name, 0)) | `validateRef` |
| create | a real `git receive-pack` answering a create of the name: `ng <name> funny refname` or not (receive-pack.c update(): check_refname_format(name + 5, 0)) | `validatePushRef(name, false)`; push() refuses before sending |
| delete | the same for a delete (check_refname_format(name + 5, REFNAME_ALLOW_ONELEVEL)) | `validatePushRef(name, true)` |

Git v2.50.0 accepts 726 names as refs, 719 for a create and 725 for a delete. The create/delete gap is receive-pack's, not check-ref-format's: `refs/<one level>` (refs/stash is one) is a valid ref and can be deleted by a push but never created or updated, and `refs/@` is a valid ref no push can touch (`@` alone is refused as a whole refname). Before #73 ply validated a push's ref with `validateRef` alone and disagreed with receive-pack on 8 cells, all of them those two shapes; git refused them as `funny refname`.

## SSH handshake faults and SSH service outcomes

**Decisions.** What ply's SSH client tells the caller when the server breaks the protocol at one handshake phase
(`ssh-faults`), and when the session is fine but the git service behind the channel refuses (`ssh-service`). Both are
enumerated with OpenSSH as the oracle: every cell runs against the same server through `git ls-remote` / `git push`
over OpenSSH, and ply must land in git's class (ok / refused) unless the cell names a divergence with its reason.

**ssh-faults** (`test/space/ssh-faults.space.js`, enumerator `test/space/ssh-faults.test.js`, server `test/sshfake.js`).
Axes: phase {banner, kexinit, ecdh, newkeys, service, userauth, channelOpen, exec, data} × defect {truncated (tcp,
reset, channel, eof), malformed, oversize (packet, stream), badPad, badMac, unknown, wrongAlg (kex, hostKey, cipher,
phase), badKey (unpinned, sigType, sigBytes, ephLength, ephLowOrder), duplicate (immediate, afterSession), outOfOrder,
disconnect (2, 11)}: 216 pairs, 109 that do not exist on the wire (each rule says why: no MAC before NEWKEYS, algorithm
lists only in KEXINIT, …), **107 cells**. The scripted server is written from the RFCs and imports nothing from
`src/ssh.js`; it advertises `kex-strict-s-v00@openssh.com` as OpenSSH ≥ 9.6 servers do, so OpenSSH's own strict-KEX
rules apply. A fault-free run is `git ls-remote` succeeding through OpenSSH. Every cell asserts ply's code and message,
an outcome within 2 s (requestTimeoutMs 4 s, so a hang shows as `timeout`), and git's class. Plus 10 pin cells
(hostKey valid / absent / not a line / ssh-rsa blob / short key, through `SshClient` and `createSshTransport`): `bad_request`
before any I/O, as `ssh-keygen -l` refuses the same lines.

Outcomes (2026-10-31, OpenSSH 10.2p1, git 2.50.0): ssh 57, network 19, protocol 10, ok 8, unsupported 7,
host_key_mismatch 2, remote_error 2, auth 1, limit_exceeded 1; 1.3 s on 4 servers. What OpenSSH does, and ply now
does too: refuses any unexpected message during the initial key exchange (strict KEX) and userauth; in the connection
phase answers an unknown or stray message with UNIMPLEMENTED (RFC 4253 §11.4) and drops a request reply that has no
request pending; disconnects on an open confirmation for a channel that is not opening; does not compare the service
name in SERVICE_ACCEPT. One divergence: `kexinit/duplicate(afterSession)`, a server-initiated rekey, which OpenSSH
honours and ply refuses (`unsupported`): ply sessions are one operation, under OpenSSH servers' rekey limits.

**ssh-service** (`test/space/ssh-service.space.js`, enumerator `test/space/ssh-service.test.js`). Axes: service
{upload-pack, receive-pack} × outcome {exists, missing, notRepo, unreadable, absent (no git on PATH), hostNotFound
("ERROR: Repository not found."), hostDenied ("ERROR: Permission to o/r.git denied to u."), silent (exit 1), warning,
emptyAdvertisement (a lone flush, then the command drains stdin and exits 0)}: **20 cells**, a real sshd whose forced command produces each outcome. git types none of them
(it prints the server's line and "fatal: Could not read from remote repository."); ply types them from the line as
HTTP types a status (`refusalCode`): missing → `not_found`, denied → `auth`, anything else → `remote_error`, with the
exit status and the server's line in the message, and the test checks git's stderr and ply's message carry the same
line. Two divergences, both the lone flush: `uploadPack/emptyAdvertisement`, git's v0 empty-repository
advertisement, which git lists as nothing and ply refuses (`unsupported`: ply speaks only v2 over ssh); and
`receivePack/emptyAdvertisement`, where git pushes blind (no report-status, so "[new branch]" and exit 0 for an update
nobody confirmed) and ply refuses (`protocol`). The forced command drains stdin before it exits: exiting right after
the flush made git's push race ssh's exit (ok, refused, or killed by SIGPIPE; #83).

**Where train/1 (77eb2c0) disagreed with the tables**: 29 of 107 fault cells and 15 of 20 service cells.

| cells | table → train/1 | cause |
|---:|---|---|
| 9 | `network` → `protocol` "read ECONNRESET" | a reset socket's raw error reached `coded()` and took the operation's default code |
| 3 | `network` / `protocol` "server disconnected (2): …" → `protocol` "This socket has been ended by the other party" | the node stream refused to write once the peer half-closed, before the DISCONNECT already received was read |
| 1 | `ssh` "all-zero shared secret" → `protocol` "The operation failed for an operation-specific reason" | WebCrypto refuses to derive X25519 with a low-order key (an untyped OperationError); the zero check after it never ran |
| 8 | `ssh` "bad padding" → `timeout` (4 s) | padding_length 3 accepted (RFC 4253 §6: ≥ 4; OpenSSH "Corrupted padlen"); the exchange went on until the bound |
| 1 | `ssh` "no version line" → `timeout` | a packet before the version line was read as a pre-version text line, then more lines were awaited forever (OpenSSH: "invalid format"; now: no NUL, ≤ 1024 lines, ≤ 64 KiB) |
| 1 | `ssh` "short message" → `timeout` | SERVICE_ACCEPT's name was never read, so a cut message was accepted |
| 4 | ok → `ssh` "unexpected message 200 / 52" | an unknown or stray message in the connection phase was fatal (RFC 4253 §11.4, OpenSSH: UNIMPLEMENTED) |
| 1 | `ssh` → ok | a second open confirmation for an open channel was accepted (OpenSSH: disconnect) |
| 1 | `remote_error` "ended before its advertisement (exit 0)" → `protocol` | a service that ended before its first byte was "ended before the response was complete" |
| 6 | `not_found` → `remote_error` | a missing repository (git's "does not appear to be a git repository", a host's "Repository not found"): the not_found classifier ran only for an advertisement that was a bare flush, so a missing repository never reached it (its regex also took "command not found" for a missing repository) |
| 2 | `auth` → `remote_error` | a host denying the repository ("Permission to … denied"), HTTP's 403 |
| 2 | `remote_error` → `protocol` (retry: yes) | a service that exits 1 and says nothing was retried as a framing fault |
| 2 | message only | git absent on the host: still `remote_error`, now with the exit status (127) and never `not_found` |
| 2 | `not_found` → `remote_error` (unreadable) | as missing: git prints the same line |
| 1 | `protocol` "empty advertisement" → `remote_error` "sent no advertisement" | a bare-flush receive-pack advertisement |
