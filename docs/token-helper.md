# Token helper for host service producers

Implements architecture audit R7, jocasta:54e226f1232b50b25fb47b8d630f46bf@1.
The shared invocation is:

```sh
chaldea-token-helper --audience akasha --action append --source quota --host agent-a --kind quota_parked
```

Exactly five string flags are required, once each. Only audience akasha and actions
append/read are supported. Success writes one compact Ed25519 JWS plus newline;
failure writes no bearer and a generic denial to stderr. The lifetime is at most
780 seconds and may shorten at key retirement. No caller can set profile, project,
run ID, lifetime, key, trust, or state paths.

The root-owned launcher calls sudo noninteractively as chaldea-issuer. sudo must set
SUDO_UID and deny SETENV. The root-owned issuer wrapper drops every inherited
environment variable except sudo's caller UID and a fixed PATH before starting the
pinned Node executable. The command requires the effective UID from protected
config. Running the Node
command directly as a producer fails before opening state or a key. Do not grant
producers a shell, Node, env, arbitrary chaldea commands, or direct issuer login.

The root-owned /etc/chaldea/token-helper.json contains this shape. Producer UID
1000 is illustrative, not a deployment grant.

```json
{
  "issuer": {"uid": 995, "key_file": "/var/lib/chaldea-issuer/keys/agent-a-2026-10.pem",
             "name": "chaldea:agent-a", "kid": "agent-a-2026-10"},
  "state_file": "/var/lib/chaldea-issuer/access/state.sqlite",
  "bundle_file": "/var/lib/chaldea-access-trust-public/bundle.jws",
  "anchor_file": "/etc/chaldea-access-trust/anchors.json",
  "clock_health_file": "/run/chaldea-access-trust/clock-health.json",
  "grants": [
    {"uid": 1000, "audience": "akasha", "action": "append", "source": "quota",
     "host": "agent-a", "kind": "quota_parked", "profile": "quota-service", "project": "chaldea"}
  ]
}
```

All issuer fields are required. The example records the original agent-a defaults;
other hosts must supply their own UID, absolute key path, issuer name and kid.
These values come only from the root-owned config, never arguments or environment.

Each request must match exactly one entry on UID and all five flags. Profile and
project come from that entry; resource is exactly source, with only the requested
action. Host must also match the issuer. This is a service producer admission
boundary, not scheduled run admission. Each invocation gets a new run ID and jti.
Scheduled/model processes must continue through RunLeases and must not receive
these sudo grants. Removal of a local grant stops subsequent minting immediately.

Kind is a selector for admission, not a JWT claim. The existing Akasha source
registration remains responsible for allowed payload kinds, roots, read mode and
global read. Configure that registration consistently; a bearer can append any
kind allowed to its source by the verifier. Use separate sources when kinds need
separate authority.

HostIssuer also checks the signed trust bundle's issuer ceiling and current clock
health. The helper installs/authenticates the updater's current envelope on every
invocation, retaining durable rollback and key-removal history. It never creates
missing state or keys. The updater remains responsible for fetching and authenticating
trust bundles signed by Normandy's deployment-2026-10b anchor. This change does not
alter the existing trust freshness policy.

The legacy packaging/token-helper/issuer-command is an uninstalled example for
older manual layouts. The fleet role renders the fixed issuer wrapper described
below; do not install the legacy example as a sudoers target.

## Deployment prerequisites, not performed by this change

- Install an independently checksum-verified client release and pinned Node under
  a root-owned directory. Install its bin/chaldea-token-helper at /usr/local/bin
  and a fixed issuer wrapper at /usr/local/libexec/chaldea-token-helper-issuer. Every ancestor of these files,
  /etc/chaldea and the config must be root-owned and not producer-writable.
- Retain chaldea-issuer uid 995 with no login. Its existing private key stays at
  /var/lib/chaldea-issuer/keys/agent-a-2026-10.pem, issuer-owned 0600 in a 0700
  directory. Never put key bytes in configuration, arguments or producer homes.
- Initialize the private access-state directory/database once as the issuer UID
  using access initialize-state. Missing state is an operator recovery condition.
- Install/enable the existing trust updater and clock-health units, with readable
  public bundle, anchor and health files at the configured paths. Grant only public
  read access to the issuer. No new persistent issuer daemon or socket is needed.
- Add explicit producer UID entries and matching signed issuer ceilings plus Akasha
  source registrations. For each approved UID, sudoers may allow only
  `/usr/local/libexec/chaldea-token-helper-issuer` with each grant's exact five flag pairs as chaldea-issuer,
  NOPASSWD and NOSETENV, with env_reset and a fixed secure_path. Validate with visudo.
  The wrapper clears the environment and invokes the verified release's bin/chaldea
  through the root-pinned Node. It interprets no shell text; the app rejects unknown flags.
- Set AKASHA_TOKEN_HELPER for publisher services, FEED_TOKEN_HELPER for feed and
  toolfeedback. FEED_TOKEN_SOURCE and FEED_TOKEN_HOST name their configured identity;
  read filters never broaden it. Feed posts use explicit --source/--host when given.
  Feed uses kind feed_post; toolfeedback reads use tool_call. Helpers target Akasha,
  including its legacy feed compatibility endpoint, not the old shared-key feedd.
- Approve service restarts, service-side trust/registry changes, canary publication,
  and eventual feed-key retirement separately. Cross-host activation is not authorized
  by this source change. No production host was modified.
