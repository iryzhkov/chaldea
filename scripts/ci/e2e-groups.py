#!/usr/bin/env python3
"""Balanced E2E file lanes; new or removed files require an explicit assignment."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path

# C59 main 39296716214 top-level case totals, excluding runner/file startup:
# e2e-1: 204.285 s; e2e-2: 211.898 s; e2e-3: 208.279 s.
GROUPS = {
    "e2e-1": [
        "test/e2e/native-decisions.e2e.test.ts",
        "test/e2e/quota.e2e.test.ts",
    ],
    "e2e-2": [
        "test/e2e/message-replay.e2e.test.ts",
        "test/e2e/provider-switch.e2e.test.ts",
        "test/e2e/route.e2e.test.ts",
        "test/e2e/waits.e2e.test.ts",
    ],
    "e2e-3": [
        "test/e2e/multiwait.e2e.test.ts",
        "test/e2e/restart-investigation.e2e.test.ts",
        "test/e2e/restart.e2e.test.ts",
        "test/e2e/token-helper.e2e.test.ts",
    ],
}


def validate_groups(groups, actual):
    counts = Counter(path for files in groups.values() for path in files)
    duplicates = sorted(path for path, count in counts.items() if count != 1)
    unassigned = sorted(set(actual) - counts.keys())
    missing = sorted(counts.keys() - set(actual))
    if (set(groups) != {"e2e-1", "e2e-2", "e2e-3"} or duplicates or unassigned
            or missing or any(not files for files in groups.values())):
        raise ValueError(
            f"E2E coverage mismatch: duplicate={duplicates}, "
            f"unassigned={unassigned}, missing={missing}; groups must be nonempty"
        )


def command(group):
    return ["scripts/with-scratch", "node", "--test", "--test-concurrency=1",
            *GROUPS[group]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("group", nargs="?", choices=GROUPS)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    actual = [path.relative_to(root).as_posix()
              for path in (root / "test/e2e").glob("*.test.ts") if path.is_file()]
    validate_groups(GROUPS, actual)
    if args.check:
        print(json.dumps({group: command(group) for group in GROUPS}, indent=2))
        return
    if args.group is None:
        parser.error("a group or --check is required")
    argv = command(args.group)
    if args.dry_run:
        print(json.dumps(argv))
        return
    os.chdir(root)
    os.execvp(argv[0], argv)


if __name__ == "__main__":
    main()
