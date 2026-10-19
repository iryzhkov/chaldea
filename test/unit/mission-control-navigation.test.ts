import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute both shipped scripts against the small DOM/history seam they use.
// Rendering remains real; no copied navigation implementation.
function browser(href = "https://board.example/?palette=mocr-1969", reduced = false) {
  class Element extends EventTarget {
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    attrs: Record<string, string> = {};
    children: Element[] = [];
    className = "";
    value = "";
    textContent = "";
    html = "";
    bar: Element | undefined;
    onload: (() => void) | undefined;
    classList = { toggle: (name: string, on: boolean) => {
      const classes = new Set(this.className.split(" ").filter(Boolean));
      if (on) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(" ");
    }};
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    getAttribute(name: string) { return this.attrs[name] ?? null; }
    removeAttribute(name: string) { delete this.attrs[name]; }
    closest() { return this; }
    append(el: Element) { this.children.push(el); }
    set innerHTML(html: string) {
      this.html = html;
      if (this === elements.tabs) this.children = [...html.matchAll(/data-m="([^"]+)"/g)].map(m => {
        const el = new Element(); el.dataset.m = m[1]!; el.bar = new Element(); return el;
      });
    }
    get innerHTML() { return this.html; }
    querySelector(selector: string): Element | null {
      if (selector === ".on .bar i") return this.children.find(e => e.className === "on")?.bar ?? null;
      if (selector === ".bar i") return this.bar ?? null;
      return null;
    }
  }
  const elements: Record<string, Element> = Object.fromEntries(
    ["board", "view", "tabs", "pick", "navstate", "urgent", "globalfresh", "clock"].map(id => [id, new Element()]));
  const document = Object.assign(new EventTarget(), {
    body: new Element(), documentElement: { style: { setProperty() {} } }, title: "",
    getElementById: (id: string) => elements[id],
    querySelector: (selector: string) => elements[selector.slice(1)] ?? null,
    createElement: () => new Element(),
  });
  document.body.dataset = { defaultDir: "flight", defaultPalette: "mocr-1969" };
  const window = new EventTarget();
  const location = new URL(href);
  const entries = [location.href]; let index = 0;
  const history = {
    pushState(_state: unknown, _title: string, url: string) {
      location.href = new URL(url, location).href;
      entries.splice(++index); entries.push(location.href);
    },
    replaceState(_state: unknown, _title: string, url: string) {
      location.href = new URL(url, location).href; entries[index] = location.href;
    },
  };
  const intervals: (() => void)[] = []; let frame = () => {};
  const context: any = {
    document, location, history, URL, URLSearchParams, Date, performance, CustomEvent,
    innerWidth: 1280, matchMedia: (q: string) => ({ matches: q.includes("reduced-motion") && reduced }),
    requestAnimationFrame: (fn: () => void) => { frame = fn; },
    setInterval: (fn: () => void) => { intervals.push(fn); },
    addEventListener: window.addEventListener.bind(window),
    EventSource: class extends EventTarget { close() {} },
  };
  context.window = context;
  const source = (file: string) => readFileSync(new URL("../../src/mission-control/static/" + file, import.meta.url), "utf8");
  runInNewContext(source("palettes.js"), context);
  runInNewContext(source("client.js").replace("export function", "function"), context);
  runInNewContext(source("core.js"), context);
  document.body.children[0]!.onload!();
  const click = (mode: string) => {
    const button = elements.tabs!.children.find(e => e.dataset.m === mode)!;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: button });
    elements.tabs!.dispatchEvent(event); frame();
  };
  const travel = (delta: number) => { index += delta; location.href = entries[index]!; window.dispatchEvent(new Event("popstate")); };
  return { elements, location, entries, click, travel, frame: () => frame(),
    refresh: () => intervals.forEach(fn => fn()), window, document };
}

for (const reduced of [false, true]) {
  test("only the current mode has a highlight and underline, reduced motion=" + reduced, () => {
    const b = browser(undefined, reduced); b.click("agents"); b.click("tokens");
    assert.deepEqual(b.elements.tabs!.children.filter(e => e.className === "on").map(e => e.dataset.m), ["tokens"]);
    for (const button of b.elements.tabs!.children) {
      assert.equal(button.bar!.style.width, button.dataset.m === "tokens" ? "100%" : "0%");
      assert.equal(button.getAttribute("aria-current"), button.dataset.m === "tokens" ? "page" : null);
    }
  });
}
test("click, reload, Back/Forward and data refresh agree without duplicate history entries", () => {
  const b = browser(); b.click("agents"); b.click("quota");
  assert.equal(b.location.searchParams.get("mode"), "quota");
  assert.equal(b.location.searchParams.get("palette"), "mocr-1969");
  assert.equal(browser(b.location.href).elements.view!.className, "quota");
  const count = b.entries.length; b.refresh(); b.click("quota"); assert.equal(b.entries.length, count);
  b.travel(-1); b.refresh(); assert.equal(b.elements.view!.className, "agents");
  b.travel(1); b.refresh(); assert.equal(b.elements.view!.className, "quota");
});
test("picker and keyboard share the URL contract; unknown mode safely falls back", () => {
  const b = browser("https://board.example/?mode=bogus#board");
  assert.equal(b.elements.view!.className, "overview");
  b.elements.pick!.value = "tokens"; b.elements.pick!.dispatchEvent(new Event("change"));
  assert.equal(b.location.searchParams.get("mode"), "tokens"); assert.equal(b.location.hash, "#board");
  const key = new Event("keydown"); Object.assign(key, { key: "2" }); b.document.dispatchEvent(key);
  assert.equal(b.location.searchParams.get("mode"), "agents");
});
test("unavailable modes replace previous content without invented data", () => {
  const b = browser();
  for (const mode of ["fleet", "events", "ops", "lab"]) {
    b.click(mode); assert.equal(b.elements.view!.className, mode);
    assert.match(b.elements.view!.innerHTML, /Unavailable · no authorized source/);
    assert.equal((b.elements.view!.innerHTML.match(/<section/g) ?? []).length, 1);
    assert.equal(browser(b.location.href).elements.view!.className, mode);
  }
});
