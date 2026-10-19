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
  let eventSource: EventTarget;
  const intervals: (() => void)[] = []; let frame = () => {};
  const context: any = {
    document, location, history, URL, URLSearchParams, Date, performance, CustomEvent,
    innerWidth: 1280, matchMedia: (q: string) => ({ matches: q.includes("reduced-motion") && reduced }),
    requestAnimationFrame: (fn: () => void) => { frame = fn; },
    setInterval: (fn: () => void) => { intervals.push(fn); },
    addEventListener: window.addEventListener.bind(window),
    EventSource: class extends EventTarget { constructor(){super();eventSource=this;} close() {} },
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
    refresh: () => intervals.forEach(fn => fn()), snapshot: (data:unknown) => {const e=new Event("snapshot");Object.assign(e,{data:JSON.stringify(data)});eventSource.dispatchEvent(e);}, context, window, document };
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
test("two agent views preserve old URLs, update immediately and disclose bounded coverage",()=>{
  const b=browser("https://board.example/?mode=agents");
  const at=Date.now(),agents=Array.from({length:48},(_,i)=>({id:"row-"+i,title:"Task "+i,model:"gpt-6.1-sol",host:"agent-a",state:i===0?"idle":"working",startedAt:at-10000,observedAt:at,detailObservedAt:at-65000,activityFreshness:"live",freshness:"live",steps:[i===0?"Command running":"read"]}));
  const snapshot={version:1,demo:false,sampled:true,now:at,source:{state:"live",observedAt:at},agents,shown:48,total:60,truncated:true,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},
    hostSummary:[{host:"agent-a",shown:48,total:60,truncated:true,observedAt:at,freshness:"live",states:{working:47,idle:1},models:[{model:"gpt-6.1-sol",count:48}]},
      {host:"agent-b",shown:0,total:0,truncated:false,observedAt:at,freshness:"live",states:{},models:[]},
      {host:"omarchy-pc",shown:0,total:null,truncated:false,observedAt:null,freshness:"nosource",states:{},models:[]}]};
  b.snapshot(snapshot);
  assert.equal(b.elements.view!.className,"agents");
  assert.equal((b.elements.view!.innerHTML.match(/panel tile/g)||[]).length,48);
  assert.match(b.elements.view!.innerHTML,/Command running/);assert.match(b.elements.view!.innerHTML,/Showing 48 of 60/);
  assert.match(b.elements.view!.innerHTML,/truncated/);assert.match(b.elements.view!.innerHTML,/activity 1m ago · source 0s ago/);
  const history=b.entries.length;b.click("agent-summary");assert.equal(b.entries.length,history+1);
  assert.equal(b.location.searchParams.get("mode"),"agent-summary");
  assert.match(b.elements.view!.innerHTML,/Agent summary/);assert.match(b.elements.view!.innerHTML,/shown 0 \/ 0/);
  assert.match(b.elements.view!.innerHTML,/NOT OBSERVED · thread count unknown/);
  assert.match(b.elements.view!.innerHTML,/gpt-6.1-sol: 48/);assert.doesNotMatch(b.elements.view!.innerHTML,/panel tile/);
  b.snapshot({...snapshot,shown:47,agents:agents.slice(0,47)});assert.equal(b.entries.length,history+1);
  assert.match(b.elements.view!.innerHTML,/Showing 47 of 60/);
  assert.equal(browser(b.location.href).document.body.dataset.mode,"agent-summary");
  b.travel(-1);b.refresh();assert.equal(b.document.body.dataset.mode,"agents");
  b.travel(1);b.refresh();assert.equal(b.document.body.dataset.mode,"agent-summary");
  for(const tool of ["read /private/key","mcp__evil__read","Bearer SECRET","command_execution rm -rf"]){
    const safe=b.context.MC.safeStep({tool,input:"PRIVATE",output:"PRIVATE",target:"PRIVATE"});
    assert.equal(safe.tool,"Activity unavailable");assert.equal(safe.target,"");
  }
  assert.equal(b.context.MC.safeStep({tool:"Command running",target:"/private/key"}).target,"");
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
