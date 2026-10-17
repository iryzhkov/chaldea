# Configuration and process conventions

Chaldea's TypeScript daemons and clients use JSON objects with camelCase keys.
The loaders and common file, path, log and exit conventions live in `src/config/`.
Existing explicit CLI paths and flags still work and take precedence over file values.
Defaults work without XDG variables; setting them intentionally relocates the corresponding files.

| Component | Default config | Required |
|---|---|---|
| Waits service, waits/decision CLI, MCP | `$XDG_CONFIG_HOME/chaldea/waits.json` | Yes |
| Quota observer and status | `$XDG_CONFIG_HOME/chaldea/quota.json` | No |
| Exec client, including show/list/fetch | `$XDG_CONFIG_HOME/chaldea/exec.json` | No |
| Akasha gateway | `$XDG_CONFIG_HOME/chaldea/akasha.json` | Yes |
| Collector and in-process event publishers | `$XDG_CONFIG_HOME/chaldea/events.json` | No |
| T3 restart/recovery support | `$XDG_CONFIG_HOME/chaldea/restart.json` | No |

An absent optional file selects the old defaults. An explicitly selected missing file,
invalid JSON, or an unsafe file fails closed. Unknown config keys are rejected except
in the pre-existing waits/restart schemas. Akasha keeps its strict JSON parser,
including duplicate-key rejection. Config readers never include file contents in errors.

The sudo token helper is a system security boundary, with a fixed root-owned
`/etc/chaldea/token-helper.json`. It deliberately ignores user XDG settings and
retains its provisioned key names. Host programs in `host/` retain their system
configuration contracts. Neither is a user daemon.

## Paths and files

`paths()` honours absolute, nonempty `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`XDG_DATA_HOME` and `XDG_RUNTIME_DIR`. Relative/empty values use these defaults:

| Base | Default |
|---|---|
| Config | `~/.config/chaldea` |
| State | `~/.local/state/chaldea` |
| Data | `~/.local/share` |
| Runtime | `~/.cache` |

The data base is not suffixed with chaldea because the collector reads the existing
`toolfeedback` spool there. T3's `~/.t3` and SSH's `~/.ssh` remain their own conventions.
Explicit paths are literal; JSON strings do not expand `~` or environment variables.

One descriptor-based reader handles configs and credentials. It opens with
`O_NOFOLLOW | O_NONBLOCK`, refuses nonregular files and multiple hard links, checks
ownership/mode/size on the open descriptor, and bounds the actual read. It refuses
symlinks at the final path component; parent directories must be trusted.
Config and public trust inputs permit root/current effective UID ownership and no
group/world write bits. Secrets refuse all group/world permission bits and normally
require current effective UID ownership. Akasha/access public adapters retain their
root-owner allowance for operator-provisioned secrets. The signing key and token
helper keep their stricter existing owner/directory requirements.

Keep tokens in separate files, mode 0600 or stricter. The shared text credential
reader trims whitespace, refuses empty input, and caps input at 16 KiB.
Config JSON is capped at 256 KiB; service-specific trust/key limits remain in force.

## Config keys and compatibility

Waits keys remain unchanged: `environment`, `t3BaseDir`, `serverUrl`, `tokenFile`,
`database`, `socket`, `listenAddress`, `port`, `answerBaseUrl`, `answerTokenFile`,
`logFile`. Its config/tokens, database/log and socket defaults now use the XDG bases.

Quota's existing `contexts`, nested `assertRuntimeHome`, and
`lowHeadroomPercent` remain unchanged. The same file can also supply
`serverUrl`, `t3BaseDir`, `tokenFile`, `stateFile`, `feedCommand`, `host`,
`enableProviderSwitch`, `switchConfig` and `restartConfig`. Existing flags override
these values. Switch/restart paths name their existing JSON support files.

Exec example:

```json
{
  "hosts": ["agent-a", "agent-b"],
  "sshConfig": "/home/example/.ssh/chaldea-job.conf",
  "stateDir": "/home/example/.local/state/chaldea/exec"
}
```

If `hosts` is absent, exec still reads the fleet-managed newline file
`chaldea/exec-hosts`; `hostsFile` can select another. Existing `CHALDEA_SSH_CONFIG`,
`CHALDEA_STATE_DIR` and `CHALDEA_EXEC_HOSTS` keep overriding file/default values,
with a deprecation warning naming the replacement key. `CHALDEA_EXEC_HOSTS` also
takes precedence over a JSON `hosts` array.

Events keys are `url`, `tokenHelper`, `stateFile`, `spool`, `timerSpool`.
The corresponding old environment variables `AKASHA_URL`, `AKASHA_TOKEN_HELPER`,
`AKASHA_STATE_FILE`, `AKASHA_SPOOL`, `AKASHA_TIMER_SPOOL` still override JSON,
with deprecation warnings. Configured event publication, even incomplete, keeps
the scoped path selected; delivery failure never selects legacy feed credentials.

Akasha uses `database`, `accessState`, `anchors`, `bundleFile`, `clockHealthFile`,
`registry`, `natsUrl`, `natsSeedFile`, `bind`, `port`. The old spellings
`access_state`, `bundle_file`, `clock_health_file`, `nats_url`, `nats_seed_file`
still work with a deprecation warning. If both forms occur, camelCase wins.
Wire/event schemas and trust bundles keep their protocol field names.

## Logs

All daemon diagnostic records use the same logger: one JSON object per line with
`at` as an ISO 8601 UTC timestamp, `level` as info/warn/error, and `message`.
Callers cannot override these fields. Never supply credentials, transcript contents
or raw provider output as fields. Compatibility warnings contain key names only.

The stderr logger retains the quota logger's 120 info/warn records per minute and
suppression summary. Errors remain uncapped. Waits still writes its private log
file with the existing 10 MiB/14-day limits, now through this logger; `event`
remains available alongside `message`. Age rotation reads both old numeric and
new ISO timestamps. CLI result JSON, remote stdout/stderr, exec retained output
logs and collector counter output remain data streams with their existing formats.

## Exit codes

This is the process exit-code table; shared constants are `src/config/exit.ts`.
Existing domain result statuses remain unchanged.

| Code | Meaning |
|---|---|
| 0 | Success or clean signal-driven shutdown |
| 1 | Runtime, authorization, storage or domain-operation failure; Akasha parity mismatch/alarm |
| 64 | CLI usage/argument error |
| 69 | Service unavailable; exec automatic hosts exhausted or queue timeout |
| 78 | Invalid/unreadable config or credential input; unsupported T3 protocol |
| 255 | Exec local/transport failure before a confirmed remote command status |
| Remote status | Exec returns the remote program's status unchanged, even if it matches a row above |

Configuration-read failures in waits, Akasha and exec now use 78 rather than
waits' generic 64, Akasha's 1 or exec's 255. Quota already used 78.
Akasha's command-count usage error uses 64. Service-specific authorization,
replay and storage errors still use 1. Exec argument errors retain 255.
Human help and command results are unchanged; diagnostic formatting and these
exit statuses are the intentional operational behavior changes.

## Fleet-config follow-up

The `chaldea_client` role already installs the units, from fleet PR #37.
This change edits no units and performs no deployment. Existing rendered
`waits.json` and `quota.json`, including `assertRuntimeHome` and
`lowHeadroomPercent`, work without a fleet change.

Future fleet cleanup can render `exec.json` instead of `exec-hosts` and render
`events.json` instead of the AKASHA environment settings. Migrate Akasha's
operator config to camelCase when convenient. Move quota's unit flags into
`quota.json` only if desired; flags remain supported. No release or fleet
pin update is included here.
