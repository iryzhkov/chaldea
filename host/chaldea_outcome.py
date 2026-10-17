"""Bounded timer summary: no module messages, arguments, results or environment."""

import json
import os
import re
from pathlib import Path

from ansible.plugins.callback import CallbackBase


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
                fields.update(failed_task="", reason="")
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
        self.save(failed_task=self.task_name(result._task), reason=reason)

    def v2_runner_on_unreachable(self, result):
        self._failed_task = result._task
        self.save(failed_task=self.task_name(result._task), reason="Ansible host unreachable")

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
                  reason=data.get("reason", "") if failed else "")
