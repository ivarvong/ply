#!/usr/bin/env bash
# One tick of the prod watch. Idempotent; safe to run from a fresh session.
#   - ply main is cloned or fast-forwarded at $PLY_DIR
#   - this directory tracks branch research/prodwatch of ivarvong/ply (scripts + log.jsonl)
#   - the run record is appended to log.jsonl and pushed; anomalies are posted to the rolling issue ($WATCH_ISSUE)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLY_DIR="${PLY_DIR:-$HERE/../ply}"
REPO=https://github.com/ivarvong/ply.git
WATCH_ISSUE="${WATCH_ISSUE:-44}"

if [ ! -d "$PLY_DIR/.git" ]; then git clone -q --branch main "$REPO" "$PLY_DIR"; else git -C "$PLY_DIR" fetch -q origin main && git -C "$PLY_DIR" reset -q --hard origin/main; fi
if [ -d "$HERE/.git" ]; then git -C "$HERE" fetch -q origin research/prodwatch && git -C "$HERE" reset -q --hard origin/research/prodwatch; fi

cd "$HERE"
OUT="$(PLY_DIR="$PLY_DIR" node run.mjs 2>&1)" || true
echo "$OUT" | tail -1 >/dev/null
REC="$(tail -1 log.jsonl)"
ANOM="$(echo "$REC" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.anomalies.length)')"
CHANGES="$(echo "$REC" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log((r.changes??[]).join("; "))')"
SUMMARY="$(echo "$REC" | node -e '
const r=JSON.parse(require("fs").readFileSync(0,"utf8"));
const t=Object.entries(r.targets).map(([h,x])=>x.error?`${h}: ${x.error.code}`:`${h}: ${x.wire.rtt} rtt ${x.wire.in} B in, ${Math.max(...x.wire.ms)} ms max`).join(" | ");
const p=r.prod; console.log(`${r.at} ply ${r.ply} · ${t} · prod / ${p.root?.status} ${p.root?.ms} ms, /view tree ${p.viewTree?.status} ${p.viewTree?.ms} ms (${p.viewTree?.gitCalls} git calls), blob ${p.viewBlob?.status} ${p.viewBlob?.ms} ms`)')"
echo "$SUMMARY"

if [ -d "$HERE/.git" ]; then
  git -C "$HERE" add log.jsonl
  git -C "$HERE" -c user.name=ply-prodwatch -c user.email=prodwatch@ply.invalid -c commit.gpgsign=false commit -q -m "watch: $(date -u +%FT%TZ) anomalies=$ANOM" || true
  git -C "$HERE" push -q origin HEAD:research/prodwatch || echo "push failed (log kept locally)"
fi

if [ "$ANOM" != "0" ] || [ -n "$CHANGES" ]; then
  BODY="$(printf '**%s**\n\n%s\n\n```json\n%s\n```\n' "$([ "$ANOM" != "0" ] && echo "$ANOM anomaly(ies)" || echo "change")" "$SUMMARY${CHANGES:+ · $CHANGES}" "$(echo "$REC" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const t of Object.values(r.targets))delete t.wire?.ms;console.log(JSON.stringify(r,null,1))')")"
  gh api "repos/ivarvong/ply/issues/$WATCH_ISSUE/comments" -f body="$BODY" --jq .html_url || echo "issue comment failed"
fi
