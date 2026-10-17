# Per-invocation instrumentation spool for the shell tools in this repository.
# Sourced after common.sh, never executed.
#
# One JSON line per run of a tool, appended to the same tool-feedback spool the
# fleet's MCP servers write and that bin/toolfeedback reads. Until now every
# claim about how these wrappers behave for an agent rested on a scheduled
# probe; this records what actually happened, one line per call, on every host
# and from every harness.
#
# Three properties decide whether the spool is worth shipping, and each one is
# enforced here rather than left to the caller.
#
# It carries no argument values. The record holds the verb, the option names
# and an outcome class, and nothing else that came from the command line. A
# value can be an entry title, a search text, a link or a token, and these
# records are shipped to another host, so the safe set is the set of names: the
# verb is recorded only when it is in the tool's SPOOL_VERBS, an option only
# when it is in its SPOOL_FLAGS, and everything else is dropped or recorded as
# "?". No message text reaches the record at all; a refusal is recorded as the
# class its refusal site declared.
#
# It never changes what the caller sees. Every failure in here - no directory,
# a full disk, a read-only home, no mktemp, a record file somebody else owns -
# is dropped in silence, and the exit trap exits with the status the tool had
# already decided. Losing an event is better than turning a working command
# into a failing one, and a warning on standard error would corrupt the output
# of every command an agent parses. Silence is a defect nearly everywhere else
# in these tools; here it is the contract, which is why every write below is
# wrapped in a group that already has standard error redirected. Bash applies
# redirections left to right, so "printf ... >>file 2>/dev/null" still reports
# a failing ">>" on the caller's own standard error: the redirection that would
# have silenced it is not in effect yet when the append is attempted.
#
# Its cost is bounded. One append of a short line built with printf, no jq, no
# fsync, no network and no retry. It is not free of subprocesses: mktemp, two
# date calls, hostname and one command substitution per derived field add a few
# milliseconds to a run. When the spool is off, spool_begin installs no trap
# and the tool does no extra work at all.

# shellcheck shell=bash

# The five outcome classes an agent actually experiences.
#
# These tools have no exit-code namespace to map from. A refusal through die()
# is exit 1; a refusal raised inside a command substitution kills only that
# subshell, so the status that finally emerges belongs to whichever program ran
# last under "set -o pipefail" - "feed recent" with no token exits 5, which is
# jq's status for input it could not parse, not a number feed chose. In the
# other direction a command can fail and still exit 0, because the service
# answers some failures with a 200 response and an "error" member.
#
# So the class never comes from the exit code. Every place the tool gives up
# names the class in the same breath as the message, spool_refuse and
# spool_class record it, and spool_finish reads what was recorded whatever the
# status turns out to be. A failure that names no class is recorded as "error",
# which is the honest name for "this tool gave up and never said what kind of
# giving up it was".
spool_outcome() {
	case $1 in
	'') printf 'ok' ;;
	usage | unknown-command | unknown-option | missing-argument | no-credential)
		printf 'usage'
		;;
	refused | unreadable | conflict | not-found) printf 'state' ;;
	unreachable | timeout) printf 'transport' ;;
	*) printf 'internal' ;;
	esac
}

# spool_enabled reports whether invocations are recorded. Off unless somebody
# asked for it, in the same way and by the same switches as the MCP producers
# that share this spool: create the file "enabled" in the spool directory, or
# set TOOLFEEDBACK=1. TOOLFEEDBACK=0 turns it off again.
spool_enabled() {
	case ${TOOLFEEDBACK:-} in
	1) return 0 ;;
	0) return 1 ;;
	esac
	local dir
	dir=$(spool_dir) || return 1
	[[ -n $dir && -e $dir/enabled ]]
}

# spool_dir is where the spool files live, one directory per tool and one file
# per host per day. The precedence is the one bin/toolfeedback and the other
# producers use, so that pointing TOOLFEEDBACK_DIR at a scratch directory moves
# the whole spool at once - which is how the tests keep out of the operator's
# real one.
spool_dir() {
	if [[ -n ${TOOLFEEDBACK_DIR:-} ]]; then
		printf '%s' "$TOOLFEEDBACK_DIR"
	elif [[ -n ${XDG_DATA_HOME:-} ]]; then
		printf '%s/toolfeedback' "$XDG_DATA_HOME"
	else
		printf '%s/.local/share/toolfeedback' "$HOME"
	fi
}

# spool_ident keeps a value that came from the environment to the characters an
# identifier is made of, so that a spool line stays one line and stays valid
# JSON whatever an environment held, and bounds its length.
spool_ident() {
	local value=${1//[^A-Za-z0-9._-]/}
	printf '%s' "${value:0:128}"
}

# spool_session is the agent session this invocation belongs to, as the harness
# exported it. It is what lets a report line a refusal up with what the agent
# did next. A harness that exports none leaves the field empty rather than
# costing the record.
spool_session() {
	local name
	for name in TOOLFEEDBACK_SESSION CLAUDE_CODE_SESSION_ID CODEX_SESSION_ID OPENCODE_SESSION_ID; do
		if [[ -n ${!name:-} ]]; then
			spool_ident "${!name}"
			return 0
		fi
	done
}

# spool_client is the harness that ran this command. The reason each tool
# writes its own record rather than having one derived from Claude Code's
# transcripts is that a call made from Codex or OpenCode leaves no transcript
# to derive it from, and those are exactly the harnesses that read the most
# stale documentation, so a transcript-derived report would under-count them.
spool_client() {
	if [[ -n ${TOOLFEEDBACK_CLIENT:-} ]]; then
		spool_ident "$TOOLFEEDBACK_CLIENT"
	elif [[ -n ${CLAUDECODE:-} || -n ${CLAUDE_CODE_ENTRYPOINT:-} ]]; then
		printf 'claude-code'
	elif [[ -n ${CODEX_HOME:-} || -n ${CODEX_SANDBOX:-} ]]; then
		printf 'codex'
	elif [[ -n ${OPENCODE:-} || -n ${OPENCODE_BIN_PATH:-} ]]; then
		printf 'opencode'
	fi
}

# spool_verb is the verb this invocation ran, recorded only when the tool
# publishes it in SPOOL_VERBS. That is what keeps operands and mistyped values
# out: "feed show 41ab" records the verb and never the entry id, and a word
# that names no command records as the bare tool name, which is a signal rather
# than a loss.
spool_verb() {
	local word=${1:-} known
	[[ -n $word ]] || return 0
	for known in ${SPOOL_VERBS:-}; do
		if [[ $word == "$known" ]]; then
			printf ' %s' "$word"
			return 0
		fi
	done
}

# spool_keys is the ordered set of option names the command line carried, with
# every value removed, as a JSON array.
#
# An option is recorded only when the tool publishes it in SPOOL_FLAGS, and
# otherwise as "?". Shape is not enough: "--sk-live-0xDEADBEEF" is shaped
# exactly like an option, and a caller that mistypes a value into option
# position would otherwise put it in a record that is shipped. An option the
# tool does not have is still worth counting, so the fact is recorded and the
# word is not.
spool_keys() {
	local word name known key
	local seen=' '
	local out=''
	for word in "$@"; do
		# A bare "--" hands the rest to whatever the caller is quoting.
		[[ $word == '--' ]] && break
		[[ $word == -?* ]] || continue
		name=${word#-}
		name=${name#-}
		name=${name%%=*}
		key='?'
		for known in ${SPOOL_FLAGS:-}; do
			[[ $name == "$known" ]] && key=$name && break
		done
		[[ $seen == *" $key "* ]] && continue
		seen+="$key "
		[[ -n $out ]] && out+=','
		out+="\"$key\""
	done
	printf '%s' "$out"
}

# spool_refuse names the class of the refusal about to happen and then refuses.
# It is written at every place a tool gives up, so that the record says which
# kind of giving up it was without anything reading the message.
#
# The class is written to a file rather than to a variable because a tool
# refuses from inside command substitutions - "$(request GET ...)" is a
# subshell - and a variable set there would be gone by the time the exit trap
# in the parent reads it.
spool_refuse() {
	local class=$1
	shift
	spool_class "$class"
	die "$@"
}

# spool_class names the class of a failure without refusing. It is for the
# failures this tool does not exit non-zero for: the feed service answers a
# missing entry with a 200 response carrying an "error" member, so "feed show
# <unknown id>" exits 0, and classifying from the exit code would record a
# failure as a success. A failure-cluster table that is confidently wrong is
# worse than no table, so the refusal site says what happened and the exit code
# is left exactly as the caller would have seen it anyway.
spool_class() {
	[[ -n ${SPOOL_CLASS_FILE:-} ]] || return 0
	# The group is what silences a failing redirection; see the file comment.
	{ printf '%s' "$1" >"$SPOOL_CLASS_FILE"; } 2>/dev/null || true
	return 0
}

# spool_begin arms the spool for one invocation: the tool's name in the spool,
# then the whole command line. When the spool is off it installs no trap and
# returns, so a tool that nobody is measuring does no extra work.
spool_begin() {
	SPOOL_TOOL=$1
	shift
	SPOOL_ARGV=("$@")
	SPOOL_CLASS_FILE=
	# Microseconds since the epoch, with the locale's decimal point removed.
	# An older bash without EPOCHREALTIME reports 0 milliseconds rather than
	# refusing to record the call.
	SPOOL_STARTED=${EPOCHREALTIME:-}
	SPOOL_STARTED=${SPOOL_STARTED//[^0-9]/}
	spool_enabled || return 0
	SPOOL_CLASS_FILE=$(mktemp "${TMPDIR:-/tmp}/spool-class.XXXXXX" 2>/dev/null) || SPOOL_CLASS_FILE=
	trap spool_finish EXIT
}

# spool_finish is the exit trap. It reads the status the tool is leaving with,
# writes one record, and leaves with that same status.
spool_finish() {
	local code=$?
	trap - EXIT
	# The class is read whatever the status is, not only when it is non-zero.
	# A refusal site that named a class is the better evidence of the two: it
	# ran, and the status may belong to a program further down a pipeline or to
	# a command that gave up and exited 0 anyway.
	local class=
	if [[ -n ${SPOOL_CLASS_FILE:-} && -s ${SPOOL_CLASS_FILE:-} ]]; then
		class=$(<"$SPOOL_CLASS_FILE")
	elif ((code != 0)); then
		class=error
	fi
	[[ -n ${SPOOL_CLASS_FILE:-} ]] && rm -f "$SPOOL_CLASS_FILE" 2>/dev/null
	spool_write "$code" "$class"
	exit "$code"
}

# spool_write appends one record. Every failure is dropped in silence; see the
# file comment for why that is the correct behaviour here and nowhere else in
# these tools.
spool_write() {
	local code=$1 class=$2
	local dir host now elapsed=0 outcome ok line
	dir=$(spool_dir) || return 0
	[[ -n $dir ]] || return 0

	host=$(spool_ident "$(hostname -s 2>/dev/null || printf 'unknown')")
	[[ -n $host ]] || host=unknown

	if [[ -n ${SPOOL_STARTED:-} && -n ${EPOCHREALTIME:-} ]]; then
		now=${EPOCHREALTIME//[^0-9]/}
		elapsed=$(((now - SPOOL_STARTED) / 1000))
		((elapsed < 0)) && elapsed=0
	fi

	outcome=$(spool_outcome "$class")
	ok=false
	[[ $outcome == ok ]] && ok=true

	# One directory per tool, because a host name contains hyphens and so does
	# a tool name: with both in one file name there is no way to tell where the
	# first ends and the second begins.
	mkdir -p "$dir/$SPOOL_TOOL" 2>/dev/null || return 0
	chmod 700 "$dir/$SPOOL_TOOL" 2>/dev/null || true

	# Every value below is either a number, a word from a closed vocabulary, or
	# an identifier spool_ident has already reduced to [A-Za-z0-9._-], so none
	# of them can carry a quote, a backslash or a newline into the line.
	line=$(printf '{"ts":"%s","host":"%s","session":"%s","proc":"%s","client":"%s","seq":1,"tool":"%s%s","args":[%s],"outcome":"%s","ok":%s,"err":"%s","exit":%d,"ms":%d}' \
		"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
		"$host" \
		"$(spool_session)" \
		"$(printf '%012x' "$$")" \
		"$(spool_client)" \
		"$SPOOL_TOOL" "$(spool_verb "${SPOOL_ARGV[0]:-}")" \
		"$(spool_keys "${SPOOL_ARGV[@]:-}")" \
		"$outcome" "$ok" "$class" "$code" "$elapsed")

	# One append of a short line, so that several processes spooling at once
	# interleave whole lines rather than fragments. The group is what silences
	# a failing redirection - a record file that exists and cannot be written,
	# a full filesystem - rather than putting a line on the caller's standard
	# error on every call; see the file comment.
	{ printf '%s\n' "$line" \
		>>"$dir/$SPOOL_TOOL/$host-$(date -u +%Y-%m-%d).jsonl"; } 2>/dev/null || true
	return 0
}
