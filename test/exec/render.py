"""Render the shipped role templates; override only fixture paths/user/port/logging."""
import json
from pathlib import Path
import sys
from jinja2 import Environment, StrictUndefined
role, scratch, values = Path(sys.argv[1]), Path(sys.argv[2]), json.loads(sys.argv[3])
env = Environment(undefined=StrictUndefined, keep_trailing_newline=True)
for source, destination in [("chaldea-job-sshd.conf.j2", "sshd.conf"), ("authorized_keys.j2", "authorized_keys")]:
    template = env.from_string((role / "templates" / source).read_text())
    (scratch / destination).write_text(template.render(**values))
