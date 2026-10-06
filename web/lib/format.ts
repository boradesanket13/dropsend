export function formatBytes(n:number):string {
  if (!n) return "0 B";
  const units=["B","KB","MB","GB","TB"], i=Math.min(Math.floor(Math.log(n)/Math.log(1024)),4);
  return `${(n/1024**i).toFixed(i?1:0)} ${units[i]}`;
}
export function newRoomId():string {
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), b=>chars[b%chars.length]).join("");
}
