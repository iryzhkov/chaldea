#!/bin/sh
set -eu
umask 077
root=$(pwd -P)
export HOME="$root/.blob-image/home" TMPDIR="$root/.blob-image/tmp"
test "$HOME" = "$root/.blob-image/home"
test "$TMPDIR" = "$root/.blob-image/tmp"
unset XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR SSH_AUTH_SOCK
test ! -e "$root/.blob-image"
mkdir -p "$HOME" "$TMPDIR"
trap 'rm -rf "$root/.blob-image"' EXIT
python3 -B test/blob/maintenance.py
