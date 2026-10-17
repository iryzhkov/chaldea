"""Render frozen deployment SSH templates with disposable fixture paths."""
import json
from pathlib import Path
import sys
from jinja2 import Environment, StrictUndefined

scratch, values = Path(sys.argv[1]), json.loads(sys.argv[2])
fixtures = Path(__file__).resolve().parents[2] / "host/tests/fixtures"
env = Environment(undefined=StrictUndefined)
for source, name in (("chaldea-job-sshd.conf.j2", "sshd.conf"), ("authorized_keys.j2", "authorized_keys")):
    rendered = env.from_string((fixtures / source).read_text()).render(values)
    if name == "sshd.conf":
        # The runner's disposable scratch has ancestors owned by its runner user.
        rendered = rendered.replace("StrictModes yes", "StrictModes no")
    (scratch / name).write_text(rendered)
