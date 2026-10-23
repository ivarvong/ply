#!/bin/sh
# uploadpack.packObjectsHook: record the exact pack-objects argv and stdin upload-pack uses, then run it.
printf '%s\n' "$*" > "$PLY_HOOK_LOG.args"
tee "$PLY_HOOK_LOG.stdin" | "$@"
