#!/usr/bin/env bash
# Deploys a release tag of the public repository: download, install, build, migrate and seed in a new
# <root>/releases/<tag>-<UTC> directory, then an atomic switch of <root>/current and a zero-downtime
# PM2 reload; a failed health check switches back. Runs as the app user; settings in
# <bin>/../deploy.env, lock <bin>/../deploy.lock. See docs/deploy.md ("GitHub Actions 自动部署").
#
# Usage: server-deploy.sh <vX.Y.Z> [<commit sha>]   deploy a tag; a given sha must be what the tag points to
#        server-deploy.sh --rollback                back to the previously deployed release (code only)
#        server-deploy.sh --dry-run <release.tar.gz> <vX.Y.Z> [<sha>] | --dry-run --rollback
#            test mode for a scratch root marked by a DRY_RUN file: tags resolve in the local git
#            repository QW_REPO, the release comes from the tarball; no network, pnpm, database or
#            PM2 reload; the health check reads QW_HEALTH_URL, and the workers' working directories
#            under <root>/proc (written there by a stand-in pm2 on PATH)
# Exit: 0 ok | 1 failed before or at the switch: the old release still runs and the new release
#       directory is deleted (its migrations and seeds may have run) | 2 unhealthy, switched back
#       | 3 unhealthy and the way back failed too: manual action | 64 usage | 75 another deploy is running
set -Eeuo pipefail
trap '' HUP PIPE # a dropped SSH session must not stop a deploy half way: it finishes or switches back
umask 022

TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
SHA_RE='^[0-9a-f]{40}$'
PIN_RE='^[0-9a-f]{64}$'
usage() {
  echo 'usage: server-deploy.sh [--dry-run <release.tar.gz>] <vX.Y.Z> [<commit sha>] | [--dry-run] --rollback' >&2
  exit 64
}
# arguments are checked before anything is read, locked or written
DRY='' TARBALL='' WANT=''
if [[ ${1:-} == --dry-run ]]; then
  DRY=1
  shift
  if [[ ${1:-} != --rollback ]]; then
    TARBALL=${1:-}
    [[ -f $TARBALL ]] || usage
    TARBALL=$(readlink -f "$TARBALL")
    shift
  fi
fi
case ${1:-} in
  --rollback)
    [[ $# -eq 1 ]] || usage
    MODE=rollback TAG=rollback
    ;;
  *)
    [[ $# -ge 1 && $# -le 2 ]] || usage
    MODE=deploy TAG=$1 WANT=${2:-}
    [[ $TAG =~ $TAG_RE ]] || usage
    [[ -z $WANT || $WANT =~ $SHA_RE ]] || usage
    ;;
esac

BIN=$(dirname "$(readlink -f "$0")")
set -a
# shellcheck source=/dev/null # root-owned settings next to bin/, no secrets (deploy.env.example)
. "$BIN/../deploy.env"
set +a
: "${QW_DEPLOY_ROOT:=/srv/qiwu}" "${QW_REPO:?QW_REPO is missing in deploy.env}" "${QW_APP_USER:=qiwu}"
: "${QW_PM2_NAME:=qiwu-server}" "${QW_PM2_INSTANCES:=2}" "${QW_HEALTH_URL:=http://127.0.0.1:3000/api/health}"
: "${QW_HEALTH_TRIES:=30}" "${QW_KEEP_RELEASES:=3}" "${QW_MIN_FREE_MB:=3072}" "${QW_DEPLOY_SEED:=1}"
: "${QW_ASSET_CARRY_DAYS:=14}" "${QW_SHARED_LINKS:=apps/server/.env apps/server/.env.local}"
: "${QW_DB_NAME:=}" "${QW_DB_BACKUP_CNF:=}" "${QW_MIGRATE_ENV:=}" "${QW_ALLOW_DOWNGRADE:=0}"
: "${QW_BUILD_TIMEOUT:=30m}" "${QW_MIGRATE_TIMEOUT:=10m}"
export QW_DEPLOY_ROOT QW_PM2_NAME QW_PM2_INSTANCES # read by ecosystem.config.cjs
[[ $(id -un) == "$QW_APP_USER" ]] || { echo "server-deploy.sh runs as $QW_APP_USER" >&2; exit 64; }
ROOT=$(readlink -f "$QW_DEPLOY_ROOT")
CUR=$ROOT/current
[[ -z $DRY || -e $ROOT/DRY_RUN ]] || { echo '--dry-run needs a scratch root marked by a DRY_RUN file' >&2; exit 64; }

exec 9>"$BIN/../deploy.lock" # next to deploy.env: a path the app user cannot replace
flock -n 9 || { echo 'another deploy is running' >&2; exit 75; }
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$ROOT/logs/deploy"
LOG=$ROOT/logs/deploy/$TS-$TAG.log
(umask 027 && : >>"$LOG")
# the caller (a public CI log) gets step summaries on fd 3, details stay in $LOG; nothing reads stdin
# (a timed step runs in its own process group and must never wait on a terminal)
exec 3>&1 >>"$LOG" 2>&1 </dev/null

say() {
  echo "$(date -u +%T) $*"
  echo "$(date -u +%T) $*" >&3 2>/dev/null || true
}
STEP=start REL=''
step() {
  STEP=$1
  say "- $1"
}
abort() {
  say "FAIL: $*"
  [[ -z $REL ]] || rm -rf -- "$REL"
  exit 1
}
# a failing command inside $(...) ends only that subshell; the assignment then fails here, once
trap '((BASH_SUBSHELL == 0)) || exit 1; abort "step \"$STEP\" (details in $LOG); nothing switched"' ERR
live() { # runs a command, or only logs it in dry-run mode
  if [[ -n $DRY ]]; then echo "dry-run, skipped: $*"; else "$@"; fi
}

PROC=/proc
[[ -z $DRY ]] || PROC=$ROOT/proc # dry-run: entries written by a stand-in pm2
workers_in() { # <release>: every PM2 worker runs from <release>
  local pid all=0 ok=0
  for pid in $(pm2 pid "$QW_PM2_NAME" 3>&- 9>&- 2>/dev/null || true); do
    all=$((all + 1))
    [[ $pid != 0 && $(readlink -f "$PROC/$pid/cwd" 2>/dev/null || true) == "$1/apps/server" ]] && ok=$((ok + 1))
  done
  ((all >= QW_PM2_INSTANCES && ok == all))
}
health() { # <release>: the health URL answers ok and the workers run that release
  local i body
  for ((i = 1; ; i++)); do
    body=$(curl -fsS --max-time 3 "$QW_HEALTH_URL" 2>/dev/null || true)
    [[ $body == *'"status":"ok"'* ]] && workers_in "$1" && return 0
    ((i < QW_HEALTH_TRIES)) || return 1
    sleep 2
  done
}
# PM2 may start its daemon: it must not inherit the lock (fd 9) or the caller's channel (fd 3)
reload() { live pm2 startOrReload "$BIN/ecosystem.config.cjs" --env production 3>&- 9>&- || true; }
switch_to() { ln -sfn "releases/${1##*/}" "$ROOT/current.next" && mv -T "$ROOT/current.next" "$CUR"; }
finish() { # <new> <old>: switch to <new> and reload; keep it when healthy, else go back to <old>
  trap - ERR
  set +e
  switch_to "$1" || abort "could not switch $CUR" # a new release is deleted, a rollback target kept
  reload
  if health "$1"; then
    touch "$1/DEPLOYED"
    live pm2 save 3>&- 9>&-
    say "OK $(cat "$1/REVISION") is live"
    return 0
  fi
  [[ -n $2 ]] || { say "FAIL: unhealthy, no earlier release to go back to (log $LOG)"; exit 3; }
  say "unhealthy: switching back to $(cat "$2/REVISION")"
  switch_to "$2" && reload && health "$2" && { say "SWITCHED BACK to $(cat "$2/REVISION") (log $LOG)"; exit 2; }
  say "FAIL: the earlier release is unhealthy too, manual action needed (log $LOG)"
  exit 3
}
last_ok() { # the newest deployed release other than the current one (empty when none)
  local m cur
  cur=$(readlink -f "$CUR" 2>/dev/null || true)
  # shellcheck disable=SC2045 # release names are <tag>-<UTC>: no whitespace
  for m in $(ls -1t "$ROOT"/releases/*/DEPLOYED 2>/dev/null || true); do
    [[ ${m%/DEPLOYED} == "$cur" ]] || { echo "${m%/DEPLOYED}"; return 0; }
  done
}
carry_assets() { # hard-link the running release's own and recent web assets: open tabs still load their chunks
  local f old=$CUR/apps/web/dist/assets new=$REL/apps/web/dist/assets
  [[ -d $old && -d $new ]] || return 0
  while IFS= read -r -d '' f; do
    [[ -e $new/${f##*/} ]] || ln "$f" "$new/"
  done < <(find "$old/" -maxdepth 1 -type f \( -newer "$CUR/REVISION" -o -mtime "-$QW_ASSET_CARRY_DAYS" \) -print0)
}
check_uploads() { # local uploads must live outside the code: a switch replaces it, pruning deletes it
  local v found=''
  while IFS= read -r v; do
    v=${v#STORAGE_LOCAL_ROOT=}
    v=${v//[\"\']/}
    [[ $v == /* ]] || abort "STORAGE_LOCAL_ROOT=$v is not an absolute path"
    case $(readlink -m "$v")/ in
      "$ROOT"/app/* | "$ROOT"/current/* | "$ROOT"/releases/*)
        abort "STORAGE_LOCAL_ROOT=$v lies inside the code; use a directory outside $ROOT/{app,current,releases}"
        ;;
    esac
    found=1
  done < <(grep -hs '^STORAGE_LOCAL_ROOT=' "$REL/apps/server/.env" "$REL/apps/server/.env.local" || true)
  [[ -n $found ]] || abort 'set STORAGE_LOCAL_ROOT to an absolute path in the shared env files'
}
# shellcheck disable=SC2317 # called through live
backup_db() {
  [[ -n $QW_DB_NAME ]] || abort 'QW_DB_BACKUP_CNF needs QW_DB_NAME'
  mkdir -p "$ROOT/backups"
  umask 077
  mysqldump --defaults-extra-file="$QW_DB_BACKUP_CNF" --single-transaction --no-tablespaces \
    --set-gtid-purged=OFF "$QW_DB_NAME" | gzip >"$ROOT/backups/$QW_DB_NAME-$TS-$TAG.sql.gz"
  umask 022
}
prune() { # keep the current release and QW_KEEP_RELEASES-1 newer deployed ones; drop failed leftovers
  local d n=0
  # shellcheck disable=SC2045 # release names are <tag>-<UTC>: no whitespace
  for d in $(ls -1dt "$ROOT"/releases/*/); do
    d=${d%/}
    [[ $d != "$REL" ]] || continue
    if [[ -e $d/DEPLOYED ]] && ((++n < QW_KEEP_RELEASES)); then continue; fi
    rm -rf -- "$d"
  done
  find "$ROOT/logs/deploy" -type f -mtime +90 -delete
  [[ ! -d $ROOT/backups ]] || find "$ROOT/backups" -maxdepth 1 -name '*.sql.gz' -mtime +14 -delete
}

[[ ! -e $CUR || -L $CUR ]] || abort "$CUR must be a symlink"
OLD=''
[[ ! -L $CUR ]] || OLD=$(readlink -f "$CUR")
if [[ $MODE == rollback ]]; then
  NEW=$(last_ok)
  [[ -n $NEW ]] || abort 'no earlier deployed release'
  step "switch back to $(cat "$NEW/REVISION") (code only, the database stays)"
  finish "$NEW" "$OLD"
  exit 0
fi

step "resolve $TAG"
REMOTE=https://github.com/$QW_REPO
[[ -z $DRY ]] || REMOTE=$QW_REPO # dry-run: a local git repository
# a stalled connection must not hold the lock: under 1 KB/s for 30 s ends it
SHA=$(GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=30 \
  git ls-remote "$REMOTE" "refs/tags/$TAG" "refs/tags/$TAG^{}" |
  awk -v r="refs/tags/$TAG" '{ s[$2] = $1 } END { p = r "^{}"; if (p in s) print s[p]; else print s[r] }')
[[ $SHA =~ $SHA_RE ]] || abort "tag $TAG not found in $QW_REPO"
[[ -z $WANT || $WANT == "$SHA" ]] || abort "tag $TAG points to $SHA, the caller sent $WANT"
CUR_TAG=$(awk '{ print $1 }' "$CUR/REVISION" 2>/dev/null || true)
if [[ $CUR_TAG =~ $TAG_RE && $QW_ALLOW_DOWNGRADE != 1 ]] &&
  [[ $(printf '%s\n' "$CUR_TAG" "$TAG" | sort -V | tail -n 1) != "$TAG" ]]; then
  abort "refusing to downgrade $CUR_TAG -> $TAG (use --rollback, or QW_ALLOW_DOWNGRADE=1)"
fi
FREE=$(df -Pk "$ROOT" | awk 'NR == 2 { print int($4 / 1024) }')
((FREE >= QW_MIN_FREE_MB)) || abort "only $FREE MB free under $ROOT, $QW_MIN_FREE_MB needed"

step "download $TAG ($SHA)"
mkdir -p "$ROOT/releases"
mkdir "$ROOT/releases/$TAG-$TS"
REL=$ROOT/releases/$TAG-$TS
if [[ -n $DRY ]]; then
  tar -xzf "$TARBALL" --strip-components=1 -C "$REL"
else
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 900 "https://codeload.github.com/$QW_REPO/tar.gz/$SHA" |
    tar -xzf - --strip-components=1 -C "$REL"
fi
echo "$TAG $SHA" >"$REL/REVISION"

step 'link shared files'
for p in $QW_SHARED_LINKS; do
  [[ -e $ROOT/shared/$p ]] || abort "missing $ROOT/shared/$p"
  ln -sfn "$ROOT/shared/$p" "$REL/$p"
done
check_uploads
PIN=$(tr -d '[:space:]' <"$REL/scripts/ip2region.sha256" 2>/dev/null || true)
if [[ $PIN =~ $PIN_RE ]]; then # one data file per pin, so an older release keeps its own
  XDB=$ROOT/shared/ip2region/$PIN.xdb
  if [[ ! -f $XDB && -z $DRY ]]; then
    mkdir -p "${XDB%/*}"
    node "$REL/scripts/fetch-ip2region.mjs" --out "$XDB" || say 'warning: ip2region not fetched, IP locations stay empty'
  fi
  if [[ -f $XDB ]]; then
    mkdir -p "$REL/apps/server/data"
    ln -sfn "$XDB" "$REL/apps/server/data/ip2region_v4.xdb"
  fi
fi

# each long step has a time limit, so a hung one cannot hold the lock (or a DDL wait the table) for
# good; GNU timeout signals the whole process group of the step
# shellcheck disable=SC2317 # called through live
timed() { timeout -v -k 30s "$@"; }
cd "$REL"
step 'install'
live timed "$QW_BUILD_TIMEOUT" env -u NODE_ENV HUSKY=0 pnpm i --frozen-lockfile
step 'build'
live timed "$QW_BUILD_TIMEOUT" env -u NODE_ENV nice -n 10 pnpm -r build
step 'carry web assets of the running release'
carry_assets

cd "$REL/apps/server"
ENVS=(--env-file-if-exists=.env.local --env-file-if-exists=.env)
[[ -z $QW_MIGRATE_ENV ]] || ENVS+=("--env-file=$QW_MIGRATE_ENV") # the last file wins
if [[ -n $QW_DB_BACKUP_CNF ]]; then
  step "back up $QW_DB_NAME"
  live backup_db
fi
step 'migrate'
live timed "$QW_MIGRATE_TIMEOUT" node "${ENVS[@]}" dist/db/migrate.js
if [[ $QW_DEPLOY_SEED == 1 ]]; then
  step 'seed'
  live timed "$QW_MIGRATE_TIMEOUT" node "${ENVS[@]}" dist/db/seed.js
fi

step 'switch and reload'
finish "$REL" "$OLD"
prune || true # the deploy already succeeded: cleanup never fails it
