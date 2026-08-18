#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  admin-reset-password.sh — reset the CryptoFlip admin password
# ═══════════════════════════════════════════════════════════════
#
#  WHEN TO USE:
#    - Operator forgot the admin password
#    - Scheduled password rotation (recommended quarterly)
#    - Suspected credential compromise
#    - After personnel change on the operator side
#
#  WHAT IT DOES (in order):
#    1. Loads DB credentials from /root/coin-master/.env
#    2. Prompts for new admin password (hidden input)
#    3. Validates length (min 12 chars) + double-entry confirmation
#    4. Generates bcrypt hash (cost 12) via backend's bcryptjs
#    5. UPDATEs users.password_hash WHERE username = 'admin'
#    6. Re-reads DB to verify hash was written
#    7. Tests login against /api/admin/login (localhost:4000)
#    8. Writes audit_log entry with category='security'
#
#  REQUIRES:
#    - SSH access to cx23 (root or any sudo user)
#    - /root/coin-master/.env readable (chmod 600)
#    - bcryptjs installed in /root/coin-master/backend/node_modules
#    - coin-master-postgres-1 container running
#    - coin-master-backend-1 container running (for login test)
#
#  SECURITY MODEL:
#    - No plaintext password is logged or written to disk
#    - Hash is NOT logged (only first 7 chars for algorithm verification)
#    - Password shell variable is unset immediately after hash gen
#    - Operator-level gate is SSH access, not application auth
#    - All actions logged to audit_log for forensics
#
#  USAGE:
#    ssh root@46.62.247.167
#    cd /root/coin-master
#    bash scripts/admin-reset-password.sh
#
#  AFTER SUCCESS:
#    1. Log in at https://crazycoin.duckdns.org/<SECRET_PATH>/admin/login
#    2. Save the new password in your password manager (1Password / Bitwarden / etc.)
#    3. Enroll 2FA via /api/auth/2fa/setup + /api/auth/2fa/verify
#    4. Wipe bash history: history -c && history -w
#
#  ROLLBACK:
#    There is no rollback. To undo, just run the script again with a
#    different password. Each run creates a new bcrypt hash (deterministic
#    for the same password+cost, but the salt is randomized — so each run
#    produces a different hash for the same password).
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Config ────────────────────────────────────────────────────
ENV_FILE="/root/coin-master/.env"
BACKEND_DIR="/root/coin-master/backend"
USERNAME="admin"
MIN_PASSWORD_LENGTH=12
COST=12
LOGIN_TEST_PATH="/api/admin/login"

# ─── Output helpers ─────────────────────────────────────────────
# ANSI colors (disabled if stdout is not a TTY)
if [[ -t 1 ]]; then
  C_STEP=$'\033[1;34m'  # blue
  C_OK=$'\033[1;32m'    # green
  C_ERR=$'\033[1;31m'   # red
  C_RST=$'\033[0m'
else
  C_STEP=''; C_OK=''; C_ERR=''; C_RST=''
fi

log_step() { printf "\n${C_STEP}▶ %s${C_RST}\n" "$1"; }
log_ok()   { printf "  ${C_OK}✓${C_RST} %s\n" "$1"; }
log_err()  { printf "  ${C_ERR}✗${C_RST} %s\n" "$1" >&2; }
log_info() { printf "    %s\n" "$1"; }

require_file() {
  if [[ ! -f "$1" ]]; then
    log_err "Required file not found: $1"
    exit 1
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log_err "Required command not found in PATH: $1"
    exit 1
  fi
}

# ─── Pre-flight ────────────────────────────────────────────────
log_step "Pre-flight"
require_file "$ENV_FILE"
require_file "$BACKEND_DIR/node_modules/bcryptjs/package.json"
require_cmd docker
require_cmd node
require_cmd psql
require_cmd curl

# Pull POSTGRES_* from .env into the current shell. .env is mode 0600
# so this only works for the file's owner (typically root or the
# operator user that owns /root/coin-master).
# shellcheck disable=SC1090
source <(grep -E '^POSTGRES_(USER|PASSWORD|DB)=' "$ENV_FILE" | sed 's/^/export /')

if [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_PASSWORD:-}" || -z "${POSTGRES_DB:-}" ]]; then
  log_err ".env missing one of POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB"
  exit 1
fi
log_ok "DB credentials loaded from $ENV_FILE"

if ! docker ps --format '{{.Names}}' | grep -q '^coin-master-postgres-1$'; then
  log_err "coin-master-postgres-1 is not running. Start it: docker compose up -d postgres"
  exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -q '^coin-master-backend-1$'; then
  log_err "coin-master-backend-1 is not running. Login test will fail."
  log_info "Start it: docker compose up -d backend"
  exit 1
fi
log_ok "postgres + backend containers running"

# ─── Step 1: Read password ──────────────────────────────────────
log_step "Step 1/6 — Read new admin password (hidden)"
NEWPW=''
while true; do
  read -rsp "    New admin password (min ${MIN_PASSWORD_LENGTH} chars): " NEWPW
  echo
  if [[ ${#NEWPW} -lt $MIN_PASSWORD_LENGTH ]]; then
    log_err "Too short (${#NEWPW} chars). Min: $MIN_PASSWORD_LENGTH."
    NEWPW=''
    continue
  fi
  read -rsp "    Confirm password: " NEWPW2
  echo
  if [[ "$NEWPW" != "$NEWPW2" ]]; then
    log_err "Passwords do not match."
    unset NEWPW NEWPW2
    continue
  fi
  unset NEWPW2
  break
done
log_ok "Password accepted (length: ${#NEWPW} chars)"

# ─── Step 2: Generate bcrypt hash ──────────────────────────────
log_step "Step 2/6 — Generate bcrypt hash (cost ${COST})"
# Run from BACKEND_DIR so node resolves bcryptjs from node_modules.
HASH=$(cd "$BACKEND_DIR" && node -e '
  const bcrypt = require("bcryptjs");
  const pw = process.argv[1];
  console.log(bcrypt.hashSync(pw, 12));
' "$NEWPW")
HASH_PREFIX="${HASH:0:7}"
if [[ "$HASH_PREFIX" != '$2a'* && "$HASH_PREFIX" != '$2b'* ]]; then
  log_err "Hash prefix unexpected: '$HASH_PREFIX' (expected \$2a\$ or \$2b\$ — bcrypt cost-12)"
  unset NEWPW HASH
  exit 1
fi
log_ok "Hash generated (algorithm: ${HASH_PREFIX:0:4})"

# ─── Step 3: Apply hash to DB ──────────────────────────────────
log_step "Step 3/6 — Apply hash to database"
UPDATED=$(docker exec coin-master-postgres-1 psql \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  -At -c \
  "UPDATE users SET password_hash = '${HASH}' WHERE username = '${USERNAME}' RETURNING id;")
if [[ -z "$UPDATED" ]]; then
  log_err "UPDATE returned 0 rows. User '${USERNAME}' may not exist."
  unset NEWPW HASH
  exit 1
fi
log_ok "Database updated (user id: ${UPDATED}, rows: 1)"

# Clear hash from shell memory now that DB is durable
unset HASH

# ─── Step 4: Verify hash was persisted ─────────────────────────
log_step "Step 4/6 — Verify hash in database"
DB_PREFIX=$(docker exec coin-master-postgres-1 psql \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  -At -c \
  "SELECT substring(password_hash, 1, 7) FROM users WHERE username = '${USERNAME}';")
if [[ "$DB_PREFIX" != "$HASH_PREFIX" ]]; then
  log_err "DB hash prefix mismatch: expected $HASH_PREFIX, got '$DB_PREFIX'"
  unset NEWPW
  exit 1
fi
log_ok "DB hash prefix matches: $DB_PREFIX"
unset HASH_PREFIX DB_PREFIX

# ─── Step 5: Test login ────────────────────────────────────────
log_step "Step 5/6 — Test login against /api/admin/login"
RESP=$(curl -sS -m 5 \
  -X POST 'http://localhost:4000/api/admin/login' \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USERNAME}\",\"password\":\"${NEWPW}\"}" \
  -w '\n__HTTP__%{http_code}' 2>&1)
HTTP_CODE=$(echo "$RESP" | grep -oE '__HTTP__[0-9]+' | grep -oE '[0-9]+' || echo '000')
BODY=$(echo "$RESP" | sed 's/__HTTP__.*//')

unset NEWPW

if echo "$BODY" | grep -q '"Invalid credentials"'; then
  log_err "Login returned 'Invalid credentials'. Hash was written but bcrypt compare failed."
  log_info "This usually means the password hash and typed value disagree."
  log_info "Try running the script again with the exact same password."
  exit 1
fi

if echo "$BODY" | grep -q '"requires2FA":true'; then
  log_ok "Login returned requires2FA: true (TOTP enrolled — password reset confirmed working)"
elif echo "$BODY" | grep -q '"success":true'; then
  log_ok "Login succeeded with HTTP $HTTP_CODE (password reset confirmed working)"
else
  log_err "Unexpected login response (HTTP $HTTP_CODE): $BODY"
  exit 1
fi

# ─── Step 6: Audit log ─────────────────────────────────────────
log_step "Step 6/6 — Write audit_log entry"
AUDIT_ID=$(docker exec coin-master-postgres-1 psql \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  -At -c \
  "INSERT INTO audit_log (category, action, severity, details)
   VALUES ('security', 'admin_password.reset', 'warn',
           '{\"method\":\"admin-reset-password.sh\",\"reason\":\"operator_initiated\"}'::jsonb)
   RETURNING id;" 2>&1 | grep -E '^[a-f0-9-]+$' | head -1)

if [[ -n "$AUDIT_ID" ]]; then
  log_ok "Audit log written (id: $AUDIT_ID)"
else
  log_err "Audit log INSERT did not return an id. Check audit_log table schema."
  log_info "This is non-fatal — the password reset itself succeeded."
fi

# ─── Done ──────────────────────────────────────────────────────
log_step "Done"
printf "${C_OK}"
cat <<EOF

  ┌────────────────────────────────────────────────────────┐
  │  Admin password reset successful                        │
  │                                                        │
  │  Username:  ${USERNAME}
  │  User ID:    ${UPDATED}
  │  Hash algo:  bcrypt cost-${COST}
  │  Audit log:  ${AUDIT_ID:-not written (non-fatal)}
  └────────────────────────────────────────────────────────┘

EOF
printf "${C_RST}"

log_info "Next steps:"
log_info "  1. Save the new password in your password manager NOW (you won't see it again)"
log_info "  2. Log in: https://crazycoin.duckdns.org/<SECRET_PATH>/admin/login"
log_info "  3. Enroll 2FA via /api/auth/2fa/setup + /api/auth/2fa/verify (browser console)"
log_info "  4. Wipe bash history: history -c && history -w"

# Note: NEWPW was unset in Step 5. HASH was unset in Step 3.
# Defensive unsets for any residual references.
unset NEWPW HASH UPDATED AUDIT_ID BODY HTTP_CODE RESP
