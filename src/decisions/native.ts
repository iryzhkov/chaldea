// Native answers stay in T3. Chaldea owns only policy, deadlines and immutable response intent.
import type { NativeRequest, WaitSnapshot } from "../t3/waits.ts";
import { WakeStore, type Item, type Delivery } from "../wake/store.ts";
import type { NativeDecisionInput, Outcome } from "../waits/types.ts";

/** Persist only answer-routing fields; bounded history may later omit the turn item. */
export function questionSchema(questions:NativeRequest["questions"]):string|null{
  if(!questions.length || questions.length>8 || new Set(questions.map(q=>q.id)).size!==questions.length)return null;
  const schema=JSON.stringify(questions.map(q=>({id:q.id,allowCustomAnswer:q.allowCustomAnswer!==false,multiSelect:!!q.multiSelect,
    options:q.allowCustomAnswer===false?q.options.map(o=>({label:o.label,...(o.value===undefined?{}:{value:o.value})})):[]})));
  return Buffer.byteLength(schema)<=4096?schema:null;
}
export function nativeResponse(item: Item, request: NativeRequest): string | null {
  if (request.kind !== "user_input" || !request.questions.length || request.questions.length>8) return null;
  const input=JSON.parse(item.input) as NativeDecisionInput;
  const text="No answer by the deadline: "+input.defaultAction+" "+input.dependentAction;
  const answers:Record<string,string|string[]>=Object.create(null);
  for(const q of request.questions){
    if (q.allowCustomAnswer !== false) answers[q.id]=text;
    else {
      // Match the declared action exactly, including an option's wire value.
      // Prose such as "skip checks and approve" is never a safe fixed option.
      const option=q.options.find(o=>o.label.trim().toLowerCase()===input.defaultAction &&
        (o.value === undefined || o.value.trim().toLowerCase()===input.defaultAction));
      if (!option) return null;
      const value=option.value??option.label;answers[q.id]=q.multiSelect && request.capability!=="message"?[value]:value;
    }
  }
  const payload=JSON.stringify({type:"runtime-request.respond",commandId:"chaldea-native:"+item.id+":default",
    threadId:item.parent,requestId:request.id,answers});
  return Buffer.byteLength(payload)<=4096 ? payload : null;
}
export class NativeDecisions {
  private store:WakeStore;
  private phone:(item:Item)=>string;
  private boundary:((name:string,id:string)=>void)|undefined;
  constructor(store:WakeStore,phone:(item:Item)=>string,boundary?: (name:string,id:string)=>void){
    this.store=store;this.phone=phone;this.boundary=boundary;
  }
  private delivery(id:string):Delivery|undefined{return this.store.deliveries().find(d=>d.item===id&&d.channel==="native");}
  private savedRequest(item:Item,request:NativeRequest):NativeRequest{
    const schema=this.store.native(item.id).questions;
    return schema?{...request,questions:JSON.parse(schema)}:request;
  }
  private outcome(item:Item,request:Pick<NativeRequest,"id">,defaulted=false):Outcome{
    const input=JSON.parse(item.input) as NativeDecisionInput;
    return {reason:defaulted?"native_default":"native_answered",defaulted,
      source:defaulted?"chaldea":"t3",runtimeRequestId:request.id,...(defaulted?{action:input.defaultAction}:{})};
  }
  finish(item:Item,request:Pick<NativeRequest,"id">,defaulted=false):void{
    this.store.finishNative(item.id,this.outcome(item,request,defaulted),defaulted);
    this.boundary?.("resolved",item.id);
  }
  attention(item:Item,detail:string,responseState="suppressed"):void{
    const input=JSON.parse(item.input) as NativeDecisionInput;
    this.store.nativeAttention(item.id,{reason:"native_needs_attention",detail,action:input.defaultAction,
      ...(this.store.native(item.id).request_id ? {runtimeRequestId:this.store.native(item.id).request_id!} : {})},responseState);
    this.boundary?.("resolved",item.id);
  }
  reconcile(item:Item,snapshot:WaitSnapshot,now:number):void{
    let policy=this.store.native(item.id);
    if (!policy.request_id){
      const baseline=new Set<string>(JSON.parse(policy.baseline));
      // Include requests already answered during downtime: never bind a later
      // unrelated question just because the first one has left pending state.
      const request=(snapshot.requests??[]).filter(r=>r.kind==="user_input" && !baseline.has(r.id) &&
        r.created>=item.created && r.created<=policy.bind_until).sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id))[0];
      if(request){
        if(!this.store.bindNative(item.id,request.id,this.phone(item),now,questionSchema(request.questions),request.itemId??null))return;
        this.boundary?.("native_bound",item.id);policy=this.store.native(item.id);
      }else{
        if(now>=policy.bind_until)this.store.finishNative(item.id,{reason:"preparation_expired"});
        return;
      }
    }
    const delivery=this.delivery(item.id);
    // A wire attempt may have committed. Replay the immutable command to learn
    // its durable receipt before classifying a resolved request as human-owned.
    if(delivery && delivery.attempts>0)return;
    const request=snapshot.requests?.find(r=>r.id===policy.request_id);
    if(!request){this.attention(item,"request_missing");return;}
    if(request.kind!=="user_input"){this.attention(item,"permission_request_ignored");return;}
    if(request.status==="resolved"){this.finish(item,request);return;}
    if(request.status!=="pending"){this.attention(item,"request_"+request.status);return;}
    if(request.capability==="not_resumable"){this.attention(item,"request_not_resumable");return;}
    if(!policy.questions || (!policy.turn_item && request.itemId)){
      const schema=questionSchema(request.questions);if(schema || request.itemId)this.store.captureNative(item.id,schema,request.itemId??null);
    }
    if(!this.store.deliveries().some(d=>d.item===item.id&&d.channel==="phone"))this.store.nativePhone(item.id,this.phone(item));
    if(now>=item.deadline && !delivery){
      const payload=nativeResponse(item,this.savedRequest(item,request));
      if(!payload){this.attention(item,"no_safe_answer_for_question_schema");return;}
      if(this.store.queueNative(item.id,payload))this.boundary?.("native_queued",item.id);
    }
  }
  deadline(item:Item):number|undefined{
    const policy=this.store.native(item.id);
    return !policy.request_id ? policy.bind_until : this.delivery(item.id) ? undefined : item.deadline;
  }
  beforeSend(item:Item,delivery:Delivery,snapshot:WaitSnapshot):boolean{
    if(this.store.get(item.id).state!=="parked")return false;
    const request=snapshot.requests?.find(r=>r.id===this.store.native(item.id).request_id);
    if(delivery.attempts===0){
      this.reconcile(item,snapshot,Date.now());
      if(this.store.get(item.id).state!=="parked")return false;
    }
    if(request?.kind && request.kind!=="user_input"){
      this.attention(item,"permission_request_ignored",delivery.attempts?"uncertain":"suppressed");return false;
    }
    if(request?.status==="pending" && request.capability!=="not_resumable" &&
        nativeResponse(item,request.questions.length?request:this.savedRequest(item,request))!==delivery.payload){
      this.attention(item,"question_schema_changed",delivery.attempts?"uncertain":"suppressed");return false;
    }
    return true;
  }
  accepted(item:Item):void{
    const id=this.store.native(item.id).request_id!;
    this.finish(item,{id},true);
  }
  rejected(item:Item,snapshot:WaitSnapshot):void{
    const request=snapshot.requests?.find(r=>r.id===this.store.native(item.id).request_id);
    if(request?.kind==="user_input" && request.status==="resolved")this.finish(item,request);
    else this.attention(item,request?.capability==="not_resumable" ? "request_not_resumable" : "response_rejected","blocked");
  }
}
