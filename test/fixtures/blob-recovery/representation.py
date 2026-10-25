"""INERT packet-local representation adapter for stopped-pair protocol @4.
No CLI, provisioning, credentials, lifecycle, start, chmod/chown or restore orchestration.
A future exact packet must bind its inputs and call these seams from the existing helpers.
"""
import copy
import hashlib
import json
import stat
from pathlib import Path


def need(value, reason):
    if not value:
        raise ValueError(reason)


def verified_pair(pair, root, limits, source_storage, source_sha, expected_pair_sha):
    limits = pair.checked_limits(limits)
    root = pair.checked_path(str(root))
    # The protected caller fixes the pair hash and limits BEFORE interpreting rows.
    cap = pair.manifest_limit(limits, True)
    with (root / "pair.json").open("rb") as stream:
        raw = stream.read(cap + 1)
    need(len(raw) <= cap, "manifest bound")
    need(hashlib.sha256(raw).hexdigest() == expected_pair_sha, "fixed pair bytes")
    version = json.loads(raw).get("version")
    need(type(version) is int and version in (2, 3), "pair version")
    if version == 2:
        digest = pair.verify(root, limits)  # Unchanged legacy dispatch.
        profile = None
    else:
        profile = pair.managed_profile(source_storage.decode(), source_sha)
        digest = pair.verify_managed(root, limits, profile)
    need(digest == expected_pair_sha, "fixed pair hash")
    return {"version": version, "pairSHA256": digest, "profile": profile,
            "trees": json.loads(raw)["trees"]}


def derived_configuration(pair, preflight, source_raw, restored_raw, source_sha,
                          restored_sha, metadata_path, data_path):
    """Only explicit fresh paths and all-null derived qualifications may differ.
    This is a scoped future restore check, never normal production qualification."""
    need(hashlib.sha256(source_raw).hexdigest() == source_sha
         and hashlib.sha256(restored_raw).hexdigest() == restored_sha, "frozen storage hashes")
    source, restored = json.loads(source_raw), json.loads(restored_raw)
    source_profile = pair.managed_profile(source_raw.decode(), source_sha)
    restored_profile = pair.managed_profile(restored_raw.decode(), restored_sha)
    need(source_profile["effectiveProfileSHA256"] == restored_profile["effectiveProfileSHA256"],
         "effective profile changed")
    need(source.get("uid") == source.get("gid") == 1000
         and source_profile["owner"] == [977, 988], "fixed process and actual mapped DATA owner")
    meta = preflight.canonical(metadata_path, "fresh metadata")
    data = preflight.canonical(data_path, "fresh DATA")
    need(meta != source["metadata"]["path"] and data != source["data"]["path"], "exclusive new destinations")
    paths = [meta, data, source["metadata"]["path"], source["data"]["path"]]
    need(all(a != b and not preflight.below(a, b) and not preflight.below(b, a)
             for i, a in enumerate(paths) for b in paths[i+1:]), "disjoint fresh paths")
    expected = copy.deepcopy(source)
    expected["metadata"]["path"], expected["data"]["path"] = meta, data
    expected["qualifications"] = {"configuration": preflight.digest(expected),
                                **{gate: None for gate in preflight.DURABILITY_GATES}}
    need(restored == expected, "unexpected restored configuration difference")
    for label in ("data", "metadata"):
        preflight.expected_store(restored, label)  # Shape/mount contract, no gate invention.
    return {"sourceStorageSHA256": source_sha, "restoredStorageSHA256": restored_sha,
            "sourceConfiguration": preflight.digest(source),
            "restoredConfiguration": preflight.digest(restored),
            "sourceEffectiveProfileSHA256": source_profile["effectiveProfileSHA256"],
            "restoredEffectiveProfileSHA256": restored_profile["effectiveProfileSHA256"],
            "differences": {"metadata.path": [source["metadata"]["path"], meta],
                            "data.path": [source["data"]["path"], data],
                            "qualifications": "all-null scoped restore; not normal production gates"}}


def restored_tree(pair, admitted, label, destination, limits, deadline, read_limit):
    """After existing UID1000 exclusive creation, check fresh owner/mode/content.
    The packet must request 0700/0600 creation. Actual NAS modes may be 0770/0660.
    Historical pair source inode/ctime are never compared to new destination IDs."""
    need(admitted["version"] == 3 and label in ("meta", "data"), "managed restore dispatch")
    limits = pair.checked_limits(limits)
    owner = (1000, 1000) if label == "meta" else (977, 988)
    destination = pair.checked_path(str(destination))
    rows = pair.inventory(destination, owner, deadline, pair.copy_limits(limits[label]),
                          managed=label == "data", private=label == "meta")
    normalized = pair.tree(destination, rows, None, deadline, read_limit, normalize=True)
    need(normalized == admitted["trees"][label], "restored content/mode mismatch")
    final = pair.inventory(destination, owner, deadline, pair.copy_limits(limits[label]),
                           managed=label == "data", private=label == "meta")
    need([(str(p), pair.stamp(s)) for p, s in final] == [(str(p), pair.stamp(s)) for p, s in rows],
         "restored epoch changed")
    return {"pairSHA256": admitted["pairSHA256"], "label": label, "owner": list(owner),
            "effectiveProfileSHA256": admitted["profile"]["effectiveProfileSHA256"],
            "observations": [{"path": str(p.relative_to(destination)),
                              "requestedMode": 0o700 if stat.S_ISDIR(s.st_mode) else 0o600,
                              "observedMode": stat.S_IMODE(s.st_mode), "stamp": list(pair.stamp(s))}
                             for p, s in rows]}
