// Fixed public window names. Native IDs outside this list never cross the browser boundary.
export const QUOTA_WINDOWS = {
  five_hour: {label:"5 hour",kind:"session"},
  seven_day: {label:"7 day",kind:"weekly"},
  seven_day_fable: {label:"7 day · Fable",kind:"weekly"},
  primary: {label:"Primary",kind:"other"},
  secondary: {label:"Secondary",kind:"other"},
  session: {label:"Session",kind:"session"},
  weekly: {label:"Weekly",kind:"weekly"},
  monthly: {label:"Monthly",kind:"monthly"},
} as const;
export const MAX_QUOTA_WINDOWS=8;
export type QuotaWindowId=keyof typeof QUOTA_WINDOWS;
export interface QuotaWindow {id:QuotaWindowId;used:number|null;resetsAt:number|null;duration:number|null;observedAt:number|null}
export const quotaWindowId=(id:unknown):id is QuotaWindowId=>typeof id==="string"&&Object.hasOwn(QUOTA_WINDOWS,id);
/** Drop unknown or duplicate IDs, never rename a private ID or infer its window. */
export function projectQuotaWindows(rows:ReadonlyArray<import("../quota/headroom.ts").Window>,observedAt:number|null,now:number):{windows:QuotaWindow[];windowsOmitted:number} {
  const windows:QuotaWindow[]=[],seen=new Set<string>(),duplicates=new Set<string>();
  for(const w of rows.slice(0,32)){if(seen.has(w.id))duplicates.add(w.id);seen.add(w.id);}
  for(const w of rows.slice(0,32)){
    if(!quotaWindowId(w.id)||duplicates.has(w.id)||windows.length>=MAX_QUOTA_WINDOWS)continue;
    const reset=w.resetsAt===null?null:Date.parse(w.resetsAt);
    windows.push({id:w.id,used:Number.isFinite(w.usedPercent)&&w.usedPercent>=0&&w.usedPercent<=100?w.usedPercent:null,
      resetsAt:reset!==null&&Number.isSafeInteger(reset)&&reset>0&&reset<=8_640_000_000_000_000?reset:null,
      duration:Number.isSafeInteger(w.windowDurationMins)&&w.windowDurationMins!>0&&w.windowDurationMins!<=525600?w.windowDurationMins:null,
      observedAt:observedAt!==null&&Number.isSafeInteger(observedAt)&&observedAt>0&&observedAt<=now?observedAt:null});
  }
  return {windows,windowsOmitted:rows.length-windows.length};
}
