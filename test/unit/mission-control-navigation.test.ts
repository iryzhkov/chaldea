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
    parts: (Element | string)[] = [];
    tag = "div";
    className = "";
    value = "";
    bar: Element | undefined;
    onload: (() => void) | undefined;
    classList = { toggle: (name: string, on: boolean) => {
      const classes = new Set(this.className.split(" ").filter(Boolean));
      if (on) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(" ");
    }};
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
      if (name === "class") this.className = value;
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())] = value;
    }
    getAttribute(name: string) { return this.attrs[name] ?? null; }
    removeAttribute(name: string) { delete this.attrs[name]; }
    parent: Element | null = null;
    open = false;
    showModal() { this.open=true; }
    close() { this.open=false;this.dispatchEvent(new Event("close")); }
    closest(selector: string): Element | null { return this.matches(selector)?this:this.parent?.closest(selector)??null; }
    matches(selector: string): boolean {
      return selector.split(",").some(s => {
        const attr = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (attr) return this.attrs[attr[1]!] !== undefined && (attr[2] === undefined || this.attrs[attr[1]!] === attr[2]);
        return s.startsWith(".") ? this.className.split(" ").includes(s.slice(1)) : this.tag === s;
      });
    }
    contains(el: Element | null): boolean { return el === this || this.children.some(c=>c.contains(el)); }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = document.body; const e=new Event("focusout");Object.defineProperty(e,"target",{value:this});document.dispatchEvent(e); }
    get options() { return this.children.filter(c=>c.tag === "option"); }
    get textContent(): string { return this.parts.map(p=>typeof p === "string" ? p : p.textContent).join(""); }
    set textContent(text: string) { this.children=[];this.parts=[text]; }
    getBoundingClientRect() { return {width,height:this.matches(".p-summary")?160:height,top:0}; }
    append(el: Element) { el.parent=this;this.children.push(el); this.parts.push(el); }
    set innerHTML(html: string) {
      if (this.children.some(c=>c.contains(document.activeElement))) document.activeElement=document.body;
      this.children=[];this.parts=[];
      const stack: Element[] = [this];
      for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
        if (token.startsWith("</")) { if(stack.length>1)stack.pop(); continue; }
        if (!token.startsWith("<")) { stack.at(-1)!.parts.push(token); continue; }
        const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;
        const el=new Element();el.tag=tag;
        for(const a of token.slice(tag.length+1,-1).matchAll(/([\w-]+)(?:="([^"]*)")?/g))el.setAttribute(a[1]!,a[2]??"");
        el.value=el.attrs.value??"";
        stack.at(-1)!.append(el);
        if(!["br","hr","input","meta","link"].includes(tag)&&!token.endsWith("/>"))stack.push(el);
      }
      for (const el of this.descendants()) {
        if(el.tag==="select")el.value=el.options.find(o=>o.attrs.selected!==undefined)?.value??el.options[0]?.value??"";
        if(el.tag==="button"&&el.dataset.m)el.bar=el.querySelector("i")??undefined;
      }
    }
    get innerHTML(): string {
      return this.parts.map(p=>typeof p==="string"?p:"<"+p.tag+Object.entries(p.attrs).map(([k,v])=>" "+k+'="'+v+'"').join("")+">"+p.innerHTML+"</"+p.tag+">").join("");
    }
    descendants(): Element[] { return this.children.flatMap(c=>[c,...c.descendants()]); }
    querySelector(selector: string): Element | null {
      if (selector === ".on .bar i") return this.children.find(e => e.className === "on")?.bar ?? null;
      if (selector === ".bar i") return this.bar ?? null;
      const [parent,child]=selector.split(" ");
      if(child)return this.descendants().filter(e=>e.matches(parent!)).map(e=>e.querySelector(child)).find(Boolean)??null;
      return this.descendants().find(e=>e.matches(selector))??null;
    }
  }
  const elements: Record<string, Element> = Object.fromEntries(
    ["board", "view", "tabs", "pick", "navstate", "urgent", "globalfresh", "clock"].map(id => [id, new Element()]));
  const document = Object.assign(new EventTarget(), {
    body: new Element(), activeElement: null as Element | null, documentElement: { style: { setProperty() {} } }, title: "",
    getElementById: (id: string) => elements[id],
    querySelector: (selector: string) => elements[selector.slice(1)] ?? null,
    createElement: (tag:string) => {const el=new Element();el.tag=tag;return el;},
  });
  document.activeElement = document.body;
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
    grid: (value:string) => { const el=elements.view!.querySelector("[data-thread-grid]")!;el.value=value;const e=new Event("change");Object.defineProperty(e,"target",{value:el});document.dispatchEvent(e);},
    page: (delta:number) => {const el=elements.view!.querySelector(`[data-thread-page="${delta}"]`)!;const e=new Event("click");Object.defineProperty(e,"target",{value:el});document.dispatchEvent(e);},
    openDetails: (id:string) => {const el=elements.view!.querySelector('[data-thread-details="'+encodeURIComponent(id)+'"]')!;el.focus();const e=new Event("click");Object.defineProperty(e,"target",{value:el});document.dispatchEvent(e);},
    closeDetails: () => {const el=document.body.querySelector("[data-close-details]")!;const e=new Event("click");Object.defineProperty(e,"target",{value:el});document.dispatchEvent(e);},
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
  assert.match(b.elements.view!.innerHTML,/Previews unavailable/);assert.match(b.elements.view!.innerHTML,/showing 48 of 48/);
  assert.match(b.elements.view!.innerHTML,/truncated/);assert.match(b.elements.view!.innerHTML,/activity stale · 1m ago/);
  const history=b.entries.length;b.click("agent-summary");assert.equal(b.entries.length,history+1);
  assert.equal(b.location.searchParams.get("mode"),"agent-summary");
  assert.match(b.elements.view!.innerHTML,/Host overview/);assert.match(b.elements.view!.innerHTML,/shown 0 \/ 0/);
  assert.match(b.elements.view!.innerHTML,/NOT OBSERVED · thread count unknown/);
  assert.match(b.elements.view!.innerHTML,/gpt-6.1-sol: 48/);assert.doesNotMatch(b.elements.view!.innerHTML,/panel tile/);
  b.snapshot({...snapshot,shown:47,agents:agents.slice(0,47)});assert.equal(b.entries.length,history+1);
  assert.match(b.elements.view!.innerHTML,/showing 47 of 47/);
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
 delete d.recent; // This fixture intentionally exercises the exact legacy v2 detail.
 const agents=[{id:"opaque-row",title:d.identity.title.text,model:"gpt-6.1-sol",host:"agent-a",state:"thinking",startedAt:now-1000,observedAt:now,detailObservedAt:now,activityFreshness:"live",freshness:"live",steps:[],details:d,detailCoverage:"reported"}];
 const host={host:"agent-a",shown:1,total:1,truncated:false,observedAt:now,freshness:"live",states:{thinking:1},models:[{model:"gpt-6.1-sol",count:1}],resources:{state:"reported",sample:{sampledAt:now,cpuUtilization:0.25,cpuCount:8,availableMemoryBytes:1073741824,totalMemoryBytes:4294967296}}};
 const snapshot={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents,shown:1,total:1,truncated:false,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[host]};
 b.snapshot(snapshot);
 let html=b.elements.view!.innerHTML;
 assert.match(html,/task-label">Task/);assert.match(html,/Thinking/);
 assert.match(html,/Actual &lt;script&gt;title&lt;\/script&gt;/);
 assert.match(html,/Latest &lt;img/);assert.doesNotMatch(html,/<script>|<img /);
 b.openDetails("opaque-row");html=b.document.body.querySelector(".thread-drawer")!.innerHTML;
 assert.match(html,/data-copy-thread="mcp:real-application-thread-123456789"/);
 assert.match(html,/high \(configured\)/);assert.match(html,/go test -race/);b.closeDetails();
 b.click("agent-summary");html=b.elements.view!.innerHTML;
 assert.match(html,/Host overview/);assert.doesNotMatch(html,/Actual &lt;script&gt;|App thread|Latest &lt;img|go test -race/);
 b.click("fleet");html=b.elements.view!.innerHTML;assert.match(html,/25.0% · 8 cores/);assert.match(html,/3.0 \/ 4.0 GiB · 75.0% used/);
 b.click("overview");assert.match(b.elements.view!.innerHTML,/25.0% · 8 cores/);
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

test("grid controls retain native nodes and focus through changes, paging and background snapshots",()=>{
 const b=browser("https://board.example/?mode=agents&grid=3x3"),now=Date.now();
 const agents=Array.from({length:48},(_,i)=>({id:"synthetic-"+i,title:"Focus task "+i,model:"sol",host:"agent-a",state:"working",startedAt:now,observedAt:now,detailObservedAt:now,activityFreshness:"live",freshness:"live",steps:[]}));
 const snapshot={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents,shown:48,total:48,truncated:false,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[]};
 b.snapshot(snapshot);
 const view=b.elements.view!,picker=view.querySelector("[data-thread-grid]")!,option=picker.options[2]!,status=view.querySelector('[role="status"]')!,next=view.querySelector('[data-thread-page="1"]')!;
 picker.focus();
 b.grid("4x3");b.grid("5x3");b.refresh();
 b.snapshot({...snapshot,agents:agents.map(a=>({...a,title:"Latest "+a.title}))});
 b.resize(1600,1000);
 assert.equal(b.document.activeElement,picker);
 assert.equal(view.querySelector("[data-thread-grid]"),picker);
 assert.equal(picker.options[2],option);
 assert.equal(view.querySelector('[role="status"]'),status);
 assert.match(view.innerHTML,/Latest Focus task 0/);
 assert.equal(b.location.searchParams.get("grid"),"5x3");
 b.travel(-1);assert.equal(picker.value,"4x3");assert.equal(b.document.activeElement,picker);
 b.travel(1);assert.equal(picker.value,"5x3");assert.equal(b.document.activeElement,picker);
 const key=new Event("keydown");Object.defineProperties(key,{target:{value:picker},key:{value:"ArrowRight"}});b.document.dispatchEvent(key);
 assert.match(status.textContent,/Page 1 of/);
 picker.blur();
 assert.match(view.innerHTML,/Latest Focus task 0/);
 next.focus();b.page(1);b.page(1);
 assert.equal(b.document.activeElement,next);
 assert.equal(view.querySelector('[data-thread-page="1"]'),next);
 assert.match(status.textContent,/Page 3 of/);
 b.refresh();assert.equal(b.document.activeElement,next);
 for(let i=0;i<48;i++)b.page(1);
 assert.equal(next.getAttribute("aria-disabled"),"true");
 assert.equal(b.document.activeElement,next);
 const last=status.textContent;b.page(1);assert.equal(status.textContent,last);
 b.snapshot({...snapshot,agents:agents.slice(0,1),shown:1,total:1});
 assert.equal(status.textContent,"Page 1 of 1");
 assert.equal(b.document.activeElement,next);
 next.blur();b.refresh();assert.equal(b.document.activeElement,b.document.body);
 b.click("fleet");b.refresh();assert.equal(b.document.activeElement,b.document.body);
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

test("Overview count follows the actual four-row budget with five observed rows",()=>{
 const b=browser(),now=Date.now();
 const agents=Array.from({length:5},(_,i)=>({id:"count-"+i,title:"Count fixture "+i,model:"sol",host:"agent-a",state:"working",startedAt:now,observedAt:now,detailObservedAt:now,activityFreshness:"live",freshness:"live",steps:[]}));
 b.snapshot({version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents,shown:5,total:5,truncated:false,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[]});
 const html=b.elements.view!.querySelector(".p-threads")!.innerHTML;
 assert.equal((html.match(/Count fixture /g)||[]).length,4);
 assert.match(html,/showing 4 of 5 observed threads/);
 assert.equal((html.match(/showing/gi)||[]).length,1);
});

test("compact cards use current state, bounded previews, safe provider identity and a stable modal",async()=>{
 const {emptyDetail}=await import("../../src/mission-control/details.ts");
 const b=browser("https://board.example/?mode=agents&grid=4x3"),now=Date.now(),d:any=emptyDetail();
 d.assistant={text:"Sanitized assistant preview ".repeat(30),state:"reported"};
 d.commands=Array.from({length:3},(_,i)=>({text:"safe command "+i+" ".repeat(20),state:"reported"}));
 delete d.recent; // Legacy path; later snapshots below exercise authoritative v3 recent.
 const row={id:"one",title:"A meaningful task title ".repeat(6),host:"agent-a",model:"claude-opus-5-5",state:"completed",startedAt:now,observedAt:now,detailObservedAt:now,activityFreshness:"live",freshness:"live",steps:["Command running"],details:d,detailCoverage:"reported"};
 const snap={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[row],shown:1,total:1,truncated:false,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[]};
 for(const state of ["completed","failed","idle"]){
  b.snapshot({...snap,agents:[{...row,state}]});b.resize(390,834);
  const card=b.elements.view!.querySelector(".tile")!;
  assert.match(card.innerHTML,new RegExp(state==="idle"?"Idle":state==="failed"?"Failed":"Completed"));
  assert.match(card.innerHTML,/Last observed command · outcome unknown/);
  assert.doesNotMatch(card.innerHTML,/Command running|Active command observed|App thread|Effort|Usage not reported/);
  assert.equal((card.innerHTML.match(/class="activity-item"/g)||[]).length,3);
  assert.match(card.innerHTML,/activity-fresh/);assert.match(card.innerHTML,/source-fresh/);
  assert.match(card.innerHTML,/aria-label="Provider unknown"/);
 }
 const opener=b.elements.view!.querySelector('[data-thread-details="one"]')!;
 opener.focus();b.refresh();assert.equal(b.document.activeElement,b.elements.view!.querySelector('[data-thread-details="one"]'));
 b.snapshot(snap);assert.equal(b.document.activeElement,b.elements.view!.querySelector('[data-thread-details="one"]'));
 b.openDetails("one");
 const dialog=b.document.body.querySelector(".thread-drawer")!,close=dialog.querySelector("[data-close-details]")!;
 assert.equal(dialog.open,true);assert.equal(b.document.activeElement,close);
 b.refresh();b.snapshot({...snap,agents:[{...row,state:"failed",details:{...d,assistant:{text:null,state:"withheld"},commands:[]}}]});
 assert.equal(b.document.activeElement,close);assert.equal(dialog.querySelector("[data-close-details]"),close);
 assert.doesNotMatch(dialog.innerHTML,/Sanitized assistant preview/);
 b.closeDetails();assert.equal(dialog.open,false);assert.equal(b.document.activeElement,b.elements.view!.querySelector('[data-thread-details="one"]'));
 // Actual optional provider/recent metadata wins over legacy data and model names.
 const recent=[{kind:"assistant",preview:{text:"Earlier actual message",state:"truncated"},at:now-10000,status:"unknown"},{kind:"command",preview:{text:"Observed completed command",state:"redacted"},at:now,status:"completed"},{kind:"command",preview:{text:null,state:"withheld"},at:now,status:"failed"}];
 b.snapshot({...snap,agents:[{...row,details:{...d,provider:{instanceId:"custom-codex",driver:"codex"},recent}}]});
 let html=b.elements.view!.innerHTML;
 assert.match(html,/OpenAI Codex · custom-codex/);assert.doesNotMatch(html,/Claude ·/);
 assert.match(html,/Earlier actual message/);assert.match(html,/Command · completed/);assert.match(html,/truncated/);assert.match(html,/redacted/);assert.doesNotMatch(html,/Sanitized assistant preview|safe command/);
 b.openDetails("one");assert.match(dialog.innerHTML,/Earlier actual message/);assert.match(dialog.innerHTML,/Observed completed command/);b.closeDetails();
 b.snapshot({...snap,agents:[{...row,details:{...d,provider:{instanceId:"custom-claude",driver:"claudeAgent"},recent:[]}}]});
 html=b.elements.view!.innerHTML;assert.match(html,/Claude · custom-claude/);assert.doesNotMatch(html,/Earlier actual message|Sanitized assistant preview/);
 b.snapshot({...snap,agents:[{...row,state:"working",detailObservedAt:now-90000,details:{...d,recent:[{kind:"command",preview:{text:"Old command",state:"reported"},at:now-90000,status:"running"}]}}]});
 assert.doesNotMatch(b.elements.view!.innerHTML,/Active command observed/);
 assert.match(b.elements.view!.innerHTML,/Last observed command/);
 const css=readFileSync(new URL("../../src/mission-control/static/core.css",import.meta.url),"utf8");
 assert.doesNotMatch(css,/\.dynamic-grid \.tile > \.body\s*\{[^}]*overflow:\s*(auto|scroll)/);
 assert.match(css,/grid-template-rows:38px minmax\(0,1fr\) 36px/);
});
test("resource instruments preserve measured CPU zero, independent stale samples, units and accessibility",()=>{
 const b=browser("https://board.example/?mode=fleet"),now=Date.now();
 const hosts=["agent-a","agent-b","omarchy-pc","laptop"].map((host,i)=>({host,shown:i,total:i,truncated:false,observedAt:now,freshness:i===1?"stale":"live",states:{},models:[],resources:{state:i===2?"unavailable":"reported",sample:i===2?null:{sampledAt:now-(i===1?120000:0),cpuUtilization:i===0?0:null,cpuCount:8,availableMemoryBytes:1073741824,totalMemoryBytes:4294967296}}}));
 b.snapshot({version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[],shown:0,total:0,truncated:false,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:hosts});
 for(const mode of ["fleet","agent-summary"]){
  b.click(mode);const html=b.elements.view!.innerHTML;
  assert.equal((html.match(/host-card/g)||[]).length,4);
  assert.match(html,/aria-valuenow="0.00"/);assert.match(html,/0.0% · 8 cores/);
  assert.match(html,/1.0 GiB available/);assert.match(html,/3.0 \/ 4.0 GiB/);
  assert.match(html,/last known \/ stale/);assert.match(html,/Resource sample unavailable/);
 }
});
