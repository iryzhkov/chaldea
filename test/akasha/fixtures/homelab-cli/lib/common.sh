# Shared helpers for the homelab CLI tools. Sourced, never executed.

# shellcheck shell=bash

HOMELAB_CONFIG=${HOMELAB_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/homelab-cli/config}
HOMELAB_LIB=$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)

# The output mode of this run: text, json (the JSON a command printed before
# the shared contract, also asked for with --raw) or v2 (one homelab/v1
# envelope). See contract_parse and README "Output and input contract".
OUTPUT=text
LIMIT=
INPUT=

die() {
	printf '%s: %s\n' "${PROGRAM:-homelab}" "$*" >&2
	if [[ -n ${HOMELAB_ERRORS:-} ]]; then
		# A child run of a --format v2 command: the parent turns this into an
		# errors[] entry. A class named by die_class already is the better one.
		[[ -s $HOMELAB_ERRORS ]] || contract_error internal "$*"
	elif [[ $OUTPUT == v2 ]]; then
		contract_error_line internal "$*"
	fi
	exit 1
}

# die_class refuses like die, naming the contract's error class first:
# usage, not_found, denied, unavailable, timeout, requires_ssh, partial or
# internal. die_class <class> <message> [next step]
die_class() {
	local class=$1 message=$2 next=${3:-}
	printf '%s: %s\n' "${PROGRAM:-homelab}" "$message" >&2
	if [[ -n ${HOMELAB_ERRORS:-} ]]; then
		contract_error "$class" "$message" "$next"
	elif [[ $OUTPUT == v2 ]]; then
		contract_error_line "$class" "$message" "$next"
	fi
	exit 1
}

warn() {
	printf '%s: %s\n' "${PROGRAM:-homelab}" "$*" >&2
}

need() {
	local binary
	for binary in "$@"; do
		command -v "$binary" >/dev/null 2>&1 && continue
		case $binary in
		ssh | scp | rsync) die_class requires_ssh "required command not found: $binary" \
			"this read needs SSH today; run it where an ssh client and keys are set up" ;;
		*) die_class unavailable "required command not found: $binary" "install $binary" ;;
		esac
	done
}

# Optional per-machine overrides: HOST_PVE, HOST_UDM, HA_URL and so on.
load_config() {
	# shellcheck source=/dev/null
	[[ -r $HOMELAB_CONFIG ]] && source "$HOMELAB_CONFIG"
	return 0
}

# Refuse credentials in endpoint settings before any diagnostic can echo them.
# Extra arguments identify v2 only for this early usage refusal; flag parsing
# still belongs to the tool and no setting value enters the message.
require_plain_url() {
	local name=$1 value authority previous='' argument
	shift
	value=${!name:-}
	authority=${value#*://}
	# urlsplit also treats leading // as an authority, without a scheme.
	authority=${authority#//}
	authority=${authority%%/*}
	if [[ $authority == *@* || $value == *\?* || $value == *\#* ]]; then
		for argument in "$@"; do
			[[ $argument == --format=v2 || ( $previous == --format && $argument == v2 ) ]] && OUTPUT=v2
			previous=$argument
		done
		die_class usage "$name must be a plain URL without user info, a query or a fragment"
	fi
	return 0
}

# This list is shared with contract.CREDENTIAL_KEY (tested for equality).
CREDENTIAL_KEY='(token|password|passwd|passphrase|secret|authorization|cookie|api[_-]?key|auth[_-]?key|private[_-]?key|pre[_-]?shared|psk|credential)'

# Redact credential-named strings before JSON or table output. Keep field
# names, scalar types and container shape, including beneath a credential key.
redact_keys() {
	jq --arg credential_key "$CREDENTIAL_KEY" '
		def hide_strings:
			if type == "string" then "<redacted>"
			elif type == "array" then map(hide_strings)
			elif type == "object" then with_entries(.value |= hide_strings)
			else . end;
		# jq compiles the regex on every test() call, which made a 1 MB Home
		# Assistant state dump cost seconds of CPU. Match each distinct key
		# name once and look the answer up while walking.
		(reduce (.. | objects | keys_unsorted[]) as $key ({};
			if has($key) then . else .[$key] = ($key | test($credential_key; "i")) end)) as $credential
		| def redact:
			if type == "object" then with_entries(
				if $credential[.key] then .value |= hide_strings
				else .value |= redact end)
			elif type == "array" then map(redact)
			else . end;
		redact'
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
		die_class denied "no secret in the keyring for service '$service' (account '$account')" \
			"store one with: secret-tool store --label='$service' service $service username $account"
	printf '%s' "$secret"
}

# limit_items applies key-based redaction and an optional array limit.
limit_items() {
	if [[ -n $LIMIT ]]; then
		redact_keys | jq --argjson limit "$LIMIT" 'if type == "array" then .[0:$limit] else . end'
	else
		redact_keys
	fi
}

# Pretty-print JSON when the caller wants human output, pass it through when a
# script is consuming it.
emit_json() {
	if [[ ${AS_JSON:-0} == 1 ]] || [[ ! -t 1 ]]; then
		limit_items
	else
		limit_items | jq .
	fi
}

# A table from JSON: emit_table <jq-row-expression> <header...>
emit_table() {
	local row_expression=$1
	shift
	if [[ ${AS_JSON:-0} == 1 ]]; then
		limit_items
		return
	fi
	local input
	input=$(limit_items)
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

# ---------------------------------------------------------------------------
# The read-only output and input contract (homelab/v1)
#
# The envelope, the error lines and --input validation are lib/contract.py,
# one implementation for every tool. This half parses the shared flags, and
# runs a --format v2 read as a child of the tool itself with --raw, so the
# child prints exactly what --json always printed and the parent wraps it:
# the read path is the same code in every mode, and nothing in the envelope
# can reach a write path.
# ---------------------------------------------------------------------------

# Help text for the shared read options, appended to a subcommand's help. The
# usage text of pve, ha and unifi carries a copy, so that it can be printed
# without this file (test/contract-review3.test.sh keeps the copies equal).
CONTRACT_HELP='Output and input (read commands; see README "Output and input contract"):
  --json              The JSON this command has always printed (unchanged).
  --raw               The same as --json.
  --format v2         One homelab/v1 envelope on stdout: canonical targets,
                      errors, completeness. Exit 3 when the result is partial.
  --limit N           At most N items (1-1000; with --format v2 default 100).
  --input FILE|-      Targets from a homelab/v1 envelope, item or item array,
                      for commands that take one target. Never a grant.
'

# contract_error appends one errors[] entry for the parent of a child run.
# contract_error <class> <message> [next step] [target]
contract_error() {
	[[ -n ${HOMELAB_ERRORS:-} ]] || return 0
	jq -nc --arg class "$1" --arg message "$2" --arg next "${3:-}" --arg target "${4:-}" \
		'{class: $class, message: $message,
		  next_step: (if $next == "" then null else $next end),
		  target: (if $target == "" then null else $target end)}' >>"$HOMELAB_ERRORS" 2>/dev/null
	return 0
}

# contract_error_line writes one homelab/error/v1 line to stderr, for a
# --format v2 refusal that happens before any child run. Values go in the
# --option=value form, as in every call of contract.py here, so a value that
# starts with - (a refused command word such as --) is not read as an option.
contract_error_line() {
	local -a next=()
	[[ -n ${3:-} ]] && next=("--next-step=$3")
	python3 "$HOMELAB_LIB/contract.py" error "--tool=${PROGRAM:-homelab}" \
		"--command=${CONTRACT_COMMAND:-}" "--class=$1" "${next[@]}" -- "$2" ||
		printf '{"schema":"homelab/error/v1","tool":"%s","class":"%s"}\n' "${PROGRAM:-homelab}" "$1" >&2
}

# print_text prints its standard input, a usage here-document, with builtins
# only, so that help needs no program at all, not even cat (unit section 3).
print_text() {
	local text
	IFS= read -r -d '' text || true
	printf '%s' "$text"
}

# help_requested: -h or --help anywhere, or "help" as the first word, outside
# the values of the shared value options. Sets HELP_TOPIC to the first word
# that is not an option, which is the subcommand whose help to print.
help_requested() {
	HELP_TOPIC=
	while (($#)); do
		case $1 in
		-h | --help) return 0 ;;
		--) return 1 ;;
		--limit | --input | --format)
			shift
			(($#)) && shift
			continue
			;;
		-*) ;;
		*)
			if [[ -z $HELP_TOPIC ]]; then
				[[ $1 == help ]] && { HELP_TOPIC=${2:-}; return 0; }
				HELP_TOPIC=$1
			fi
			;;
		esac
		shift
	done
	return 1
}

# print_help [subcommand]: the lines of usage that describe one subcommand, or
# the whole of it. Only the shell and the tool's own usage text are used.
print_help() {
	local topic=${1:-} line printing=0
	local -a lines=()
	if [[ -n $topic && $topic != -* ]]; then
		while IFS= read -r line; do
			if [[ $line =~ ^\ \ ([a-z][a-z0-9-]*)(\ |$) ]]; then
				printing=0
				[[ ${BASH_REMATCH[1]} == "$topic" ]] && printing=1
			elif [[ ! $line =~ ^\ {4,} ]]; then
				printing=0
			fi
			((printing)) && lines+=("$line")
		done < <(usage)
	fi
	if ((${#lines[@]})); then
		printf 'Usage: %s [options] %s\n\n' "${PROGRAM:-homelab}" "$topic"
		printf '%s\n' "${lines[@]}"
		printf '\n%s' "$CONTRACT_HELP"
		printf '\nRun "%s --help" for every command.\n' "${PROGRAM:-homelab}"
	else
		usage
	fi
}

# contract_parse takes the shared flags out of the arguments, wherever they
# are, and leaves the rest in ARGS. Everything after "--" is left alone.
contract_parse() {
	ARGS=()
	while (($#)); do
		case $1 in
		--)
			ARGS+=("$@")
			break
			;;
		--json | --raw) [[ $OUTPUT == v2 ]] || OUTPUT=json ;;
		--format | --format=*)
			local value
			if [[ $1 == --format ]]; then
				value=${2-}
				(($# >= 2)) && shift
			else
				value=${1#--format=}
			fi
			[[ $value == v2 ]] || { OUTPUT=v2; die_class usage "--format takes v2, not '$value'"; }
			OUTPUT=v2
			;;
		--limit | --limit=*)
			if [[ $1 == --limit ]]; then
				LIMIT=${2-}
				(($# >= 2)) && shift
			else
				LIMIT=${1#--limit=}
			fi
			[[ -n $LIMIT ]] || die_class usage "--limit must be a whole number from 1 to 1000, not ''"
			;;
		--input | --input=*)
			if [[ $1 == --input ]]; then
				INPUT=${2-}
				(($# >= 2)) && shift
			else
				INPUT=${1#--input=}
			fi
			[[ -n $INPUT ]] || die_class usage "--input needs a file, or - for stdin"
			;;
		*) ARGS+=("$1") ;;
		esac
		shift
	done
	# Digits are spelled out: in some locales [0-9] also matches '²'.
	if [[ -n $LIMIT ]] && { [[ ! $LIMIT =~ ^[123456789][0123456789]{0,3}$ ]] || ((10#$LIMIT > 1000)); }; then
		die_class usage "--limit must be a whole number from 1 to 1000, not '$LIMIT'"
	fi
	# --input is read, validated and honoured only by contract_run, which
	# --format v2 reaches. In any other mode it is refused here, before any
	# backend call, rather than silently ignored next to a positional target.
	if [[ -n $INPUT && $OUTPUT != v2 ]]; then
		die_class usage "--input needs --format v2, which reads every target it names; --json and text take the target as an operand"
	fi
	[[ $OUTPUT == text ]] || AS_JSON=1
	return 0
}

# contract_leading moves the shared output flags that come before a tool's
# command word to just after it, so "t3-job --json list" means
# "t3-job list --json", for a tool that reads its command first. The result is
# in ARGS. Nothing else is moved, and "--" stops it.
contract_leading() {
	local -a lead=()
	while (($#)); do
		case $1 in
		--json | --raw | --format=* | --limit=* | --input=*) lead+=("$1") ;;
		--format | --limit | --input)
			lead+=("$1" "${2-}")
			(($# >= 2)) && shift
			;;
		*) break ;;
		esac
		shift
	done
	if (($#)); then
		ARGS=("$1" ${lead[@]+"${lead[@]}"} "${@:2}")
	else
		ARGS=(${lead[@]+"${lead[@]}"})
	fi
}

# contract_run runs one read command for --format v2 and exits with its code.
#
# The tool sets, before calling it:
#   C_SHAPE      items (backend array), item (one object per target),
#                data (one object) or lines (text, one entry per line)
#   C_TARGET     jq expression for an item's canonical target; $pos is the
#                command's operand
#   C_REVISION   jq expression for the backend's revision marker, else null
#   C_BACKEND, C_TRANSPORT, C_ENDPOINT   for source
#   C_KIND       the --input target kind, empty when the command takes none
#   C_VERDICTS   exit codes, besides 0 and 3, that a command documents for a
#                result it read (homelab-health: "1 2"); default none
#   C_NO_VERB    set for a tool whose command is not a word on its command
#                line (homelab-health), so the child is run without it
#
# contract_run <command> [operands...]
contract_run() {
	local command=$1
	shift
	CONTRACT_COMMAND=$command
	command -v python3 >/dev/null 2>&1 ||
		die_class unavailable "--format v2 needs python3, which is not installed" "install python3"
	local dir
	dir=$(mktemp -d "${TMPDIR:-/tmp}/homelab-contract.XXXXXX") || die "cannot create a temporary directory"
	local -a targets=()
	if [[ -n $INPUT ]]; then
		if [[ -z ${C_KIND:-} ]]; then
			rm -rf "$dir"
			die_class usage "$command takes no --input"
		fi
		if (($#)); then
			rm -rf "$dir"
			die_class usage "give $command a target or --input, not both"
		fi
		local listing
		if ! listing=$(python3 "$HOMELAB_LIB/contract.py" input --full --structured \
			"--kind=$C_KIND" "--tool=${PROGRAM:-homelab}" "--command=$command" -- "$INPUT"); then
			rm -rf "$dir"
			exit 1
		fi
		mapfile -t targets <<<"$listing"
	fi
	local n=0 status=0 ok=0 rc target
	local -a verb=("$command")
	[[ -z ${C_NO_VERB:-} ]] || verb=()
	VERDICT=0
	if ((${#targets[@]})); then
		for target in "${targets[@]}"; do
			rc=0
			contract_child "$dir" "$n" "$target" "${target##*/}" "${verb[@]}" "${target##*/}" || rc=$?
			((rc)) && ((status == 0)) && status=$rc
			((rc)) || ok=1
			n=$((n + 1))
		done
		# Some targets answered: that is a partial result, which the
		# envelope's errors and exit code 3 report.
		((ok)) && status=0
	else
		contract_child "$dir" 0 "" "${1:-}" "${verb[@]}" "$@" || status=$?
	fi
	local shape=items
	[[ $C_SHAPE == data || $C_SHAPE == lines ]] && shape=data
	local -a limit=()
	[[ -n $LIMIT ]] && limit=(--limit "$LIMIT")
	rc=0
	{
		if [[ $shape == data ]]; then
			cat "$dir/rows.0" 2>/dev/null
		elif compgen -G "$dir/rows.*" >/dev/null; then
			jq -s -c 'add // []' "$dir"/rows.*
		else
			printf '[]'
		fi
	} | python3 "$HOMELAB_LIB/contract.py" envelope "--tool=${PROGRAM:-homelab}" "--command=$command" \
		"--backend=$C_BACKEND" "--transport=$C_TRANSPORT" "--endpoint=${C_ENDPOINT:-}" \
		--shape "$shape" --status "$status" --verdict "$VERDICT" --errors "$dir/errors" "${limit[@]}" || rc=$?
	rm -rf "$dir"
	exit "$rc"
}

# contract_emit [errors-file] [status]: wrap rows read on stdin ([{target,
# revision, data}] for items, one object for data) in an envelope, for a read
# the tool answers itself rather than through a child run. A nonzero status
# is a failed read. Exits with the envelope's code.
contract_emit() {
	local shape=items rc=0
	[[ $C_SHAPE == data ]] && shape=data
	local -a extra=()
	[[ -n $LIMIT ]] && extra+=(--limit "$LIMIT")
	[[ -n ${1:-} ]] && extra+=(--errors "$1")
	python3 "$HOMELAB_LIB/contract.py" envelope "--tool=${PROGRAM:-homelab}" "--command=$CONTRACT_COMMAND" \
		"--backend=$C_BACKEND" "--transport=$C_TRANSPORT" "--endpoint=${C_ENDPOINT:-}" \
		--shape "$shape" --status "${2:-0}" "${extra[@]}" || rc=$?
	exit "$rc"
}

# contract_child <dir> <n> <target> <operand> <command> [operands...]
# One child run with --raw, its rows in rows.<n> and its errors appended to
# errors. A child that exits 3 printed a partial result and keeps its rows.
contract_child() {
	local dir=$1 n=$2 target=$3 pos=$4
	shift 4
	local out=$dir/out.$n err=$dir/errors.$n rc=0
	: >"$err"
	HOMELAB_CHILD=1 HOMELAB_ERRORS=$err TOOLFEEDBACK=0 "$SCRIPT_PATH" "$@" --raw </dev/null >"$out" || rc=$?
	if ((rc)) && [[ " ${C_VERDICTS:-} " == *" $rc "* ]]; then
		# A documented verdict: the result was read, and it is adverse.
		VERDICT=$rc
		rc=0
	fi
	if ((rc == 0 || rc == 3)); then
		if ! contract_rows "$out" "$pos" >"$dir/rows.$n" 2>/dev/null; then
			rm -f "$dir/rows.$n"
			HOMELAB_ERRORS=$err contract_error internal \
				"the backend answered something this tool cannot read as JSON"
			rc=1
		fi
	fi
	if ((rc)) && [[ ! -s $err ]]; then
		HOMELAB_ERRORS=$err contract_error internal "${PROGRAM:-homelab} $* failed (exit $rc)"
	fi
	if [[ -n $target ]]; then
		jq -c --arg target "$target" '.target //= $target' "$err" >>"$dir/errors"
	else
		cat "$err" >>"$dir/errors"
	fi
	((rc == 3)) && rc=0
	return "$rc"
}

# contract_rows <file> <operand>: a child's output as [{target, revision, data}].
contract_rows() {
	local file=$1 pos=$2
	case $C_SHAPE in
	items)
		jq -e -c --arg pos "$pos" "if type == \"array\" then [ .[] | {target: (try ($C_TARGET) catch null),
			revision: (try ($C_REVISION) catch null), data: .} ] else error(\"not a list\") end" "$file"
		;;
	item)
		jq -e -c --arg pos "$pos" "if type == \"object\" then [ {target: (try ($C_TARGET) catch null),
			revision: (try ($C_REVISION) catch null), data: .} ] else error(\"not an object\") end" "$file"
		;;
	data) jq -e -c '.' "$file" ;;
	lines) jq -R -s -c --arg log "$C_TARGET" '{log: $log, lines: (split("\n") | map(select(length > 0)))}' "$file" ;;
	esac
}
