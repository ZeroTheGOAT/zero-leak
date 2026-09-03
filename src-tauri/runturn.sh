#!/bin/sh
# runturn.sh <session> <prompt> [workspaceId] [mode]
. ./sess.sh
WS="${3:-ws_72801e9537984fe4862cdd28853c5447}"
MODE="${4:-agent}"
LOG="sse-$1.log"; rm -f "$LOG"
curl -sN -b jar.txt "http://127.0.0.1:$PORT/api/events" > "$LOG" 2>&1 &
SSE=$!
sleep 1
P=$(python -c "import json,sys;print(json.dumps(sys.argv[1]))" "$2")
./call.sh agent_start "{\"input\":{\"sessionId\":\"$1\",\"workspaceId\":\"$WS\",\"mode\":\"$MODE\",\"prompt\":$P,\"attachments\":[]}}" > /dev/null
./approve.sh "$LOG" > /dev/null 2>&1 &
APP=$!
N=0
until grep -q 'agent://done' "$LOG" 2>/dev/null || [ $N -gt 300 ]; do sleep 2; N=$((N+2)); done
sleep 1
kill $SSE $APP 2>/dev/null
python decode.py "$LOG"
