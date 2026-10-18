import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs, { appendFileSync, chmodSync, linkSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { ConfigurationError } from "../../src/config/files.ts";
import { loadRouteConfig } from "../../src/route/config.ts";
import { loadCapacityConfig } from "../../src/quota/capacity-config.ts";
import { readJson, writeJson } from "../../src/route/cache.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";

const unsafe = (reason: string) => (error: unknown) => error instanceof ConfigurationError && error.reason === reason;
for (const [name, load] of [["route", loadRouteConfig], ["capacity", loadCapacityConfig]] as const) {
  test(name + " config accepts absence only and refuses unsafe files", () => {
    const d = routeScratch();
    try {
      const path = join(d.path, name + ".json");
      const defaults = load(d.path, path);
      writeFileSync(path, "{}", { mode: 0o644 });
      assert.deepEqual(load(d.path, path), defaults);
      const link = path + ".link";
      symlinkSync(path, link);
      assert.throws(() => load(d.path, link), unsafe("symlink"));
      symlinkSync(path + ".missing", path + ".dangling");
      assert.throws(() => load(d.path, path + ".dangling"), unsafe("symlink"));
      chmodSync(path, 0o664);
      assert.throws(() => load(d.path, path), unsafe("mode"));
      chmodSync(path, 0o600);
      linkSync(path, path + ".hard");
      assert.throws(() => load(d.path, path), unsafe("links"));
      const invalid = path + ".invalid";
      for (const text of ["[]", "null", "{broken"]) {
        writeFileSync(invalid, text, { mode: 0o600 });
        assert.throws(() => load(d.path, invalid), unsafe("parse"));
      }
      writeFileSync(invalid, '{"unknown":true}');
      assert.throws(() => load(d.path, invalid), /Invalid/);
    } finally { d.remove(); }
  });
  test(name + " config keeps its 64 KiB limit, including growth after stat", () => {
    const d = routeScratch(), path = join(d.path, name + ".json");
    const original = fs.fstatSync;
    try {
      writeFileSync(path, "{}" + " ".repeat(64 * 1024 - 2), { mode: 0o600 });
      load(d.path, path);
      appendFileSync(path, " ");
      assert.throws(() => load(d.path, path), unsafe("size"));
      writeFileSync(path, "{}" + " ".repeat(64 * 1024 - 2));
      const statMock = mock.method(fs, "fstatSync", (fd: number) => {
        const stat = original(fd);
        appendFileSync(path, " ");
        return stat;
      });
      syncBuiltinESMExports();
      try { assert.throws(() => load(d.path, path), unsafe("read_size")); }
      finally { statMock.mock.restore(); syncBuiltinESMExports(); }
    } finally { d.remove(); }
  });
}

test("cache JSON keeps all payload shapes, 2 MiB default and explicit limits", () => {
  const d = routeScratch(), path = join(d.path, "cache.json");
  try {
    for (const value of [{ value: [1] }, [1, "two"], null, "text", 42, true]) {
      writeJson(path, value);
      assert.deepEqual(readJson(path), value);
    }
    writeFileSync(path, "{}" + " ".repeat(2 * 1024 * 1024 - 2));
    assert.deepEqual(readJson(path), {});
    appendFileSync(path, " ");
    assert.throws(() => readJson(path), unsafe("size"));
    writeFileSync(path, '"12345678"');
    assert.equal(readJson(path, 10), "12345678");
    assert.throws(() => readJson(path, 9), unsafe("size"));
    symlinkSync(path, path + ".link");
    assert.throws(() => readJson(path + ".link"), unsafe("symlink"));
    chmodSync(path, 0o666);
    assert.throws(() => readJson(path), unsafe("mode"));
    chmodSync(path, 0o600);
    linkSync(path, path + ".hard");
    assert.throws(() => readJson(path), unsafe("links"));
  } finally { d.remove(); }
});

test("cache atomic writes create directories and replace files privately without following destination links", () => {
  const d = routeScratch(), dir = join(d.path, "new"), path = join(dir, "cache.json");
  try {
    writeJson(path, { value: "first" });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    chmodSync(path, 0o644);
    writeJson(path, { value: "second" });
    assert.deepEqual(readJson(path), { value: "second" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const target = join(d.path, "target");
    writeFileSync(target, "untouched");
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    writeJson(link, [1, 2]);
    assert.deepEqual(readJson(link), [1, 2]);
    assert.equal(statSync(link).mode & 0o777, 0o600);
    assert.equal(readFileSync(target, "utf8"), "untouched");
    assert.deepEqual(readdirSync(dir).sort(), ["cache.json", "link.json"]);
  } finally { d.remove(); }
});
