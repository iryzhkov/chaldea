"""Outcome behavior against fake jobs/feed and real Ansible on throwaway homes."""

import importlib.machinery
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "chaldea-timer-report"
CALLBACK = ROOT / "chaldea_outcome.py"


def load_reporter():
    loader = importlib.machinery.SourceFileLoader("timer_report", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    for name in ("FEED_TOKEN", "FEED_KEY_FILE", "XDG_CONFIG_HOME", "FEED_CONFIG", "CHALDEA_RUN_STATE"):
        monkeypatch.delenv(name, raising=False)
    config = tmp_path / ".config/chaldea"
    config.mkdir(parents=True)
    (config / "timer-reporting.json").write_text('{"delivery":"queue"}')
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    monkeypatch.setenv("INVOCATION_ID", "a" * 32)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    feed = bin_dir / "feed"
    feed.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/feed-calls\"\nexit \"${FAKE_FEED_STATUS:-0}\"\n")
    feed.chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir) + os.pathsep + os.environ["PATH"])
    return tmp_path


def records(home):
    return json.loads((home / ".local/state/chaldea/fleet-status.json").read_text())


def run_job(home, status=0, changed=0):
    child = (
        "import json,os,pathlib,sys;"
        "p=pathlib.Path(os.environ['CHALDEA_RUN_STATE']);d=json.loads(p.read_text());"
        f"d.update(changed={changed},complete=True,task='safe task',reason='');"
        "p.write_text(json.dumps(d));print('SECRET_ENV_VALUE');"
        f"sys.exit({status})"
    )
    return subprocess.run([sys.executable, str(SCRIPT), "run", "--job", "chaldea-retention",
                           "--", sys.executable, "-c", child], capture_output=True, text=True)


@pytest.mark.parametrize("changed,status", [(0, 0), (3, 0), (0, 2)])
def test_each_queued_run_has_one_safe_record_and_never_calls_feed(home, changed, status):
    result = run_job(home, status, changed)
    assert result.returncode == status
    data = records(home)
    assert len(data) == 1 and data[0]["changed"] == changed
    assert "SECRET_ENV_VALUE" not in result.stdout + result.stderr + json.dumps(data)
    assert data[0]["delivery"] == ("quiet" if status == 0 and changed == 0 else "queued")
    assert not (home / "feed-calls").exists()
    assert (home / ".local/state/chaldea/fleet-status.json").stat().st_mode & 0o777 == 0o600


def test_changed_timer_queues_locally_even_with_a_shared_key_present(home, monkeypatch):
    monkeypatch.setenv("FEED_TOKEN", "test-only")
    result = run_job(home, changed=2)
    assert result.returncode == 0
    assert not (home / "feed-calls").exists()
    assert records(home)[0]["delivery"] == "queued"
    queued = list((home / ".local/state/chaldea/timer-spool").glob("*.jsonl"))
    assert len(queued) == 1
    value = json.loads(queued[0].read_text())
    assert value["job"] == "chaldea-retention" and value["invocation"] == "a" * 32
    assert queued[0].stat().st_mode & 0o777 == 0o600


def test_quiet_success_does_not_post_even_with_credential(home, monkeypatch):
    monkeypatch.setenv("FEED_TOKEN", "test-only")
    assert run_job(home).returncode == 0
    assert not (home / "feed-calls").exists()


def test_failure_handler_deduplicates_wrapper_failure(home, monkeypatch, capsys):
    assert run_job(home, status=2).returncode == 2
    reporter = load_reporter()
    monkeypatch.setenv("MONITOR_INVOCATION_ID", "a" * 32)
    monkeypatch.setenv("MONITOR_SERVICE_RESULT", "exit-code")
    assert reporter.main(["failure", "--job", "chaldea-retention"]) == 0
    assert len(records(home)) == 1 and capsys.readouterr().out == ""


def test_crash_handler_uses_invocation_and_last_task_not_its_own_id(home, monkeypatch):
    reporter = load_reporter()
    reporter.STATE.mkdir(parents=True)
    reporter.write_json(reporter.run_path("chaldea-fleet-pull"), dict(
        invocation="b" * 32, task="Check a credential exists", changed=0))
    monkeypatch.setenv("MONITOR_INVOCATION_ID", "b" * 32)
    monkeypatch.setenv("MONITOR_SERVICE_RESULT", "timeout")
    reporter.main(["failure", "--job", "chaldea-fleet-pull"])
    data = records(home)[0]
    assert data["task"] == "Check a credential exists" and data["reason"] == "systemd timeout"
    assert data["invocation"] == "b" * 32


def test_crash_before_wrapper_start_is_reported_without_stale_task(home, monkeypatch):
    reporter = load_reporter()
    monkeypatch.setenv("MONITOR_INVOCATION_ID", "c" * 32)
    reporter.main(["failure", "--job", "chaldea-fleet-pull"])
    assert records(home)[0]["task"] == "ansible-pull setup"


def test_ring_is_bounded_and_recovers_corrupt_status(home, monkeypatch):
    reporter = load_reporter()
    reporter.STATE.mkdir(parents=True)
    (reporter.STATE / "fleet-status.json").write_text("broken")
    for number in range(70):
        reporter.record_outcome("chaldea-retention", f"{number:032x}", 0)
    assert len(records(home)) == 50
    assert (reporter.STATE / "fleet-status.json").stat().st_size < reporter.MAX_BYTES


def test_delivery_never_starts_feed_and_failure_handler_keeps_the_same_queue_key(home, monkeypatch):
    reporter = load_reporter()
    monkeypatch.setenv("FEED_TOKEN", "test-only")
    reporter.record_outcome("chaldea-retention", "a" * 32, 2)
    before = list((reporter.STATE / "timer-spool").glob("*.jsonl"))
    payload = before[0].read_bytes()
    # A crash after durable queue creation but before the status claim reuses
    # immutable input, even if the status ring has no claim.
    (reporter.STATE / "fleet-status.json").unlink()
    reporter.record_outcome("chaldea-retention", "a" * 32, 2)
    assert len(list((reporter.STATE / "timer-spool").glob("*.jsonl"))) == 1
    assert before[0].read_bytes() == payload
    assert not (home / "feed-calls").exists()


def test_timer_spool_is_bounded_and_counted_without_changing_job_result(home):
    reporter = load_reporter()
    spool = reporter.STATE / "timer-spool"
    spool.mkdir(parents=True)
    (spool / "full").write_bytes(b"x" * (8 * 1024 * 1024))
    assert run_job(home, changed=1).returncode == 0
    assert records(home)[0]["delivery"] == "queue-full"
    counter = json.loads((reporter.STATE / "timer-spool-count.json").read_text())
    assert counter["dropped"] == 1


@pytest.mark.parametrize("failed", [False, True, "rescued"])
def test_real_ansible_callback_counts_changes_and_redacts_failure(home, failed):
    callback_dir = home / ".local/share/chaldea/timer-reporting"
    callback_dir.mkdir(parents=True)
    shutil.copyfile(CALLBACK, callback_dir / CALLBACK.name)
    play = home / "play.yml"
    play.write_text(
        "- hosts: localhost\n  gather_facts: false\n  tasks:\n"
        "    - name: Create a harmless file\n      ansible.builtin.copy:\n"
        f"        content: hello\n        dest: {home}/created\n        mode: '0600'\n"
        + ("    - block:\n"
           "        - name: Rescued failure\n          ansible.builtin.fail:\n            msg: SECRET_ENV_VALUE\n"
           "      rescue:\n"
           "        - name: Rescue failure\n          ansible.builtin.debug:\n            msg: recovered\n"
           if failed == "rescued" else
           "    - name: 'Fail with {{ lookup(\"env\", \"SECRET\") }}'\n"
           "      ansible.builtin.fail:\n        msg: 'SECRET_ENV_VALUE'\n" if failed else "")
    )
    environment = os.environ.copy()
    environment["SECRET"] = "SECRET_ENV_VALUE"
    environment["ANSIBLE_LOCAL_TEMP"] = str(home / "ansible-local")
    environment["ANSIBLE_REMOTE_TEMP"] = str(home / "ansible-remote")
    result = subprocess.run([sys.executable, str(SCRIPT), "run", "--job", "chaldea-fleet-pull",
                             "--", shutil.which("ansible-playbook"), "-i", "localhost,", "-c", "local",
                             str(play), "-e", "ansible_python_interpreter=" + sys.executable],
                            capture_output=True, text=True, env=environment)
    assert (result.returncode != 0) is (failed is True), result.stdout + result.stderr
    data = records(home)[0]
    assert data["changed"] == 1
    assert "SECRET_ENV_VALUE" not in json.dumps(data) + result.stdout + result.stderr
    if failed is True:
        assert data["task"] == "Fail with <redacted>"
        assert data["reason"] == "Ansible task failed"
    if failed == "rescued":
        state = json.loads((home / ".local/state/chaldea/chaldea-fleet-pull-run.json").read_text())
        assert state["failed_task"] == ""


def test_missing_summary_is_visible_failure(home):
    result = subprocess.run([sys.executable, str(SCRIPT), "run", "--job", "chaldea-fleet-pull",
                             "--", "/bin/true"], capture_output=True, text=True)
    assert result.returncode == 1
    assert records(home)[0]["reason"] == "outcome summary missing"


def test_release_identifiers_are_bounded_and_paths_are_not_exported(home):
    reporter = load_reporter()
    tools = home / ".local/share/agent-tools"
    tools.mkdir(parents=True)
    (tools / "current").symlink_to("f" * 64)
    assert reporter.release_names() == ["agent-tools@" + "f" * 12]


def test_killed_wrapper_is_reported_by_failure_handler(home, monkeypatch):
    process = subprocess.Popen(
        [sys.executable, str(SCRIPT), "run", "--job", "chaldea-retention", "--",
         sys.executable, "-c", "import time; time.sleep(60)"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    state = home / ".local/state/chaldea/chaldea-retention-run.json"
    try:
        deadline = time.monotonic() + 3
        while not state.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert state.exists()
    finally:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=3)
    monkeypatch.setenv("MONITOR_INVOCATION_ID", "a" * 32)
    monkeypatch.setenv("MONITOR_SERVICE_RESULT", "signal")
    reporter = load_reporter()
    reporter.main(["failure", "--job", "chaldea-retention"])
    reporter.main(["failure", "--job", "chaldea-retention"])
    assert len(records(home)) == 1
    assert records(home)[0]["reason"] == "systemd signal"


def test_tmp_leftover_note_is_bounded_local_and_does_not_post(home, monkeypatch):
    reporter = load_reporter()
    reporter.STATE.mkdir(parents=True)
    reporter.write_json(reporter.run_path("chaldea-retention"),
                        dict(invocation="a" * 32, changed=0, tmp_leftovers=2000000))
    monkeypatch.setenv("FEED_TOKEN", "test-only")
    reporter.record_outcome("chaldea-retention", "a" * 32, 0)
    data = records(home)[0]
    assert data["notes"] == ["temporary entries left after best-effort cleanup: 1000000"]
    assert data["severity"] == "info" and data["delivery"] == "quiet"
    assert not (home / "feed-calls").exists()


@pytest.mark.parametrize("rescued", [False, True])
def test_callback_only_keeps_unrescued_failure_across_later_tasks(home, monkeypatch, rescued):
    from ansible.playbook.block import Block
    from ansible.playbook.task import Task
    from ansible.plugins.loader import init_plugin_loader
    from types import SimpleNamespace

    if "ansible_collections" not in sys.modules:
        init_plugin_loader()

    loader = importlib.machinery.SourceFileLoader("chaldea_outcome", str(CALLBACK))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    callback = module.CallbackModule()
    state = home / "callback-state.json"
    state.write_text("{}")
    monkeypatch.setenv("CHALDEA_RUN_STATE", str(state))
    block = Block.load({
        "block": [{"name": "Earlier failure", "ansible.builtin.fail": {"msg": "SECRET_ENV_VALUE"}}],
        "rescue": [{"name": "Rescue failure", "ansible.builtin.debug": {"msg": "rescued"}}],
        "always": [{"name": "Always task", "ansible.builtin.debug": {"msg": "always"}}],
    })
    callback.v2_playbook_on_task_start(block.block[0], False)
    callback.v2_runner_on_failed(SimpleNamespace(_task=block.block[0], _result={"rc": 7}))
    if rescued:
        callback.v2_playbook_on_task_start(block.rescue[0], False)
        # Simulate a later failure without a runner result (e.g. load failure).
        callback.v2_playbook_on_task_start(Task.load({"name": "Later failure", "ansible.builtin.fail": {}}), False)
    else:
        callback.v2_playbook_on_task_start(block.always[0], False)
    stats = SimpleNamespace(processed={"localhost": None},
                            summarize=lambda host: {"failures": 1, "changed": 0})
    callback.v2_playbook_on_stats(stats)
    data = json.loads(state.read_text())
    assert data["task"] == ("Later failure" if rescued else "Earlier failure")
    assert data["reason"] == ("" if rescued else "module failed (status 7)")
    assert "SECRET_ENV_VALUE" not in state.read_text()
