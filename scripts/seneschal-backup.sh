#!/usr/bin/env bash
# Seneschal — encrypted daily backup of the Private Watch SQLite DB
# to a Hetzner storagebox (or any SSH-accessible target).
#
# What it does:
#   1. SQLite online-backup of /var/lib/seneschal/private-watch.db
#      (safe to run while the API is serving — uses the engine's
#      .backup primitive, not cp).
#   2. AES-256-CBC + PBKDF2(100k) encrypts the snapshot using the
#      passphrase in $SENESCHAL_BACKUP_KEY_FILE so the storagebox
#      operator can't read the metadata at rest (view keys + payer
#      addresses are ALREADY AES-256-GCM-encrypted inside the DB
#      with PRIVATE_WATCH_ENCRYPTION_KEY; the outer layer protects
#      everything else — webhook URLs, addresses, token hashes).
#   3. SHA-256 manifest stored alongside so we can verify integrity
#      on restore without decrypting.
#   4. rsync over SSH (key-based) to $SENESCHAL_BACKUP_REMOTE.
#   5. Rotates LOCAL backups: keep the last 30 daily snapshots.
#      Remote rotation is the storagebox's problem (snapshot-based
#      retention or another rotate job — out of scope here).
#
# Designed to be idempotent: re-running it the same day overwrites
# that day's file. The exit code is non-zero if ANY stage fails
# (the systemd timer should send the journal output on failure).
#
# Required env:
#   SENESCHAL_BACKUP_KEY_FILE  — path to a file containing the
#                                AES passphrase. 600, root-owned.
#   SENESCHAL_BACKUP_REMOTE    — rsync-style target, e.g.
#                                u470163@u470163.your-storagebox.de:/backups/seneschal
#   SENESCHAL_BACKUP_SSH_PORT  — optional, default 22
#   SENESCHAL_BACKUP_SSH_KEY   — optional, default /root/.ssh/id_ed25519
#
# Optional env:
#   SENESCHAL_WATCH_DB         — path to the watch DB; defaults
#                                to /var/lib/seneschal/private-watch.db
#   SENESCHAL_BACKUP_LOCAL_DIR — local staging/keep dir, default
#                                /var/backups/seneschal
#   SENESCHAL_BACKUP_KEEP_DAYS — local retention in days, default 30
#   SENESCHAL_BACKUP_DRY_RUN   — set non-empty to print without push

set -euo pipefail
umask 077

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# ── Config + sanity ──────────────────────────────────────────────
WATCH_DB="${SENESCHAL_WATCH_DB:-/var/lib/seneschal-data-api/private-watches.db}"
LOCAL_DIR="${SENESCHAL_BACKUP_LOCAL_DIR:-/var/backups/seneschal}"
KEEP_DAYS="${SENESCHAL_BACKUP_KEEP_DAYS:-30}"
SSH_PORT="${SENESCHAL_BACKUP_SSH_PORT:-22}"
SSH_KEY="${SENESCHAL_BACKUP_SSH_KEY:-/root/.ssh/id_ed25519}"
DRY_RUN="${SENESCHAL_BACKUP_DRY_RUN:-}"

[[ -f "$WATCH_DB" ]] || die "watch DB not found: $WATCH_DB"
[[ -n "${SENESCHAL_BACKUP_KEY_FILE:-}" ]] || die "SENESCHAL_BACKUP_KEY_FILE not set"
[[ -f "$SENESCHAL_BACKUP_KEY_FILE" ]] || die "key file does not exist: $SENESCHAL_BACKUP_KEY_FILE"
[[ -r "$SENESCHAL_BACKUP_KEY_FILE" ]] || die "key file not readable: $SENESCHAL_BACKUP_KEY_FILE"
if [[ -z "${SENESCHAL_BACKUP_REMOTE:-}" && -z "$DRY_RUN" ]]; then
	log "WARN: SENESCHAL_BACKUP_REMOTE not set — encrypting locally only (no remote push)."
fi
if ! command -v sqlite3 >/dev/null 2>&1; then die "sqlite3 not installed"; fi
if ! command -v openssl >/dev/null 2>&1; then die "openssl not installed"; fi

mkdir -p "$LOCAL_DIR"
chmod 700 "$LOCAL_DIR"

STAMP="$(date -u +%Y%m%d)"
TIME_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
SNAPSHOT="$TMPDIR/watch-$STAMP.db"
ENCRYPTED="$LOCAL_DIR/watch-$STAMP.db.enc"
MANIFEST="$LOCAL_DIR/watch-$STAMP.manifest"

# ── 1. Online SQLite backup ──────────────────────────────────────
log "stage=snapshot src=$WATCH_DB dst=$SNAPSHOT"
sqlite3 "$WATCH_DB" ".backup '$SNAPSHOT'"

# Quick integrity check before we commit to encrypting it.
INTEGRITY=$(sqlite3 "$SNAPSHOT" 'PRAGMA integrity_check;' || true)
[[ "$INTEGRITY" == "ok" ]] || die "sqlite integrity_check failed on snapshot: $INTEGRITY"
log "stage=snapshot integrity=ok size_bytes=$(stat -c%s "$SNAPSHOT")"

# Stats line — handy in journalctl when reviewing a failed restore.
COUNT_QUERY="SELECT COUNT(*), COALESCE(SUM(credit_atomic),0) FROM private_watches WHERE cancelled=0 AND dead=0;"
STATS_LINE=$(sqlite3 "$SNAPSHOT" "$COUNT_QUERY")
log "stage=snapshot active_watches+credit_atomic=$STATS_LINE stamp=$TIME_STAMP"

# ── 2. Encrypt + manifest ────────────────────────────────────────
log "stage=encrypt out=$ENCRYPTED"
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
	-in "$SNAPSHOT" \
	-out "$ENCRYPTED" \
	-pass file:"$SENESCHAL_BACKUP_KEY_FILE"
chmod 600 "$ENCRYPTED"

ENC_SHA256=$(sha256sum "$ENCRYPTED" | awk '{print $1}')
SRC_SHA256=$(sha256sum "$SNAPSHOT"  | awk '{print $1}')
ENC_SIZE=$(stat -c%s "$ENCRYPTED")

cat > "$MANIFEST" <<EOF
seneschal_backup_version: 1
created_at_utc: $TIME_STAMP
host: $(hostname)
watch_db_path: $WATCH_DB
plaintext_sha256: $SRC_SHA256
ciphertext_sha256: $ENC_SHA256
ciphertext_size_bytes: $ENC_SIZE
active_watches_credit_atomic_sum: $STATS_LINE
encryption: aes-256-cbc/pbkdf2-100000/salted
restore_cmd: openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in watch-$STAMP.db.enc -out watch-$STAMP.db -pass file:/path/to/key
EOF
chmod 600 "$MANIFEST"
log "stage=encrypt sha256=$ENC_SHA256 size_bytes=$ENC_SIZE"

# ── 3. Push to remote ────────────────────────────────────────────
# Failure policy:
#   * Local snapshot + encryption MUST succeed (exit 1 above).
#   * Remote push is "best effort" by default — we log a clear
#     warning but exit 0 so the systemd timer doesn't go red
#     just because the storagebox key isn't authorised yet OR
#     the storagebox is down. The encrypted blob is already on
#     local disk and rotation keeps the last 30 days.
#   * Set SENESCHAL_BACKUP_REMOTE_REQUIRED=1 to flip the policy:
#     failure to push then exits non-zero (use this once the
#     pubkey is authorised + you want to be paged on push
#     regressions).
PUSH_FATAL="${SENESCHAL_BACKUP_REMOTE_REQUIRED:-}"
push_exit=0
if [[ -n "${SENESCHAL_BACKUP_REMOTE:-}" ]]; then
	# Hetzner storagebox supports rsync over SSH on the same port
	# as their custom ssh-daemon. Use rsync's -e to inject our
	# port + key choices without polluting ssh_config.
	# StrictHostKeyChecking=accept-new lets the first run prime
	# known_hosts; subsequent runs will fail loud if the host key
	# changes.
	RSYNC_SSH=(ssh -p "$SSH_PORT" -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
	if [[ -n "$DRY_RUN" ]]; then
		log "stage=push DRY_RUN target=$SENESCHAL_BACKUP_REMOTE"
		"${RSYNC_SSH[@]}" "$(echo "$SENESCHAL_BACKUP_REMOTE" | cut -d: -f1)" "ls -la $(echo "$SENESCHAL_BACKUP_REMOTE" | cut -d: -f2)" 2>&1 | head -5 >&2 || true
	else
		log "stage=push target=$SENESCHAL_BACKUP_REMOTE fatal_on_fail=${PUSH_FATAL:-no}"
		if rsync -av -e "${RSYNC_SSH[*]}" "$ENCRYPTED" "$MANIFEST" "$SENESCHAL_BACKUP_REMOTE/" >&2; then
			log "stage=push status=ok"
		else
			push_exit=$?
			log "WARN: stage=push status=failed exit=$push_exit — local snapshot is intact at $ENCRYPTED. Authorise the host pubkey on the storagebox: ssh-copy-id -p $SSH_PORT -i $SSH_KEY.pub $(echo "$SENESCHAL_BACKUP_REMOTE" | cut -d: -f1)"
		fi
	fi
fi

# ── 4. Rotate local ──────────────────────────────────────────────
log "stage=rotate keep=$KEEP_DAYS dir=$LOCAL_DIR"
find "$LOCAL_DIR" -maxdepth 1 -type f \( -name 'watch-*.db.enc' -o -name 'watch-*.manifest' \) -mtime "+$KEEP_DAYS" -print -delete >&2 || true

# Exit policy: local snapshot is the protected artefact, so we
# stay green even if the remote push failed — UNLESS the operator
# explicitly opted in to push-required mode.
if [[ "$push_exit" -ne 0 && -n "$PUSH_FATAL" ]]; then
	log "stage=done file=$ENCRYPTED remote=FAILED (required)"
	exit "$push_exit"
fi
if [[ "$push_exit" -ne 0 ]]; then
	log "stage=done file=$ENCRYPTED remote=warn (best-effort)"
else
	log "stage=done file=$ENCRYPTED remote=$([[ -n "${SENESCHAL_BACKUP_REMOTE:-}" ]] && echo ok || echo none)"
fi
exit 0
