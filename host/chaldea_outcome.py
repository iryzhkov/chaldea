"""Bounded timer summary: no module messages, arguments, results or environment.

A failed task contributes one short detail that fails closed: it is assembled
only from fixed phrases for causes recognised in the result's message, HTTP
response and standard error, standard HTTP reason phrases and errno names, the
validated module name and an integer exit status. No byte of result text is
copied, so a credential templated into a message from any variable cannot be
published; an unrecognised message is reported as withheld.
"""

import errno
import http
import json
import os
import re
from pathlib import Path

from ansible.plugins.callback import CallbackBase

INPUT_LIMIT = 65536
# Literal alternations only, so matching stays linear in the bounded input.
CAUSES = (
    (re.compile(r"timed out|timeout", re.I), "timed out"),
    (re.compile(r"connection refused", re.I), "connection refused"),
    (re.compile(r"connection reset|connection aborted|remote end closed connection", re.I), "connection reset"),
    (re.compile(r"name or service not known|temporary failure in name resolution|nodename nor servname"
                r"|could not resolve host|getaddrinfo failed|no address associated with hostname", re.I),
     "DNS resolution failed"),
    (re.compile(r"no route to host|network is unreachable", re.I), "network unreachable"),
    (re.compile(r"certificate verify failed|certificate_verify_failed", re.I), "TLS certificate verification failed"),
    (re.compile(r"ssl: |sslerror|tlsv1 alert|wrong version number", re.I), "TLS error"),
    (re.compile(r"incomplete read", re.I), "incomplete download"),
    (re.compile(r"checksum mismatch|checksums? (?:do(?:es)? not|did not) match|sha256 mismatch", re.I),
     "checksum mismatch"),
    (re.compile(r"no space left on device", re.I), "no space left on device"),
    (re.compile(r"read-only file system", re.I), "read-only file system"),
    (re.compile(r"permission denied", re.I), "permission denied"),
    (re.compile(r"no such file or directory|could not find or access|does not exist", re.I), "path not found"),
    (re.compile(r"could not get lock|lock-frontend|unable to acquire the dpkg", re.I), "package manager lock held"),
    (re.compile(r"no package matching|unable to locate package|no match for argument", re.I), "package not found"),
    (re.compile(r"could not read from remote repository|repository not found|authentication failed", re.I),
     "remote access refused"),
    (re.compile(r"missing sudo password|a password is required|incorrect sudo password", re.I),
     "privilege escalation needs a password"),
    (re.compile(r"unit [^ ]{1,200} not found|could not find the requested service", re.I), "systemd unit not found"),
    (re.compile(r"assertion failed", re.I), "assertion failed"),
    (re.compile(r"module failure|traceback \(most recent call last\)", re.I), "module crashed"),
)
HTTP_STATUS = re.compile(r"\bHTTP Error (\d{3})\b|\bstatus code was (\d{3})\b|\bHTTP/\d(?:\.\d)? (\d{3})\b", re.I)
ERRNO = re.compile(r"\[Errno (\d{1,4})\]")


def http_phrase(code):
    try:
        return f"HTTP {code} {http.HTTPStatus(code).phrase}"
    except ValueError:
        return f"HTTP {code}" if 100 <= code <= 599 else ""


def module_name(task):
    action = str(getattr(task, "action", "") or "").rsplit(".", 1)[-1]
    return action if re.fullmatch(r"[A-Za-z0-9_]{1,64}", action) else "task"


def classify(data):
    """Fixed phrases for recognised causes in allowlisted fields; never their text."""
    texts = [data.get(key) for key in ("msg", "response", "stderr", "module_stderr")]
    text = "\n".join(t[-INPUT_LIMIT:] for t in texts if isinstance(t, str))
    causes = []
    status = data.get("status_code", data.get("status"))
    codes = [status] if type(status) is int and status >= 100 else []
    codes += [int(next(g for g in m.groups() if g)) for m in HTTP_STATUS.finditer(text)]
    for code in codes:
        phrase = http_phrase(code)
        if phrase and phrase not in causes:
            causes.append(phrase)
    for match in ERRNO.finditer(text):
        name = errno.errorcode.get(int(match.group(1)))
        if name and name not in causes:
            causes.append(name)
    for pattern, phrase in CAUSES:
        if phrase not in causes and pattern.search(text):
            causes.append(phrase)
    rc = data.get("rc")
    if type(rc) is int and rc != 0:
        causes.append(f"exit status {max(-1000, min(rc, 1000))}")
    return causes[:6]


def failure_detail(data, task=None, no_log=False):
    """One short line for a failed result, built only from fixed text."""
    if no_log or not isinstance(data, dict) or data.get("censored") or data.get("_ansible_no_log"):
        return "output hidden by no_log"
    if isinstance(data.get("results"), list):
        for item in data["results"]:
            if isinstance(item, dict) and (item.get("failed") or item.get("unreachable")):
                return failure_detail(item, task)
    causes = classify(data)
    return module_name(task) + ": " + ("; ".join(causes) if causes else "unrecognised error, message withheld")


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
            return failure_detail(result._result, result._task, getattr(result._task, "no_log", False) is True)
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
