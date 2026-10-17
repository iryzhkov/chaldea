import { WakeStore } from "../../src/wake/store.ts";
const end=Date.now()+4000;
for(;;){
  let store:WakeStore|undefined;
  try {
    store=new WakeStore(process.argv[2]!,"test-env");
    store.answer(process.argv[3]!,process.argv[4]!);
    break;
  } catch(error) {
    if(Date.now()>end || !(error instanceof Error) || !/checkpoint blocked|database is locked/.test(error.message))throw error;
    await new Promise(r=>setTimeout(r,10));
  } finally {store?.close();}
}
