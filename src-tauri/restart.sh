#!/bin/sh
# Rebuild and relaunch the headless core, then bootstrap a fresh cookie.
cd /c/Users/harih/OneDrive/Documents/ocr/zero-leak-app/src-zero || exit 1
[ -f jar.txt ] && ./call.sh app_quit > /dev/null 2>&1
sleep 2
cargo build 2>&1 | tail -2
(nohup ./target/debug/sovereign-workbench.exe --headless > wb.log 2>&1 &)
sleep 6
rm -f jar.txt
. ./sess.sh
curl -s -o /dev/null -w "port $PORT bootstrap=%{http_code}\n" -c jar.txt "$URL"
./call.sh core_status
