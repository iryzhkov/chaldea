"""Bounded test-only manifest/retention contract, before production exec wiring."""
import datetime
import hashlib
import json
import re
import time
import urllib.parse
import xml.etree.ElementTree as ET

AGE = 14 * 86400


def listing(client, bucket, query, member):
    status, body = client.request("GET", bucket + "?" + query)
    if status != 200:
        raise ValueError("listing_failed")
    root = ET.fromstring(body)
    if root.findtext("{*}IsTruncated") == "true":
        raise ValueError("listing_bound")
    values = root.findall("{*}" + member)
    if len(values) > 32:
        raise ValueError("listing_bound")
    return values


def key_path(bucket, key):
    if not re.fullmatch(r"v1/[a-zA-Z0-9/_.-]{1,512}", key) or any(p in ("", ".", "..") for p in key.split("/")):
        raise ValueError("key_invalid")
    return bucket + "/" + key


def retrieve(client, bucket, job, now=None):
    now = time.time() if now is None else now
    prefix = "v1/" + job + "/manifests/"
    rows = listing(client, bucket, "list-type=2&max-keys=32&prefix=" + urllib.parse.quote(prefix, safe=""), "Contents")
    keys = [row.findtext("{*}Key") for row in rows]
    if len(keys) != 1:
        raise ValueError("manifest_missing" if not keys else "manifest_conflict")
    key = keys[0]
    suffix = key[len(prefix):]
    if not re.fullmatch(r"[0-9a-f]{64}\.json", suffix):
        raise ValueError("manifest_key")
    status, body = client.request("GET", key_path(bucket, key))
    if status != 200 or hashlib.sha256(body).hexdigest() != suffix[:-5]:
        raise ValueError("manifest_integrity")
    manifest = json.loads(body)
    if set(manifest) != {"version", "jobId", "principal", "createdAt", "expiresAt", "artifacts"} or (
        manifest["version"] != 1 or manifest["jobId"] != job or manifest["principal"] != "a"
    ):
        raise ValueError("manifest_binding")
    if not isinstance(manifest["createdAt"], int) or not isinstance(manifest["expiresAt"], int) or (
        manifest["createdAt"] > now + 300 or manifest["expiresAt"] > manifest["createdAt"] + AGE or
        manifest["expiresAt"] <= manifest["createdAt"] or now >= manifest["expiresAt"]
    ):
        raise ValueError("manifest_expired")
    artifacts = manifest["artifacts"]
    # The representative proof has one fixed named artifact, not caller paths.
    if len(artifacts) != 1 or set(artifacts[0]) != {"path", "sha256", "size"} or artifacts[0]["path"] != "report.txt":
        raise ValueError("artifact_binding")
    entry = artifacts[0]
    if not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) or not isinstance(entry["size"], int) or not 0 <= entry["size"] <= 64 * 1024 * 1024:
        raise ValueError("artifact_bounds")
    status, data = client.request("GET", bucket + "/v1/" + job + "/objects/" + entry["sha256"])
    if status != 200 or len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise ValueError("artifact_integrity")
    return data


def cleanup(client, bucket, now):
    """Protected max ages, independent of the writer-mutable lifecycle rule.
    All listings complete within their bound before any delete. No pagination
    or unknown success during outage; production needs a sized finite policy.
    """
    objects = listing(client, bucket, "list-type=2&max-keys=32", "Contents")
    uploads = listing(client, bucket, "uploads&max-uploads=32", "Upload")

    def old(row, field, age):
        stamp = row.findtext("{*}" + field)
        date = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if date.tzinfo is None:
            raise ValueError("missing_object_time")
        return date.timestamp() + age <= now

    expired = [key_path(bucket, row.findtext("{*}Key")) for row in objects if old(row, "LastModified", AGE)]
    abandoned = [(key_path(bucket, row.findtext("{*}Key")), row.findtext("{*}UploadId"))
                 for row in uploads if old(row, "Initiated", 86400)]
    for path, upload in abandoned:
        status, _ = client.request("DELETE", path + "?uploadId=" + urllib.parse.quote(upload, safe=""))
        if status not in (204, 404):
            raise ValueError("abort_failed")
    for path in expired:
        status, _ = client.request("DELETE", path)
        if status not in (204, 404):
            raise ValueError("delete_failed")
    return {"objects": len(expired), "uploads": len(abandoned)}
