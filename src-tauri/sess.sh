#!/bin/sh
# The launch URL, port and cookie for whatever instance is running now.
URL=$(grep -o 'http://127.0.0.1:[0-9]*/?k=[a-f0-9]*' "$LOCALAPPDATA/SovereignWorkbench/session-url.txt")
PORT=$(echo "$URL" | sed -n 's|.*127.0.0.1:\([0-9]*\)/.*|\1|p')
export URL PORT
