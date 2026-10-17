"""Recovery uses the mounted image, retains only output/named files, and has no clock sleeps."""
import json
import os
from pathlib import Path
import runpy
from unittest.mock import patch
import uuid

import pytest

server = type("Server", (), {})()
# runpy functions keep their module globals, so patch globals through the dict.
module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "chaldea-job-server"))
retention = module["retention"]


def request(**overrides):
    return {"version": 1, "jobId": str(uuid.uuid4()), "argv": ["secret-argv"],
            "cwd": "", "gpu": False, "artifacts": ["out"], "files": [], **overrides}


def finished(root, workspace, req, now=100, outcome="finished", code=7):
    job = retention.RetainedJob(root, req, {}, now=now)
    job.output("O", b"printed-public\n")
    job.output("S", b"printed-stderr\n")
    job.finish(workspace, module["artifact_file"], outcome, code, now=now)
    job.close(True)
    return root / ".retained" / req["jobId"]


def test_retained_payload_permissions_and_no_snapshot_or_host_secrets(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "out").write_text("requested")
    (workspace / "unrequested").write_text("secret-input-not-printed")
    req = request()
    path = finished(tmp_path, workspace, req)
    assert (path / "output.log").read_text() == "\n[stdout]\nprinted-public\n\n[stderr]\nprinted-stderr\n"
    meta = json.loads((path / "metadata.json").read_text())
    assert meta["exitCode"] == 7
    assert (path / "artifact-0").read_text() == "requested"
    payload = b"".join(p.read_bytes() for p in path.iterdir())
    assert b"secret-input-not-printed" not in payload
    assert b"secret-argv" not in payload
    assert path.stat().st_mode & 0o777 == 0o700
    assert (tmp_path / ".retained").stat().st_mode & 0o777 == 0o700
    assert all(p.stat().st_mode & 0o777 == 0o600 for p in path.iterdir())


def test_prune_three_days_fake_clock_and_oldest_first_cap(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "out").write_text("artifact")
    old = finished(tmp_path, workspace, request(), now=100)
    newer = finished(tmp_path, workspace, request(), now=200)
    ttl = retention.LIMITS["retentionSeconds"]
    retention.prune(tmp_path, {}, now=100 + ttl)
    assert old.exists() and newer.exists()
    retention.prune(tmp_path, {}, now=101 + ttl)
    assert not old.exists() and newer.exists()
    newest = finished(tmp_path, workspace, request(), now=300)
    # Choose a cap that retains the newer of these two complete records.
    cap = sum(p.stat().st_size for p in newest.iterdir())
    retention.prune(tmp_path, {"retention_cap_bytes": cap}, now=301)
    assert not newer.exists() and newest.exists()
    retention.prune(tmp_path, {}, now=301 + ttl)
    assert not newest.exists()


def test_live_store_is_reserved_and_not_pruned(tmp_path):
    req = request(artifacts=[])
    job = retention.RetainedJob(tmp_path, req, {}, now=100)
    try:
        with pytest.raises(ValueError, match="active recovery data protected"):
            retention.prune(tmp_path, {"retention_cap_bytes": 1}, now=999999)
        assert job.path.exists()
        with pytest.raises(ValueError, match="still being finalized"):
            with retention.fetch(tmp_path, {"version": 1, "jobId": req["jobId"]}, {}):
                pass
    finally:
        job.close(False)


def test_output_and_regular_named_artifacts_caps(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "small").write_bytes(b"1234")
    (workspace / "too-big").write_bytes(b"x" * 8)
    (workspace / "symlink").symlink_to(workspace / "small")
    os.mkfifo(workspace / "fifo")
    req = request(artifacts=["too-big", "small", "missing", "symlink", "fifo"])
    with patch.dict(retention.RetainedJob.output.__globals__, LOG_CAP=32):
        job = retention.RetainedJob(tmp_path, req, {})
        job.output("O", b"x" * 100)
    with patch.dict(retention.RetainedJob.finish.__globals__, ARTIFACT_CAP=4):
        job.finish(workspace, module["artifact_file"], "preempted")
    job.close(True)
    assert (job.path / "output.log").stat().st_size == 32
    meta = json.loads((job.path / "metadata.json").read_text())
    assert meta["logTruncated"]
    assert meta["outcome"] == "preempted" and meta["exitCode"] is None
    assert [a["path"] for a in meta["artifacts"]] == ["small"]
    assert len(meta["artifactErrors"]) == 4
    assert [p.name for p in job.path.glob("artifact-*")] == ["artifact-1"]


def test_fetch_is_read_only_and_versioned_and_survives_workspace_cleanup(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "out").write_text("available")
    req = request()
    path = finished(tmp_path, workspace, req, now=100)
    module["cleanup"](tmp_path)
    assert not workspace.exists() and path.exists()
    with patch.dict(retention.fetch.__wrapped__.__globals__, **{}):
        # A fake wall clock proves fetch invokes expiration without waiting.
        with patch.object(retention.time, "time", return_value=101):
            with retention.fetch(tmp_path, {"version": 1, "jobId": req["jobId"]}, {}) as (found, meta):
                assert found == path and meta["outcome"] == "finished"
    for value in [{"version": 2, "jobId": req["jobId"]}, {"version": 1, "jobId": "../escape"}]:
        with pytest.raises(ValueError):
            with retention.fetch(tmp_path, value, {}):
                pass


@pytest.mark.parametrize("error", [ConnectionError("lost client"), module["Preempted"]("preempted")])
def test_run_job_finalizes_recovery_before_removing_workspace(tmp_path, error):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "out").write_text("after-failure")
    req = request()
    def execute(*_):
        module["run_job"].__globals__["RECOVERY"].output("O", b"before-disconnect")
        raise error
    env = module["run_job"].__globals__
    with patch.dict(env, execute=execute, send=lambda *args: None):
        with pytest.raises(type(error)):
            module["run_job"](tmp_path, tmp_path, req, workspace, {})
    assert not workspace.exists()
    path = tmp_path / ".retained" / req["jobId"]
    assert (path / "artifact-0").read_text() == "after-failure"
    assert b"before-disconnect" in (path / "output.log").read_bytes()
    assert json.loads((path / "metadata.json").read_text())["outcome"] == ("preempted" if isinstance(error, module["Preempted"]) else "uncertain")
    assert env["RECOVERY"] is None


def test_success_discards_host_copy_but_lost_result_keeps_it(tmp_path):
    for lose_result in (False, True):
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        req = request(artifacts=[])
        def send(kind, *_):
            if lose_result and kind == "X":
                raise BrokenPipeError()
        env = module["run_job"].__globals__
        with patch.dict(env, execute=lambda *_: 0, artifacts=lambda *_: None, send=send):
            if lose_result:
                with pytest.raises(BrokenPipeError):
                    module["run_job"](tmp_path, tmp_path, req, workspace, {})
            else:
                module["run_job"](tmp_path, tmp_path, req, workspace, {})
        assert (tmp_path / ".retained" / req["jobId"]).exists() == lose_result
