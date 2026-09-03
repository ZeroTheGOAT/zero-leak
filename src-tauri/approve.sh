#!/bin/sh
# Watch an SSE log and answer every permission request with allow_once.
# approve.sh <sse-log> — runs until the log shows agent://done.
. ./sess.sh
LOG="$1"
SEEN=""
while :; do
  grep -q 'agent://done' "$LOG" 2>/dev/null && break
  IDS=$(python decode.py "$LOG" --perm-ids 2>/dev/null)
  for id in $IDS; do
    case " $SEEN " in *" $id "*) continue;; esac
    SEEN="$SEEN $id"
    echo "approving $id"
    ./call.sh permission_respond "{\"requestId\":\"$id\",\"decision\":\"allow_once\"}" > /dev/null
  done
  sleep 1
done
