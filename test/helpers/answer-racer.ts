import { WakeStore } from "../../src/wake/store.ts";
const store=new WakeStore(process.argv[2]!,"test-env");
store.answer(process.argv[3]!,process.argv[4]!);
store.close();
