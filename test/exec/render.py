"""Write a disposable, unprivileged SSH fixture for the in-tree job server."""
import json
from pathlib import Path
import sys

scratch, values = Path(sys.argv[1]), json.loads(sys.argv[2])
v = {key.removeprefix("chaldea_job_host_"): value for key, value in values.items()}
(scratch / "sshd.conf").write_text(f"""
Port {v["port"]}
ListenAddress 127.0.0.1
HostKey {v["host_key"]}
PidFile {v["pid_file"]}
AuthorizedKeysFile {v["authorized_keys"]}
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitRootLogin no
AllowUsers {v["user"]}
DisableForwarding yes
MaxSessions 1
PermitTTY no
PermitUserRC no
PermitUserEnvironment no
X11Forwarding no
LogLevel {v["log_level"]}
ForceCommand {v["command"]}
""")
(scratch / "authorized_keys").write_text("".join(
    f'restrict,from="{source["ip"]}" {source["public_key"]}\n'
    for source in v["sources"]
))
