# Shared helpers for the homelab CLI tools. Sourced, never executed.

# shellcheck shell=bash

HOMELAB_CONFIG=${HOMELAB_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/homelab-cli/config}

die() {
	printf '%s: %s\n' "${PROGRAM:-homelab}" "$*" >&2
	exit 1
}

warn() {
	printf '%s: %s\n' "${PROGRAM:-homelab}" "$*" >&2
}

need() {
	local binary
	for binary in "$@"; do
		command -v "$binary" >/dev/null 2>&1 || die "required command not found: $binary"
	done
}

# Optional per-machine overrides: HOST_PVE, HOST_UDM, HA_URL and so on.
load_config() {
	# shellcheck source=/dev/null
	[[ -r $HOMELAB_CONFIG ]] && source "$HOMELAB_CONFIG"
	return 0
}

# Read a password or token out of the GNOME keyring. Secrets are never stored in
# this repository or in the job files; the keyring is the only copy.
keyring_get() {
	local service=$1 account=$2
	need secret-tool
	local secret
	secret=$(secret-tool lookup service "$service" username "$account" 2>/dev/null) || true
	[[ -n $secret ]] || secret=$(secret-tool lookup service "$service" account "$account" 2>/dev/null) || true
	[[ -n $secret ]] || secret=$(secret-tool lookup service "$service" 2>/dev/null) || true
	[[ -n $secret ]] ||
		die "no secret in the keyring for service '$service' (account '$account'); store one with: secret-tool store --label='$service' service $service username $account"
	printf '%s' "$secret"
}

# Pretty-print JSON when the caller wants human output, pass it through when a
# script is consuming it.
emit_json() {
	if [[ ${AS_JSON:-0} == 1 ]] || [[ ! -t 1 ]]; then
		cat
	else
		jq .
	fi
}

# A table from JSON: emit_table <jq-row-expression> <header...>
emit_table() {
	local row_expression=$1
	shift
	if [[ ${AS_JSON:-0} == 1 ]]; then
		cat
		return
	fi
	local input
	input=$(cat)
	# An upstream command that failed produces nothing; printing a bare header
	# under its error message would suggest the query merely came back empty.
	[[ -n ${input//[[:space:]]/} ]] || return 1
	{
		(($#)) && printf '%s\n' "$(
			IFS=$'\t'
			printf '%s' "$*"
		)"
		jq -r "$row_expression" <<<"$input"
	} | column -t -s $'\t'
}
