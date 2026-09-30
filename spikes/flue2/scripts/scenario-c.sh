#!/bin/sh
# usage: scenario-c.sh <instanceId> <origKey|-> <retryKey|-|none>
# dispatch, kill mid-sleep, restart, then re-dispatch the same input (simulated reaper retry) ~8s after restart.
cd "$(dirname "$0")/.."
ID=$1; K1=$2; K2=$3
curl -s -X POST localhost:5199/reset-rows > /dev/null
node scripts/go2.mjs "$ID" retry "$K1"
sleep 11
scripts/devctl.sh kill
sleep 2
scripts/devctl.sh start
sleep 12
date +%s
if [ "$K2" = "none" ]; then echo "(no re-dispatch)"; else node scripts/go2.mjs "$ID" retry "$K2"; fi
sleep 100
node scripts/rows.mjs
node scripts/events.mjs "$ID" --types=submission_queued,submission_running,submission_settled,tool_start | cut -c1-200
