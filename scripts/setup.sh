#!/usr/bin/env bash
# Stand up MoreHands on the currently-logged-in Cloudflare account.
#
#   ./scripts/setup.sh             full run: resources -> migrate -> deploy -> secrets
#   ./scripts/setup.sh resources   create D1 + KV, write their ids into the env file
#   ./scripts/setup.sh migrate     apply D1 migrations (remote)
#   ./scripts/setup.sh deploy      build + deploy hatchery (crons included; ticker worker retired)
#   ./scripts/setup.sh secrets     push secrets from the env file to the worker
#   ./scripts/setup.sh manifest [url]   print the Slack app manifest with the worker URL filled
#                                  in, ready to paste at api.slack.com/apps -> App Manifest
#                                  (url defaults to MOREHANDS_PUBLIC_URL from the env file)
#   ./scripts/setup.sh doctor      verify the deployment leg by leg: config, worker, Slack,
#                                  optional integrations — with the exact next step for each gap
#
# Multi-account: MOREHANDS_ENV selects the env file — MOREHANDS_ENV=work reads .env.deploy.work
# (default: .env.deploy). Account-specific resource ids (D1/KV) live in the env file, NOT in
# wrangler.jsonc: `resources` writes them there and `deploy` patches the BUILT dist config, so
# deploying to a second account never dirties a tracked file. The ids committed in wrangler.jsonc
# remain the canonical (CI-deployed) instance's.
#
# Idempotent: re-running reuses existing D1/KV and never clobbers a secret you didn't change.
# Phaseable on purpose — the Slack app needs the worker URL (from `deploy`), but `secrets`
# needs the bot token the Slack app gives you. So: full run, make the Slack app, fill the
# token in the env file, then `./scripts/setup.sh secrets` again (it derives SLACK_BOT_ID and
# KNOWN_TEAM_IDS from the token via Slack auth.test).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE=".env.deploy${MOREHANDS_ENV:+.$MOREHANDS_ENV}"
DB_NAME="hatchery-skills"
KV_BINDING="SLACK_EVENTS"
WORKER="hatchery"
BULK_FILE=".secrets.bulk.json"

# `manifest` and `doctor` degrade gracefully without the env file; every other phase needs it.
if [ -f "$ENV_FILE" ]; then
  set -a; . "./$ENV_FILE"; set +a
elif [ "${1:-full}" != "manifest" ] && [ "${1:-full}" != "doctor" ]; then
  echo "❌ Missing $ENV_FILE — copy .env.deploy.example to $ENV_FILE and fill it."; exit 1
fi

require_login() {
  wrangler whoami >/dev/null 2>&1 || { echo "❌ Not logged in. Run 'wrangler login' for the TARGET account first."; exit 1; }
}

# Upsert KEY=VALUE in the env file (replaces an existing uncommented line, else appends).
set_env_kv() {
  K="$1" V="$2" FILE="$ENV_FILE" node -e '
    const fs = require("fs"); const { K, V, FILE } = process.env;
    let t = fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : "";
    const line = `${K}=${V}`;
    const re = new RegExp(`^${K}=.*$`, "m");
    t = re.test(t) ? t.replace(re, line) : (t === "" || t.endsWith("\n") ? t : t + "\n") + line + "\n";
    fs.writeFileSync(FILE, t);
  '
}

resources() {
  require_login
  echo "→ D1 '$DB_NAME'"
  wrangler d1 info "$DB_NAME" >/dev/null 2>&1 || wrangler d1 create "$DB_NAME" >/dev/null
  DB_ID="$(wrangler d1 info "$DB_NAME" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.uuid||j.database_id||"")})')"
  [ -n "$DB_ID" ] || { echo "❌ Could not resolve D1 id for $DB_NAME"; exit 1; }

  echo "→ KV '$KV_BINDING'"
  find_kv() { wrangler kv namespace list | KV_BINDING="$KV_BINDING" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const m=a.find(n=>n.title&&n.title.endsWith(process.env.KV_BINDING));process.stdout.write(m?m.id:"")})'; }
  KV_ID="$(find_kv)"
  [ -n "$KV_ID" ] || { wrangler kv namespace create "$KV_BINDING" >/dev/null; KV_ID="$(find_kv)"; }
  [ -n "$KV_ID" ] || { echo "❌ Could not resolve KV id for $KV_BINDING"; exit 1; }

  # Account-specific ids live with the account's other config in the (gitignored) env file —
  # the tracked wrangler.jsonc keeps the canonical instance's ids and is never rewritten.
  set_env_kv D1_DATABASE_ID "$DB_ID"
  set_env_kv KV_NAMESPACE_ID "$KV_ID"
  D1_DATABASE_ID="$DB_ID"; KV_NAMESPACE_ID="$KV_ID"
  echo "✓ $ENV_FILE → D1=$DB_ID KV=$KV_ID"
}

migrate() {
  require_login
  echo "→ applying D1 migrations (remote)"
  if [ -n "${D1_DATABASE_ID:-}" ]; then
    # Same multi-account rule as deploy: the tracked wrangler.jsonc keeps the canonical
    # instance's id, so point wrangler at a temp copy patched with THIS account's id.
    # In the repo root (gitignored), not mktemp -t: the config's relative paths
    # (e.g. the sandbox Dockerfile) must keep resolving.
    TMP_CFG=".wrangler.migrate.tmp.jsonc"
    sed -E "s/\"database_id\": \"[^\"]*\"/\"database_id\": \"$D1_DATABASE_ID\"/" wrangler.jsonc > "$TMP_CFG"
    wrangler d1 migrations apply "$DB_NAME" --remote --config "$TMP_CFG"
    rm -f "$TMP_CFG"
  else
    wrangler d1 migrations apply "$DB_NAME" --remote
  fi
}

deploy() {
  require_login
  echo "→ build + deploy $WORKER"
  npm run build
  # Patch THIS account's resource ids into the built config (the tracked wrangler.jsonc keeps
  # the canonical ids; the Cloudflare Vite plugin copied them into dist during the build).
  if [ -n "${D1_DATABASE_ID:-}" ] || [ -n "${KV_NAMESPACE_ID:-}" ]; then
    DIST="dist/$WORKER/wrangler.json" DB_NAME="$DB_NAME" KV_BINDING="$KV_BINDING" node -e '
      const fs = require("fs"); const p = process.env.DIST;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const d1 = process.env.D1_DATABASE_ID, kv = process.env.KV_NAMESPACE_ID;
      if (d1) for (const b of j.d1_databases ?? []) if (b.database_name === process.env.DB_NAME) b.database_id = d1;
      if (kv) for (const n of j.kv_namespaces ?? []) if (n.binding === process.env.KV_BINDING) n.id = kv;
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    '
    echo "✓ patched dist config with env-file resource ids"
  fi
  DEPLOY_OUT="$(wrangler deploy --config "dist/$WORKER/wrangler.json" 2>&1 | tee /dev/stderr)"
  # Autofill the public URL on first deploy so manifest/doctor/secrets can use it.
  if [ -z "${MOREHANDS_PUBLIC_URL:-}" ]; then
    URL="$(printf '%s' "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1 || true)"
    if [ -n "$URL" ]; then
      set_env_kv MOREHANDS_PUBLIC_URL "$URL"
      MOREHANDS_PUBLIC_URL="$URL"
      echo "✓ MOREHANDS_PUBLIC_URL=$URL written to $ENV_FILE"
    fi
  fi
  echo "✓ deployed. Use the worker URL above for the Slack/Nango/Linear webhooks."
}

# Derive SLACK_BOT_ID / KNOWN_TEAM_IDS from the bot token (Slack auth.test) when only the
# token is filled in — turns three manual copy-backs from the Slack dashboard into one.
derive_slack_ids() {
  [ -n "${SLACK_BOT_TOKEN_DEFAULT:-}" ] || return 0
  [ -z "${SLACK_BOT_ID:-}" ] || [ -z "${KNOWN_TEAM_IDS:-}" ] || return 0
  echo "→ deriving Slack ids from the bot token (auth.test)"
  local auth ids
  auth="$(curl -sS -m 10 -H "Authorization: Bearer $SLACK_BOT_TOKEN_DEFAULT" https://slack.com/api/auth.test || true)"
  ids="$(AUTH="$auth" node -e '
    let j = {}; try { j = JSON.parse(process.env.AUTH || "{}"); } catch {}
    if (j.ok && j.user_id && j.team_id) process.stdout.write(`${j.user_id} ${j.team_id}`);
  ')"
  if [ -n "$ids" ]; then
    if [ -z "${SLACK_BOT_ID:-}" ]; then SLACK_BOT_ID="${ids%% *}"; set_env_kv SLACK_BOT_ID "$SLACK_BOT_ID"; echo "✓ SLACK_BOT_ID=$SLACK_BOT_ID"; fi
    if [ -z "${KNOWN_TEAM_IDS:-}" ]; then KNOWN_TEAM_IDS="${ids##* }"; set_env_kv KNOWN_TEAM_IDS "$KNOWN_TEAM_IDS"; echo "✓ KNOWN_TEAM_IDS=$KNOWN_TEAM_IDS"; fi
  else
    echo "⚠ auth.test failed — fill SLACK_BOT_ID and KNOWN_TEAM_IDS in $ENV_FILE by hand."
  fi
}

secrets() {
  require_login
  derive_slack_ids
  if [ -z "${HEARTBEAT_TOKEN:-}" ]; then
    HEARTBEAT_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
    set_env_kv HEARTBEAT_TOKEN "$HEARTBEAT_TOKEN"
    echo "ℹ generated HEARTBEAT_TOKEN and saved it to $ENV_FILE."
  fi
  # Bulk file holds only the keys that are actually set (blanks skipped → feature stays inert).
  HEARTBEAT_TOKEN="$HEARTBEAT_TOKEN" BULK_FILE="$BULK_FILE" node -e '
    const keys=["ZAI_API_KEY","ZAI_CODING_API_KEY","OPENROUTER_API_KEY","HEARTBEAT_TOKEN","SLACK_SIGNING_SECRET","SLACK_BOT_TOKEN_DEFAULT","KNOWN_TEAM_IDS","SLACK_BOT_ID","SLACK_DEFAULT_TOKEN_REF","ADMIN_CONNECTIONS_TOKEN","NANGO_SECRET_KEY","NANGO_WEBHOOK_SECRET","LINEAR_WEBHOOK_SECRET","TRIGGER_SECRET_KEY","TRIGGER_API_URL","AGENT_RUNNER_TOKEN","MOREHANDS_PUBLIC_URL","RUNNER_GITHUB_PAT_TEMP","LINEAR_AGENT_PROJECTS","WORKBENCH_RUNNER_TOKEN","CODING_RUNNER_URL","TAVILY_API_KEY"];
    const out={}; for(const k of keys){const v=process.env[k]; if(v&&String(v).trim()) out[k]=String(v);}
    require("fs").writeFileSync(process.env.BULK_FILE, JSON.stringify(out));
  '
  chmod 600 "$BULK_FILE"
  trap 'rm -f "$BULK_FILE"' EXIT
  local n; n="$(BULK_FILE="$BULK_FILE" node -e 'process.stdout.write(String(Object.keys(require("./"+process.env.BULK_FILE)).length))')"
  echo "→ pushing $n secrets to $WORKER"
  wrangler secret bulk "$BULK_FILE"
  rm -f "$BULK_FILE"; trap - EXIT
  echo "✓ secrets set."
}

manifest() {
  local url="${1:-${MOREHANDS_PUBLIC_URL:-}}"
  [ -n "$url" ] || { echo "❌ No worker URL. Set MOREHANDS_PUBLIC_URL in $ENV_FILE or pass one: ./scripts/setup.sh manifest https://hatchery.<account>.workers.dev"; exit 1; }
  # Parse → substitute → reprint: validates the JSON and drops the repo-reader _comment so the
  # output is exactly what api.slack.com/apps -> App Manifest expects.
  URL="${url%/}" node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync("slack-app.manifest.json", "utf8"));
    delete m._comment;
    process.stdout.write(JSON.stringify(m, null, 2).replaceAll("https://REPLACE-WITH-YOUR-WORKER-URL", process.env.URL) + "\n");
  '
}

doctor() {
  local fails=0
  ok()   { echo "  ✅ $1"; }
  bad()  { echo "  ✗ $1"; fails=$((fails + 1)); }
  todo() { echo "  ⬜ $1"; }
  local url="${MOREHANDS_PUBLIC_URL:-<worker-url>}"

  echo "MoreHands doctor — env file: $ENV_FILE"
  if [ ! -f "$ENV_FILE" ]; then
    bad "env file missing — cp .env.deploy.example $ENV_FILE and fill it"
    echo "✗ doctor: 1 core check failed."; exit 1
  fi
  ok "env file present"

  echo "core config:"
  local k
  if [ -n "${ZAI_API_KEY:-}" ] || [ -n "${ZAI_CODING_API_KEY:-}" ]; then
    ok "default Z.ai provider key set"
  else
    bad "ZAI_API_KEY missing (or legacy ZAI_CODING_API_KEY) — required for the default model; fill it in $ENV_FILE"
  fi
  for k in SLACK_SIGNING_SECRET SLACK_BOT_TOKEN_DEFAULT ADMIN_CONNECTIONS_TOKEN; do
    if [ -n "${!k:-}" ]; then ok "$k set"; else bad "$k missing (required core — fill it in $ENV_FILE)"; fi
  done
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    ok "OPENROUTER_API_KEY set (Pi runner / OpenRouter model pins)"
  else
    todo "OPENROUTER_API_KEY missing — needed only for the Pi runner or OpenRouter model pins"
  fi

  echo "cloudflare:"
  if wrangler whoami >/dev/null 2>&1; then ok "wrangler logged in"; else bad "wrangler not logged in (run: wrangler login)"; fi
  if [ -n "${D1_DATABASE_ID:-}" ] && [ -n "${KV_NAMESPACE_ID:-}" ]; then
    ok "resource ids in env file (D1 + KV)"
  else
    todo "no D1/KV ids in $ENV_FILE — run: ./scripts/setup.sh resources (deploys fall back to the tracked wrangler.jsonc ids)"
  fi

  echo "worker:"
  if [ -n "${MOREHANDS_PUBLIC_URL:-}" ]; then
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$MOREHANDS_PUBLIC_URL/slack/events" || true)"
    [ -n "$code" ] || code=000
    # An unsigned POST must bounce with 401 — that proves the worker is live AND verifying signatures.
    if [ "$code" = "401" ]; then
      ok "worker live at $MOREHANDS_PUBLIC_URL (unsigned /slack/events → 401)"
    else
      bad "POST $MOREHANDS_PUBLIC_URL/slack/events returned $code (expected 401) — not deployed, wrong URL, or SLACK_SIGNING_SECRET not pushed"
    fi
  else
    todo "MOREHANDS_PUBLIC_URL not set — ./scripts/setup.sh deploy autofills it"
  fi

  echo "slack:"
  if [ -n "${SLACK_BOT_TOKEN_DEFAULT:-}" ]; then
    local auth team bot
    auth="$(curl -sS -m 10 -H "Authorization: Bearer $SLACK_BOT_TOKEN_DEFAULT" https://slack.com/api/auth.test || true)"
    read -r bot team < <(AUTH="$auth" node -e '
      let j = {}; try { j = JSON.parse(process.env.AUTH || "{}"); } catch {}
      process.stdout.write(j.ok ? `${j.user_id} ${j.team_id}` : "- -");
    ') || true
    if [ "$bot" != "-" ] && [ -n "$bot" ]; then
      ok "bot token valid (bot $bot, team $team)"
      [ "${SLACK_BOT_ID:-$bot}" = "$bot" ] || bad "SLACK_BOT_ID=${SLACK_BOT_ID} does not match auth.test ($bot)"
      case ",${KNOWN_TEAM_IDS:-$team}," in *",$team,"*) : ;; *) bad "KNOWN_TEAM_IDS=${KNOWN_TEAM_IDS} does not include auth.test team ($team)";; esac
    else
      bad "bot token rejected by Slack auth.test — reinstall the app and update SLACK_BOT_TOKEN_DEFAULT"
    fi
  else
    todo "no bot token yet — ./scripts/setup.sh manifest, create/update the app, then put the xoxb token in $ENV_FILE and re-run secrets"
  fi

  echo "optional integrations:"
  if [ -n "${NANGO_SECRET_KEY:-}" ] && [ -n "${NANGO_WEBHOOK_SECRET:-}" ]; then
    ok "Nango keys set (webhook: $url/nango/webhook)"
  else
    todo "Nango connections off — set NANGO_SECRET_KEY + NANGO_WEBHOOK_SECRET; webhook URL: $url/nango/webhook"
  fi
  if [ -n "${LINEAR_WEBHOOK_SECRET:-}" ]; then
    ok "Linear ingress key set (webhook: $url/linear/webhook)"
  else
    todo "Linear agent runs off — set LINEAR_WEBHOOK_SECRET; webhook URL: $url/linear/webhook (Issue + Comment events)"
  fi
  if [ -n "${TRIGGER_SECRET_KEY:-}" ] && [ -n "${AGENT_RUNNER_TOKEN:-}" ]; then
    ok "Trigger.dev runner dispatch keys set"
  else
    todo "coding runner off — set TRIGGER_SECRET_KEY + AGENT_RUNNER_TOKEN (+ RUNNER_GITHUB_PAT_TEMP); deploy the runner: npm run trigger:deploy"
  fi

  echo
  if [ "$fails" -eq 0 ]; then
    echo "✓ doctor: all core checks passed. ⬜ items are optional features, each listed with its next step."
  else
    echo "✗ doctor: $fails core check(s) failed — see ✗ lines above."
    exit 1
  fi
}

checklist() {
  cat <<'EOF'

──────────────────────────────────────────────────────────────────────────
✅ Cloudflare side is live. Wire the SaaS side (can't be automated), using the
   worker URL printed by the deploy step above as <URL>:

  [ ] Slack   ./scripts/setup.sh manifest <URL>  prints paste-ready JSON for
              api.slack.com/apps → From a manifest (new app) or App Manifest (existing app —
              re-applying a scope change also needs Install App → Reinstall to Workspace)
              put the Bot User OAuth Token (xoxb-…) in the env file as SLACK_BOT_TOKEN_DEFAULT
              then: ./scripts/setup.sh secrets   (derives SLACK_BOT_ID + KNOWN_TEAM_IDS for you)
  [ ] Nango   create integrations named EXACTLY  github  linear  notion
              webhook URL → <URL>/nango/webhook
	  [ ] Linear  webhook URL → <URL>/linear/webhook ; enable Issue + Comment events
	  [ ] Runner  create/deploy the Trigger.dev run-coding-task ; set TRIGGER_SECRET_KEY,
	              AGENT_RUNNER_TOKEN, MOREHANDS_PUBLIC_URL, RUNNER_GITHUB_PAT_TEMP ; re-run secrets

  ./scripts/setup.sh doctor  re-checks all of this leg by leg, any time.
──────────────────────────────────────────────────────────────────────────
EOF
}

case "${1:-full}" in
  resources) resources ;;
  migrate)   migrate ;;
  deploy)    deploy ;;
  secrets)   secrets ;;
  manifest)  manifest "${2:-}" ;;
  doctor)    doctor ;;
  full)      resources; migrate; deploy; secrets; checklist ;;
  *) echo "usage: [MOREHANDS_ENV=<name>] $0 [full|resources|migrate|deploy|secrets|manifest [url]|doctor]"; exit 1 ;;
esac
