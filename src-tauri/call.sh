#!/bin/sh
. ./sess.sh
CMD="$1"; ARGS="${2:-{\}}"
curl -s -b jar.txt -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
  -d "{\"command\":\"$CMD\",\"args\":$ARGS}" "http://127.0.0.1:$PORT/api/invoke"
