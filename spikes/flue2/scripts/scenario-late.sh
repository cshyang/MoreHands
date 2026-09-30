#!/bin/sh
# C-late: a clean turn completes, THEN a reaper-style re-dispatch of the same input arrives (no key / new key).
cd "$(dirname "$0")/.."
ID=$1
curl -s -X POST localhost:5199/reset-rows > /dev/null
node scripts/go2.mjs "$ID" retry
sleep 45
echo "--- after first turn"; node scripts/rows.mjs
node scripts/go2.mjs "$ID" retry
sleep 50
echo "--- after late re-dispatch (no key)"; node scripts/rows.mjs
