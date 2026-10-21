// Isolated placement transport for the M3 spike. Management stays in fixture setup.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, nkeys, nkeyAuthenticator, createInbox, type NatsConnection, type Msg } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, AckPolicy, StorageType, RetentionPolicy, DiscardPolicy } from "@nats-io/jetstream";
const STREAM = { command: "PLACEMENT_COMMANDS", result: "PLACEMENT_RESULTS" } as const;
const PROOF_SUBJECT = { command: "davinci.assignment.worker_a", result: "davinci.result.worker_a" } as const;
const CONSUMER = { command: "worker_a", result: "coordinator" } as const;
type Kind = keyof typeof STREAM;
const next = (kind: Kind) => "$JS.API.CONSUMER.MSG.NEXT." + STREAM[kind] + "." + CONSUMER[kind];
export async function broker(root: string,runtime=false) {
  const SUBJECT=runtime?{command:"chaldea.davinci.assignment.worker_a",result:"chaldea.davinci.result.worker_a"}:PROOF_SUBJECT;
  const inbox=runtime?"_INBOX_davinci":"_INBOX_dv";
  assert.ok(process.env.NATS_SERVER, "pinned isolated NATS required");
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = (listener.address() as {port:number}).port;
  await new Promise<void>(r => listener.close(() => r()));
  const url = "nats://127.0.0.1:" + port, config = join(root, "placement.conf");
  const keys = { coordinator: nkeys.createUser(), worker: nkeys.createUser() };
  const consume = (kind: Kind) => [next(kind), "$JS.ACK." + STREAM[kind] + "." + CONSUMER[kind] + ".>"];
  writeFileSync(config, JSON.stringify({ host: "127.0.0.1", port,
    jetstream: { store_dir: join(root, "placement-broker"), max_file_store: 8*1024*1024, max_memory_store: 1024*1024 },
    accounts: { [runtime?"DAVINCI":"PLACEMENT"]: { jetstream: "enabled", users: [
      { user: "fixture-admin", password: "synthetic-only" },
      { nkey: keys.coordinator.getPublicKey(), permissions: { publish: [SUBJECT.command, ...consume("result")], subscribe: [inbox+".coordinator.>"] } },
      { nkey: keys.worker.getPublicKey(), permissions: { publish: [SUBJECT.result, ...consume("command")], subscribe: [inbox+".worker.>"] } },
    ] } },
  }), {mode:0o600});
  let server: ChildProcess | undefined, errors = "";
  const clients = new Set<NatsConnection>();
  async function start() {
    errors = "";
    server = spawn(process.env.NATS_SERVER!, ["-c", config], {stdio:["ignore","ignore","pipe"]});
    server.stderr!.on("data", b => { errors = (errors + b.toString()).slice(-4096); });
    for (let n=0;n<100;n++) {
      try {
        const admin = await connect({servers:url,user:"fixture-admin",pass:"synthetic-only",reconnect:false,timeout:100});
        clients.add(admin); return admin;
      } catch { assert.equal(server.exitCode,null,errors); await new Promise(r=>setTimeout(r,30)); }
    }
    throw new Error("broker_start_timeout");
  }
  async function stop() {
    for (const nc of clients) await nc.close(); clients.clear();
    if (server && server.exitCode === null) { const done = once(server,"close"); server.kill("SIGTERM"); await done; }
  }
  const admin = await start(), manager = await jetstreamManager(admin);
  for (const kind of ["command","result"] as const) {
    await manager.streams.add({ name: STREAM[kind], subjects:[SUBJECT[kind]], storage:StorageType.File,
      retention:RetentionPolicy.Workqueue, discard:DiscardPolicy.New, max_bytes:1024*1024,max_msgs:runtime?1:32,
      max_msg_size:8192,max_age:3600e9,max_consumers:1,num_replicas:1,duplicate_window:1e9 });
    await manager.consumers.add(STREAM[kind], { durable_name:CONSUMER[kind],filter_subject:SUBJECT[kind],
      ack_policy:AckPolicy.Explicit,ack_wait:300e6,max_deliver:8,max_ack_pending:1,max_waiting:2,max_batch:1,max_expires:1e9 });
  }
  async function client(who: keyof typeof keys) {
    const nc = await connect({servers:url,authenticator:nkeyAuthenticator(keys[who].getSeed()),
      inboxPrefix:inbox+"."+who,reconnect:false,timeout:1000});
    clients.add(nc); return nc;
  }
  async function publish(nc:NatsConnection,kind:Kind,bytes:string) {
    const ack = await jetstream(nc,{timeout:2000}).publish(SUBJECT[kind],Buffer.from(bytes),{expect:{streamName:STREAM[kind]}});
    assert.equal(ack.stream,STREAM[kind]);
  }
  async function take(nc:NatsConnection,kind:Kind):Promise<Msg> {
    const sub = nc.subscribe(createInbox(inbox+"." + (kind === "command" ? "worker" : "coordinator")),{max:1,timeout:5000});
    try {
      nc.publish(next(kind),JSON.stringify({batch:1,expires:1e9}),{reply:sub.getSubject()});
      for await (const m of sub) {
        if (m.headers?.code && m.headers.code >= 300) throw new Error("fixture_pull_"+m.headers.code);
        assert.equal(m.subject,SUBJECT[kind]);return m;
      }
      throw new Error("fixture_missing_delivery");
    } finally { sub.unsubscribe(); }
  }
  async function ack(nc:NatsConnection,kind:Kind,m:Msg) {
    const reply = m.reply;
    assert.ok(reply && reply.startsWith("$JS.ACK."+STREAM[kind]+"."+CONSUMER[kind]+"."));
    nc.publish(reply,"+ACK");await nc.flush();
  }
  async function inspect(kind:Kind,bytes?:string) {
    const nc=await connect({servers:url,user:"fixture-admin",pass:"synthetic-only",reconnect:false});
    try {
      if(bytes!==undefined)await publish(nc,kind,bytes);
      return (await (await jetstreamManager(nc)).streams.info(STREAM[kind])).state.messages;
    } finally {await nc.close();}
  }
  async function expiry(kind:Kind,short:boolean) {
    const nc=await connect({servers:url,user:"fixture-admin",pass:"synthetic-only",reconnect:false});
    try {await (await jetstreamManager(nc)).streams.update(STREAM[kind],{max_age:short?1e9:3600e9,duplicate_window:short?100e6:1e9});}
    finally {await nc.close();}
  }
  return {client,publish,take,ack,inspect,expiry,runtimeConfig(who:keyof typeof keys) {
    const seedFile=join(root,who+".seed");
    writeFileSync(seedFile,keys[who].getSeed(),{mode:0o600});
    return {broker:{url:url+"/",account:"DAVINCI",seedFile,publicKey:keys[who].getPublicKey(),
      inboxPrefix:inbox+"."+who,commandStream:STREAM.command,receiptStream:STREAM.result},
      mapping:{commandSubject:SUBJECT.command,receiptSubject:SUBJECT.result,
        commandConsumer:CONSUMER.command,receiptConsumer:CONSUMER.result}};
  },async restart(){await stop();await start();},
    async close(){await stop();keys.coordinator.clear();keys.worker.clear();}};
}
