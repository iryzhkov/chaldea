"""Moved image allocation contract, including Btrfs NOCOW before formatting."""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import tempfile
from unittest.mock import patch
import pytest

def image_module():
    path = Path(__file__).resolve().parents[1] / "chaldea-job-image"
    loader = importlib.machinery.SourceFileLoader("job_image_nocow", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


@pytest.mark.parametrize("filesystem", ["btrfs", "ext4"])
def test_new_btrfs_image_sets_nocow_while_empty_before_formatting(filesystem):
    module = image_module()
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "job.ext4"
        calls = []
        def run(command, **_kwargs):
            calls.append(command)
            temporary = Path(command[-1])
            if command[0] == "chattr":
                assert temporary.stat().st_size == 0
                assert command[1] == "+C"
            else:
                assert command[0] == "mkfs.ext4"
                assert temporary.stat().st_size == 512 * 1024**2
                assert (len(calls) == 2) == (filesystem == "btrfs")
        with patch.object(module.subprocess, "check_output", return_value=filesystem + "\n"), \
             patch.object(module.subprocess, "run", side_effect=run):
            assert module.create(target, 512 * 1024**2, (os.getuid(), os.getgid()))
        assert any(call[0] == "chattr" for call in calls) == (filesystem == "btrfs")
        assert target.stat().st_size == 512 * 1024**2
        with patch.object(module.subprocess, "check_output") as probe:
            assert not module.create(target, 512 * 1024**2, (os.getuid(), os.getgid()))
            probe.assert_not_called()
