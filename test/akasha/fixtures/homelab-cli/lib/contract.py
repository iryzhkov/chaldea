#!/usr/bin/env python3
"""The read-only output and input contract every homelab tool shares.

One implementation, used two ways. The Python tools import it; the shell tools
run it as a small command (`python3 lib/contract.py envelope ...`), because a
homelab/v1 envelope, a structured error line and a strictly validated --input
are the same thing whichever tool produced them, and three copies of them would
drift apart.

Output: one JSON document on stdout, then a newline.

  {"schema": "homelab/v1", "tool", "command", "observed_at", "source": {backend,
   transport, endpoint}, "effect": "read", "complete", "items" | "data", "count",
   "limit", "truncated", "next_cursor", "errors"}

Each item is {"ref": {"target", "revision", "observed_at", "effect"}, "data"}
with the backend object unmodified in data, so a jq filter over .items keeps
the canonical target next to the data it selected.

Errors: every failure is an entry in the envelope's errors, and one line of
{"schema": "homelab/error/v1", tool, command, class, message, next_step} on
stderr, after the tool's own human message. A failure is never an empty
success: complete is false and the exit code is not zero.

Input: a homelab/v1 envelope, one item, or an array of items. It is a list of
targets and nothing else. Endpoints, URLs, data and anything else in it are
ignored, so a piped object is never a grant, and fields named like credentials
are refused so that a caller learns they are not honoured.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import typing
import urllib.parse

SCHEMA = "homelab/v1"
ERROR_SCHEMA = "homelab/error/v1"
ERROR_CLASSES = ("usage", "not_found", "denied", "unavailable", "timeout",
                 "requires_ssh", "partial", "internal")
MAX_LIMIT = 1000
DEFAULT_LIMIT = 100
MAX_INPUT_BYTES = 1024 * 1024
MAX_INPUT_TARGETS = 100
PARTIAL_EXIT = 3
CREDENTIAL_WORDS = ("token", "password", "secret", "authorization", "cookie", "grant")

# A target kind and the shape of the key that follows it. A key is what the
# tool resolves again with its own configuration; nothing else in an input is
# read. The patterns refuse "..", slashes and anything that could turn a key
# into a path or an option.
TARGET_KINDS = {
    "pve:guest": re.compile(r"^pve:guest/[a-z0-9][a-z0-9.-]{0,62}/(?P<key>[0-9]{1,9})$"),
    "ha:entity": re.compile(r"^ha:entity/(?P<key>[a-z0-9_]+\.[a-z0-9_]+)$"),
    "feed:entry": re.compile(r"^feed:entry/(?P<key>[0-9]{1,18})$"),
    "toolfeedback:cluster": re.compile(r"^toolfeedback:cluster/(?P<key>[0-9a-f]{6})$"),
}

# A key whose value is a credential wherever it appears in what a backend
# answered: Home Assistant's camera access_token, an API key, a password
# field. A string, list or object under such a key is replaced whole; numbers
# and booleans (token counts, has_password) are not credentials and are kept.
CREDENTIAL_KEY = re.compile(
    r"(?i)(token|password|passwd|passphrase|secret|authorization|cookie|api[_-]?key|auth[_-]?key"
    r"|private[_-]?key|pre[_-]?shared|psk|credential)")
REDACTED = "<redacted>"

class UsageError(ValueError):
    """An argument or input the contract refuses, before any backend call."""


class HumanParser(argparse.ArgumentParser):
    """argparse with control characters escaped in human refusal lines."""

    def error(self, message):
        super().error(human_line(message))


class ContractParser(HumanParser):
    """argparse, plus one homelab/error/v1 usage line when the command line
    asks for structured output, for every way argparse refuses (a missing
    argument, an unknown option, a bad --limit). The exit code stays 2.

    A tool subclasses it and sets contract_tool, and contract_flags to the
    options that ask for structured errors on that tool.
    """

    contract_tool = "homelab"
    contract_flags: tuple[str, ...] = ("--format",)

    def contract_command(self, argv: list[str]) -> str:
        words = iter(argv)
        for word in words:
            if word in ("--format", "--limit", "--input"):
                next(words, None)
            elif not word.startswith("-"):
                return word
        return ""

    def error(self, message):
        argv = sys.argv[1:]
        if any(word in self.contract_flags or word.startswith("--format=") for word in argv):
            command = self.contract_command(argv)
            write_error(self.contract_tool, command, "usage", message,
                        f"{self.contract_tool} {command} --help".replace("  ", " "))
        super().error(message)


def limit_type(value: str) -> int:
    """parse_limit for an argparse type=."""
    try:
        return parse_limit(value)
    except UsageError as error:
        raise argparse.ArgumentTypeError(str(error)) from None


CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")


def human_line(text: str) -> str:
    """A refusal for one line of human stderr: with control
    characters escaped, so a quoted argument cannot end the line and forge
    another (a homelab/error/v1 line, say)."""
    return CONTROL_CHARACTER.sub(lambda match: f"\\x{ord(match.group()):02x}", text)


def redact(value: typing.Any) -> typing.Any:
    """A copy of a value bound for output, with every credential removed.

    String leaves under credential-named keys are replaced, preserving shape.
    Numbers, booleans, null and unrelated strings retain their values.
    Raises RecursionError for a value nested too deep to walk.
    """
    def credential_value(inner):
        if isinstance(inner, str):
            return REDACTED
        if isinstance(inner, list):
            return [credential_value(child) for child in inner]
        if isinstance(inner, dict):
            return {key: credential_value(child) for key, child in inner.items()}
        return inner

    if isinstance(value, dict):
        return {key: (credential_value(inner) if isinstance(key, str)
                      and CREDENTIAL_KEY.search(key) else redact(inner))
                for key, inner in value.items()}
    if isinstance(value, list):
        return [redact(inner) for inner in value]
    return value


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def require_plain_url(name: str, value: str) -> str:
    """Refuse credential-bearing URL settings without quoting their value."""
    try:
        parts = urllib.parse.urlsplit(value)
        if parts.username is not None or parts.password is not None or "?" in value or "#" in value:
            raise ValueError
    except ValueError:
        raise UsageError(f"{name} must be a plain URL without user info, query or fragment") from None
    return value


def clean_endpoint(endpoint: str) -> str:
    """An endpoint without user info, query or fragment."""
    if "://" not in endpoint:
        return endpoint
    try:
        parts = urllib.parse.urlsplit(endpoint)
        host = parts.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        if parts.port:
            host = f"{host}:{parts.port}"
        return urllib.parse.urlunsplit((parts.scheme, host, parts.path, "", ""))
    except ValueError:
        # Not a URL urlsplit can read, such as a password holding a /: the
        # scheme and what follows the last @, without a query, and never a
        # traceback that quotes the pieces.
        scheme, _, rest = endpoint.partition("://")
        rest = rest.rpartition("@")[2].partition("?")[0].partition("#")[0]
        return f"{scheme}://{rest}"


def parse_limit(value: str) -> int:
    if not re.fullmatch(r"[1-9][0-9]{0,3}", value or "") or int(value) > MAX_LIMIT:
        raise UsageError(f"--limit must be a whole number from 1 to {MAX_LIMIT}, not '{value}'")
    return int(value)


def normal_error(entry: dict) -> dict:
    """One errors[] entry with a known class and credential keys redacted."""
    try:
        error = redact(entry)
    except RecursionError:
        error = {"class": entry.get("class"), "message": "an error too deep to print"}
    if error.get("class") not in ERROR_CLASSES:
        error["class"] = "internal"
    error.setdefault("target", None)
    error.setdefault("message", "")
    return error


def write_error(tool: str, command: str, cls: str, message: str, next_step: str | None = None,
                stream=None) -> None:
    stream = stream or sys.stderr
    line = {"schema": ERROR_SCHEMA, "tool": tool, "command": command,
            "class": cls if cls in ERROR_CLASSES else "internal",
            "message": message, "next_step": next_step}
    stream.write(json.dumps(line) + "\n")
    stream.flush()


def make_item(target: str, data, revision=None, observed_at: str | None = None) -> dict:
    return {"ref": {"target": target, "revision": revision,
                    "observed_at": observed_at or now(), "effect": "read"},
            "data": data}


def envelope(tool: str, command: str, backend: str, transport: str, endpoint: str, *,
             items: list | None = None, data=None, errors: list | None = None,
             limit: int | None = None, failed: bool = False, observed_at: str | None = None,
             extra: dict | None = None) -> dict:
    """The homelab/v1 document. items is a list of make_item() results.

    Every document a tool prints is built here, so the two output invariants
    hold for all of them: no credential (redact) and never more than
    MAX_LIMIT items, whatever limit the caller passed. Data with a list of
    "lines" (a log tail) keeps its last limit lines.
    """
    observed_at = observed_at or now()
    errors = [normal_error(error) for error in (errors or [])]
    # Cut to the limit first, so only what is printed is walked.
    truncated = False
    if items is not None:
        limit = MAX_LIMIT if limit is None else min(limit, MAX_LIMIT)
        if len(items) > limit:
            items = items[:limit]
            truncated = True
    else:
        lines = data.get("lines") if isinstance(data, dict) else None
        if isinstance(lines, list) and limit is not None:
            limit = min(limit, MAX_LIMIT)
            if len(lines) > limit:
                data = {**data, "lines": lines[len(lines) - limit:]}
                truncated = True
        elif not isinstance(lines, list):
            limit = None
    try:
        if items is not None:
            items = [{**item, "data": redact(item.get("data"))} for item in items]
        data = redact(data)
        extra = redact(extra) if extra else extra
    except RecursionError:
        items = [] if items is not None else None
        data = None
        failed = True
        errors.append(normal_error({"class": "internal",
                                    "message": "the backend answer is nested too deep to print"}))
    doc = {"schema": SCHEMA, "tool": tool, "command": command, "observed_at": observed_at,
           "source": {"backend": backend, "transport": transport,
                      "endpoint": clean_endpoint(endpoint)},
           "effect": "read", "complete": not errors and not failed}
    if items is not None:
        for item in items:
            item["ref"]["observed_at"] = observed_at
        doc["items"] = items
        doc["count"] = len(items)
    else:
        doc["data"] = data
        doc["count"] = 0 if data is None else 1
    doc.update({"limit": limit, "truncated": truncated, "next_cursor": None, "errors": errors})
    if extra:
        doc.update(extra)
    return doc


def exit_code(status: int, doc: dict, verdict: int = 0) -> int:
    """The code a command leaves with.

    Its own failure first; then a verdict code the command documents for a
    result it did read (homelab-health's 1 for a warning, 2 for a failure);
    then 1 when nothing was printed because of an internal failure; then 3
    for a partial result.
    """
    if status:
        return status
    if verdict:
        return verdict
    if doc["complete"]:
        return 0
    printed = bool(doc.get("items")) or doc.get("data") is not None
    if not printed and any(error.get("class") == "internal" for error in doc["errors"]):
        return 1
    return PARTIAL_EXIT


def quiet_broken_pipe() -> None:
    """Point stdout at /dev/null so a closed pipe does not print at exit."""
    try:
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, sys.stdout.fileno())
    except OSError:
        pass


def emit(doc: dict, stream=None) -> bool:
    """Write one document and a newline. False when the reader went away."""
    stream = stream or sys.stdout
    try:
        text = json.dumps(doc, separators=(",", ":"))
    except (ValueError, RecursionError):
        # A backend object too deep or too odd to print: say so, never half of it.
        doc = {**doc, "complete": False, "count": 0, "truncated": False,
               "errors": doc["errors"] + [{"target": None, "class": "internal",
                                           "message": "the backend answer could not be encoded"}]}
        doc.pop("items", None)
        doc.pop("data", None)
        doc["items"] = []
        text = json.dumps(doc, separators=(",", ":"))
    try:
        stream.write(text + "\n")
        stream.flush()
    except BrokenPipeError:
        quiet_broken_pipe()
        return False
    return True


def report(doc: dict, status: int = 0, stream=None, err_stream=None, verdict: int = 0) -> int:
    """Emit a document and its error lines; return the exit code."""
    emit(doc, stream)
    for error in doc["errors"]:
        write_error(doc["tool"], doc["command"], error["class"], error.get("message", ""),
                    error.get("next_step"), stream=err_stream)
    return exit_code(status, doc, verdict)


# --------------------------------------------------------------------------
# Input
# --------------------------------------------------------------------------

def _refuse_duplicates(pairs):
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise UsageError(f"input has a duplicate key '{key}'")
        seen[key] = value
    return seen


def _credential_field(value, path=""):
    """The path of the first credential-named key, walked without recursion."""
    stack = [(value, path)]
    while stack:
        current, where = stack.pop()
        if isinstance(current, dict):
            for key, inner in current.items():
                named = f"{where}.{key}" if where else key
                if any(word in key.lower() for word in CREDENTIAL_WORDS):
                    return named
                stack.append((inner, named))
        elif isinstance(current, list):
            for index, inner in enumerate(current):
                stack.append((inner, f"{where}[{index}]"))
    return None


def _refuse_constant(name):
    raise ValueError(f"{name} is not a JSON number")


def parse_input(raw: bytes, kind: str, max_targets: int = MAX_INPUT_TARGETS) -> list[str]:
    """The canonical targets in an input, after every check, or UsageError."""
    if kind not in TARGET_KINDS:
        raise UsageError(f"no input kind {kind}")
    if len(raw) > MAX_INPUT_BYTES:
        raise UsageError("input is larger than 1 MiB")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise UsageError("input is not UTF-8") from None
    if not text.strip():
        raise UsageError("input is empty")
    try:
        value = json.loads(text, object_pairs_hook=_refuse_duplicates,
                           parse_constant=_refuse_constant)
    except UsageError:
        raise
    except (ValueError, RecursionError) as error:
        raise UsageError(f"input is not valid JSON: {str(error)[:200]}") from None
    field = _credential_field(value)
    if field:
        raise UsageError(f"input carries a credential-named field '{field}'; "
                         "credentials in an input are never honoured")
    if isinstance(value, dict) and "schema" in value:
        if value["schema"] != SCHEMA:
            raise UsageError(f"input schema '{value['schema']}' is not {SCHEMA}")
        if value.get("effect", "read") != "read":
            raise UsageError(f"input effect '{value.get('effect')}' is not read")
        items = value.get("items")
        if not isinstance(items, list):
            raise UsageError("input envelope has no items list")
    elif isinstance(value, dict):
        items = [value]
    elif isinstance(value, list):
        items = value
    else:
        raise UsageError("input must be a homelab/v1 envelope, one item or an array of items")
    if not items:
        raise UsageError("input names no target")
    if len(items) > max_targets:
        raise UsageError(f"input names {len(items)} targets; at most {max_targets} are accepted")
    pattern = TARGET_KINDS[kind]
    targets: list[str] = []
    for index, item in enumerate(items):
        ref = item.get("ref") if isinstance(item, dict) else None
        if not isinstance(ref, dict) or not isinstance(ref.get("target"), str):
            raise UsageError(f"input item {index} has no ref.target")
        if ref.get("effect", "read") != "read":
            raise UsageError(f"input item {index} has effect '{ref.get('effect')}', not read")
        target = ref["target"]
        if not pattern.fullmatch(target):
            raise UsageError(f"input target '{target[:120]}' is not a {kind} target")
        if target in targets:
            raise UsageError(f"input names the duplicate target '{target}'")
        targets.append(target)
    return targets


def target_key(target: str, kind: str) -> str:
    match = TARGET_KINDS[kind].fullmatch(target)
    if not match:
        raise UsageError(f"'{target}' is not a {kind} target")
    return match.group("key")


def read_source(source: str) -> bytes:
    """An --input operand: a file, or stdin when it is '-'. Reads at most 1 MiB + 1."""
    if source == "-":
        return sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    try:
        with open(source, "rb") as handle:
            return handle.read(MAX_INPUT_BYTES + 1)
    except OSError as error:
        raise UsageError(f"cannot read --input {source}: {error.strerror}") from None


# --------------------------------------------------------------------------
# Command line, for the shell tools
# --------------------------------------------------------------------------

def _load_errors(path: str | None) -> list[dict]:
    errors: list[dict] = []
    if not path:
        return errors
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(entry, dict) and entry not in errors:
                    errors.append(entry)
    except OSError:
        pass
    return errors


def _cmd_envelope(args) -> int:
    status = int(args.status) if args.status.isdigit() else 1
    errors = _load_errors(args.errors)
    raw = sys.stdin.buffer.read()
    observed = now()
    items = None
    data = None
    failed = bool(status)
    if status and not errors:
        errors.append({"target": None, "class": "internal",
                       "message": f"{args.tool} {args.command} failed (exit {status})"})
    try:
        # NaN and Infinity are not JSON; they become null rather than reach stdout.
        payload = (json.loads(raw.decode("utf-8"), parse_constant=lambda _: None)
                   if raw.strip() else None)
    except (ValueError, RecursionError):
        payload = None
        if not status:
            status = 1
            failed = True
            errors.append({"target": None, "class": "internal",
                           "message": "the backend answered something that is not JSON"})
    limit = args.limit if args.limit is not None else args.limit_default
    if args.shape == "items":
        items = []
        if isinstance(payload, list):
            untargeted = 0
            for row in payload:
                target = row.get("target") if isinstance(row, dict) else None
                # A target built from a missing field reads "...null" or is null.
                if isinstance(target, str) and not target.endswith(("/null", "/")):
                    items.append(make_item(target, row.get("data"), row.get("revision"),
                                           observed))
                else:
                    untargeted += 1
            if untargeted:
                errors.append({"target": None, "class": "partial",
                               "message": f"{untargeted} backend rows had no canonical target "
                                          "and are left out"})
        elif payload is not None and not status:
            status = 1
            failed = True
            errors.append({"target": None, "class": "internal",
                           "message": "the backend answered something that is not a list"})
    else:
        # A data document has no limit, except a log tail's lines (envelope).
        data = payload if not status else None
    doc = envelope(args.tool, args.command, args.backend, args.transport, args.endpoint,
                   items=items, data=data, errors=errors, limit=limit,
                   failed=failed, observed_at=observed)
    return report(doc, status, verdict=args.verdict)


def _cmd_input(args) -> int:
    try:
        targets = parse_input(read_source(args.source), args.kind)
    except UsageError as error:
        message = str(error)
        print(f"{args.tool}: {human_line(message)}", file=sys.stderr)
        if args.structured:
            write_error(args.tool, args.command, "usage", message,
                        f"give --input a {SCHEMA} envelope, one item or an array of "
                        f"{args.kind} items")
        return 1
    for target in targets:
        print(target_key(target, args.kind) if not args.full else target)
    return 0


def _cmd_check_limit(args) -> int:
    try:
        parse_limit(args.value)
    except UsageError as error:
        print(f"{args.tool}: {human_line(str(error))}", file=sys.stderr)
        return 1
    return 0


def _cmd_error(args) -> int:
    write_error(args.tool, args.command, args.cls, args.message, args.next_step)
    return 0


def main(argv=None) -> int:
    parser = HumanParser(prog="contract.py", description=(__doc__ or "").split("\n\n")[0])
    sub = parser.add_subparsers(dest="helper", required=True)

    env = sub.add_parser("envelope", help="wrap prepared rows read on stdin")
    env.add_argument("--tool", required=True)
    env.add_argument("--command", required=True)
    env.add_argument("--backend", required=True)
    env.add_argument("--transport", required=True)
    env.add_argument("--endpoint", default="")
    env.add_argument("--shape", choices=("items", "data"), required=True)
    env.add_argument("--status", default="0")
    env.add_argument("--verdict", type=int, default=0,
                     help="exit code of a result that was read but is adverse")
    env.add_argument("--errors")
    env.add_argument("--limit", type=int)
    env.add_argument("--limit-default", type=int, default=DEFAULT_LIMIT, dest="limit_default")
    env.set_defaults(func=_cmd_envelope)

    inp = sub.add_parser("input", help="validate an --input operand and print its target keys")
    inp.add_argument("--kind", required=True, choices=sorted(TARGET_KINDS))
    inp.add_argument("--tool", required=True)
    inp.add_argument("--command", required=True)
    inp.add_argument("--structured", action="store_true")
    inp.add_argument("--full", action="store_true", help="print whole targets, not keys")
    inp.add_argument("source")
    inp.set_defaults(func=_cmd_input)

    lim = sub.add_parser("check-limit", help="refuse a --limit value outside 1..1000")
    lim.add_argument("--tool", default="homelab")
    lim.add_argument("value")
    lim.set_defaults(func=_cmd_check_limit)

    err = sub.add_parser("error", help="write one homelab/error/v1 line to stderr")
    err.add_argument("--tool", required=True)
    err.add_argument("--command", required=True)
    err.add_argument("--class", dest="cls", required=True)
    err.add_argument("--next-step", dest="next_step")
    err.add_argument("message")
    err.set_defaults(func=_cmd_error)

    # argparse on Python 3.11 drops a value that is exactly "--" from
    # --option=--, leaving an empty list, and a refused command word can be
    # "--" (t3-job --json -- run). Such a value is carried past argparse.
    argv = list(sys.argv[1:] if argv is None else argv)
    end = argv.index("--") if "--" in argv else len(argv)
    argv[:end] = [word[:-2] + DASHES if re.fullmatch(r"--[\w-]+=--", word) else word
                  for word in argv[:end]]
    args = parser.parse_args(argv)
    for name, value in vars(args).items():
        if value == DASHES:
            setattr(args, name, "--")
    return args.func(args)


DASHES = "\0--"


if __name__ == "__main__":
    try:
        try:
            sys.exit(main())
        finally:
            # argparse exits via SystemExit; flush here so closed readers
            # still reach the BrokenPipeError handler before interpreter exit.
            sys.stdout.flush()
    except BrokenPipeError:
        quiet_broken_pipe()
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
