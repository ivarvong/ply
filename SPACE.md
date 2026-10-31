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
