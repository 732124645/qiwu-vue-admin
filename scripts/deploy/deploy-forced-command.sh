#!/usr/bin/env bash
# sshd forced command of the deploy key: accepts exactly "<vX.Y.Z> <40-hex commit sha>" and runs
# server-deploy.sh with them; anything else (a shell, options, --rollback, extra words) exits 64.
set -euo pipefail
export LC_ALL=C # sshd accepts LC_* from the client: one fixed locale for the checks and the deploy
re='^(v[0-9]+\.[0-9]+\.[0-9]+) ([0-9a-f]{40})$'
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ $re ]]; then
  exec "$(dirname "$(readlink -f "$0")")/server-deploy.sh" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
fi
echo 'usage: ssh <user>@<host> "<vX.Y.Z> <commit sha>"' >&2
exit 64
