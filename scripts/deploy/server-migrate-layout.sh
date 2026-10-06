#!/usr/bin/env bash
# Prepares a server for server-deploy.sh and moves a single-directory install (<root>/app run by a
# PM2 fork process) to the release layout. Run as root from a copy of the kit that only root can
# change (a release unpacked by root into a root-owned directory, never <root>/current or releases):
#   bash /root/qiwu-kit-<tag>/scripts/deploy/server-migrate-layout.sh [--pubkey <deploy_key.pub>] [--root /srv/qiwu]
# Steps, each skipped when already done (the script can run again): install the kit into the
# root-owned /opt/qiwu-deploy (bin/, deploy.env, deploy.lock), make <root> root:<app group> 1775 (the
# app user adds its own entries, the sticky bit keeps root's), create the directories, copy the env
# files and ip2region data into shared/, move <root>/app to releases/legacy-* behind <root>/current
# (<root>/app stays as a compatibility link), point Nginx at current, give the deploy key its forced
# command in a root-owned keys file, and restart the PM2 app as a cluster (the only downtime, a few
# seconds). Updating the kit after a release changed scripts/deploy is the same command. Root writes
# only root-owned paths: everything under <root> and in the app user's home runs as the app user.
# See docs/deploy.md.
set -euo pipefail
KIT=$(dirname "$(readlink -f "$0")")
DEST=/opt/qiwu-deploy ROOT=/srv/qiwu PUBKEY='' SSHD_CONF=/etc/ssh/sshd_config.d/60-qiwu-deploy.conf
SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin # what a forced SSH command gets
while (($#)); do
  case $1 in
    --pubkey) PUBKEY=${2:?--pubkey needs a file} && shift 2 ;;
    --root) ROOT=${2:?--root needs a directory} && shift 2 ;;
    *) echo 'usage: server-migrate-layout.sh [--pubkey <deploy_key.pub>] [--root <dir>]' >&2 && exit 64 ;;
  esac
done
log() { echo "== $*"; }
die() {
  echo "STOP: $*" >&2
  exit 1
}
# root runs this kit and installs it into the root-owned bin/: a kit another user can change would
# hand that user root (and the deploy logic)
trusted() { # <path>: owned by root, not writable by group or others (a link has mode 777: refused)
  local m
  m=$(stat -c '%u %a' -- "$1" 2>/dev/null) || return 1
  [[ ${m%% *} == 0 ]] && ((!(8#${m#* } & 8#22)))
}
p=$KIT
while :; do
  trusted "$p" || die "$p must be owned by root and not writable by group or others: unpack the release as root into a root-owned directory (docs/deploy.md)"
  [[ $p != / ]] || break
  p=$(dirname "$p")
done
for f in server-migrate-layout.sh server-deploy.sh deploy-forced-command.sh ecosystem.config.cjs deploy.env.example; do
  { [[ -f $KIT/$f ]] && trusted "$KIT/$f"; } || die "$KIT/$f must be a file owned by root and not writable by group or others"
done
[[ $(id -u) == 0 ]] || die 'run as root'
TS=$(date -u +%Y%m%dT%H%M%SZ)
BK=/root/qiwu-layout-backup-$TS # Nginx files before they change

install -d -o root -g root -m 0755 "$DEST" "$DEST/bin"
if [[ ! -f $DEST/deploy.env ]]; then
  install -o root -g root -m 0644 "$KIT/deploy.env.example" "$DEST/deploy.env"
  sed -i "s#^QW_DEPLOY_ROOT=.*#QW_DEPLOY_ROOT=$ROOT#" "$DEST/deploy.env"
  die "review $DEST/deploy.env (QW_PM2_NAME = the running PM2 app, QW_APP_USER, QW_REPO), then run again"
fi
set -a
# shellcheck source=/dev/null
. "$DEST/deploy.env"
set +a
U=${QW_APP_USER:-qiwu} NAME=${QW_PM2_NAME:-qiwu-server} INST=${QW_PM2_INSTANCES:-2}
H=$(getent passwd "$U" | cut -d: -f6 || true)
[[ $U != root ]] || die 'QW_APP_USER must not be root'
[[ -n $H ]] || die "no user $U"
G=$(id -gn "$U")
# <root> becomes group-writable: any other user in the group could add files there, and in the app
# user's home when that is <root> (dotfiles that git and pnpm read during a deploy)
own_group() {
  local gid others
  gid=$(getent group "$G" | cut -d: -f3)
  others=$({ getent group "$G" | cut -d: -f4 | tr , '\n' && getent passwd | awk -F: -v g="$gid" '$4 == g { print $1 }'; } |
    awk -v u="$U" 'NF && $0 != u' | sort -u | paste -sd, -)
  [[ -z $others ]] || die "group $G of $U also holds $others, who could write in $ROOT: give $U a group of its own"
}
own_group
# a clean environment: nothing of the root session reaches PM2 (it saves the CLI environment); fd 9
# is the lock, which a PM2 daemon started here must not keep
as_app() {
  runuser -u "$U" -- env -i HOME="$H" PATH="$SAFE_PATH" QW_DEPLOY_ROOT="$ROOT" QW_PM2_NAME="$NAME" \
    QW_PM2_INSTANCES="$INST" "$@" 9>&-
}
# the deploy runs over SSH with the default PATH: the tools must be found there, not only in a login shell
for t in git curl tar flock timeout node pnpm pm2; do
  as_app bash -c "command -v $t" >/dev/null || die "$t is not on the default PATH of $U"
done

# the lock of server-deploy.sh: in a root-owned directory, so opening it never follows a link of the app user
: >>"$DEST/deploy.lock"
chown "root:$G" "$DEST/deploy.lock" && chmod 0660 "$DEST/deploy.lock"
exec 9>>"$DEST/deploy.lock"
flock -n 9 || die 'a deploy is running: run again when it has finished'
log "deploy kit -> $DEST/bin (root-owned: the app user cannot change the deploy logic or its settings)"
for f in server-deploy.sh deploy-forced-command.sh ecosystem.config.cjs; do
  install -o root -g root -m 0755 "$KIT/$f" "$DEST/bin/.$f.new"
  mv -f "$DEST/bin/.$f.new" "$DEST/bin/$f" # a new file: a running bash keeps reading its old copy
done

P=$(readlink -f "$(dirname "$ROOT")")
[[ ! -L $ROOT && $(stat -c %U "$P") == root ]] || die "$ROOT must be a directory (not a link) inside a root-owned one"
log "$ROOT: root:$G 1775"
mkdir -p "$ROOT"
chown "root:$G" "$ROOT" && chmod 1775 "$ROOT"
log "directories (as $U)"
as_app mkdir -p "$ROOT/releases" "$ROOT/shared/apps/server" "$ROOT/shared/ip2region" "$ROOT/logs/deploy"
as_app mkdir -p -m 0700 "$ROOT/backups"

pm2_info() { # "<exec mode> <count> <online|down>" of the PM2 app, or "none"
  # shellcheck disable=SC2016 # a JavaScript template literal, not a shell expansion
  as_app pm2 jlist 2>/dev/null | as_app node -e '
    let s = ""
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      // a starting daemon prints "[PM2] ..." lines first: only the JSON line counts
      const line = s.split("\n").find((l) => l.startsWith("[{") || l.startsWith("[]"))
      const all = JSON.parse(line ?? "[]").filter((p) => p.name === process.argv[1])
      const up = all.every((p) => p.pm2_env.status === "online") ? "online" : "down"
      console.log(all.length ? `${all[0].pm2_env.exec_mode} ${all.length} ${up}` : "none")
    })' "$NAME"
}
healthy() { # the health URL answers ok and every PM2 worker runs from the current release
  local i pid all ok want body
  want=$(readlink -f "$ROOT/current")/apps/server
  for ((i = 0; i < ${QW_HEALTH_TRIES:-30}; i++)); do
    sleep 2
    body=$(curl -fsS --max-time 3 "${QW_HEALTH_URL:-http://127.0.0.1:3000/api/health}" 2>/dev/null || true)
    [[ $body == *'"status":"ok"'* ]] || continue
    all=0 ok=0
    for pid in $(as_app pm2 pid "$NAME" 2>/dev/null || true); do
      all=$((all + 1))
      [[ $pid != 0 && $(readlink -f "/proc/$pid/cwd" 2>/dev/null || true) == "$want" ]] && ok=$((ok + 1))
    done
    ((all >= INST && ok == all)) && return 0
  done
  return 1
}
check_uploads() { # STORAGE_LOCAL_ROOT is absolute and outside the code (a switch replaces it, pruning deletes it)
  local v found=''
  while IFS= read -r v; do
    v=${v#STORAGE_LOCAL_ROOT=}
    v=${v//[\"\']/}
    case $(readlink -m "$v")/ in "$ROOT"/app/* | "$ROOT"/current/* | "$ROOT"/releases/*) v='' ;; esac
    [[ $v == /* ]] ||
      die "STORAGE_LOCAL_ROOT lies inside the code: move the uploads outside $ROOT/app, set an absolute path, restart, run again"
    found=1
  done < <(as_app grep -hs '^STORAGE_LOCAL_ROOT=' "$ROOT/shared/apps/server/.env" "$ROOT/shared/apps/server/.env.local" || true)
  [[ -n $found ]] || die "set an absolute STORAGE_LOCAL_ROOT outside $ROOT/app in $ROOT/shared/apps/server/.env"
}
# the deploy key may only run the forced command. Its keys file is root-owned and outside the app
# user's home: that home may be <root> itself, group-writable, where sshd (StrictModes) refuses
# ~/.ssh/authorized_keys; and the app user cannot add keys of its own
deploy_key() { # <public key file>
  local key ak=$DEST/authorized_keys forced=$DEST/bin/deploy-forced-command.sh
  key=$(head -n 1 "$1")
  [[ $key =~ ^ssh-[a-z0-9-]+\ [A-Za-z0-9+/=]+ ]] || die "$1 is not an SSH public key"
  log "sshd: user $U may only run $forced, keys in $ak"
  case $(getent passwd "$U" | cut -d: -f7) in */nologin | */false) usermod -s /bin/bash "$U" ;; esac
  [[ $(passwd -S "$U" | awk '{ print $2 }') == L ]] || echo "warning: the password of $U is not locked (passwd -l $U)"
  local kv bad='' want=("AuthorizedKeysFile $ak" 'AuthenticationMethods publickey' "ForceCommand $forced"
    'DisableForwarding yes' 'PermitUserRC no' 'PermitTTY no')
  { echo "Match User $U" && printf '    %s\n' "${want[@]}"; } >"$SSHD_CONF.new"
  mv "$SSHD_CONF.new" "$SSHD_CONF"
  # an earlier Match block for the user wins over ours (sshd keeps the first value it reads): only the
  # effective settings tell whether ours apply
  cfg() { sshd -T -C "user=$1,host=localhost,addr=127.0.0.1" 2>/dev/null | awk -v k="$2" '$1 == tolower(k) { sub(/^[^ ]+ /, ""); print }'; }
  sshd -t || bad=1
  for kv in "${want[@]}"; do [[ $(cfg "$U" "${kv%% *}") == "${kv#* }" ]] || bad=1; done
  [[ $(cfg root forcecommand) != "$forced" && $(cfg root authorizedkeysfile) != *"$ak"* ]] || bad=1
  if [[ -n $bad ]]; then
    rm -f "$SSHD_CONF"
    die "the sshd drop-in did not check out and was removed ($SSHD_CONF)"
  fi
  touch "$ak"
  chown root:root "$ak" && chmod 0644 "$ak" # sshd reads it as the app user
  grep -qF -- "$(awk '{ print $2 }' <<<"$key")" "$ak" ||
    printf '%s\n' "restrict,command=\"$forced\" $key" >>"$ak"
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  sshd -T 2>/dev/null | awk -v u="$U" '$1 ~ /^allow(users|groups)$/ { print "warning: sshd " $0 " - add " u }'
}

APP=$ROOT/app
if [[ -d $APP && ! -L $APP ]]; then
  [[ ! -e $ROOT/current ]] || die "both $APP and $ROOT/current exist"
  [[ $(pm2_info) == *' online' ]] || die "PM2 app $NAME is not online (QW_PM2_NAME in $DEST/deploy.env)"
  log "env files and ip2region data -> $ROOT/shared (as $U)"
  # the legacy release then reads the shared files too: its workers, and a way back to it, see edits
  # and rotated secrets (running processes read their env at start)
  for f in .env .env.local; do
    L=$APP/apps/server/$f S=$ROOT/shared/apps/server/$f
    [[ -f $L ]] || continue
    [[ -e $S ]] || as_app cp -p "$L" "$S"
    [[ $(readlink -f "$L") != $(readlink -f "$S") ]] || continue
    as_app cmp -s "$L" "$S" || die "$L and $S differ: give both the right content, then run again"
    as_app ln -sfn "$S" "$L.layout-new"
    as_app mv -T "$L.layout-new" "$L"
  done
  check_uploads
  XDB=$APP/apps/server/data/ip2region_v4.xdb
  if [[ -f $XDB ]]; then
    SUM=$(as_app sha256sum "$XDB" | cut -d' ' -f1)
    [[ -f $ROOT/shared/ip2region/$SUM.xdb ]] || as_app cp "$XDB" "$ROOT/shared/ip2region/$SUM.xdb"
  fi
  REV=$(as_app head -n 1 "$APP/.deployed-tag" 2>/dev/null | cut -d' ' -f1 | tr -dc 'A-Za-z0-9.' | cut -c1-40 || true)
  REV=${REV:-unknown}
  ID=legacy-${REV:0:12}-$TS
  log "$APP -> $ROOT/releases/$ID, $ROOT/current -> it, $APP -> current (as $U)"
  as_app mv "$APP" "$ROOT/releases/$ID"
  as_app ln -s "releases/$ID" "$ROOT/current"
  as_app ln -s current "$APP"
  printf 'legacy %s\n' "$REV" | as_app tee "$ROOT/releases/$ID/REVISION" >/dev/null
  as_app touch -d @0 "$ROOT/releases/$ID/REVISION" # older than every web asset: the first deploy keeps them all
  as_app touch "$ROOT/releases/$ID/DEPLOYED"
elif [[ -L $ROOT/current ]]; then
  log "$ROOT/current exists: layout already moved"
else
  log "no $APP: the first server-deploy.sh run creates $ROOT/current"
fi

mapfile -t CONFS < <(grep -rlF -- "$ROOT/app/" /etc/nginx 2>/dev/null || true)
if ((${#CONFS[@]})); then
  log "Nginx: $ROOT/app/ -> $ROOT/current/ in ${CONFS[*]}"
  install -d -m 0700 "$BK"
  for f in "${CONFS[@]}"; do cp -p "$f" "$BK/nginx-${f//\//_}" && sed -i "s#$ROOT/app/#$ROOT/current/#g" "$f"; done
  if ! nginx -t; then
    for f in "${CONFS[@]}"; do cp -p "$BK/nginx-${f//\//_}" "$f"; done
    die 'nginx -t failed: the Nginx files were restored'
  fi
  systemctl reload nginx
fi

[[ -z $PUBKEY ]] || deploy_key "$PUBKEY"

INFO=$(pm2_info)
if [[ $INFO == none ]]; then
  log "PM2 app $NAME not running: the first server-deploy.sh run starts it"
elif [[ $INFO == "cluster_mode $INST online" ]]; then
  log "PM2 app $NAME already runs $INST cluster workers"
else
  log "PM2 app $NAME ($INFO) -> $INST cluster workers: a few seconds of downtime"
  DUMP=$H/.pm2/dump.pm2
  if as_app test -f "$DUMP"; then as_app cp -p "$DUMP" "$DUMP.layout-$TS"; fi
  as_app pm2 delete "$NAME"
  as_app pm2 start "$DEST/bin/ecosystem.config.cjs" --env production || true
  if ! healthy; then
    as_app pm2 delete "$NAME" || true
    if as_app test -f "$DUMP.layout-$TS"; then
      as_app cp -p "$DUMP.layout-$TS" "$DUMP"
      as_app pm2 resurrect
    fi
    die "the cluster did not become healthy: the saved PM2 process list was restored ($DUMP.layout-$TS)"
  fi
  as_app pm2 save
fi

log 'done. Next:'
echo "- after the first automatic deploy: grep -r $ROOT/app /etc/nginx (no match), then sudo -u $U rm $APP (a link)"
echo '- DEPLOY_KNOWN_HOSTS line (put the address of DEPLOY_HOST first):'
echo "  <server address> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
