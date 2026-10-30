const qq=/^[1-9]\d{3,15}$/;
const positive=(n,f,min,max)=>Number.isInteger(n)&&n>=min&&n<=max?n:f;
export function continuationLimits(s={}){return {windowMs:positive(s.followupWindowSec,120,15,300)*1000,turns:positive(s.followupMaxTurns,8,1,20),maxAgeMs:600000};}
// This ledger stores attention only. Execution identity always comes from a new gateway message.
export class Continuation{
 constructor(data={},now=()=>Date.now()){this.data=data;this.now=now;}
 get(msg,s){const f=this.data[msg.key]?.[msg.user],now=this.now(),limit=continuationLimits(s);
  if(!f||f.actor!==msg.user||!qq.test(f.actor)||!Number.isFinite(f.openedAt)||!Number.isFinite(f.lastReplyAt)||!Number.isInteger(f.used)||f.used<0||now<f.openedAt||now-f.openedAt>=limit.maxAgeMs||now-f.lastReplyAt>=limit.windowMs||f.used>=limit.turns)return null;
  return {...f,until:Math.min(f.lastReplyAt+limit.windowMs,f.openedAt+limit.maxAgeMs),remaining:limit.turns-f.used};
 }
 use(msg,s){const f=this.get(msg,s);if(!f)return null;this.data[msg.key][msg.user].used++;return f;}
 replied(msg,wake,s){if(s.followupEnabled===false)return null;const direct=wake?.direct||wake?.poke||wake?.pending,follow=wake?.reason==='followup';if(!direct&&!follow)return null;
  const previous=this.get(msg,s);if(!direct&&!previous)return null;const now=this.now();
  for(const [key,room]of Object.entries(this.data)){for(const [actor,f]of Object.entries(room))if(!f||!Number.isFinite(f.lastReplyAt)||now-f.lastReplyAt>300000||now-f.openedAt>=600000)delete room[actor];if(!Object.keys(room).length)delete this.data[key];}
  if(!this.data[msg.key]&&Object.keys(this.data).length>=64){const oldest=Object.keys(this.data).sort((a,b)=>Math.max(...Object.values(this.data[a]).map(f=>f.lastReplyAt))-Math.max(...Object.values(this.data[b]).map(f=>f.lastReplyAt)))[0];delete this.data[oldest];}
  const room=this.data[msg.key]??={};room[msg.user]={actor:msg.user,openedAt:direct?now:previous.openedAt,lastReplyAt:now,used:direct?0:previous.used,source:wake?.poke?'poke':direct?'called':previous.source};
  const actors=Object.keys(room).sort((a,b)=>room[a].lastReplyAt-room[b].lastReplyAt);while(actors.length>8)delete room[actors.shift()];return this.get(msg,s);
 }
 clear(key){delete this.data[key];}
}
