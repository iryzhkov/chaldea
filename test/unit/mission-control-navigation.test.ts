import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute both shipped scripts against the small DOM/history seam they use.
// Rendering remains real; no copied navigation implementation.
function browser(href = "https://board.example/?palette=mocr-1969", reduced = false) {
  let width=3840,height=1800;
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
    closest(selector: string) { if (selector === "[data-copy-thread]") return null; return selector === "[data-thread-page]" && !this.dataset.threadPage ? null : this; }
    matches(selector: string) { return selector === "[data-thread-grid]" && this.attrs["data-thread-grid"] !== undefined; }
    getBoundingClientRect() { return {width,height,top:0}; }
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
    innerWidth: width, innerHeight:height, matchMedia: (q: string) => ({ matches: q.includes("reduced-motion") && reduced }),
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
    resize: (w:number,h:number) => {width=w;height=h;context.innerWidth=w;context.innerHeight=h;window.dispatchEvent(new Event("resize"));},
    grid: (value:string) => { const el=new Element();el.attrs["data-thread-grid"]="";el.value=value;const e=new Event("change");Object.defineProperty(e,"target",{value:el});document.dispatchEvent(e);},
    page: (delta:number) => {const el=new Element();el.dataset.threadPage=String(delta);const e=new Event("click");Object.defineProperty(e,"target",{value:el});document.dispatchEvent(e);},
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
  assert.match(b.elements.view!.innerHTML,/Host overview/);assert.match(b.elements.view!.innerHTML,/shown 0 \/ 0/);
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
  for (const mode of ["events", "ops", "lab"]) {
    b.click(mode); assert.equal(b.elements.view!.className, mode);
    assert.match(b.elements.view!.innerHTML, /Unavailable · no authorized source/);
    assert.equal((b.elements.view!.innerHTML.match(/<section/g) ?? []).length, 1);
    assert.equal(browser(b.location.href).elements.view!.className, mode);
  }
});

test("cards render sanitized title, compact real app ID, top state, effort and resources without HTML injection",async()=>{
 const {emptyDetail}=await import("../../src/mission-control/details.ts");
 const b=browser("https://board.example/?mode=agents"),now=Date.now(),d=emptyDetail();
 d.identity={title:{text:"Actual <script>title</script>",state:"reported"},appThreadId:{text:"mcp:real-application-thread-123456789",state:"reported"}};
 d.assistant={text:"Latest <img src=x onerror=alert(1)> paragraph",state:"reported"};
 d.commands=[{text:"go test -race ./...",state:"reported"}];d.effort={value:"high",source:"configured"};
 const agents=[{id:"opaque-row",title:d.identity.title.text,model:"gpt-6.1-sol",host:"agent-a",state:"thinking",startedAt:now-1000,observedAt:now,detailObservedAt:now,activityFreshness:"live",freshness:"live",steps:[],details:d,detailCoverage:"reported"}];
 const host={host:"agent-a",shown:1,total:1,truncated:false,observedAt:now,freshness:"live",states:{thinking:1},models:[{model:"gpt-6.1-sol",count:1}],resources:{state:"reported",sample:{sampledAt:now,cpuUtilization:0.25,cpuCount:8,availableMemoryBytes:1073741824,totalMemoryBytes:4294967296}}};
 const snapshot={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents,shown:1,total:1,truncated:false,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[host]};
 b.snapshot(snapshot);
 let html=b.elements.view!.innerHTML;
 assert.match(html,/task-label">Task/);assert.match(html,/Thinking/);
 assert.match(html,/Actual &lt;script&gt;title&lt;\/script&gt;/);
 assert.match(html,/Latest &lt;img/);assert.doesNotMatch(html,/<script>|<img /);
 assert.match(html,/data-copy-thread="mcp:real-application-thread-123456789"/);
 assert.match(html,/high \(configured\)/);assert.match(html,/go test -race/);
 b.click("agent-summary");html=b.elements.view!.innerHTML;
 assert.match(html,/Host overview/);assert.doesNotMatch(html,/Actual &lt;script&gt;|App thread|Latest &lt;img|go test -race/);
 b.click("fleet");html=b.elements.view!.innerHTML;assert.match(html,/CPU 25.0%/);assert.match(html,/RAM 3.0 \/ 4.0 GiB \(75.0% used\)/);
 b.click("overview");assert.match(b.elements.view!.innerHTML,/CPU 25.0%/);
});

test("explicit grids page every row, clamp on resize and SSE shrink, and survive history",()=>{
 const b=browser("https://board.example/?mode=agents#board"),now=Date.now();
 const agents=Array.from({length:48},(_,i)=>({id:"row-"+i,title:"Distinct task "+i,model:"sol",host:"agent-a",state:"working",startedAt:now,observedAt:now,detailObservedAt:now,activityFreshness:"live",freshness:"live",steps:[]}));
 const snapshot={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents,shown:48,total:48,truncated:false,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[]};
 b.snapshot(snapshot);
 for(const [grid,capacity] of [["3x3",9],["4x3",12],["5x3",15]] as const){
   b.grid(grid); assert.equal(b.location.searchParams.get("grid"),grid);
   assert.equal((b.elements.view!.innerHTML.match(/panel tile/g)||[]).length,capacity);
   const seen=new Set<number>();
   for(let page=0;page<Math.ceil(48/capacity);page++){
     for(const m of b.elements.view!.innerHTML.matchAll(/Distinct task (\d+)/g))seen.add(Number(m[1]));
     b.page(1);
   }
   assert.equal(seen.size,48);assert.match(b.elements.view!.innerHTML,/Distinct task 47/);
 }
 b.resize(640,900);assert.match(b.elements.view!.innerHTML,/Effective fit 2 × 3/);
 b.resize(320,600);assert.match(b.elements.view!.innerHTML,/Effective fit 1 × 1/);
 b.snapshot({...snapshot,agents:agents.slice(0,2),shown:2,total:2});
 assert.match(b.elements.view!.innerHTML,/Page 2 of 2/);
 b.page(-1);assert.match(b.elements.view!.innerHTML,/Distinct task 0/);
 b.grid("3x3");b.grid("4x3");const count=b.entries.length;b.refresh();assert.equal(b.entries.length,count);
 b.travel(-1);assert.equal(b.location.searchParams.get("grid"),"3x3");
 b.travel(1);assert.equal(b.location.searchParams.get("grid"),"4x3");
 const reload=browser(b.location.href);assert.match(reload.elements.view!.innerHTML,/Effective fit 4 × 3/);
 b.grid("evil");assert.equal(b.location.searchParams.get("grid"),"4x3");
 assert.equal(b.location.hash,"#board");
 b.resize(3840,1800);b.grid("auto");b.snapshot(snapshot);
 assert.equal((b.elements.view!.innerHTML.match(/panel tile/g)||[]).length,48);
});
test("host cards keep independent ages, observed zero, missing counts and escaped metadata",()=>{
 const b=browser("https://board.example/?mode=agent-summary"),now=Date.now();
 const host=(name:string,observedAt:number|null,freshness:string,total:number|null)=>({host:name,shown:0,total,truncated:false,observedAt,freshness,states:{},models:[]});
 b.snapshot({version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[],shown:0,total:0,truncated:false,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},
 hostSummary:[host("fresh <script>",now,"live",0),host("old",now-100000,"live",0),host("absent",null,"nosource",null),host("offline",now,"disconnected",0)]});
 const html=b.elements.view!.innerHTML;
 assert.equal((html.match(/host-card/g)||[]).length,4);
 assert.match(html,/fresh &lt;script&gt;/);assert.doesNotMatch(html,/<script>|undefined/);
 assert.match(html,/observed · source 0s ago · shown 0 \/ 0/);
 assert.match(html,/stale · source 100s ago/);assert.match(html,/disconnected/);
 assert.match(html,/NOT OBSERVED · thread count unknown/);
 assert.equal(browser(b.location.href).document.body.dataset.mode,"agent-summary");
});
