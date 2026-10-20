import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute both shipped scripts against the small DOM/history seam they use.
// Rendering remains real; no copied navigation implementation.
function browser(href = "https://board.example/?palette=mocr-1969", reduced = false, clock?:{now:number}) {
  let width=3840,height=1800;
  const animations: string[] = [];
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
    animate() { animations.push(this.attrs['data-thread-card']!); }
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
    querySelectorAll(selector: string): Element[] { return this.descendants().filter(e=>e.matches(selector)); }
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
  const timeouts=new Map<number,{fn:()=>void;at:number}>();let timeoutId=0;
  const context: any = {
    document, location, history, URL, URLSearchParams, Date:class extends Date {static override now(){return clock?.now??Date.now();}}, performance, CustomEvent,
    innerWidth: width, innerHeight:height, matchMedia: (q: string) => ({ matches: q.includes("reduced-motion") && reduced }),
    requestAnimationFrame: (fn: () => void) => { frame = fn; },
    setInterval: (fn: () => void) => { intervals.push(fn); },
    setTimeout: (fn:()=>void,delay:number) => {const id=++timeoutId;timeouts.set(id,{fn,at:(clock?.now??Date.now())+delay});return id;},
    clearTimeout: (id:number) => timeouts.delete(id),
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
    tick: (now:number) => {assert.ok(clock);clock.now=now;for(const [id,timer] of [...timeouts])if(timer.at<=now){timeouts.delete(id);timer.fn();}},
    resize: (w:number,h:number) => {width=w;height=h;context.innerWidth=w;context.innerHeight=h;window.dispatchEvent(new Event("resize"));},
    grid: (value:string) => { const el=elements.view!.querySelector("[data-thread-grid]")!;el.value=value;const e=new Event("change");Object.defineProperty(e,"target",{value:el});document.dispatchEvent(e);},
    page: (delta:number) => {const el=elements.view!.querySelector(`[data-thread-page="${delta}"]`)!;const e=new Event("click");Object.defineProperty(e,"target",{value:el});document.dispatchEvent(e);},
    openDetails: (id:string) => {const el=elements.view!.querySelector('[data-thread-details="'+encodeURIComponent(id)+'"]')!;el.focus();const e=new Event("click");Object.defineProperty(e,"target",{value:el});document.dispatchEvent(e);},
    closeDetails: () => {const el=document.body.querySelector("[data-close-details]")!;const e=new Event("click");Object.defineProperty(e,"target",{value:el});document.dispatchEvent(e);},
    disconnect: () => (eventSource as any).onerror(),
    refresh: () => intervals.forEach(fn => fn()), snapshot: (data:unknown) => {const e=new Event("snapshot");Object.assign(e,{data:JSON.stringify(data)});eventSource.dispatchEvent(e);}, context, window, document, animations };
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
  assert.match(b.elements.view!.innerHTML,/truncated/);assert.match(b.elements.view!.innerHTML,/Activity stale · 1m ago/);
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
test("observed pages replace previous content with honest empty states and preserve URLs", () => {
  const b = browser(), empty = {events:/No changed or failed timer runs observed in 48h/,ops:/No report in 48h/,lab:/No observed threads/};
  for (const mode of ["events", "ops", "lab"] as const) {
    b.click(mode); assert.equal(b.elements.view!.className, mode);
    assert.match(b.elements.view!.innerHTML, empty[mode]);
    assert.doesNotMatch(b.elements.view!.innerHTML, /undefined|NaN|all sources live/);
    assert.equal(browser(b.location.href).elements.view!.className, mode);
  }
});

test("cards render sanitized title and footer state with full identity and provenance in Details",async()=>{
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
 assert.match(b.elements.view!.querySelector(".card-status")!.textContent,/Thinking/);
 assert.equal(b.elements.view!.querySelector(".card-effort")!.textContent,"high configured");
 d.effort={value:"high",source:"reported"};b.snapshot(snapshot);
 assert.match(b.elements.view!.querySelector(".card-effort")!.textContent,/high/);
 d.effort={value:"high",source:"configured"};b.snapshot(snapshot);
 assert.doesNotMatch(b.elements.view!.querySelector("header")!.textContent,/Thinking|high/);
 assert.match(html,/Actual &lt;script&gt;title&lt;\/script&gt;/);
 assert.match(html,/Latest &lt;img/);assert.doesNotMatch(html,/<script>|<img /);
 b.openDetails("opaque-row");html=b.document.body.querySelector(".thread-drawer")!.innerHTML;
 assert.match(html,/data-copy-thread="mcp:real-application-thread-123456789"/);
 assert.match(html,/high \(configured\)/);assert.match(html,/go test -race/);
 assert.match(html,/detail-freshness/);assert.match(html,/detail coverage reported/);b.closeDetails();
 b.click("agent-summary");html=b.elements.view!.innerHTML;
 assert.match(html,/Host overview/);assert.doesNotMatch(html,/Actual &lt;script&gt;|App thread|Latest &lt;img|go test -race/);
 b.click("fleet");html=b.elements.view!.innerHTML;assert.match(html,/25.0% · 8 cores/);assert.match(html,/3.0 \/ 4.0 GiB · 75.0% used/);
 b.click("overview");assert.match(b.elements.view!.innerHTML,/25.0% · 8 cores/);
});

test("Auto maximizes readable card area for the current count and viewport",()=>{
 const b=browser("https://board.example/?mode=agents"),now=Date.now();b.resize(3840,2160);
 const rows=Array.from({length:48},(_,i)=>({id:"auto-"+i,title:"Auto task "+i,model:"sol",host:"agent-a",state:"working",startedAt:now,observedAt:now,detailObservedAt:now,activityFreshness:"live",freshness:"live",steps:[]}));
 const snap=(n:number)=>({version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:rows.slice(0,n),shown:n,total:n,truncated:false,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[]});
 for(const [n,cols,lines] of [[1,1,1],[2,2,1],[5,3,2],[6,3,2],[7,3,3],[9,3,3],[10,4,3],[12,4,3],[13,4,4],[16,4,4],[48,8,6]]){
  b.snapshot(snap(n!));const html=b.elements.view!.innerHTML;
  assert.match(html,new RegExp("Effective fit "+cols+" × "+lines+" ·"));
  assert.equal(b.elements.view!.querySelector(".agrid")!.children.length,n);
  assert.match(html,/Page 1 of 1/);
 }
 b.snapshot(snap(13));b.resize(1920,1080);assert.match(b.elements.view!.innerHTML,/Effective fit 5 × 3/);
 b.grid("4x4");b.snapshot(snap(5));assert.match(b.elements.view!.innerHTML,/Effective fit 4 × 3/);
 b.grid("auto");b.snapshot(snap(5));assert.match(b.elements.view!.innerHTML,/Effective fit 3 × 2/);
 b.resize(390,600);assert.match(b.elements.view!.innerHTML,/Effective fit 1 × 1/);
});

test("Auto widens sparse pages while capacity, stable rows and manual columns stay fixed",()=>{
 const b=browser("https://board.example/?mode=agents"),now=Date.now();b.resize(1280,800);
 const agents=Array.from({length:17},(_,i)=>({id:"endcap-"+i,title:"Endcap "+i,model:"claude-opus-5-5",host:"agent-a",state:"waiting-children",observedAt:now,detailObservedAt:now,activityFreshness:"live",freshness:"live",steps:[],detailCoverage:"reported",details:{effort:{value:"high",source:"configured"}}}));
 const snap=(n:number)=>({version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:agents.slice(0,n),shown:n,total:n,truncated:false,tokens:{coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[]});
 const view=b.elements.view!,columns=()=>view.querySelector(".dynamic-grid")!.getAttribute("style");
 const ids=()=>view.querySelectorAll(".tile").map(e=>e.getAttribute("data-thread-card"));
 for(const n of [9,10,17]){
  b.grid("auto");b.snapshot(snap(n));
  const pages=Math.ceil(n/8),seen:string[]=[];
  for(let page=0;page<pages;page++){
   const visible=Math.min(8,n-page*8);
   assert.match(view.textContent,new RegExp("Page "+(page+1)+" of "+pages));
   assert.match(view.textContent,/Effective fit 4 × 2 · 8 per page/);
   assert.match(columns()!,new RegExp("grid-template-columns:repeat\\("+Math.min(4,visible)+","));
   assert.deepEqual(ids(),agents.slice(page*8,Math.min(n,page*8+8)).map(a=>a.id));
   seen.push(...ids() as string[]);
   for(const card of view.querySelectorAll(".tile")){
    assert.equal(card.querySelector(".card-model")!.textContent,"claude-opus-5-5");
    assert.match(card.querySelector(".card-status")!.textContent,/Waiting for children/);
    assert.equal(card.querySelector(".card-effort")!.textContent,"high configured");
   }
   b.page(1);
  }
  assert.equal(new Set(seen).size,n);
  assert.equal(view.querySelector('[data-thread-page="1"]')!.getAttribute("aria-disabled"),"true");
  b.page(-1);assert.match(columns()!,/grid-template-columns:repeat\(4,/);
 }
 b.grid("4x3");b.snapshot(snap(10));b.page(1);
 assert.deepEqual(ids(),["endcap-8","endcap-9"]);
 assert.match(columns()!,/grid-template-columns:repeat\(4,/);
 assert.equal(b.location.searchParams.get("grid"),"4x3");
 assert.match(view.textContent,/Page 2 of 2/);
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
  assert.doesNotMatch(card.innerHTML,/Command running|Active command observed|App thread|Usage not reported/);
  assert.equal((card.innerHTML.match(/class="activity-item"/g)||[]).length,3);
  assert.match(card.querySelector("header")!.textContent,/A meaningful task title/);
  assert.doesNotMatch(card.querySelector("header")!.textContent,/Task |Completed|Failed|Idle/);
  assert.match(card.querySelector(".card-status")!.textContent,new RegExp(state==="idle"?"Idle":state==="failed"?"Failed":"Completed"));
  assert.doesNotMatch(card.querySelector(".body")!.innerHTML,/card-model|card-effort|card-usage|card-fresh|data-thread-details/);
  assert.match(card.querySelector(".card-fresh")!.getAttribute("title")!,/Activity live.*A source live/);
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
 html=b.elements.view!.innerHTML;assert.match(html,/Claude · custom-claude/);assert.doesNotMatch(html,/Earlier actual message/);assert.match(html,/Sanitized assistant preview/);
 b.snapshot({...snap,agents:[{...row,state:"working",detailObservedAt:now-90000,details:{...d,recent:[{kind:"command",preview:{text:"Old command",state:"reported"},at:now-90000,status:"running"}]}}]});
 assert.doesNotMatch(b.elements.view!.innerHTML,/Active command observed/);
 assert.match(b.elements.view!.innerHTML,/Last observed command/);
 const css=readFileSync(new URL("../../src/mission-control/static/core.css",import.meta.url),"utf8");
 assert.doesNotMatch(css,/\.dynamic-grid \.tile > \.body\s*\{[^}]*overflow:\s*(auto|scroll)/);
 const card=b.elements.view!.querySelector(".tile")!;
 assert.ok(card.querySelector(".card-foot")!.contains(card.querySelector(".card-status")));
 assert.ok(card.querySelector(".card-foot")!.contains(card.querySelector("[data-thread-details]")));
 assert.match(css,/@container \(max-width:460px\).*card-usage/);
});

test("card metrics stay in the footer and visual updates follow real evidence only",async()=>{
 const {emptyDetail}=await import("../../src/mission-control/details.ts");
 for(const reduced of [false,true]){
  const b=browser("https://board.example/?mode=agents",reduced),now=Date.now(),d:any=emptyDetail();
  d.effort={value:"high",source:"reported"};
  d.usage={...d.usage,total:12345,coverage:"observed",observedAt:now};
  d.recent=[{kind:"assistant",preview:{text:"Real preview",state:"reported"},at:now,status:"unknown"}];
  const row={id:"glance",title:"Actual task",host:"agent-a",model:"actual-model",state:"working",startedAt:now,observedAt:now,detailObservedAt:now,activityFreshness:"live",freshness:"live",steps:[],details:d,detailCoverage:"reported"};
  const snap={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[row],shown:1,total:1,truncated:false,tokens:{rate:null,output:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[]};
  b.snapshot(snap);
  const foot=b.elements.view!.querySelector(".card-foot")!;
  assert.match(foot.textContent,/Working.*actual-model.*high.*12K tok/);
  assert.doesNotMatch(b.elements.view!.querySelector(".tile")!.querySelector(".body")!.textContent,/actual-model|12K tok/);
  assert.equal(b.animations.length,0);
  b.refresh();b.snapshot(snap);assert.equal(b.animations.length,0);
  b.snapshot({...snap,now:now+1,agents:[{...row,observedAt:now+1}]});
  assert.equal(b.animations.length,reduced?0:1);
  b.snapshot({...snap,now:now+1,agents:[{...row,observedAt:now+1,details:{...d,recent:[{...d.recent[0],preview:{text:"New real preview",state:"truncated"}}]}}]});
  assert.equal(b.animations.length,reduced?0:2);
  b.snapshot({...snap,agents:[{...row,state:"completed",detailObservedAt:now-120000,activityFreshness:"stale",details:{...d,effort:{value:null,source:null},usage:{coverage:"not-reported"},recent:[{kind:"command",preview:{text:"PRIVATE WITHHELD",state:"withheld"},at:now,status:"running"}]}}]});
  const card=b.elements.view!.querySelector(".tile")!;
  assert.match(card.querySelector(".card-status")!.textContent,/Completed/);
  assert.match(card.querySelector(".card-fresh")!.textContent,/Completed · last activity 2m ago/);
  assert.equal(card.getAttribute("data-fresh"),"cached");
  assert.equal(card.querySelector(".card-effort")!.textContent,"effort unknown");
  assert.doesNotMatch(card.innerHTML,/PRIVATE WITHHELD|Command · running|card-usage|not reported/);
  assert.equal(card.querySelector(".recent-activity")!.textContent,"Previews unavailable");
 }
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

test("provider quota cards retain separate host readings, source ages and known zero",()=>{
 const b=browser("https://board.example/?mode=quota"),now=Date.now();
 const account={label:"Codex account 1",state:"cached",observedAt:now-4000000,used:0,resetsAt:now+3600000,duration:300,credits:"0",creditState:"cached",resetState:"unknown",unlimited:false,manualResets:0};
 const hosts=[{host:"agent-a",state:"cached",observedAt:now-4000000,omitted:2,accounts:[account]},{host:"agent-b",state:"cached",observedAt:now,omitted:0,accounts:[{...account,observedAt:now}]},{host:"laptop",state:"byte-budget",observedAt:null,omitted:0,accounts:[]},{host:"omarchy-pc",state:"error",observedAt:null,omitted:0,accounts:[]}];
 const snap={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[],tokens:{rate:null,coverage:"unknown"},quota:{state:"cached",accounts:[],hosts},hostSummary:[]};
 b.snapshot(snap);let html=b.elements.view!.innerHTML;
 assert.equal((html.match(/class="quota-account"/g)||[]).length,2);
 assert.match(html,/Observed by agent-a/);assert.match(html,/Observed by agent-b/);
 assert.equal(b.elements.view!.querySelectorAll(".quota-provider").length,2);assert.match(html,/account identity unverified/);
 assert.match(html,/0% used · 100% headroom/);assert.match(html,/aria-valuenow="0.00"/);
 assert.match(html,/Credits remaining 0/);assert.match(html,/0 manual resets available/);
 assert.match(html,/data-fresh="stale"/);assert.match(html,/usage observed 1h ago/);
 assert.match(html,/Quota withheld · host byte budget/);assert.match(html,/Quota source error/);
 assert.match(html,/2 account rows omitted/);assert.doesNotMatch(html,/undefined|NaN|financial|quality score/);
 b.snapshot({...snap,quota:{state:"cached",accounts:[account]}});html=b.elements.view!.innerHTML;
 assert.match(html,/Codex account 1/);assert.match(html,/Observed by Local/);
});

test("Events uses actual maintenance occurrence order, coverage and safe labels",()=>{
 const b=browser("https://board.example/?mode=events"),now=Date.now();
 const event=(host:string,job:string,status:string,occurredAt:number,receivedAt:number)=>({host,job,status,occurredAt,receivedAt,severity:status==="failed"?"fail":"info",title:"PRIVATE RAW TITLE",body:"PRIVATE RAW BODY",id:"PRIVATE ID"});
 const snap={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[],tokens:{rate:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[],events:{state:"cached",checkedAt:now,windowHours:48,rows:[event("older","chaldea-fleet-pull","changed",now-20000,now),event("newest <img>","chaldea-retention","failed",now-10000,now-20000)],truncated:true}};
 b.snapshot(snap);let html=b.elements.view!.innerHTML;
 assert.ok(html.indexOf("newest &lt;img&gt;")<html.indexOf("older"));
 assert.match(html,/Fleet pull/);assert.match(html,/Retention/);assert.match(html,/Occurred <time/);assert.match(html,/received <time/);
 assert.match(html,/48h window/);assert.match(html,/truncated; more runs may be omitted/);
 assert.doesNotMatch(html,/PRIVATE|<img>|exec jobs|healthy|idle/);
 b.snapshot({...snap,events:{...snap.events,rows:[],truncated:false}});html=b.elements.view!.innerHTML;
 assert.match(html,/No changed or failed timer runs observed in 48h/);
 b.snapshot({...snap,events:{...snap.events,state:"error",rows:[]}});assert.match(b.elements.view!.innerHTML,/source error/);
 b.snapshot({...snap,events:undefined});html=b.elements.view!.innerHTML;assert.match(html,/unknown · last checked unknown/);assert.doesNotMatch(html,/undefined|NaN/);
});

test("Ops distinguishes last checked, report occurrence, missing report and host resources",()=>{
 const b=browser("https://board.example/?mode=ops"),now=Date.now();
 const hostSummary=[{host:"agent-a",observedAt:now-120000,freshness:"stale",shown:0,total:0,states:{},models:[],resources:{state:"reported",sample:{sampledAt:now-120000,cpuUtilization:.96,cpuCount:8,totalMemoryBytes:4294967296,availableMemoryBytes:0}}}];
 const snap={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[],tokens:{rate:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary,events:{state:"cached",checkedAt:now,windowHours:48,rows:[],truncated:false},ops:{dailyHealth:{state:"cached",checkedAt:now,report:null}}};
 b.snapshot(snap);let html=b.elements.view!.innerHTML;
 assert.match(html,/No report in 48h/);assert.match(html,/last checked 0s ago/);
 assert.match(html,/CPU 96.0%/);assert.match(html,/RAM 4.0 \/ 4.0 GiB/);assert.match(html,/last known \/ stale/);
 assert.match(html,/aria-valuenow="100.00"/);assert.doesNotMatch(html,/healthy|free slots/);
 b.snapshot({...snap,ops:{dailyHealth:{state:"error",checkedAt:now,report:{status:"warning <script>",occurredAt:now-3600000,receivedAt:now-3000000,checks:[{name:"Disk <img>",status:"failed"}],omitted:3}}}});
 html=b.elements.view!.innerHTML;assert.match(html,/source error/);assert.match(html,/Report occurred <time/);
 assert.match(html,/warning &lt;script&gt;/);assert.match(html,/Disk &lt;img&gt;/);assert.match(html,/3 checks omitted/);
 assert.doesNotMatch(html,/<script>|<img>|No report in 48h/);
});

test("Lab groups only observed provider/model/reported effort/activity within each host",()=>{
 const b=browser("https://board.example/?mode=lab"),now=Date.now();
 const row=(host:string,driver:string,instanceId:string,state="working",source="reported")=>({id:host+instanceId+source,host,title:"Observed",model:"claude-model",state,observedAt:now,detailObservedAt:now,activityFreshness:"live",steps:[],detailCoverage:"reported",details:{provider:{driver,instanceId},effort:{value:"high",source}}});
 const agents=[row("agent-a","codex","custom"),row("agent-a","codex","custom"),row("agent-b","custom-driver","custom <img>","completed","configured"),{...row("agent-b","",""),details:undefined}];
 b.snapshot({version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents,tokens:{rate:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[]});
 const html=b.elements.view!.innerHTML;
 assert.match(html,/Observed thread set/);assert.match(html,/agent-a · 2 observed threads/);assert.match(html,/agent-b · 2 observed threads/);
 assert.match(html,/OpenAI Codex · custom/);assert.doesNotMatch(html,/Claude · custom/);
 assert.match(html,/custom-driver · custom &lt;img&gt;/);assert.match(html,/Provider unknown/);
 assert.match(html,/reported effort high/);assert.match(html,/completed · reported effort unknown/);
 assert.match(html,/AA quality scores disabled \/ unqualified/);assert.match(html,/Exec slots unknown/);
 assert.doesNotMatch(html,/<img>|benchmark|recommendation|available catalog|undefined/);
});

test("Overview renders four compact resource summaries without full host-card stacks",()=>{
 const b=browser(),now=Date.now();b.resize(1280,800);
 const hostSummary=["agent-a","agent-b","omarchy-pc","laptop"].map(host=>({host,observedAt:now,freshness:"live",shown:0,total:0,states:{},models:[],resources:{state:"reported",sample:{sampledAt:now,cpuUtilization:0,cpuCount:8,totalMemoryBytes:4294967296,availableMemoryBytes:1073741824}}}));
 b.snapshot({version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[],tokens:{rate:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary});
 assert.equal(b.elements.view!.getAttribute("tabindex"),"0");
 assert.equal(b.elements.view!.getAttribute("aria-label"),"Mission Control page");
 const html=b.elements.view!.querySelector(".p-hosts")!.innerHTML;
 assert.equal((html.match(/class="host-glance"/g)||[]).length,4);
 assert.equal((html.match(/role="meter"/g)||[]).length,8);
 assert.match(html,/CPU 0.0%/);assert.match(html,/RAM 3.0 \/ 4.0 GiB/);
 assert.doesNotMatch(html,/host-card|thread count|NOT OBSERVED/);
 const kpi=b.elements.view!.querySelector(".p-kpi")!.innerHTML;
 assert.equal((kpi.match(/class="stat /g)||[]).length,3);
 assert.match(kpi,/not connected/);
 const css=readFileSync(new URL("../../src/mission-control/static/core.css",import.meta.url),"utf8");
 assert.match(css,/#view.overview \{ grid-template-columns:minmax\(0,1.25fr\) minmax\(300px,1fr\)/);
 assert.match(css,/@media \(max-width:650px\)/);
});

test("active threads precede completed rows before Overview and mobile pagination",()=>{
 const b=browser("https://board.example/?mode=agents"),now=Date.now();b.resize(390,844);
 const states=["completed","idle","cancelled","working","thinking","waiting-igor","queued","waiting-ci"];
 const agents=states.map((state,i)=>({id:"priority-"+i,title:"Priority "+state,model:"sol",host:"agent-a",state,startedAt:now,observedAt:now,detailObservedAt:now-i*1000,activityFreshness:"live",freshness:"live",steps:[]}));
 const snap={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents,shown:8,total:8,truncated:false,tokens:{rate:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[]};
 b.snapshot(snap);
 const ordered=b.context.MC.orderThreads(agents).map((a:any)=>a.state);
 assert.deepEqual(Array.from(ordered),["working","thinking","waiting-igor","queued","waiting-ci","completed","idle","cancelled"]);
 assert.equal(agents[0]!.state,"completed");
 const seen:string[]=[];
 for(let i=0;i<8;i++){
   seen.push(...b.elements.view!.querySelectorAll(".tile").map(e=>e.getAttribute("data-thread-card")!));
   if(b.elements.view!.querySelector('[data-thread-page="1"]')!.getAttribute("aria-disabled")==="true")break;
   b.page(1);
 }
 assert.equal(new Set(seen).size,8);
 assert.equal(seen[0],"priority-3");assert.ok(seen.indexOf("priority-0")>seen.indexOf("priority-7"));
 b.click("overview");
 const overview=b.elements.view!.querySelector(".p-threads")!;
 assert.equal(overview.querySelectorAll(".overview-thread").length,2);
 assert.match(overview.textContent,/showing 2 of 8 observed threads/);
 assert.match(overview.textContent,/Priority working/);assert.doesNotMatch(overview.textContent,/Priority completed/);
 assert.match(overview.innerHTML,/href="\?mode=agents"/);
 const tied=[{...agents[3],id:"b"},{...agents[3],id:"a"}];
 assert.deepEqual(Array.from(b.context.MC.orderThreads(tied),(a:any)=>a.id),["a","b"]);
 b.snapshot({...snap,agents:[...agents].reverse()});assert.match(b.elements.view!.innerHTML,/Priority working/);
});

test("completed inactivity stays neutral only with fresh source evidence",()=>{
 const b=browser("https://board.example/?mode=agents"),now=Date.now();
 const row={id:"done",title:"Done",model:"sol",host:"agent-a",state:"completed",observedAt:now,detailObservedAt:now-3600000,activityFreshness:"stale",freshness:"live",steps:[]};
 const host={host:"agent-a",observedAt:now,freshness:"live",shown:1,total:1,states:{},models:[]};
 const snap={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[row],tokens:{rate:null,coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[host]};
 b.snapshot(snap);
 let card=b.elements.view!.querySelector(".tile")!;
 assert.equal(card.getAttribute("data-fresh"),"cached");assert.match(card.textContent,/Completed · last activity 1h 0m ago/);
 b.snapshot({...snap,hostSummary:[{...host,observedAt:now-120000}]});
 card=b.elements.view!.querySelector(".tile")!;
 assert.equal(card.getAttribute("data-fresh"),"stale");assert.match(card.textContent,/Source stale/);
 b.snapshot({...snap,source:{state:"disconnected",observedAt:now}});
 assert.match(b.elements.view!.querySelector(".card-fresh")!.textContent,/Source disconnected/);
 b.snapshot({...snap,agents:[{...row,state:"working"}]});
 assert.equal(b.elements.view!.querySelector(".tile")!.getAttribute("data-fresh"),"stale");
});

test("token unknown timestamps and unqualified coverage cannot imply freshness",()=>{
 const b=browser("https://board.example/?mode=tokens"),now=Date.now();
 const snap={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[],tokens:{rate:null,output:null,coverage:"unknown",observedAt:null},quota:{state:"unknown",accounts:[]},hostSummary:[]};
 b.snapshot(snap);
 assert.match(b.elements.view!.textContent,/oldest usage unknown/);
 assert.doesNotMatch(b.elements.view!.textContent,/unknowns ago/);
 assert.equal(b.elements.view!.querySelector(".p-thero")!.getAttribute("data-fresh"),"nosource");
 b.snapshot({...snap,tokens:{...snap.tokens,observedAt:now}});
 assert.equal(b.elements.view!.querySelector(".p-thero")!.getAttribute("data-fresh"),"nosource");
 b.snapshot({...snap,tokens:{...snap.tokens,coverage:"partial",observedAt:now}});
 assert.equal(b.elements.view!.querySelector(".p-thero")!.getAttribute("data-fresh"),"nosource","legacy process freshness cannot qualify transported usage");
});

test("Overview groups bounded readings into provider cards and links all observations",()=>{
 const b=browser(),now=Date.now();
 const hosts=["a","b","c","d"].map(host=>({host,state:"cached",observedAt:now,omitted:2,accounts:Array.from({length:4},(_,i)=>({label:(i<2?"codex":"claudeAgent")+" account "+i,used:i===0?0:i*20,state:"cached",observedAt:now}))}));
 b.snapshot({version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[],tokens:{coverage:"unknown"},quota:{state:"cached",accounts:[],hosts},hostSummary:[]});
 const quota=b.elements.view!.querySelector(".p-quota")!;
 assert.equal(quota.querySelectorAll(".quota-glance").length,2);
 assert.equal(quota.querySelectorAll(".quota-account").length,16);
 assert.match(quota.textContent,/0% used · 100% headroom/);assert.match(quota.textContent,/40% used · 60% headroom/);
 assert.match(quota.textContent,/account identity unverified/);
 assert.match(quota.textContent,/2 account rows omitted by source/);assert.match(quota.innerHTML,/href="\?mode=quota"/);
 b.click("quota");assert.equal(b.elements.view!.querySelectorAll(".quota-account").length,16);
});

test("sparse v4 fallback shares display selection and stable change evidence",async()=>{
 const {emptyDetail}=await import("../../src/mission-control/details.ts"),{compactDetail,normalizeRich}=await import("../../src/mission-control/detail-contract.ts");
 const now=Date.now(),d=emptyDetail();d.assistant={text:"Approved fallback",state:"reported"};
 const sparse=compactDetail(d);assert.equal(Object.hasOwn(sparse,"recent"),false);
 const decoded=normalizeRich({v:4,resources:{state:"unavailable",sample:null},details:[{id:"fallback",value:sparse}],omitted:0},new Set(["fallback"]),now).details[0]!.value;
 if(decoded.fieldCoverage==="identity-only")throw new Error("Expected full detail");
 assert.deepEqual(decoded.recent,[]);
 const b=browser("https://board.example/?mode=agents"),row={id:"fallback",title:"Fallback",host:"agent-a",model:"sol",state:"working",observedAt:now,detailObservedAt:now,activityFreshness:"live",freshness:"live",steps:[],details:decoded,detailCoverage:"reported"};
 const snap={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[row],tokens:{coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[]};
 const display=(details:any,coverage="reported")=>{b.snapshot({...snap,agents:[{...row,details,detailCoverage:coverage}]});return b.elements.view!.querySelector(".recent-activity")!.textContent;};
 const stamp=(details:any)=>b.context.MC.UI.agentChangeStamp({...row,details});
 assert.match(display(decoded),/Approved fallback/);
 const updated={...decoded,assistant:{text:"Changed fallback",state:"reported"}};
 assert.notEqual(stamp(decoded),stamp(updated));assert.match(display(updated),/Changed fallback/);assert.equal(b.animations.length,1);
 b.refresh();assert.equal(b.animations.length,1);
 const withheld={...decoded,recent:[{kind:"command",preview:{text:"PRIVATE",state:"withheld"},at:now,status:"running"}],commands:[{text:null,state:"withheld"}]};
 assert.match(display(withheld),/Approved fallback/);assert.doesNotMatch(display(withheld),/PRIVATE|Command/);
 const actual={...withheld,recent:[{kind:"command",preview:{text:"First actual",state:"redacted"},at:now,status:"completed"},{kind:"assistant",preview:{text:"Second actual",state:"truncated"},at:now-1000,status:"unknown"}]};
 assert.match(display(actual),/First actual.*Second actual/s);assert.match(display(actual),/redacted/);assert.match(display(actual),/truncated/);assert.doesNotMatch(display(actual),/Approved fallback/);
 assert.equal(stamp(actual),stamp({...actual,assistant:{text:"Hidden fallback change",state:"reported"}}));
 assert.equal(display({...withheld,assistant:{text:null,state:"withheld"}}),"Previews unavailable");
 assert.equal(display(decoded,"byte-budget"),"Previews unavailable");
});

test("quiet connected local streams remain live while sampled age and transport loss invalidate",()=>{
 const b=browser("https://board.example/?mode=agents"),now=Date.now(),old=now-120000;
 const agents=["completed","working"].map(state=>({id:state,title:state,host:"agent-a",model:"sol",state,observedAt:old,detailObservedAt:old,activityFreshness:"live",freshness:"live",steps:[]}));
 const host={host:"agent-a",observedAt:old,freshness:"live",shown:2,total:2,states:{},models:[]};
 const snap={version:1,demo:false,sampled:false,now,source:{state:"live",observedAt:old},agents,tokens:{coverage:"unknown"},quota:{state:"unknown",accounts:[]},hostSummary:[host]};
 const card=(id:string)=>b.elements.view!.querySelector('[data-thread-card="'+id+'"]')!;
 b.snapshot(snap);
 assert.equal(card("completed").getAttribute("data-fresh"),"cached");
 assert.equal(card("working").getAttribute("data-fresh"),"live");
 for(const id of ["completed","working"])assert.match(card(id).querySelector(".card-fresh")!.getAttribute("title")!,/source live · 2m ago/);
 b.snapshot({...snap,sampled:true});
 for(const id of ["completed","working"]){assert.equal(card(id).getAttribute("data-fresh"),"stale");assert.match(card(id).textContent,/Source stale/);}
 b.snapshot(snap);b.disconnect();
 for(const id of ["completed","working"]){assert.equal(card(id).getAttribute("data-fresh"),"stale");assert.match(card(id).textContent,/Source disconnected/);}
 b.snapshot(snap);assert.equal(card("working").getAttribute("data-fresh"),"live");
 b.context.Date=class extends Date{static override now(){return now+31000;}};
 b.refresh();
 for(const id of ["completed","working"])assert.match(card(id).textContent,/Source disconnected/);
});

test("Tokens uses retained transported detail usage with subsets, zeros, partial coverage and replacement",async()=>{
 const {emptyDetail}=await import("../../src/mission-control/details.ts");
 const b=browser("https://board.example/?mode=tokens"),now=Date.now();
 const d=emptyDetail();d.usage={...d.usage,input:100,output:20,total:120,cacheRead:30,cacheWrite:0,reasoning:5,turns:1,coverage:"observed",observedAt:now};
 const row={id:"usage",host:"agent-a",title:"Observed task",model:"known",state:"working",steps:[],freshness:"live",startedAt:now,observedAt:now,detailObservedAt:now,activityFreshness:"live",details:d,detailCoverage:"reported"};
 const snap={version:1,now,demo:false,source:{state:"live",observedAt:now},agents:[row],shown:1,total:1,truncated:false,hostSummary:[{host:"agent-a",details:{usage:d.usage}}],tokens:{output:987654321,rate:987654321,coverage:"observed",observedAt:now},quota:{state:"unknown",accounts:[]}};
 b.snapshot(snap);
 let text=b.elements.view!.textContent;
 assert.match(text,/Retained OBSERVED main-agent contributions/);
 assert.match(text,/120/);assert.match(text,/cache write.*input subset/);assert.match(text,/reasoning.*output subset/);
 assert.match(text,/1 usable turns \/ 1 usable threads/);assert.match(text,/eight turns per thread.*48 shown threads/);
 assert.match(text,/0.*cache write/);assert.doesNotMatch(text,/987654321|since process start|60 s average/);
 b.snapshot({...snap,agents:[row,row]});assert.match(b.elements.view!.textContent,/1 usable turns \/ 1 usable threads/);
 b.snapshot({...snap,total:2,agents:[row,{...row,id:"missing",detailCoverage:"byte-budget",details:undefined}]});
 text=b.elements.view!.textContent;assert.match(text,/Partial coverage/);assert.match(text,/1 shown threads missing usable usage/);assert.match(text,/1 \/ 2 threads report this field/);
 b.snapshot({...snap,source:{state:"stale",observedAt:now},agents:[{...row,activityFreshness:"stale",details:{...d,usage:{...d.usage,input:0,output:0,total:0,cacheRead:null,reasoning:null}}}]});
 text=b.elements.view!.textContent;assert.match(text,/source stale/);assert.match(text,/0 \/ 1 threads report this field/);assert.doesNotMatch(text,/120/);
 b.snapshot({...snap,agents:[{...row,details:{...d,fieldCoverage:"identity-only"}}]});
 text=b.elements.view!.textContent;assert.match(text,/0 usable turns \/ 0 usable threads/);assert.match(text,/Generation rate, p95, daily totals and model history unavailable/);
});

test("completion expiry uses actual time at 59.999s and 60s without data, clamps paging and keeps source evidence",()=>{
 const start=Date.parse("2026-10-20T00:00:00Z"),clock={now:start+59_999};
 const b=browser("https://board.example/?mode=agents&grid=2x2",false,clock);
 const states=["working","completed","completed","completed","completed","failed","cancelled","completed"];
 const agents=states.map((state,i)=>({id:"expiry-"+i,title:"Expiry "+i,model:"sol",host:"agent-a",state,completedAt:i===7?null:start,startedAt:start-1000,observedAt:clock.now,detailObservedAt:clock.now,activityFreshness:"live",freshness:"live",steps:[]}));
 const hostSummary=[{host:"agent-a",shown:8,total:8,truncated:false,observedAt:clock.now,freshness:"live",states:{completed:5,working:1,failed:1,cancelled:1},models:[]}];
 const snap={version:1,demo:false,sampled:true,now:clock.now,source:{state:"live",observedAt:clock.now},agents,shown:8,total:8,truncated:false,tokens:{output:123,rate:0,coverage:"observed"},quota:{state:"unknown",accounts:[]},hostSummary};
 b.snapshot(snap);
 assert.equal(b.context.DATA.threads.length,8);assert.match(b.elements.view!.textContent,/Page 1 of 2/);
 b.page(1);assert.match(b.elements.view!.textContent,/Page 2 of 2/);
 b.snapshot({...snap,now:clock.now}); // A refreshed sample cannot restart the lifetime.
 assert.equal(b.context.DATA.threads.length,8);
 b.tick(start+60_000); // Fires the shipped expiry timeout, with no new snapshot or interval tick.
 assert.equal(b.context.DATA.threads.length,4);
 assert.match(b.elements.view!.textContent,/Page 1 of 1/);
 assert.equal(b.elements.view!.querySelectorAll("[data-thread-card]").length,4);
 assert.match(b.elements.view!.textContent,/showing 4 of 4 observed threads/);
 assert.match(b.elements.view!.textContent,/4 completed hidden; 8 source rows retained/);
 assert.match(b.elements.view!.textContent,/completion time unknown; retained/);
 assert.deepEqual(Array.from(b.context.DATA.threads,(a:any)=>a.state),["working","failed","cancelled","completed"]);
 assert.equal(snap.agents.length,8);assert.equal(snap.hostSummary[0]!.shown,8);assert.equal(snap.tokens.output,123);
 b.click("agent-summary");assert.match(b.elements.view!.textContent,/shown 8 \/ 8/);
 b.click("tokens");assert.match(b.elements.view!.textContent,/shown 8 \/ 8 threads/);
 b.snapshot({...snap,now:clock.now,agents:agents.map((a,i)=>i===1?{...a,state:"working"}:a)});
 b.click("agents");assert.equal(b.context.DATA.threads.length,5);
 assert.ok(b.context.DATA.threads.some((a:any)=>a.id==="expiry-1"));
 b.click("overview");assert.doesNotMatch(b.elements.view!.querySelector(".p-threads")!.textContent,/Expiry [234]/);
});

test("provider summaries consistently select newest window observations without merging readings or borrowing host freshness",()=>{
 const start=Date.parse("2026-10-20T00:00:00Z"),clock={now:start},b=browser("https://board.example/?mode=quota",false,clock);
 const account=(label:string,used:number,observedAt:number|null,duration=300)=>({label,used,observedAt,state:"cached",duration,resetsAt:start+3600000,credits:"99",creditState:"cached",manualResets:9,resetState:"cached"});
 const hosts=[
  {host:"agent-b",state:"cached",observedAt:start,omitted:0,accounts:[account("codex account 1",10,start-2000),account("claudeAgent account 2",20,start-1000)]},
  {host:"agent-a",state:"cached",observedAt:start,omitted:0,accounts:[account("codex account 3",80,start-1000,10080),account("codex account 4",90,null),{...account("codex account 5",0,start),used:null,state:"unsupported"},account("claudeAgent account 1",70,start-3000)]}
 ];
 const snap={version:1,demo:false,sampled:true,now:start,source:{state:"live",observedAt:start},agents:[],tokens:{coverage:"unknown"},quota:{state:"cached",accounts:[],hosts},hostSummary:[]};
 b.snapshot(snap);
 const cards=b.elements.view!.querySelectorAll(".quota-provider");
 assert.equal(cards.length,2);
 const codex=cards.find(c=>c.textContent.includes("OpenAI Codex"))!,claude=cards.find(c=>c.textContent.includes("Claude"))!;
 const codexBody=codex.querySelector(".body")!,claudeBody=claude.querySelector(".body")!;
 assert.match(codexBody.textContent,/Newest window observation · agent-a · 0s ago · codex account 5/);
 assert.match(claudeBody.textContent,/Newest window observation · agent-b · 1s ago/);
 assert.match(codex.textContent,/80% used · 20% headroom/);assert.match(claude.textContent,/20% used · 80% headroom/);
 assert.equal(codex.querySelectorAll(".quota-account").length,4);assert.equal(claude.querySelectorAll(".quota-account").length,2);
 assert.match(codex.textContent,/10080 min window/);assert.match(codex.textContent,/90% used/);
 assert.match(codex.textContent,/Credits · agent-a.*nosource · observed unknown/);assert.match(codex.textContent,/Percentages are never added/);
 clock.now+=60_000;b.snapshot({...snap,now:clock.now,quota:{...snap.quota,hosts:hosts.slice().reverse().map(h=>({...h,observedAt:clock.now}))}});
 assert.match(b.elements.view!.querySelector(".quota-provider")!.textContent,/agent-a · 1m ago/);
 b.click("overview");const overview=b.elements.view!.querySelector(".p-quota")!;
 assert.equal(overview.querySelectorAll(".quota-glance").length,2);
 assert.match(overview.textContent,/Newest window observation · agent-a · 1m ago/);
 assert.match(overview.textContent,/Newest window observation · agent-b · 1m ago/);
 b.click("quota");
 b.snapshot({...snap,quota:{...snap.quota,hosts:hosts.map(h=>({...h,accounts:h.accounts.filter(a=>a.label.startsWith("codex"))}))}});
 assert.match(b.elements.view!.querySelectorAll(".quota-provider")[1]!.textContent,/Claude.*Usage unknown/);
});

test("local quota retains all 32 separate readings and provider errors across Quota and Overview",()=>{
 const start=Date.parse("2026-10-20T00:00:00Z"),b=browser("https://board.example/?mode=quota",false,{now:start});
 const accounts=Array.from({length:32},(_,i)=>({label:(i===31?"claudeAgent":"codex")+" account "+(i+1),used:i,observedAt:start-1000-i,state:"cached",duration:300,resetsAt:null,credits:null,manualResets:null}));
 const snap={version:1,demo:false,now:start,source:{state:"live",observedAt:start},agents:[],tokens:{coverage:"unknown"},quota:{state:"cached",accounts},hostSummary:[]};
 b.snapshot({...snap,quota:{state:"cached",accounts:[...accounts.slice(0,4),accounts[31]]}});
 assert.match(b.elements.view!.querySelectorAll(".quota-provider").find(c=>c.textContent.includes("Claude"))!.textContent,/31% used/);
 b.snapshot(snap);
 assert.equal(b.elements.view!.querySelectorAll(".quota-account").length,32);
 const claude=b.elements.view!.querySelectorAll(".quota-provider").find(c=>c.textContent.includes("Claude"))!;
 assert.match(claude.textContent,/31% used/);assert.match(claude.textContent,/1 separate readings/);
 assert.match(b.elements.view!.textContent,/31 separate readings/);
 b.click("overview");
 assert.equal(b.elements.view!.querySelector(".p-quota")!.querySelectorAll(".quota-account").length,32);
 assert.match(b.elements.view!.querySelector(".p-quota")!.textContent,/31% used/);
 for(const mode of ["quota","overview"]){
  b.click(mode);b.snapshot({...snap,quota:{state:"error",accounts:[]}});
  assert.match(b.elements.view!.textContent,/Quota source error/);
 }
});
test("hosted quota groups retain all 16 bounded hosts and enforce four readings per host",()=>{
 const start=Date.parse("2026-10-20T00:00:00Z"),b=browser("https://board.example/?mode=quota",false,{now:start});
 const hosts=Array.from({length:16},(_,h)=>({host:"host-"+h,state:"cached",observedAt:start,omitted:1,accounts:Array.from({length:5},(_,i)=>({label:(i===3?"claudeAgent":"codex")+" account "+i,used:i,observedAt:start-h,state:"cached"}))}));
 b.snapshot({version:1,demo:false,sampled:true,now:start,source:{state:"live",observedAt:start},agents:[],tokens:{coverage:"unknown"},quota:{state:"cached",accounts:[],hosts},hostSummary:[]});
 assert.equal(b.elements.view!.querySelectorAll(".quota-account").length,64);
 assert.match(b.elements.view!.textContent,/host-15/);assert.match(b.elements.view!.textContent,/account rows omitted by source/);
});

test("shared quota shows each native window, disagreement and missing coverage without opening details",async()=>{
 const {MissionModel}=await import("../../src/mission-control/model.ts"),{newProvider,applyT3,emptyHeadroom}=await import("../../src/quota/headroom.ts");
 const {captureSnapshot,quotaAccounts}=await import("../../src/mission-control/contract.ts");
 const now=Date.now(),ids=["five_hour","seven_day","seven_day_fable"];
 const account=(all:boolean)=>{
  const m=new MissionModel(false,()=>now);m.shell({kind:"snapshot",sequence:1,threads:[]});m.shell({kind:"synchronized"});
  const p=newProvider("PRIVATE","claudeAgent"),head=emptyHeadroom();
  applyT3(p,{usageLimits:{checkedAt:new Date(now-(all?100000:1000)).toISOString(),windows:(all?ids:ids.slice(0,1)).map((id,i)=>({id,kind:i?"weekly":"session",usedPercent:all?[8,90,43][i]!:12,windowDurationMins:i?10080:300}))}} as any);
  p.credits={state:"fresh",observedAt:new Date(now-(all?2000:5000)).toISOString(),error:null,source:"private",value:{balance:all?"250":"10",hasCredits:true,unlimited:false}};
  head.providers=[p];m.setQuota(head);
  return quotaAccounts(captureSnapshot(m,"agent-a","a".repeat(32),1)!.quota!,now)[0]!;
 };
 const a=account(true),b=account(false),hosts=[{host:"agent-a",state:"cached",observedAt:now,omitted:0,accounts:[a]},{host:"agent-b",state:"cached",observedAt:now,omitted:0,accounts:[b]},{host:"laptop",state:"unknown",observedAt:null,omitted:0,accounts:[]}];
 const snapshot={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[],tokens:{coverage:"unknown"},quota:{state:"cached",accounts:[],hosts},hostSummary:[]};
 for(const width of [390,1280]){
  const browserView=browser();browserView.resize(width,width===390?844:900);
  for(const mode of ["overview","quota"]){
   browserView.click(mode);browserView.snapshot(snapshot);
   const html=browserView.elements.view!.innerHTML.replace(/<details>[\s\S]*?<\/details>/g,"");
   for(const label of ["5 hour","7 day","7 day · Fable"])assert.ok(html.includes(label));
   assert.match(html,/90% used · 10% headroom/);assert.match(html,/43% used · 57% headroom/);
   assert.match(html,/12% used · 88% headroom/);assert.match(html,/Newest window observation · agent-b/);
   assert.match(html,/Newest window observation · agent-a/);assert.match(html,/1 \/ 2 account readings report this window/);
   assert.match(html,/Shared subscription · operator confirmed/);assert.match(html,/Host readings differ/);
   assert.match(html,/agent-a · claudeAgent account 1 · 8% used/);assert.match(html,/agent-b · claudeAgent account 1 · 12% used/);
   assert.match(html,/Credits · agent-a/);assert.match(html,/Credits remaining 250/);
   assert.match(html,/Source coverage/);assert.match(html,/laptop · unknown/);
   assert.doesNotMatch(html,/PRIVATE|undefined|NaN|total blocked|Credits unlimited/);
  }
  browserView.snapshot({...snapshot,quota:{...snapshot.quota,hosts:[{...hosts[0],accounts:[{...a,windows:a.windows!.slice(0,1),windowsOmitted:2}]}]}});
  const missing=browserView.elements.view!.innerHTML.replace(/<details>[\s\S]*?<\/details>/g,"");
  assert.match(missing,/7 day/);assert.match(missing,/Usage unknown · window not reported/);assert.match(missing,/2 windows omitted by source/);
 }
});

test("included exhaustion keeps credits and unknown provider observations distinct",()=>{
 const b=browser("https://board.example/?mode=quota"),now=Date.now();
 const account={label:"codex account 1",state:"fresh",observedAt:now,used:100,resetsAt:null,duration:300,credits:"125",creditState:"fresh",creditObservedAt:now-2000,resetState:"unknown",unlimited:false,manualResets:null,windows:[{id:"primary",used:100,resetsAt:null,duration:300,observedAt:now}]};
 const snap={version:1,demo:false,sampled:true,now,source:{state:"live",observedAt:now},agents:[],tokens:{coverage:"unknown"},quota:{state:"cached",accounts:[],hosts:[{host:"agent-a",state:"cached",observedAt:now,omitted:0,accounts:[account,{...account,label:"Provider account 2",credits:null,windows:[]}]}]},hostSummary:[]};
 b.snapshot(snap);const html=b.elements.view!.innerHTML.replace(/<details>[\s\S]*?<\/details>/g,"");
 assert.match(html,/100% used · 0% headroom/);assert.match(html,/Credits remaining 125/);
 assert.match(html,/Included usage and credits are separate/);assert.match(html,/Provider unknown/);assert.match(html,/Subscription context unknown/);
 assert.doesNotMatch(html,/blocked|Credits unlimited|PRIVATE|undefined|NaN/);
});
