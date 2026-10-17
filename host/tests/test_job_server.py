"""Policy/security unit tests complement the rootless real-SSH test in chaldea."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import tempfile
from unittest.mock import patch
import pytest

PATH = Path(__file__).resolve().parents[1] / "chaldea-job-server"
loader = importlib.machinery.SourceFileLoader("job_server", str(PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
server = importlib.util.module_from_spec(spec)
loader.exec_module(server)


@pytest.mark.parametrize("kill_supervisor", [False, True])
def test_supervisor_kills_transport_that_clears_parent_death_signal(kill_supervisor):
    import os
    import select
    import signal
    import subprocess
    import sys
    import time
    transport = """
import ctypes,json,os,signal,subprocess,sys
inherited=ctypes.c_int()
assert ctypes.CDLL(None).prctl(2,ctypes.byref(inherited),0,0,0) == 0
assert inherited.value == signal.SIGKILL
assert ctypes.CDLL(None).prctl(1,0,0,0,0) == 0
child = subprocess.Popen([sys.executable,'-I','-c','import time; time.sleep(100)'])
print(json.dumps([os.getppid(),os.getpid(),child.pid]), flush=True)
child.wait()
"""
    driver = """
import json,os,subprocess,sys
from pathlib import Path
server,launch = sys.argv[1:]
value=json.loads(Path(launch).read_text())
value['parent_pid']=os.getpid()
Path(launch).write_text(json.dumps(value))
child=subprocess.Popen([sys.executable,'-I',server,'--network-supervisor',launch],start_new_session=True)
sys.exit(child.wait())
"""
    with tempfile.TemporaryDirectory() as tmp:
        launch = Path(tmp) / "launch.json"
        launch.write_text(json.dumps({"transport": [sys.executable, "-I", "-c", transport]}))
        parent = subprocess.Popen([sys.executable, "-I", "-c", driver, str(PATH), str(launch)],
                                  stdout=subprocess.PIPE)
        assert parent.stdout is not None
        group = None
        descriptors = []
        try:
            assert select.select([parent.stdout], [], [], 5)[0], "transport did not start"
            pids = json.loads(parent.stdout.readline())
            group = pids[0]
            descriptors = [os.pidfd_open(pid) for pid in pids]
            if kill_supervisor:
                os.kill(group, signal.SIGKILL)
            parent.kill()
            parent.wait(timeout=5)
            pending = set(descriptors)
            deadline = time.monotonic() + 5
            while pending:
                ready, _, _ = select.select(list(pending), [], [], max(0, deadline - time.monotonic()))
                assert ready, "supervisor/transport/worker survived parent crash"
                pending.difference_update(ready)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=5)
            if group:
                try:
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for descriptor in descriptors:
                os.close(descriptor)
            parent.stdout.close()


def test_network_child_uses_nft_path_available_on_debian_and_arch():
    with tempfile.TemporaryDirectory() as tmp:
        launch = Path(tmp) / "launch.json"
        launch.write_text(json.dumps({"addresses": [], "subnets": [],
                                     "command": ["/usr/bin/bwrap", "--", "true"], "env": {}}))
        with (patch("ctypes.CDLL") as libc, patch.object(server.subprocess, "run") as run,
              patch.object(server.os, "open", return_value=42),
              patch.object(server.os, "set_inheritable"), patch.object(server.os, "execve")):
            libc.return_value.prctl.return_value = 0
            server.network_child(launch)
        assert run.call_args.args[0] == ["/usr/sbin/nft", "-f", "-"]


def request(**overrides):
    return {"version": 1, "jobId": "11111111-1111-1111-1111-111111111111",
            "argv": ["printf", "$HOME"], "cwd": "", "gpu": False,
            "artifacts": [], "files": [], **overrides}


@pytest.mark.parametrize("path", ["../x", "/x", "a//x", ".git/config", ".chaldea/log", "a/./b", "a\\b", ""])
def test_unsafe_paths(path):
    with pytest.raises(ValueError):
        server.safe_path(path)


def test_protocol_and_command_validation():
    assert server.validate(request())["argv"] == ["printf", "$HOME"]
    for override in [{"version": 2}, {"jobId": "../x"}, {"argv": "sh"},
                     {"argv": []}, {"gpu": "yes"}, {"artifacts": ["out", "out"]},
                     {"files": [{"path": "x", "size": 65 * 1024 ** 2,
                                 "sha256": "a" * 64, "mode": 0o644}]}]:
        with pytest.raises(ValueError):
            server.validate(request(**override))


def test_idle_policy_steam_wrapper_children_minecraft_and_custom_patterns():
    config = {"policy": "idle", "desktop_user": "igor"}
    idle = [(1, 0, "sunshine", "/usr/bin/sunshine"),
            (2, 0, "steam", "/usr/bin/steam"),
            (3, 0, "java", "java -jar ordinary-build-tool.jar")]
    assert not server.gaming(config, idle)
    cases = [
        idle + [(10, 2, "reaper", "/steam/reaper SteamLaunch AppId=570 -- game"),
                (11, 10, "game", "./game"), (12, 11, "worker", "./worker")],
        idle + [(10, 0, "java", "java net.minecraft.client.main.Main")],
        idle + [(10, 0, "java", "java net.fabricmc.loader.impl.launch.knot.KnotClient")],
        idle + [(10, 0, "java", "java -jar client.jar --gameDir /home/igor/.minecraft-modded")],
    ]
    for rows in cases:
        assert server.gaming(config, rows)
        with patch.object(server, "process_table", return_value=rows):
            with pytest.raises(server.Refused, match="Steam game or Minecraft"):
                server.idle_policy(config)
    with patch.object(server, "process_table", return_value=idle):
        server.idle_policy(config)
        server.idle_policy({"policy": "always"})
    assert server.gaming({**config, "steam_game_pattern": "custom-game"},
                         [(1, 0, "custom", "custom-game")])
    with patch.object(server.subprocess, "check_output", return_value="10 2 reaper reaper SteamLaunch AppId=42 -- game\n"):
        assert server.process_table("igor") == [(10, 2, "reaper", "reaper SteamLaunch AppId=42 -- game")]


def test_admission_and_stale_workspace_cleanup():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        workspace = root / request()["jobId"]
        workspace.mkdir()
        (workspace / "old").write_text("old")
        (root / "admission.lock").touch()
        server.cleanup(root)
        assert [p.name for p in root.iterdir()] == ["admission.lock"]
        with pytest.raises(ValueError, match="over cap"):
            server.admission(root, {"state_cap_bytes": 1, "require_mount": False})
        with pytest.raises(ValueError, match="image full"):
            server.admission(root, {"min_free_bytes": 2 ** 63, "require_mount": False})


def test_apply_smoke_defers_on_busy_lock_without_launching_or_cleaning_jobs(tmp_path):
    import fcntl
    import subprocess
    import sys

    lock = tmp_path / "admission.lock"
    sentinel = tmp_path / "running-job"
    sentinel.mkdir()
    (sentinel / "output").write_text("keep")
    config = tmp_path / "server.json"
    config.write_text(json.dumps({"state_root": str(tmp_path), "require_mount": False}))
    with lock.open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        with pytest.raises(server.Busy):
            with server.admission_lock(tmp_path):
                pytest.fail("busy lock admitted another job")
        result = subprocess.run([sys.executable, "-I", str(PATH), "--config", str(config),
                                 "--smoke-test"], capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, result.stderr
    assert "sandbox smoke test deferred to the next run: host busy" in result.stderr
    assert (sentinel / "output").read_text() == "keep"


def test_sandbox_identity_is_private_readonly_and_cleaned_with_slot(tmp_path):
    workspace = tmp_path / request()["jobId"]
    workspace.mkdir()
    with (patch.object(server, "host_addresses", return_value=[]),
          patch.object(server, "connected_subnets", return_value=[]),
          patch.object(server, "check_tools", return_value=""),
          patch.object(server.subprocess, "check_output", return_value="--disable-userns")):
        _wrapped, launch = server.prepare_launch(request(), workspace, {})
    value = json.loads(launch.read_text())
    cmd, env = value["command"], value["env"]
    mounts = [cmd[i:i + 3] for i, arg in enumerate(cmd) if arg in ("--ro-bind", "--bind")]
    for name, content in (("passwd", "job:x:0:0::/home/job:/bin/sh\n"),
                          ("group", "job:x:0:\n")):
        mount = next(mount for mount in mounts if mount[2] == "/etc/" + name)
        assert mount[0] == "--ro-bind"
        source = Path(mount[1])
        assert not source.is_relative_to(workspace)
        assert source.read_text() == content
        assert source.stat().st_mode & 0o777 == 0o444
        assert not any(source.is_relative_to(Path(m[1])) for m in mounts if m[0] == "--bind")
    assert env["USER"] == env["LOGNAME"] == "job"
    server.cleanup(tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_sandbox_is_allowlisted_no_gpu_without_explicit_request():
    with tempfile.TemporaryDirectory() as tmp:
        with patch.object(server.subprocess, "check_output", return_value="--disable-userns"):
            cmd, env = server.sandbox(request(), Path(tmp), {"gpu_devices": ["/dev/nvidia0"]})
        assert "--disable-userns" in cmd
        assert "--unshare-all" in cmd and "--share-net" in cmd
        assert "--die-with-parent" in cmd and "--cap-drop" in cmd
        assert "--dev-bind" not in cmd
        assert not any(key in env for key in ("SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "GH_TOKEN"))
        assert env["HOME"] == "/home/job"
        assert cmd[-2:] == ["printf", "$HOME"]
    with tempfile.TemporaryDirectory() as tmp:
        with patch.object(server.subprocess, "check_output", return_value="--disable-userns"):
            with pytest.raises(ValueError, match="GPU unavailable"):
                server.sandbox(request(gpu=True), Path(tmp), {})


@pytest.mark.parametrize("alternatives_present", [True, False])
def test_alternatives_mount_is_optional_readonly_and_adds_no_writable_host_paths(tmp_path, alternatives_present):
    exists = Path.exists
    def present(path):
        return alternatives_present if str(path) == "/etc/alternatives" else exists(path)
    with patch.object(Path, "exists", present):
        with patch.object(server.subprocess, "check_output", return_value="--disable-userns"):
            cmd, _env = server.sandbox(request(), tmp_path, {})
    mounts = [cmd[i:i + 3] for i, value in enumerate(cmd) if value in ("--ro-bind", "--bind")]
    assert (["--ro-bind", "/etc/alternatives", "/etc/alternatives"] in mounts) == alternatives_present
    assert [mount for mount in mounts if mount[0] == "--bind"] == [
        ["--bind", str(tmp_path), "/work"],
        ["--bind", str(tmp_path / ".chaldea-home"), "/home/job"],
        ["--bind", str(tmp_path / ".chaldea-tmp"), "/tmp"]]
    assert not any(mount[1] in ("/etc", "/etc/shadow", "/home", "/root", "/run") for mount in mounts)


def test_toolchains_are_mounted_readonly_with_private_caches(tmp_path):
    root = tmp_path / "tools"
    defaults = {"node": "26.12.0", "go": "1.27.0", "rust": "1.99.0", "uv": "0.12.10"}
    for tool, version in defaults.items():
        (root / tool / version / "bin").mkdir(parents=True)
    workspace = tmp_path / "job"
    workspace.mkdir()
    config = {"toolchain_root": str(root), "toolchain_defaults": defaults}
    with patch.object(server.subprocess, "check_output", return_value="--disable-userns"):
        cmd, env = server.sandbox(request(), workspace, config)
    offset = cmd.index(str(root))
    assert cmd[offset - 1:offset + 2] == ["--ro-bind", str(root), str(root)]
    assert env["PATH"].split(":")[:4] == [str(root / t / v / "bin") for t, v in defaults.items()]
    assert env["TAR_OPTIONS"] == "--no-same-owner"
    assert env["GOTOOLCHAIN"] == "local"
    for key in ("npm_config_cache", "CARGO_HOME", "GOPATH", "GOMODCACHE", "GOCACHE",
                "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR"):
        assert env[key].startswith("/home/job/")
    server.cleanup(tmp_path)
    assert not workspace.exists()


def test_missing_or_unpinned_toolchain_fails_closed(tmp_path):
    defaults = {t: "1.2.3" for t in ("node", "go", "rust", "uv")}
    with pytest.raises(ValueError, match="not installed"):
        server.toolchain_environment({"toolchain_root": str(tmp_path), "toolchain_defaults": defaults})
    with pytest.raises(ValueError, match="pinned"):
        server.toolchain_environment({"toolchain_root": str(tmp_path), "toolchain_defaults": {**defaults, "node": "../escape"}})


def test_artifact_symlink_and_fifo_rejected_without_blocking():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "escape").symlink_to("/etc/passwd")
        with pytest.raises(ValueError, match="symlinks"):
            server.artifact_file(root, "escape")
        import os
        os.mkfifo(root / "pipe")
        with pytest.raises(ValueError, match="regular"):
            server.artifact_file(root, "pipe")

def test_absent_mount_refuses_before_using_underlying_host_disk():
    with tempfile.TemporaryDirectory() as tmp:
        with pytest.raises(server.Refused, match="image is not mounted"):
            server.admission(Path(tmp), {})


def test_deep_tree_over_path_max_and_unremovable_leftover_do_not_wedge_jobs(capsys):
    import os
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tree = root / "old"
        tree.mkdir()
        fd = os.open(tree, os.O_RDONLY | os.O_DIRECTORY)
        try:
            name = "d" * 200
            for _ in range(30):
                os.mkdir(name, dir_fd=fd)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = child
            file = os.open("file", os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=fd)
            os.close(file)
        finally:
            os.close(fd)
        server.remove_tree(tree)
        assert not tree.exists()  # deepest pathname exceeded 6000 bytes
        tree.mkdir()
        with patch.object(server, "remove_tree", side_effect=PermissionError):
            server.cleanup(root)
        assert "could not remove" in capsys.readouterr().err
        server.admission(root, {"require_mount": False})
        server.cleanup(root)


def test_preemption_sends_term_then_kill_after_ten_seconds_and_keeps_stdin_after_pipes_close():
    import io
    import signal
    from types import SimpleNamespace
    clock = [0.0]
    class Selector:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def register(self, *args): pass
        def unregister(self, *args): pass
        def select(self, timeout):
            clock[0] += timeout
            return []
    process = SimpleNamespace(pid=4321, stdout=io.BytesIO(), stderr=io.BytesIO(), wait=lambda **_: 0)
    signals = []
    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(tmp) / "work"
        workspace.mkdir()
        with patch.object(server, "sandbox", return_value=(["true"], {})), \
             patch.object(server, "host_addresses", return_value=[]), \
             patch.object(server, "connected_subnets", return_value=[]), \
             patch.object(server, "check_tools", return_value=""), \
             patch.object(server.subprocess, "Popen", return_value=process), \
             patch.object(server.os, "pidfd_open", return_value=999), \
             patch.object(server.os, "close"), \
             patch.object(server, "kill_group"), \
             patch.object(server, "job_signal", side_effect=lambda _, sig, _pasta: signals.append((sig, clock[0]))), \
             patch.object(server, "gaming", return_value=True), \
             patch.object(server.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(server.selectors, "DefaultSelector", Selector):
            with pytest.raises(server.Preempted):
                server.execute(request(), workspace, {"policy": "idle"})
    assert signals[0] == (signal.SIGTERM, 5)
    assert signals[1] == (signal.SIGKILL, 15)


def test_stdin_is_monitored_after_both_output_pipes_close():
    import io
    from types import SimpleNamespace
    clock = [0.0]
    phase = [0]
    class Selector:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def register(self, *args): pass
        def unregister(self, *args): pass
        def select(self, _):
            clock[0] += .01
            phase[0] += 1
            if phase[0] == 1:
                return [(SimpleNamespace(data=k, fd=i, fileobj=i), 1) for k, i in [("O", 101), ("S", 102)]]
            return [(SimpleNamespace(data="input", fd=0), 1)]
    process = SimpleNamespace(pid=4321, stdout=io.BytesIO(), stderr=io.BytesIO(), wait=lambda **_: 0)
    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(tmp) / "work"
        workspace.mkdir()
        with patch.object(server, "sandbox", return_value=(["true"], {})), \
             patch.object(server, "host_addresses", return_value=[]), \
             patch.object(server, "connected_subnets", return_value=[]), \
             patch.object(server, "check_tools", return_value=""), \
             patch.object(server.subprocess, "Popen", return_value=process), \
             patch.object(server.os, "pidfd_open", return_value=999), \
             patch.object(server.os, "read", return_value=b""), \
             patch.object(server.os, "close"), \
             patch.object(server, "kill_group"), patch.object(server, "job_signal"), \
             patch.object(server.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(server.selectors, "DefaultSelector", Selector):
            with pytest.raises(ConnectionError, match="disconnected"):
                server.execute(request(), workspace, {})



def test_fixed_image_creation_is_atomic_and_never_reformats_existing():
    import os
    image_loader = importlib.machinery.SourceFileLoader("image", str(PATH.with_name("chaldea-job-image")))
    image_spec = importlib.util.spec_from_loader(image_loader.name, image_loader)
    image_module = importlib.util.module_from_spec(image_spec)
    image_loader.exec_module(image_module)
    with tempfile.TemporaryDirectory() as tmp:
        image = Path(tmp) / "jobs.ext4"
        assert image_module.create(image, 512 * 1024**2, (os.getuid(), os.getgid()))
        assert not image_module.create(image, 512 * 1024**2, (os.getuid(), os.getgid()))
        assert image.stat().st_size == 512 * 1024**2
        kind = server.subprocess.check_output(["blkid", "-p", "-s", "TYPE", "-o", "value", str(image)], text=True)
        assert kind.strip() == "ext4"
        with pytest.raises(ValueError, match="refusing"):
            image_module.create(image, 1024 * 1024**2, (os.getuid(), os.getgid()))
        assert not Path(str(image) + ".new").exists()


def test_network_blocks_nondefault_connected_subnets_and_keeps_default_route():
    rows = [
        {"ifname": "lo", "flags": ["LOOPBACK"], "addr_info": [{"local": "127.0.0.1", "prefixlen": 8}]},
        {"ifname": "eno1", "addr_info": [{"local": "192.168.90.212", "prefixlen": 24}]},
        {"ifname": "docker0", "addr_info": [{"local": "172.17.0.1", "prefixlen": 16}]},
        {"ifname": "nebula1", "addr_info": [{"local": "10.42.0.6", "prefixlen": 24},
                                          {"local": "fd42::6", "prefixlen": 64}]},
    ]
    subnets = server.connected_subnets(rows, [{"dev": "eno1", "dst": "default"}])
    assert set(subnets) == {"172.17.0.0/16", "10.42.0.0/24", "fd42::/64"}
    rules = server.network_rules(["192.168.90.212", "172.17.0.1", "127.0.0.1"], subnets)
    assert "172.17.0.0/16" in rules and "10.42.0.0/24" in rules and "fd42::/64" in rules
    assert "192.168.90.212/32" in rules
    assert "192.168.90.0/24" not in rules and "127.0.0.1" not in rules


def test_connected_subnet_filter_rejects_packets_in_private_netns():
    import shutil
    import subprocess
    import sys
    if not all(shutil.which(name) for name in ("nft", "unshare", "ip")):
        pytest.skip("nft/unshare/ip absent; packet test needs an existing rootless netns toolchain")
    probe = subprocess.run(["unshare", "-Urn", "true"], capture_output=True)
    if probe.returncode:
        pytest.skip("unprivileged user/network namespaces unavailable; no host changes made")
    # Both listeners live in this disposable netns. The synthetic bridge's
    # subnet contains a second endpoint, not just its interface's own address.
    subnets = server.connected_subnets(
        [{"ifname": "docker0", "addr_info": [{"local": "127.20.0.1", "prefixlen": 16}]}],
        [{"dev": "eno1"}])
    rules = server.network_rules([], subnets)
    code = """
import errno,socket,subprocess,sys
subprocess.run(['ip','link','set','lo','up'],check=True)
blocked=socket.socket(); blocked.bind(('127.20.0.2',0)); blocked.listen()
allowed=socket.socket(); allowed.bind(('127.0.0.1',0)); allowed.listen()
subprocess.run(['nft','-f','-'],input=sys.argv[1],text=True,check=True)
client=socket.socket(); client.settimeout(1)
assert client.connect_ex(blocked.getsockname()) == errno.ECONNREFUSED
client.close()
client=socket.create_connection(allowed.getsockname(),timeout=1)
peer,_=allowed.accept(); peer.close(); client.close()
"""
    result = subprocess.run(["unshare", "-Urn", sys.executable, "-I", "-c", code, rules],
                            capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("resolv,expected", [
    ("nameserver 127.0.0.53\n", ["1.1.1.1", "9.9.9.9"]),
    ("# no nameserver configured\n", ["1.1.1.1", "9.9.9.9"]),
    ("nameserver 192.0.2.1\nnameserver 10.42.0.5\nnameserver 8.8.8.8\n", ["8.8.8.8"]),
])
def test_pasta_skips_dns_discovery_and_guest_keeps_sanitized_resolvers(resolv, expected):
    read_text = Path.read_text
    def read(path, *args, **kwargs):
        return resolv if path == Path("/etc/resolv.conf") else read_text(path, *args, **kwargs)
    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(tmp) / "work"
        workspace.mkdir()
        with (patch.object(Path, "read_text", read),
              patch.object(server, "host_addresses", return_value=["192.0.2.1"]),
              patch.object(server, "connected_subnets", return_value=["10.42.0.0/24"]),
              patch.object(server, "check_tools", return_value=""),
              patch.object(server.subprocess, "check_output", return_value="--disable-userns")):
            wrapped, launch = server.prepare_launch(request(), workspace, {})
        assert "--network-supervisor" in wrapped
        transport = json.loads(launch.read_text())["transport"]
        assert "--foreground" in transport
        assert [transport[i + 1] for i, arg in enumerate(transport) if arg == "--dns"] == ["none"]
        assert (workspace / ".chaldea-resolv").read_text() == "".join("nameserver " + address + "\n" for address in expected)


def test_package_baseline_rejects_old_bwrap_and_missing_pasta_options():
    from types import SimpleNamespace
    required = "--foreground --dns --config-net --no-map-gw --map-host-loopback --no-splice"
    with patch.object(server.subprocess, "check_output", return_value="bubblewrap 0.8.0"):
        with pytest.raises(server.Refused, match="bubblewrap >= 0.9"):
            server.check_tools()
    with patch.object(server.subprocess, "check_output", return_value="bubblewrap 0.12.0"), \
         patch.object(server.subprocess, "run", return_value=SimpleNamespace(stdout=required, stderr="")):
        assert "--no-pidns" not in server.check_tools()
    with patch.object(server.subprocess, "check_output", return_value="bubblewrap 0.12.0"), \
         patch.object(server.subprocess, "run", return_value=SimpleNamespace(stdout="--config-net", stderr="")):
        with pytest.raises(server.Refused, match="lacks required option"):
            server.check_tools()


def test_pid_translation_stays_in_pasta_tree_and_signals_host_group():
    import signal
    with tempfile.TemporaryDirectory() as tmp:
        proc = Path(tmp)
        def row(pid, children, ids):
            task = proc / str(pid) / "task" / str(pid)
            task.mkdir(parents=True)
            (task / "children").write_text(children)
            (proc / str(pid) / "status").write_text("NSpid:\t" + ids + "\n")
        row(100, "101", "100")
        row(101, "102", "101 1")
        row(102, "", "102 7 1")
        row(999, "", "999 7 1")  # same inner PID, outside transport tree
        assert server.host_job_pid(7, 100, proc) == 102
        assert server.host_job_pid(99, 100, proc) is None
        launch = proc / "job.launch"
        Path(str(launch) + ".status").write_text('{"child-pid":7}\n')
        with patch.object(server, "host_job_pid", return_value=102), \
             patch.object(server.os, "getpgid", return_value=102), \
             patch.object(server.os, "killpg") as kill:
            server.job_signal(launch, signal.SIGTERM, 100)
            kill.assert_called_once_with(102, signal.SIGTERM)


def test_image_refuses_insufficient_backing_space_before_creating_any_file():
    import os
    import shutil
    image_loader = importlib.machinery.SourceFileLoader("image_space", str(PATH.with_name("chaldea-job-image")))
    image_spec = importlib.util.spec_from_loader(image_loader.name, image_loader)
    image_module = importlib.util.module_from_spec(image_spec)
    image_loader.exec_module(image_module)
    size = 512 * 1024**2
    with tempfile.TemporaryDirectory() as tmp:
        image = Path(tmp) / "jobs.ext4"
        with patch.object(shutil, "disk_usage", return_value=shutil._ntuple_diskusage(size * 2, size + 1, size - 1)):
            with pytest.raises(ValueError, match="free space for the full job image"):
                image_module.create(image, size, (os.getuid(), os.getgid()))
        assert list(Path(tmp).iterdir()) == []



def test_resolver_on_blocked_connected_subnet_is_not_imported():
    with tempfile.TemporaryDirectory() as tmp:
        read = Path.read_text
        def resolver(path, *args, **kwargs):
            if str(path) == "/etc/resolv.conf":
                return "nameserver 172.17.0.53\n"
            return read(path, *args, **kwargs)
        with patch.object(Path, "read_text", resolver), \
             patch.object(server.subprocess, "check_output", return_value="--disable-userns"):
            server.sandbox(request(), Path(tmp), {"_blocked_subnets": ["172.17.0.0/16"]})
        value = (Path(tmp) / ".chaldea-resolv").read_text()
        assert "172.17.0.53" not in value and "1.1.1.1" in value


def test_smoke_refuses_busy_lock_before_touching_a_jobs_workspace():
    import fcntl
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        workspace = root / "running-job"
        workspace.mkdir()
        marker = workspace / "keep"
        marker.write_text("still running")
        with (root / "admission.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(server, "prepare_launch") as prepare:
                with pytest.raises(server.Refused, match="host busy"):
                    server.smoke_test({"state_root": str(root), "require_mount": False})
                prepare.assert_not_called()
            assert marker.read_text() == "still running"
            assert sorted(p.name for p in root.iterdir()) == ["admission.lock", "running-job"]


def test_smoke_holds_admission_lock_through_launch_and_releases_after_cleanup():
    import io
    from types import SimpleNamespace
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        workspaces = []
        def check_locked():
            with pytest.raises(server.Refused, match="host busy"):
                with server.admission_lock(root):
                    pytest.fail("smoke did not hold the job admission lock")
        def prepare(_request, workspace, _config):
            check_locked()
            workspaces.append(workspace.parent)
            return ["fake-pasta"], workspace.parent / "launch"
        def communicate(timeout):
            check_locked()
            assert timeout == 15
            return "sandbox-smoke-ok\n", ""
        process = SimpleNamespace(returncode=0, stdout=io.StringIO(), stderr=io.StringIO(),
                                  communicate=communicate)
        with (patch.object(server, "prepare_launch", side_effect=prepare),
              patch.object(server.subprocess, "Popen", return_value=process) as popen,
              patch.object(server, "kill_group", side_effect=lambda _process: check_locked()) as kill,
              patch.object(server, "launched", return_value=True)):
            server.smoke_test({"state_root": str(root), "require_mount": False})
        assert popen.call_args.kwargs["start_new_session"] is True
        kill.assert_called_once_with(process)
        assert workspaces and not workspaces[0].exists()
        with server.admission_lock(root):
            assert list(root.iterdir()) == [root / "admission.lock"]


def test_smoke_timeout_kills_tree_before_workspace_cleanup_and_unlock():
    import os
    import select
    import signal
    import subprocess
    import sys
    import time
    popen = subprocess.Popen
    kill_group = server.kill_group
    descriptors = []
    workspaces = []
    group = None
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        transport = """
import json,os,subprocess,sys
child=subprocess.Popen([sys.executable,'-I','-c','import time; time.sleep(100)'])
print(json.dumps([os.getppid(),os.getpid(),child.pid]),flush=True)
child.wait()
"""
        def prepare(_request, workspace, _config):
            workspaces.append(workspace.parent)
            launch = workspace.parent / "launch"
            launch.write_text(json.dumps({"parent_pid": os.getpid(),
                                          "transport": [sys.executable, "-I", "-c", transport]}))
            return [sys.executable, "-I", str(PATH), "--network-supervisor", str(launch)], launch
        class SmokeProcess(popen):
            def communicate(self, *, timeout):
                nonlocal group
                assert timeout == 15
                assert select.select([self.stdout], [], [], 5)[0], "transport did not start"
                pids = json.loads(self.stdout.readline())
                group = pids[0]
                descriptors.extend(os.pidfd_open(pid) for pid in pids)
                return super().communicate(timeout=.1)
        def kill_before_cleanup(process):
            assert workspaces[0].exists(), "workspace removed before killing smoke"
            with pytest.raises(server.Refused, match="host busy"):
                with server.admission_lock(root):
                    pytest.fail("smoke released admission before killing its group")
            kill_group(process)
        try:
            with (patch.object(server, "prepare_launch", side_effect=prepare),
                  patch.object(server.subprocess, "Popen", SmokeProcess),
                  patch.object(server, "kill_group", side_effect=kill_before_cleanup)):
                with pytest.raises(subprocess.TimeoutExpired):
                    server.smoke_test({"state_root": str(root), "require_mount": False})
            pending = set(descriptors)
            assert pending
            deadline = time.monotonic() + 5
            while pending:
                ready, _, _ = select.select(list(pending), [], [], max(0, deadline - time.monotonic()))
                assert ready, "timed-out smoke left a live process"
                pending.difference_update(ready)
            assert not workspaces[0].exists()
            with server.admission_lock(root):
                assert list(root.iterdir()) == [root / "admission.lock"]
        finally:
            if group:
                try:
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for descriptor in descriptors:
                os.close(descriptor)


def test_connected_subnets_excludes_link_scope_so_ipv6_gateway_is_usable():
    rows = [
        {"ifname": "eno1", "addr_info": [{"local": "192.168.90.212", "prefixlen": 24, "scope": "global"}]},
        {"ifname": "docker0", "addr_info": [
            {"local": "172.17.0.1", "prefixlen": 16, "scope": "global"},
            {"local": "fe80::123", "prefixlen": 64, "scope": "link"},
            {"local": "169.254.1.1", "prefixlen": 16, "scope": "link"}]},
        {"ifname": "nebula1", "addr_info": [{"local": "fd42::6", "prefixlen": 64, "scope": "global"}]},
    ]
    networks = server.connected_subnets(rows, [{"dev": "eno1"}])
    assert set(networks) == {"172.17.0.0/16", "fd42::/64"}
    import ipaddress
    gateway = ipaddress.ip_address("fe80::1")
    assert not any(gateway in ipaddress.ip_network(network) for network in networks)
    rules = server.network_rules(["fe80::123"], networks)
    assert "fe80::123/128" in rules  # the host's own address is still blocked
    assert "fe80::/64" not in rules


def test_two_slots_run_independently_third_refused_and_smoke_defers(tmp_path):
    # Exercise real interprocess flock ownership, not a mocked lock.
    import os
    import select
    import subprocess
    import sys
    assert tmp_path.is_relative_to(Path(tempfile.gettempdir()))
    driver = """
import importlib.machinery,importlib.util,json,os,sys
from pathlib import Path
loader=importlib.machinery.SourceFileLoader("slots",sys.argv[1])
spec=importlib.util.spec_from_loader(loader.name,loader)
server=importlib.util.module_from_spec(spec);loader.exec_module(server)
with server.admission_lock(Path(sys.argv[2]),2) as root:
    server.cleanup(root)
    workspace=root / sys.argv[3];workspace.mkdir()
    (workspace / "keep").write_text("running")
    print(str(workspace),flush=True)
    sys.stdin.readline()
    server.cleanup(root)
"""
    children = []
    workspaces = []
    try:
        for name in ("first", "second"):
            child = subprocess.Popen([sys.executable, "-I", "-c", driver, str(PATH), str(tmp_path), name],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            children.append(child)
            assert select.select([child.stdout], [], [], 5)[0], "slot did not start"
            workspaces.append(Path(child.stdout.readline().strip()))
        assert workspaces[0].parent != workspaces[1].parent
        assert all((p / "keep").read_text() == "running" for p in workspaces)
        with pytest.raises(server.Busy, match="all job slots"):
            with server.admission_lock(tmp_path, 2):
                pytest.fail("third job admitted")
        with patch.object(server, "prepare_launch") as prepare:
            with pytest.raises(server.Busy):
                server.smoke_test({"state_root": str(tmp_path), "require_mount": False, "slots": 2})
            prepare.assert_not_called()
        children[0].communicate("\n", timeout=5)
        assert not workspaces[0].exists()
        assert (workspaces[1] / "keep").read_text() == "running"
        # Free slot zero is acquired first, then released when slot one is busy.
        with pytest.raises(server.Busy):
            with server.admission_lock(tmp_path, 2, all_slots=True):
                pytest.fail("smoke admitted with slot one busy")
        with server.admission_lock(tmp_path, 2) as available:
            assert available == workspaces[0].parent
        children[1].communicate("\n", timeout=5)
        with server.admission_lock(tmp_path, 2, all_slots=True):
            with pytest.raises(server.Busy):
                with server.admission_lock(tmp_path, 2):
                    pytest.fail("maintenance failed to exclude jobs")
        assert all(not p.exists() for p in workspaces)
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)


@pytest.mark.parametrize("slots", [0, -1, 65, "2", True])
def test_slot_count_rejects_invalid_configuration(slots):
    with pytest.raises(ValueError, match="slots"):
        server.slot_count({"slots": slots})


