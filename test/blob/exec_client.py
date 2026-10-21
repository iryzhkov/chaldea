"""Ordinary exec protocol -> production blob client -> fresh read-only context.
Only SSH transport/namespace setup are substituted, as in recovery.test.ts.
The maintained host server still scans, transfers and cleans its job workspace.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid


def prove(home, endpoint, publisher, reader, garage):
    repo = Path.cwd()
    base = home / "exec-custody"
    base.mkdir()
    client_home, work, state, tools = [base / name for name in ("home", "work", "state", "bin")]
    for path in (client_home, work, state, tools, base / "tmp"):
        path.mkdir(mode=0o700)
    subprocess.run(["git", "init", "-q", str(work)], check=True, timeout=10)
    (work / "input.txt").write_text("representative source\n")
    wrapper = base / "host.py"
    wrapper.write_text('''import os,runpy,sys
from pathlib import Path
root=Path(sys.argv[1])
os.environ["SSH_ORIGINAL_COMMAND"]=sys.argv[2]
s=runpy.run_path(sys.argv[3])
def launch(request,workspace,config):
    marker=workspace.parent/(request["jobId"]+".launch");marker.touch()
    scratch=workspace/".fixture-home";scratch.mkdir()
    temp=workspace/".fixture-tmp";temp.mkdir()
    return ["/usr/bin/env","-i","PATH="+os.environ["PATH"],"HOME="+str(scratch),"TMPDIR="+str(temp),
            "/bin/sh","-c",'cd "$1"; shift; exec "$@"',"job",str(workspace),*request["argv"]],marker
s["execute"].__globals__.update(prepare_launch=launch,launched=lambda path:True,job_signal=lambda *args:None)
sys.argv=["server","--config",str(root/"host.json")]
s["main"]()
''')
    quote = lambda value: "'" + str(value).replace("'", "'\\''") + "'"
    (tools / "ssh").write_text(
        '#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = "-G" ]; then echo "controlpath none"; exit 0; fi; done\n'
        'for last do :; done\nexec ' + " ".join(quote(p) for p in (
            sys.executable, "-I", wrapper, base)) + ' "$last" ' + quote(repo / "host/chaldea-job-server") + "\n")
    (tools / "ssh").chmod(0o700)
    (base / "host.json").write_text(json.dumps({"state_root": str(base / "jobs"), "require_mount": False}))

    def configure(target, key):
        directory = target / ".config" / "chaldea"
        directory.mkdir(parents=True, mode=0o700)
        secret = directory / "garage-key.json"
        secret.write_text(json.dumps({"accessKeyId": key.access, "secretAccessKey": key.secret}))
        secret.chmod(0o600)
        (directory / "blob.json").write_text(json.dumps({
            "version": 1, "endpoint": endpoint, "bucket": "artifact-c", "principal": "fixture-client",
            "region": "garage", "credentialFile": str(secret)}))

    configure(client_home, publisher)
    node = shutil.which("node")
    assert node is not None
    def command(target, *args, cwd=work):
        env = dict(os.environ, HOME=str(target), TMPDIR=str(base / "tmp"),
                   PATH=str(tools) + ":" + os.environ["PATH"],
                   CHALDEA_STATE_DIR=str(state), CHALDEA_SSH_CONFIG=str(base / "ssh.conf"))
        for name in ("XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK"):
            env.pop(name, None)
        result = subprocess.run([node, str(repo / "bin/chaldea"), "exec", *args],
                                cwd=cwd, env=env, capture_output=True, timeout=90)
        assert result.returncode == 0, "production exec/client command failed: " + str(result.returncode) + ": " + result.stderr.decode(errors="replace")[-4096:]
        return result

    def produce():
        result = command(client_home, "--host", "test", "--no-queue", "--artifact", "out/report.txt",
                "--", sys.executable, "-c",
                'import os,pathlib; h=pathlib.Path(os.environ["HOME"]); assert h.name==".fixture-home"; '
                'assert not (h/".config/chaldea/garage-key.json").exists(); '
                'pathlib.Path("out").mkdir(); pathlib.Path("out/report.txt").write_bytes(b"representative artifact\\n")')
        entries = [json.loads(p.read_text()) for p in (state / "journal").glob("*.json")]
        return dict(sorted(entries, key=lambda e: e["started"])[-1], fixtureStderr=result.stderr.decode(errors="replace")[-4096:])

    completed = produce()
    if completed["outcome"] != "finished" or completed["blob"]["state"] != "confirmed":
        _, listing = publisher.request("GET", "artifact-c?list-type=2&max-keys=2&prefix=v1/" + completed["jobId"] + "/manifests/")
        raise AssertionError(completed["fixtureStderr"] + "\\nlisting: " + listing[:4096].decode(errors="replace"))
    assert not (base / "jobs" / completed["jobId"]).exists()
    shutil.rmtree(work / ".chaldea")
    fresh = base / "fresh-home"
    fresh.mkdir()
    configure(fresh, reader)
    # No producer journal or source workspace is present in this context.
    saved = base / "saved-state"
    state.rename(saved)
    fresh_result = command(fresh, "artifacts", "fetch", completed["jobId"], "--output", str(fresh / "download"), cwd=fresh)
    receipt = json.loads(fresh_result.stdout)
    assert receipt["unavailable"] == []
    payload = (fresh / "download/out/report.txt").read_bytes()
    assert payload == b"representative artifact\n"
    assert not state.exists()
    # Reader semantics for a deliberately partial manifest, separate from the
    # ordinary host's existing missing-request behavior (uncertain, not success).
    partial = json.loads((fresh / "download/.chaldea-blob-receipt.json").read_text())
    partial["jobId"] = str(uuid.uuid4())
    partial["requested"].append("unavailable.txt")
    digest = hashlib.sha256(payload).hexdigest()
    prefix = "artifact-c/v1/" + partial["jobId"] + "/"
    assert publisher.request("PUT", prefix + "objects/" + digest, payload)[0] == 200
    partial_bytes = json.dumps(partial).encode()
    assert publisher.request("PUT", prefix + "manifests/" + hashlib.sha256(partial_bytes).hexdigest() + ".json", partial_bytes)[0] == 200
    partial_result = command(fresh, "artifacts", "fetch", partial["jobId"], "--output", str(fresh / "partial"), cwd=fresh)
    assert json.loads(partial_result.stdout)["unavailable"] == ["unavailable.txt"]
    saved.rename(state)

    # A failed publication cannot change a successful job outcome or lose its
    # only local copy. Retry uses the same frozen draft and original job UUID.
    garage.stop()
    pending = produce()
    assert pending["outcome"] == "finished" and pending["blob"]["state"] == "pending" and pending["blob"]["draft"]
    assert Path(pending["artifactPaths"][0]).read_bytes() == payload
    draft = pending["blob"]["draft"]
    garage.start()
    command(client_home, "artifacts", "publish", pending["jobId"])
    recovered = json.loads((state / "journal" / (pending["jobId"] + ".json")).read_text())
    assert recovered["blob"]["state"] == "confirmed"
    assert hashlib.sha256(draft.encode()).hexdigest() + ".json" in recovered["blob"]["manifestKey"]
    command(client_home, "artifacts", "publish", pending["jobId"])
    return {"ordinaryExec": True, "hostWorkspaceDeleted": True, "freshReadOnlyFetch": True,
            "explicitUnavailable": True, "outageRetainsLocalCopy": True, "sameDraftRetry": True,
            "jobId": completed["jobId"], "recoveredJobId": pending["jobId"]}
