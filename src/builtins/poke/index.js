import {isOwner} from '../../core/owners.js';
import {createHash} from 'node:crypto';
export const manifest={id:'poke',name:'戳一戳互动',version:'1.0.0',apiVersion:2,services:['poke-interaction']};
export const pokeDefaults=()=>({mode:'text',textSource:'ai',text:'怎么啦？',cooldown:30,probability:100,autoPokeEnabled:false,pokeProbability:100,continueConversation:true,groups:[],users:[],private:true,group:true});
export function validatePokeConfig(value={}){
 const c={...pokeDefaults(),...value};if(!['text','poke','both','auto'].includes(c.mode)||!['ai','fixed'].includes(c.textSource))throw Error('互动方式无效');
 for(const key of ['autoPokeEnabled','continueConversation','private','group'])if(typeof c[key]!=='boolean')throw Error('互动开关无效');
 for(const [key,min,max]of [['cooldown',5,600],['probability',0,100],['pokeProbability',0,100]])if(!Number.isInteger(c[key])||c[key]<min||c[key]>max)throw Error('互动概率或冷却范围无效');
 if(typeof c.text!=='string'||!c.text.trim()||Array.from(c.text).length>80)throw Error('固定回应需为 1–80 字');
 for(const key of ['groups','users'])if(!Array.isArray(c[key])||c[key].length>200||c[key].some(x=>typeof x!=='string'||!/^\d{4,16}$/.test(x)))throw Error('互动范围无效');
 if(['poke','both'].includes(c.mode)&&!c.autoPokeEnabled)throw Error('请明确开启自动回戳许可');
 return c;
}
export function parsePokePlan(value){
 const raw=String(value||'').trim().replace(/^\x60\x60\x60(?:json)?\s*/, '').replace(/\x60\x60\x60\s*$/, '').trim();if(raw.length>2000||raw[0]!=='{')throw Error('互动决策格式无效');
 let depth=0,quoted=false,escaped=false,end=-1;for(let i=0;i<raw.length;i++){const ch=raw[i];if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0){end=i+1;break;}}
 if(end<0||/[{}]/.test(raw.slice(end)))throw Error('互动决策不完整或有多个对象');const d=JSON.parse(raw.slice(0,end));
 if(Object.keys(d).some(k=>!['reply','poke','text'].includes(k))||typeof d.reply!=='boolean'||typeof d.poke!=='boolean'||typeof d.text!=='string'||Array.from(d.text).length>80)throw Error('互动决策字段无效');return d;
}

export class PokePackage{
 constructor(store,services,{now=()=>Date.now(),random=Math.random}={}){Object.assign(this,{store,services,now,random});this.cooldowns=new Map();this.plans=new Map();}
 config(){return {...pokeDefaults(),...this.store.data.framework.builtins.poke?.config};}
 active(){const p=this.store.data.framework.builtins.poke;return !!p?.enabled&&!p.uninstalled&&this.store.data.settings.pokeReplyEnabled!==false;}
 async back(event,msg,c){const generation=this.store.data.framework.generation;if(!c.autoPokeEnabled||this.random()*100>=c.pokeProbability)return null;try{const r=await this.services.back(event,()=>this.active()&&this.config().autoPokeEnabled);if(r.outcome==='confirmed'&&c.continueConversation&&this.active()&&this.store.data.framework.generation===generation)this.services.continued(msg);return r;}catch(e){this.services.log('warn','回戳未完成：'+e.message);return null;}}
 async handle(event){
  const s=this.store.data.settings,f=this.store.data.framework,c=this.config();
  if(!this.active()||event.type!=='notice'||event.name!=='notify'||event.subtype!=='poke'||event.target!==event.bot||event.user===event.bot||!/^\d{4,16}$/.test(event.user||'')||!s.enabled||!f.listenNotices||f.paused||!Number.isFinite(event.time)||Math.abs(this.now()/1000-event.time)>300||this.services.bot()?.status.bot!==event.bot)return false;
  if(event.kind==='group'?!f.listenGroups.includes(event.peer):!isOwner(f,event.user)&&(!f.listenPrivate||!f.listenAllPrivate&&!f.listenUsers.includes(event.user)))return false;
  if(event.kind==='group'&&!c.group||event.kind==='private'&&!c.private||c.groups.length&&event.kind==='group'&&!c.groups.includes(event.peer)||c.users.length&&!c.users.includes(event.user))return false;
  const msg={type:'message',interaction:'poke',bot:event.bot,user:event.user,kind:event.kind,peer:event.peer,key:event.key,time:event.time,id:'poke-'+createHash('sha256').update([event.key,event.user,event.target,event.time,event.id].join('|')).digest('hex').slice(0,24),sender:event.user,text:'[戳一戳] 对方戳了你一下。',mentions:[event.bot],parts:[],replyable:false,pokeContinue:c.continueConversation};
  if(this.services.access(msg)||this.random()*100>=c.probability)return false;
  const now=this.now(),key=event.key+'|'+event.user,roomKey='room|'+event.key,last=this.cooldowns.get(key)||0,room=this.cooldowns.get(roomKey);
  if(now-last<c.cooldown*1000||room&&(room.pending||now-room.at<10000))return false;
  this.cooldowns.set(key,now);const state={at:now,pending:true};this.cooldowns.set(roomKey,state);if(this.cooldowns.size>2000)for(const k of [...this.cooldowns.keys()].slice(0,200))this.cooldowns.delete(k);
  try{
   if(['poke','both'].includes(c.mode))await this.back(event,msg,c);
   if(c.mode==='poke'){state.pending=false;return true;}
   const ai=this.services.canAI();
   if(c.mode==='auto'&&ai){msg.pokePlan=true;this.plans.set(msg.id,{event,msg,config:c});}
   else if(c.textSource==='fixed'||!ai)msg.pokeFixedText=c.text;
   await this.services.deliver(msg);const pending=this.services.pending(msg.key);if(pending)void pending.finally(()=>{state.pending=false;this.plans.delete(msg.id);}).catch(()=>{});else{state.pending=false;this.plans.delete(msg.id);}return true;
  }catch(e){state.pending=false;this.plans.delete(msg.id);throw e;}
 }
 async resolve(msg,value){const plan=this.plans.get(msg.id);if(!plan||!this.active())return {text:'',skip:true};
  try{const parsed=parsePokePlan(value),result=parsed.poke?await this.back(plan.event,plan.msg,plan.config):null;return {text:parsed.reply?parsed.text:'',skip:!parsed.reply||!parsed.text.trim(),decision:{reply:parsed.reply,pokeRequested:parsed.poke,poke:result?.outcome==='confirmed',pokeOutcome:result?.outcome||(parsed.poke?'not-sent':'none')}};
  }catch(e){this.services.log('warn','互动决策未采用：'+e.message);return {text:plan.config.text,skip:false};}
 }
}
