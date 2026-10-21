"""Extract only the verified Garage executable from the exact PR10 OCI image.
Disposable M2 preparation, not object-custody or deployment qualification.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import urllib.request

IMAGE = "sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020"
REGISTRY = "https://registry-1.docker.io/v2/dxflrs/garage/"
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def read(url, cap, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=60) as response:
        value = response.read(cap + 1)
        if len(value) > cap:
            raise ValueError("OCI response exceeds bound")
        return value


def verified(token, kind, identifier, cap):
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", identifier):
        raise ValueError("invalid digest")
    data = read(REGISTRY + kind + "/" + identifier, cap,
                {"Authorization": "Bearer " + token, "Accept": ACCEPT})
    if "sha256:" + hashlib.sha256(data).hexdigest() != identifier:
        raise ValueError("OCI digest mismatch")
    return data


def prepare_binary():
    home = Path(os.environ["HOME"])
    if not home.is_absolute() or home != Path.cwd() / ".blob-image" / "home":
        raise ValueError("asserted scratch HOME required")
    token = json.loads(read(
        "https://auth.docker.io/token?service=registry.docker.io&scope=repository:dxflrs/garage:pull",
        65536))["token"]
    raw = verified(token, "manifests", IMAGE, 2 * 1024 * 1024)
    selected = IMAGE
    manifest = json.loads(raw)
    if "manifests" in manifest:
        candidates = [m for m in manifest["manifests"]
                      if m.get("platform", {}).get("os") == "linux"
                      and m.get("platform", {}).get("architecture") == "amd64"]
        if len(candidates) != 1:
            raise ValueError("ambiguous linux/amd64 image")
        selected = candidates[0]["digest"]
        manifest = json.loads(verified(token, "manifests", selected, 2 * 1024 * 1024))
    config = json.loads(verified(token, "blobs", manifest["config"]["digest"], 2 * 1024 * 1024))
    if config["architecture"] != "amd64" or config["os"] != "linux" or len(manifest["layers"]) != 1:
        raise ValueError("expected one-layer scratch linux/amd64 image")
    layer = manifest["layers"][0]["digest"]
    data = verified(token, "blobs", layer, 128 * 1024 * 1024)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
        members = [m for m in archive.getmembers() if m.name.lstrip("./") == "garage"]
        if len(members) != 1 or not members[0].isfile() or not 0 < members[0].size <= 128 * 1024 * 1024:
            raise ValueError("expected one regular bounded garage binary")
        extracted = archive.extractfile(members[0])
        assert extracted is not None
        binary = extracted.read(128 * 1024 * 1024 + 1)
        if len(binary) != members[0].size:
            raise ValueError("binary length mismatch")
    target = home / "garage"
    target.write_bytes(binary)
    target.chmod(0o700)
    version = subprocess.run([str(target), "--version"], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    if not re.fullmatch(r"garage v?2\.4\.1(?: \[features: [a-z0-9, _-]+\])?", version):
        raise ValueError("unexpected Garage version: " + repr(version[:256]))
    report = {"passed": True, "proof": "pinned-garage-extraction", "image": IMAGE, "selected": selected,
              "layer": layer, "binarySha256": hashlib.sha256(binary).hexdigest(), "version": version}
    return target, report


def main():
    _, report = prepare_binary()
    Path("blob-image-proof.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
