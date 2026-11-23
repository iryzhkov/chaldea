"""Bounded timer summary: no module arguments, raw results or environment.

A failed task contributes one redacted, single-line detail built only from
allowlisted result fields (message, HTTP status/response and the last line of
standard error), so a feed entry says why a run failed without carrying output.
"""

import json
import os
import re
from pathlib import Path

from ansible.plugins.callback import CallbackBase

DETAIL_LIMIT = 300
INPUT_LIMIT = 65536
REDACTED = "<redacted>"
GENERIC_MESSAGES = {"", "non-zero return code", "MODULE FAILURE", "MODULE FAILURE\nSee stdout/stderr for the exact error",
                    "One or more items failed", "All items completed"}
SENSITIVE_NAME = r"[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passphrase|credential|api[_-]?key|access[_-]?key|private[_-]?key|auth|cookie|session|signature)[A-Za-z0-9_.-]*"
PATTERNS = (
    # URL user information and query strings can carry credentials.
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]+@"), r"\1" + REDACTED + "@"),
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://[^\s?#]*)\?[^\s#'\"<>]*"), r"\1?" + REDACTED),
    # Authorization schemes and private key blocks.
    (re.compile(r"(?i)\b(bearer|basic|token|digest)(\s+)[^\s,;'\"]+"), r"\1\2" + REDACTED),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", re.S),
     REDACTED),
    # name=value, name: value and "name": "value" where the name looks sensitive.
    (re.compile(r"(?i)(" + SENSITIVE_NAME + r")(['\"]?\s*[=:]\s*['\"]?)[^\s,;&'\"}]+"), r"\1\2" + REDACTED),
)
# Opaque credentials: long runs mixing letters and digits (also hashes), and
# base64 that may contain slashes. Ordinary paths and URLs split at / and . so
# only their long mixed segments are removed.
# The slash-aware pattern runs first so a base64 value is removed whole.
OPAQUE = (
    re.compile(r"(?<![A-Za-z0-9+/=_-])(?=[A-Za-z0-9+/=_-]*[0-9])(?=[A-Za-z0-9+/=_-]*[a-z])"
               r"(?=[A-Za-z0-9+/=_-]*[A-Z])[A-Za-z0-9+/=_-]{24,}"),
    re.compile(r"(?<![A-Za-z0-9+=_-])(?=[A-Za-z0-9+=_-]*[0-9])(?=[A-Za-z0-9+=_-]*[A-Za-z])[A-Za-z0-9+=_-]{20,}"),
)
# Environment values that are ordinary paths or identities stay readable.
BENIGN_ENVIRONMENT = {"HOME", "PATH", "PWD", "OLDPWD", "USER", "LOGNAME", "SHELL", "LANG", "TERM",
                      "TMPDIR", "HOSTNAME", "CHALDEA_RUN_STATE"}


def redact(text):
    """Return one bounded line with credentials and environment values removed."""
    text = str(text)[:INPUT_LIMIT]
    for name, value in os.environ.items():
        if (len(value) >= 8 and name not in BENIGN_ENVIRONMENT and not name.startswith(("ANSIBLE_", "LC_", "XDG_"))
                and value in text):
            text = text.replace(value, REDACTED)
    for pattern, replacement in PATTERNS:
        text = pattern.sub(replacement, text)
    for pattern in OPAQUE:
        text = pattern.sub(REDACTED, text)
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= DETAIL_LIMIT else text[:DETAIL_LIMIT - 3].rstrip() + "..."


def last_line(value):
    if not isinstance(value, str):
        return ""
    lines = [line.strip() for line in value[-INPUT_LIMIT:].splitlines() if line.strip()]
    return lines[-1] if lines else ""


def failure_detail(data, no_log=False):
    """Explain a failed result from allowlisted fields only."""
    if no_log or not isinstance(data, dict) or data.get("censored") or data.get("_ansible_no_log"):
        return "output hidden by no_log"
    if isinstance(data.get("results"), list):
        for item in data["results"]:
            if isinstance(item, dict) and (item.get("failed") or item.get("unreachable")):
                return failure_detail(item)
    parts = []
    message = data.get("msg")
    if isinstance(message, str) and message.strip() not in GENERIC_MESSAGES:
        parts.append(message)
    status = data.get("status_code", data.get("status"))
    if type(status) is int and status > 0:
        parts.append(f"HTTP status {status}")
    response = data.get("response")
    if isinstance(response, str) and response.strip() and response.strip() not in parts:
        parts.append(response)
    if not parts:
        stderr = last_line(data.get("stderr")) or last_line(data.get("module_stderr"))
        if stderr:
            parts.append(stderr)
    return redact("; ".join(parts)) if parts else ""


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "aggregate"
    CALLBACK_NAME = "chaldea_outcome"
    CALLBACK_NEEDS_ENABLED = True

    def save(self, **fields):
        location = os.environ.get("CHALDEA_RUN_STATE")
        if not location:
            return
        path = Path(location)
        try:
            data = json.loads(path.read_text())
            data.update(fields)
            temporary = path.with_suffix(".new")
            with open(temporary, "w", opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
                json.dump(data, stream)
            temporary.replace(path)
        except (OSError, ValueError):
            pass

    @staticmethod
    def task_name(task):
        # get_ds is the original YAML, before task-name templating. Strip
        # expressions rather than recording any expanded environment/values.
        name = str(task.get_ds().get("name", "unnamed Ansible task"))
        name = re.sub(r"{{.*?}}|{%.*?%}", "<redacted>", name, flags=re.S)
        return re.sub(r"[\x00-\x1f\x7f]", " ", name)[:160]

    def failure_in_block(self, block):
        candidate = getattr(self, "_failed_task", None)
        while candidate is not None and candidate._parent is not None:
            if candidate._parent._uuid == block._uuid:
                return any(item._uuid == candidate._uuid for item in block.block)
            candidate = candidate._parent
        return False

    def start_task(self, task):
        fields = {"task": self.task_name(task)}
        child, parent = task, task._parent
        while parent is not None:
            if (any(item._uuid == child._uuid for item in getattr(parent, "rescue", []))
                    and self.failure_in_block(parent)):
                # A rescued failure must not survive into a later failure that
                # ends the play before a runner result can replace it.
                fields.update(failed_task="", reason="", detail="")
                self._failed_task = None
                break
            child, parent = parent, getattr(parent, "_parent", None)
        self.save(**fields)

    def v2_playbook_on_task_start(self, task, is_conditional):
        self.start_task(task)

    def v2_playbook_on_handler_task_start(self, task):
        self.start_task(task)

    def v2_runner_on_failed(self, result, ignore_errors=False):
        if ignore_errors:
            return
        self._failed_task = result._task
        rc = result._result.get("rc")
        reason = f"module failed (status {rc})" if type(rc) is int else "Ansible task failed"
        self.save(failed_task=self.task_name(result._task), reason=reason,
                  detail=self.detail(result))

    def v2_runner_on_unreachable(self, result):
        self._failed_task = result._task
        self.save(failed_task=self.task_name(result._task), reason="Ansible host unreachable",
                  detail=self.detail(result))

    @staticmethod
    def detail(result):
        try:
            return failure_detail(result._result, getattr(result._task, "no_log", False) is True)
        except Exception:
            # Reporting must never change the play's own outcome.
            return ""

    def v2_playbook_on_stats(self, stats):
        location = os.environ.get("CHALDEA_RUN_STATE")
        if not location:
            return
        summaries = [stats.summarize(host) for host in stats.processed]
        failed = any(s.get("failures", 0) or s.get("unreachable", 0) for s in summaries)
        try:
            data = json.loads(Path(location).read_text())
        except (OSError, ValueError):
            data = {}
        self.save(changed=sum(s.get("changed", 0) for s in summaries), complete=True,
                  task=(data.get("failed_task") or data.get("task", "")) if failed else "",
                  reason=data.get("reason", "") if failed else "",
                  detail=data.get("detail", "") if failed else "")
