// Admission owns native identity, quota pauses, children, questions and outcome.
import type { SessionStatus } from "../session/lifecycle.ts";
import { WorkerJournal } from "./store.ts";
import type { Assignment, Result } from "./protocol.ts";
export interface Admission {
  lookup(input: {threadId:string;requestId:string;preset:string}): Promise<SessionStatus | null>;
  start(input: {threadId:string;requestId:string;preset:string}): Promise<SessionStatus>;
  status(id:string): Promise<SessionStatus>;
}
export class Worker {
  readonly store: WorkerJournal;
  private readonly caller: string;
  private readonly admission: Admission;
  private readonly qualify: () => void;
  constructor(store: WorkerJournal,caller: string,admission: Admission,qualify: () => void) {
    this.store=store;this.caller=caller;this.admission=admission;this.qualify=qualify;
  }
  async recover(id: string,now: number): Promise<Result> {
    const row=this.store.get(id)!;
    if(row.closed)return JSON.parse(row.result!) as Result;
    const a=JSON.parse(row.assignment) as Assignment;
    const input={threadId:this.caller,requestId:a.requestId,preset:this.store.definition.preset};
    try {
      // Lookup is read-only: an expired lost answer must never become a new admission.
      let status=row.session ? await this.admission.status(row.session) : await this.admission.lookup(input);
      if(!status) {
        if(now>=a.expires)return this.store.observe(id,null,row.attempted?"uncertain":"expired");
        this.qualify(); // current protected preset/pin, immediately before every admission
        this.store.attempted(id);
        status=await this.admission.start(input);
      }
      return this.store.observe(id,status,"session");
    } catch {
      // Includes storage/RPC/authority failure after a possibly committed effect.
      // Do not claim failure, free the slot, or move the assignment elsewhere.
      const current=this.store.get(id)!;
      if(current.session && current.result)return JSON.parse(current.result) as Result;
      return this.store.observe(id,null,"uncertain");
    }
  }
}
