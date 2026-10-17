// Private, size/age bounded log. Event names only: no URLs, answers or exception text.
import { openSync, readSync, statSync, closeSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function boundedLog(path: string): (event: string) => void {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  let lines=0; let window=Date.now();
  return event => {
    const now=Date.now();
    if(now-window>=60_000){window=now;lines=0;}
    if(++lines>120)return;
    try {
      const stat=statSync(path); const fd=openSync(path,"r");
      const bytes=Buffer.alloc(128); try {readSync(fd,bytes,0,128,0);} finally {closeSync(fd);}
      const match=/"at":(\d+)/.exec(bytes.toString());
      if(stat.size>10*1024*1024-1024 || (match && now-Number(match[1])>14*86_400_000)) writeFileSync(path,"",{mode:0o600});
    } catch {}
    appendFileSync(path,JSON.stringify({at:now,event})+"\n",{mode:0o600});
  };
}
