"""Keep every Python test's user state in its own disposable scratch home."""
import os
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolated_home(tmp_path_factory, monkeypatch):
    from uuid import uuid4
    base = tmp_path_factory.getbasetemp()
    home = base / ("home-" + uuid4().hex)
    assert home.is_relative_to(base)
    assert home != Path(os.path.expanduser("~"))
    monkeypatch.setenv("HOME", str(home))
    assert Path.home() == home
    home.mkdir(exist_ok=True)
    for name, suffix in (("XDG_CONFIG_HOME", ".config"), ("XDG_CACHE_HOME", ".cache"),
                         ("XDG_STATE_HOME", ".local/state"), ("XDG_DATA_HOME", ".local/share")):
        monkeypatch.setenv(name, str(home / suffix))
