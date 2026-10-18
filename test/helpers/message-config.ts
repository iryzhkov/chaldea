import { join } from "node:path";
import type { ReceiverConfig } from "../../src/message-receiver.ts";
import type { BrokerConfig, Mapping } from "../../src/message-broker.ts";
export const transport:Mapping={commandSubject:"chaldea.message.command.pc.source.target",receiptSubject:"chaldea.message.receipt.pc.source.target",commandConsumer:"receive_pc",receiptConsumer:"source_pc"};
export const broker:BrokerConfig={url:"nats://127.0.0.1:1/",account:"MESSAGES",seedFile:"/absent-fixture-seed",publicKey:"U"+"A".repeat(55),
 inboxPrefix:"_INBOX_message.fixture",commandStream:"MESSAGE_COMMANDS",receiptStream:"MESSAGE_RECEIPTS"};
export function receiver(dir:string):ReceiverConfig {
 return {host:"target",environment:"fixture",loopbackT3Url:"http://127.0.0.1:1",tokenFile:join(dir,"token"),database:join(dir,"receipts.db"),
  logFile:join(dir,"events.jsonl"),broker,callers:{pc:{...transport,sourceHost:"source",publisherKey:broker.publicKey,threads:["thread"]}}};
}
