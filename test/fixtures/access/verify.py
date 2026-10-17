#!/usr/bin/env python3
"""Test-only access-v1 verifier. Requires cryptography; no private fixture keys.
Run with v1.json (default) or another frozen fixture file. Never uses local wall time.
State survives simulated restarts via a JSON round-trip, matching a durable adapter.
"""
import base64
import copy
import json
import math
import re
import sys
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

TRUST_FRESH_SECONDS = 24 * 60 * 60

AUD = {"homelab", "feed", "akasha", "jocasta", "ov", "huyang", "github-broker"}


def need(ok):
    if not ok:
        raise ValueError("access denied")


def fields(obj, required, optional=()):
    need(isinstance(obj, dict) and set(required) <= obj.keys()
         and obj.keys() <= set(required) | set(optional))


def ident(v):
    need(isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", v))


def sec(v):
    need(type(v) is int and 0 <= v <= 9007199254740991)


def issuer(v):
    need(isinstance(v, str) and re.fullmatch(r"chaldea:[a-z0-9][a-z0-9.-]{0,126}", v))


def resource(v):
    need(isinstance(v, str) and re.fullmatch(r"[\x21-\x7e]{1,512}", v)
         and "*" not in v and "\\" not in v)


def grants(gs):
    need(isinstance(gs, list) and 1 <= len(gs) <= 32)
    seen = set()
    for g in gs:
        fields(g, ("resource", "actions"))
        resource(g["resource"])
        need(g["resource"] not in seen)
        seen.add(g["resource"])
        actions = g["actions"]
        need(isinstance(actions, list) and 1 <= len(actions) <= 16)
        for a in actions:
            ident(a)
        need(len(actions) == len(set(actions)))


def subset(gs, ceiling):
    return all(any(g["resource"] == c["resource"] and a in c["actions"]
                   for c in ceiling) for g in gs for a in g["actions"])


def decode(s):
    need(isinstance(s, str) and re.fullmatch(r"[A-Za-z0-9_-]+", s))
    b = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    need(base64.urlsafe_b64encode(b).decode().rstrip("=") == s)
    return b


def unique(pairs):
    result = {}
    for k, v in pairs:
        need(k not in result)
        result[k] = v
    return result


def strict_json(b):
    def integer_literal(s):
        need(re.fullmatch(r"(?:0|[1-9][0-9]*)", s))
        return int(s)
    v = json.loads(b.decode("utf-8"), object_pairs_hook=unique,
                   parse_int=integer_literal, parse_float=lambda _: need(False),
                   parse_constant=lambda _: need(False))

    def depth(v, d=0):
        need(d <= 16)
        if isinstance(v, dict):
            for x in v.values():
                depth(x, d + 1)
        elif isinstance(v, list):
            for x in v:
                depth(x, d + 1)
    depth(v)
    return v


def parts(token, limit=16384):
    need(isinstance(token, str) and len(token) <= limit)
    p = token.split(".")
    need(len(p) == 3)
    h, payload, sig = (decode(x) for x in p)
    need(len(sig) == 64)
    return strict_json(h), strict_json(payload), sig, (p[0] + "." + p[1]).encode()


def public(k):
    fields(k, ("kty", "crv", "x"))
    need(k["kty"] == "OKP" and k["crv"] == "Ed25519" and len(decode(k["x"])) == 32)


def signature(k, sig, message):
    public(k)
    Ed25519PublicKey.from_public_bytes(decode(k["x"])).verify(sig, message)


class Verifier:
    def __init__(self, anchors, sample, state=None):
        self.anchors, self.sample = anchors, sample
        self.state = state or {"clock": None, "trust": None, "history": {}}

    def clock(self):
        s = self.sample
        sec(s["unixSeconds"])
        need(s["healthy"] is True and type(s["offsetSeconds"]) in (int, float)
             and math.isfinite(s["offsetSeconds"]) and abs(s["offsetSeconds"]) <= 30
             and type(s["monotonicSeconds"]) in (int, float)
             and math.isfinite(s["monotonicSeconds"]) and s["monotonicSeconds"] >= 0
             and isinstance(s["bootId"], str) and len(s["bootId"]) > 0)
        p = self.state["clock"]
        wall_anchor, mono_anchor = s["unixSeconds"], s["monotonicSeconds"]
        if p:
            need(s["unixSeconds"] >= p["unixSeconds"])
            if s["bootId"] == p["bootId"]:
                wall_anchor, mono_anchor = p["wall_anchor"], p["mono_anchor"]
                need(s["monotonicSeconds"] >= p["monotonicSeconds"]
                     and s["unixSeconds"] - wall_anchor + 30
                     >= s["monotonicSeconds"] - mono_anchor)
        self.state["clock"] = dict(s, wall_anchor=wall_anchor, mono_anchor=mono_anchor)
        return s["unixSeconds"]

    def bundle(self, envelope):
        h, b, sig, message = parts(envelope, 262144)
        fields(h, ("alg", "typ", "kid"))
        need(h["alg"] == "EdDSA" and h["typ"] == "chaldea-trust+jws")
        a = next(a for a in self.anchors if a["kid"] == h["kid"])
        signature(a["public_key"], sig, message)
        fields(b, ("v", "sequence", "published_at", "expires_at", "keys"))
        need(type(b["v"]) is int and b["v"] == 1)
        for name in ("sequence", "published_at", "expires_at"):
            sec(b[name])
        need(b["sequence"] > 0 and 0 < b["expires_at"] - b["published_at"] <= TRUST_FRESH_SECONDS
             and isinstance(b["keys"], list) and len(b["keys"]) <= 128)
        ids = set()
        for k in b["keys"]:
            fields(k, ("issuer", "kid", "public_key", "not_before", "issue_until", "verify_until", "ceilings"))
            issuer(k["issuer"])
            ident(k["kid"])
            public(k["public_key"])
            kid = (k["issuer"], k["kid"])
            need(kid not in ids)
            ids.add(kid)
            need(all(k["public_key"]["x"] != a["public_key"]["x"] for a in self.anchors))
            for name in ("not_before", "issue_until", "verify_until"):
                sec(k[name])
            need(k["not_before"] < k["issue_until"] <= k["verify_until"]
                 and k["verify_until"] - k["issue_until"] <= 810
                 and isinstance(k["ceilings"], list) and 1 <= len(k["ceilings"]) <= 64)
            for c in k["ceilings"]:
                fields(c, ("audience", "profile", "project", "grants"), ("source",))
                need(isinstance(c["audience"], str) and c["audience"] in AUD)
                ident(c["profile"])
                ident(c["project"])
                grants(c["grants"])
                if c["audience"] in ("feed", "akasha"):
                    ident(c.get("source"))
                else:
                    need("source" not in c)
        now = self.clock()
        need(b["published_at"] <= now + 30 and now < b["expires_at"])
        return b

    def install(self, envelope):
        b = self.bundle(envelope)
        old = self.state["trust"]
        if old:
            need(b["sequence"] > old["bundle"]["sequence"]
                 or (b["sequence"] == old["bundle"]["sequence"] and envelope == old["envelope"]))
            if envelope == old["envelope"]:
                return
        history = copy.deepcopy(self.state["history"])
        active = {k["issuer"] + "/" + k["kid"] for k in b["keys"]}
        for kid, record in history.items():
            if kid not in active:
                record["removed"] = True
        for k in b["keys"]:
            kid = k["issuer"] + "/" + k["kid"]
            p = history.get(kid)
            need(all(other_id == kid or other["x"] != k["public_key"]["x"]
                     for other_id, other in history.items()))
            need(not p or (not p["removed"] and p["x"] == k["public_key"]["x"]
                           and p["not_before"] == k["not_before"]
                           and k["issue_until"] <= p["issue_until"]
                           and k["verify_until"] <= p["verify_until"]))
            history[kid] = {name: k[name] for name in ("not_before", "issue_until", "verify_until")}
            history[kid].update(x=k["public_key"]["x"], removed=False)
        need(len(history) <= 4096)
        self.state.update(trust={"bundle": b, "envelope": envelope}, history=history)

    def verify(self, token, op, skew=30):
        need(type(skew) is int and 0 <= skew <= 30)
        need(op["audience"] in AUD)
        resource(op["resource"])
        ident(op["action"])
        h, c, sig, message = parts(token)
        fields(h, ("alg", "typ", "kid"))
        need(h["alg"] == "EdDSA" and h["typ"] == "chaldea-run+jwt")
        ident(h["kid"])
        fields(c, ("v", "iss", "sub", "aud", "run_id", "project", "iat", "nbf", "exp", "jti", "grants"), ("host", "source"))
        need(type(c["v"]) is int and c["v"] == 1)
        issuer(c["iss"])
        for name in ("sub", "run_id", "project"):
            ident(c[name])
        need(isinstance(c["aud"], str) and c["aud"] in AUD and c["aud"] == op["audience"])
        for name in ("iat", "nbf", "exp"):
            sec(c[name])
        need(c["iat"] <= c["nbf"] < c["exp"] and c["exp"] - c["iat"] <= 780)
        need(isinstance(c["jti"], str) and re.fullmatch(r"[A-Za-z0-9_-]{22,64}", c["jti"]))
        grants(c["grants"])
        if c["aud"] in ("feed", "akasha"):
            ident(c.get("source"))
            ident(c.get("host"))
            need(c["host"] == c["iss"][8:])
        else:
            need("host" not in c and "source" not in c)
        b = self.bundle(self.state["trust"]["envelope"])
        k = next(k for k in b["keys"] if k["issuer"] == c["iss"] and k["kid"] == h["kid"])
        signature(k["public_key"], sig, message)
        now = self.clock()
        need(c["iat"] <= now + skew and c["nbf"] <= now + skew and now < c["exp"] + skew)
        need(k["not_before"] <= c["iat"] < k["issue_until"]
             and c["exp"] + 30 <= k["verify_until"] and now < k["verify_until"])
        need(any(x["audience"] == c["aud"] and x["profile"] == c["sub"]
                 and x["project"] == c["project"] and x.get("source") == c.get("source")
                 and subset(c["grants"], x["grants"]) for x in k["ceilings"]))
        need(any(g["resource"] == op["resource"] and op["action"] in g["actions"] for g in c["grants"]))
        return c


def run(path):
    f = json.loads(Path(path).read_text())
    count = 0
    def check(name, accepted, action):
        nonlocal count
        try:
            action()
            actual = True
        except (ValueError, KeyError, TypeError, StopIteration, UnicodeError, OverflowError, RecursionError):
            actual = False
        except Exception as e:
            # cryptography InvalidSignature is intentionally an independent failure.
            from cryptography.exceptions import InvalidSignature
            if not isinstance(e, InvalidSignature):
                raise
            actual = False
        need(actual == accepted or print("FAILED: " + name, file=sys.stderr))
        count += 1
    for c in f["cases"]:
        v = Verifier(f["anchors"], c.get("clock", f["clock"]))
        def action():
            v.install(c.get("bundle", f["bundle"]))
            v.verify(c["token"], c.get("operation", f["operation"]), c.get("skew", 30))
        check(c["name"], c["accept"], action)
    for scenario in f["scenarios"]:
        v = Verifier(f["anchors"], f["clock"])
        v.install(f["bundle"])
        for i, step in enumerate(scenario["steps"]):
            v.sample = step.get("clock", v.sample)
            if step.get("restart"):
                v = Verifier(f["anchors"], v.sample, json.loads(json.dumps(v.state)))
            def action():
                if "install" in step:
                    v.install(step["install"])
                if "token" in step:
                    v.verify(step["token"], f["operation"])
            check(scenario["name"] + "/" + str(i), step["accept"], action)
    return count


def main():
    paths = sys.argv[1:] or [Path(__file__).with_name(name) for name in ("v1.json", "v1-encoding.json", "v1-freshness.json")]
    total = sum(run(path) for path in paths)
    print("Python: " + str(total) + " frozen vector checks passed")


if __name__ == "__main__":
    main()
