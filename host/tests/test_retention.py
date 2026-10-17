"""Behaviour of the rendered retention script against throwaway trees."""

import types
import os
import subprocess
import time
from pathlib import Path

import pytest
import yaml
from jinja2 import Environment, StrictUndefined

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "chaldea-retention"
NODE_VERSION = "26.10.0"
DAY = 86400


def load_script(node_version=NODE_VERSION):
    source = SCRIPT.read_text()
    module = types.ModuleType("chaldea_retention")
    exec(compile(source, str(SCRIPT), "exec"), module.__dict__)
    module.CHALDEA_NODE_VERSION = node_version
    return module


retention = load_script()


def test_missing_runtime_version_prevents_mise_pruning(monkeypatch):
    monkeypatch.setattr(retention, "CHALDEA_NODE_VERSION", "")
    monkeypatch.setattr(retention.subprocess, "run", lambda *a, **k: pytest.fail("must not prune"))
    args = retention.parse_args([])
    retention.prune_mise(args, set())
    assert any("CHALDEA_NODE_VERSION must be configured" in message for message in retention.problems)



def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def age(path, days):
    stamp = time.time() - days * DAY
    for dirpath, dirnames, filenames in os.walk(path):
        for name in dirnames + filenames:
            os.utime(os.path.join(dirpath, name), (stamp, stamp), follow_symlinks=False)
    os.utime(path, (stamp, stamp))


@pytest.fixture(autouse=True)
def git_identity(monkeypatch, tmp_path):
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for role in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{role}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{role}_EMAIL", "test@example.invalid")


@pytest.fixture
def repo(tmp_path):
    main = tmp_path / "repo"
    main.mkdir()
    git("init", "-q", "-b", "main", cwd=main)
    (main / "README").write_text("x\n")
    git("add", "README", cwd=main)
    git("commit", "-q", "-m", "init", cwd=main)
    return main


def add_worktree(repo, root, name, days, detached=False):
    path = root / "project" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if detached:
        git("worktree", "add", "-q", "--detach", str(path), cwd=repo)
    else:
        git("worktree", "add", "-q", "-b", name, str(path), cwd=repo)
    age(path, days)
    return path


def run(root, *extra):
    args = retention.parse_args(["--worktree-root", str(root), *extra])
    return retention.prune_worktrees(root, args, set(), time.time())


@pytest.fixture(autouse=True)
def nothing_held(monkeypatch):
    # The test runner's own processes must not count as sessions.
    monkeypatch.setattr(retention, "held_paths", set)
    monkeypatch.setattr(retention, "problems", [])
    monkeypatch.setattr(retention, "outcome", {"changed": 0, "releases": [], "task": "", "reason": ""})


def test_removes_only_clean_worktrees_untouched_past_the_age_limit(repo, tmp_path):
    root = tmp_path / "worktrees"
    old = add_worktree(repo, root, "old", days=20)
    recent = add_worktree(repo, root, "recent", days=0.5)
    dirty = add_worktree(repo, root, "dirty", days=20)
    (dirty / "README").write_text("changed\n")
    age(dirty, 20)

    assert run(root) == 0

    assert not old.exists()
    assert recent.exists() and dirty.exists()


def test_dry_run_changes_nothing(repo, tmp_path):
    root = tmp_path / "worktrees"
    old = add_worktree(repo, root, "old", days=20)

    run(root, "--dry-run")

    assert old.exists()


def test_keeps_worktrees_a_process_holds(repo, tmp_path):
    root = tmp_path / "worktrees"
    held = add_worktree(repo, root, "held", days=20)
    args = retention.parse_args(["--worktree-root", str(root)])

    retention.prune_worktrees(root, args, {str(held.resolve() / "README")}, time.time())

    assert held.exists()


def test_keeps_detached_commits_that_no_branch_contains(repo, tmp_path):
    root = tmp_path / "worktrees"
    detached = add_worktree(repo, root, "detached", days=20, detached=True)
    (detached / "new").write_text("y\n")
    git("add", "new", cwd=detached)
    git("commit", "-q", "-m", "orphan", cwd=detached)
    age(detached, 20)

    run(root)

    assert detached.exists()


def test_budget_pressure_lowers_the_age_limit_but_not_the_protection_window(repo, tmp_path):
    root = tmp_path / "worktrees"
    five_days = add_worktree(repo, root, "five-days", days=5)
    today = add_worktree(repo, root, "today", days=0.5)

    assert run(root) == 0
    assert five_days.exists()

    status = run(root, "--worktree-budget-gb", "0")

    assert not five_days.exists()
    assert today.exists()
    assert status == 1


def test_keeps_worktrees_with_ignored_output_outside_the_disposable_list(repo, tmp_path):
    (repo / ".gitignore").write_text("out/\nnode_modules/\n")
    git("add", ".gitignore", cwd=repo)
    git("commit", "-q", "-m", "ignore", cwd=repo)
    root = tmp_path / "worktrees"
    output = add_worktree(repo, root, "output", days=20)
    (output / "out").mkdir()
    (output / "out" / "result.bin").write_text("only copy\n")
    age(output, 20)
    deps = add_worktree(repo, root, "deps", days=20)
    (deps / "node_modules" / "pkg").mkdir(parents=True)
    (deps / "node_modules" / "pkg" / "index.js").write_text("x\n")
    age(deps, 20)

    run(root)

    assert (output / "out" / "result.bin").read_text() == "only copy\n"
    assert not deps.exists()


def test_disposable_list_is_configurable(repo, tmp_path):
    (repo / ".gitignore").write_text("out/\n")
    git("add", ".gitignore", cwd=repo)
    git("commit", "-q", "-m", "ignore", cwd=repo)
    root = tmp_path / "worktrees"
    output = add_worktree(repo, root, "output", days=20)
    (output / "out").mkdir()
    (output / "out" / "result.bin").write_text("x\n")
    age(output, 20)

    run(root, "--disposable-ignored", "out")

    assert not output.exists()


def in_trash(root):
    return [slot / "worktree" for slot in (root / retention.TRASH).iterdir()]


def test_a_worktree_taken_into_use_during_removal_goes_back(repo, tmp_path, monkeypatch):
    root = tmp_path / "worktrees"
    wt = add_worktree(repo, root, "late", days=20)
    # A session opens the worktree after the first check, so it shows up only
    # when the quarantined copy is checked again.
    monkeypatch.setattr(retention, "held_paths", lambda: {str(moved / "README") for moved in in_trash(root.resolve())})

    run(root)

    assert (wt / "README").exists()
    assert git_ok("status", cwd=wt)
    assert not any((root / retention.TRASH).iterdir())


def test_a_worktree_written_during_removal_goes_back(repo, tmp_path, monkeypatch):
    root = tmp_path / "worktrees"
    wt = add_worktree(repo, root, "written", days=20)

    def write_then_report_nothing_held():
        for moved in in_trash(root.resolve()):
            (moved / "README").write_text("new work\n")
        return set()

    monkeypatch.setattr(retention, "held_paths", write_then_report_nothing_held)

    run(root)

    assert (wt / "README").read_text() == "new work\n"


def test_an_interrupted_run_is_restored(repo, tmp_path):
    root = tmp_path / "worktrees"
    wt = add_worktree(repo, root, "interrupted", days=1)
    slot = root / retention.TRASH / "wt-crashed"
    slot.mkdir(parents=True)
    (slot / "origin").write_text(f"{wt.resolve()}\n")
    git("worktree", "move", str(wt), str(slot / "worktree"), cwd=repo)

    run(root)

    assert (wt / "README").exists()
    assert not slot.exists()


def git_ok(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True).returncode == 0


PRUNE_PLAN = """\
mise claude@2.1.296 is prunable: claude is required at 2.1.273 by ~/.config/mise/conf.d/agents.toml
mise claude@2.1.296 [dryrun]  uninstall
mise claude@2.1.296 [dryrun]  remove {installs}/claude/2.1.296, ~/.cache/mise/claude/2.1.296
mise claude@2.1.296 [dryrun]  ✓ done
mise claude@2.1.200 is prunable: claude is required at 2.1.273 by ~/.config/mise/conf.d/agents.toml
mise claude@2.1.200 [dryrun]  remove {installs}/claude/2.1.200, ~/.cache/mise/claude/2.1.200
mise codex@0.150.0 is prunable: no tracked config or tool stub requires codex
mise codex@0.150.0 [dryrun]  remove {installs}/codex/0.150.0, ~/.cache/mise/codex/0.150.0
mise node@24.0.0 is prunable: no tracked config or tool stub requires node
"""


def test_mise_prune_keeps_the_latest_link_target_and_versions_in_use(tmp_path):
    installs = tmp_path / "installs"
    for version in ("claude/2.1.296", "claude/2.1.200", "codex/0.150.0"):
        (installs / version).mkdir(parents=True)
    (installs / "claude" / "latest").symlink_to("./2.1.296")
    held = {str(installs / "codex" / "0.150.0" / "bin" / "codex")}

    plan = retention.parse_prune_plan(PRUNE_PLAN.format(installs=installs))
    reasons = {f"{tool}@{version}": retention.prune_reason(path, held) for tool, version, path in plan}

    assert reasons == {
        "claude@2.1.296": "the latest link points at it",
        "claude@2.1.200": None,
        "codex@0.150.0": "a process uses it",
        "node@24.0.0": "install path not known",
    }


@pytest.mark.parametrize("node_version", [NODE_VERSION, "26.11.0"])
def test_mise_keeps_pinned_chaldea_node_without_latest_or_process(tmp_path, monkeypatch, capsys, node_version):
    script = load_script(node_version)
    monkeypatch.setenv("HOME", str(tmp_path))
    installs = tmp_path / ".local/share/mise/installs/node"
    for version in (node_version, "26.12.0", "24.0.0"):
        (installs / version).mkdir(parents=True)
    (installs / "latest").symlink_to("26.12.0")
    plan = "\n".join(
        f"mise node@{v} is prunable\nmise node@{v} [dryrun]  remove {installs / v}, cache"
        for v in (node_version, "24.0.0"))
    calls = []
    def mise(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=plan, stderr="")
    monkeypatch.setattr(script.shutil, "which", lambda name: "/fake/mise")
    monkeypatch.setattr(script.subprocess, "run", mise)

    script.prune_mise(script.parse_args([]), set())

    assert calls == [["/fake/mise", "prune", "--tools", "--dry-run"],
                     ["/fake/mise", "uninstall", "node@24.0.0"]]
    assert f"keep node@{node_version}: the pinned Chaldea runtime" in capsys.readouterr().out


def test_tmp_removes_old_entries_and_keeps_recent_ones(tmp_path):
    tmp = tmp_path / "tmp"
    (tmp / "old").mkdir(parents=True)
    (tmp / "old" / "f").write_text("x")
    (tmp / "new").write_text("x")
    age(tmp / "old", 10)
    args = retention.parse_args(["--tmp-dir", str(tmp)])

    retention.prune_tmp(tmp, args, set(), time.time())

    assert not (tmp / "old").exists()
    assert (tmp / "new").exists()


def test_dry_run_lists_tmp_and_mise_sizes_without_deleting(tmp_path, monkeypatch, capsys):
    tmp = tmp_path / "old-tmp"
    tmp.mkdir()
    candidate = tmp / "old"
    candidate.write_bytes(b"x" * 8192)
    age(candidate, 10)
    install = tmp_path / "installs/claude/2.1.200"
    install.mkdir(parents=True)
    (install / "tool").write_bytes(b"x" * 4096)
    args = retention.parse_args(["--dry-run", "--tmp-dir", str(tmp)])
    monkeypatch.setattr(retention.shutil, "which", lambda name: "/fake/mise")
    plan = PRUNE_PLAN.format(installs=tmp_path / "installs")
    monkeypatch.setattr(retention.subprocess, "run",
                        lambda *a, **kw: subprocess.CompletedProcess(a, 0, stdout=plan, stderr=""))
    retention.prune_tmp(tmp, args, set(), time.time())
    retention.prune_mise(args, set())
    output = capsys.readouterr().out
    assert f"would remove {candidate} (8192 bytes)" in output
    assert "would uninstall claude@2.1.200 (4096 bytes in install; download cache excluded)" in output
    assert candidate.exists() and install.exists()


def test_retention_summary_tracks_changes_and_failed_phase(tmp_path, monkeypatch):
    import json

    state = tmp_path / "state.json"
    state.write_text('{"invocation":"test"}')
    monkeypatch.setenv("CHALDEA_RUN_STATE", str(state))
    monkeypatch.setattr(retention, "outcome", {"changed": 0, "releases": [], "task": "", "reason": ""})
    monkeypatch.setattr(retention, "prune_worktrees", lambda *args: 0)
    monkeypatch.setattr(retention, "prune_tmp", lambda *args: retention.changed())
    monkeypatch.setattr(retention, "prune_go_cache", lambda *args: retention.problem("SECRET_ENV_VALUE"))
    monkeypatch.setattr(retention, "prune_mise", lambda *args: None)
    assert retention.main([]) == 1
    data = json.loads(state.read_text())
    assert data["changed"] == 1 and data["task"] == "prune Go cache"
    assert data["complete"] is True and "SECRET_ENV_VALUE" not in state.read_text()


def test_tmp_partial_cleanup_is_non_failing_and_later_work_continues(tmp_path, monkeypatch, capsys):
    tmp = tmp_path / "tmp"
    stuck = tmp / "read-only-modules"
    stuck.mkdir(parents=True)
    (stuck / "removable").write_text("old output")
    (stuck / "protected").write_text("read-only module")
    other = tmp / "other"
    other.write_text("old output")
    age(tmp, 10)
    later = []
    monkeypatch.setattr(retention, "prune_worktrees", lambda *args: 0)
    monkeypatch.setattr(retention, "prune_go_cache", lambda *args: later.append("go"))
    monkeypatch.setattr(retention, "prune_mise", lambda *args: later.append("mise"))

    def partial_removal(path, ignore_errors=False):
        assert path == stuck and ignore_errors is True
        (path / "removable").unlink()

    monkeypatch.setattr(retention.shutil, "rmtree", partial_removal)
    assert retention.main(["--tmp-dir", str(tmp)]) == 0
    assert not (stuck / "removable").exists() and (stuck / "protected").exists()
    assert not other.exists() and later == ["go", "mise"]
    assert retention.outcome["tmp_leftovers"] == 1
    assert retention.outcome["changed"] == 1  # Only the fully removed entry.
    assert retention.problems == []
    output = capsys.readouterr().out
    assert "note: tmp: 1 entries remain after best-effort cleanup" in output
    assert str(stuck) not in output


def test_tmp_vanishing_during_lstat_does_not_fail_or_skip_later_stages(tmp_path, monkeypatch):
    tmp = tmp_path / "tmp"
    tmp.mkdir()
    vanishing = tmp / "vanishing"
    vanishing.write_text("old output")
    other = tmp / "other"
    other.write_text("old output")
    age(tmp, 10)
    original_lstat = Path.lstat

    def disappearing(path, *args, **kwargs):
        if path == vanishing:
            path.unlink()
            raise FileNotFoundError("SECRET_ENV_VALUE")
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", disappearing)
    later = []
    monkeypatch.setattr(retention, "prune_worktrees", lambda *args: 0)
    monkeypatch.setattr(retention, "prune_go_cache", lambda *args: later.append("go"))
    monkeypatch.setattr(retention, "prune_mise", lambda *args: later.append("mise"))
    assert retention.main(["--tmp-dir", str(tmp)]) == 0
    assert not vanishing.exists() and not other.exists()
    assert later == ["go", "mise"] and retention.problems == []


@pytest.mark.parametrize("failing", range(4))
@pytest.mark.parametrize("error", [OSError, RuntimeError])
def test_each_stage_error_preserves_failure_and_runs_all_stages(monkeypatch, failing, error):
    import json

    calls = []
    functions = ["prune_worktrees", "prune_tmp", "prune_go_cache", "prune_mise"]
    names = ["prune worktrees", "prune temporary files", "prune Go cache", "prune mise installs"]
    for index, function in enumerate(functions):
        def stage(*args, number=index):
            calls.append(number)
            if number == failing:
                raise error("SECRET_ENV_VALUE")
        monkeypatch.setattr(retention, function, stage)
    assert retention.main([]) == 1
    assert calls == [0, 1, 2, 3]
    assert retention.outcome["task"] == names[failing]
    assert retention.outcome["complete"] is True
    assert "SECRET_ENV_VALUE" not in json.dumps(retention.outcome)


def test_go_clean_failure_is_reported_and_mise_still_runs(tmp_path, monkeypatch):
    cache = tmp_path / "go-cache"
    cache.mkdir()
    age(cache, 3)
    monkeypatch.setattr(retention.shutil, "which", lambda name: "/fake/go")
    monkeypatch.setattr(retention, "size_of", lambda path: retention.GIB)
    commands, later = [], []

    def command(argv, **kwargs):
        commands.append(argv)
        if argv[1:] == ["env", "GOCACHE"]:
            return subprocess.CompletedProcess(argv, 0, stdout=str(cache))
        return subprocess.CompletedProcess(argv, 2)

    monkeypatch.setattr(retention.subprocess, "run", command)
    monkeypatch.setattr(retention, "prune_worktrees", lambda *args: 0)
    monkeypatch.setattr(retention, "prune_tmp", lambda *args: None)
    monkeypatch.setattr(retention, "prune_mise", lambda *args: later.append("mise"))
    assert retention.main(["--go-cache-max-gb", "0"]) == 1
    assert commands[-1] == ["/fake/go", "clean", "-cache"] and later == ["mise"]
    assert retention.outcome["task"] == "prune Go cache"
    assert retention.outcome["changed"] == 0
