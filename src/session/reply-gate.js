import {Continuation} from './continuation.js';
const pureMedia=text=>/^(?:\[(?:图片|语音|视频|文件|QQ 表情|合并转发)\]\s*)+$/.test(text);
const stop=new Set(['什么','怎么','这个','那个','可以','知道','一下','不是','就是','这样','我们','你们','他们','的是','了吧','现在','没有','一个','回复','消息','普通','聊天']);
function topicTerms(value){
 const result=new Set();
 for(const part of String(value||'').slice(0,800).match(/[A-Za-z][\w-]{2,}|[\u3400-\u9fff]{2,}/g)||[]){
  if(/^[A-Za-z]/.test(part))result.add(part.toLowerCase());
  else for(let i=0;i<part.length-1&&result.size<160;i++){const word=part.slice(i,i+2);if(!stop.has(word))result.add(word);}
 }
 return [...result].slice(0,160);
}
function addressed(text){return /^(?:(?:那|所以|不过|诶|欸|哎|对了|话说)[，,\s]*)?你(?!们)/.test(text)||/^(?:真的假的|真的吗|然后呢|为什么(?:呢)?|怎么说|什么意思|啥意思|展开说说|细说|继续说)[?？!！。 ]*$/.test(text);}
function continuing(msg,scene){
 const text=String(msg.text||'').trim();if(!text||text.length>250||pureMedia(text))return false;
 if(addressed(text))return true;
 if(scene.actor===msg.user)return false;
 const question=/[?？]|[吗么呢][！!。 ]*$/.test(text),connect=/^(?:那|我也|这个|这么|还是|确实)/.test(text);
 return (question||connect)&&scene.terms.some(word=>text.toLowerCase().includes(word));
}
export class ReplyGate{
 constructor({now=()=>Date.now(),random=Math.random,continuations={}}={}){this.continuation=new Continuation(continuations,now);this.now=now;this.random=random;this.groups=new Map();}
 decide(msg,s,{quoted=false,control=false,fixed=false,pending=false}={}){
  if(msg.kind!=='group'||control||fixed)return {allow:true,reason:control?'management':fixed?'plugin':'private',ambient:false,release:()=>{}};
  const mode=s.groupReplyMode||(s.groupMentionOnly?'direct':'all'),now=this.now(),key=msg.key;
  let state=this.groups.get(key);if(!state){state={last:0,recent:[],pending:false,follow:null,scene:null,social:[],lastContext:null};this.groups.set(key,state);if(this.groups.size>1000)this.groups.delete(this.groups.keys().next().value);}
  const aliases=s.botAliases||[],called=aliases.some(a=>msg.text.includes(a));
  const direct=msg.mentions?.includes(msg.bot)||quoted||called&&s.intentRecognition!==true;
  if(direct)return {allow:true,reason:quoted?'quoted':called?'called':'mentioned',ambient:false,direct:true,release:()=>{}};
  if(msg.mentions?.some(id=>id!==msg.bot)&&s.intentRecognition!==true)return {allow:false,reason:'正在与其他成员交谈'};
  if(msg.reply&&s.intentRecognition!==true)return {allow:false,reason:'正在回复其他成员'};
  if(s.followupEnabled!==false&&pending)return {allow:true,reason:'followup',intent:s.intentRecognition===true,pending:true,ambient:false,release:()=>{}};
  const follow=s.followupEnabled!==false?this.continuation.use(msg,s):null;
  if(follow){state.follow=this.continuation.get(msg,s)||{...follow,remaining:0};return {allow:true,reason:'followup',intent:s.intentRecognition===true,ambient:false,release:()=>{}};}
  if(mode!=='all'&&pureMedia(msg.text))return {allow:false,reason:'纯媒体不随机插话'};
  const scene=state.scene;
  if(mode!=='all'&&s.followupEnabled!==false&&scene&&scene.until>now&&scene.remaining>0&&continuing(msg,scene)){
   state.social=state.social.filter(t=>now-t<60000);
   if(scene.pending)return {allow:false,reason:'本群正在接话，等待本轮完成'};
   if(state.social.length>=3)return {allow:false,reason:'本群接话达到每分钟上限'};
   if(state.lastContext!==null&&now-state.lastContext<3000)return {allow:false,reason:'接话间隔中'};
   scene.remaining--;scene.pending=true;state.social.push(now);state.lastContext=now;
   return {allow:true,reason:'context',intent:s.intentRecognition===true,contextual:true,ambient:false,release:()=>{scene.pending=false;}};
  }
  if(s.intentRecognition===true){return {allow:true,reason:called?'called':'intent',intent:true,contextual:true,ambient:false,release:()=>{}};}
  if(mode==='direct')return {allow:false,reason:'等待 @、引用、叫名或同群接话'};
  if(mode==='all')return {allow:true,reason:'all',ambient:false,release:()=>{}};
  const recent=state.recent.filter(t=>now-t<60000);state.recent=recent;
  if(state.pending)return {allow:false,reason:'本群已有随机回复任务'};
  if(state.last&&now-state.last<(s.groupReplyCooldown??30)*1000)return {allow:false,reason:'随机回复冷却中'};
  if(recent.length>=(s.groupAutoLimit??2))return {allow:false,reason:'本群随机回复达到每分钟上限'};
  if(this.random()*100>=(s.groupReplyProbability??10))return {allow:false,reason:'本条未命中回复概率'};
  state.last=now;state.recent.push(now);state.pending=true;
  return {allow:true,reason:'ambient',ambient:true,release:()=>{state.pending=false;}};
 }
 admitIntent(msg,wake,s,d){
  if(d.reason==='addressed'){wake.direct=true;wake.contextual=false;wake.ambient=false;return true;}
  if(d.reason!=='related'||(s.groupReplyMode||(s.groupMentionOnly?'direct':'smart'))==='direct')return false;
  if(s.groupReplyMode==='all')return true;
  const state=this.groups.get(msg.key),now=this.now();if(!state)return false;
  state.recent=state.recent.filter(t=>now-t<60000);
  if(state.last&&now-state.last<(s.groupReplyCooldown??30)*1000||state.recent.length>=(s.groupAutoLimit??2)||this.random()*100>=(s.groupReplyProbability??10))return false;
  state.last=now;state.recent.push(now);wake.ambient=true;wake.contextual=false;return true;
 }
 replied(msg,wake,s,replyText=''){
  if(msg.kind!=='group')return;
  const state=this.groups.get(msg.key);if(!state)return;
  if(wake?.ambient)state.last=this.now();
  if(s.followupEnabled===false)return;
  const continued=this.continuation.replied(msg,wake,s);if(continued)state.follow=continued;
  if(wake?.direct||wake?.poke||(!state.scene||state.scene.until<=this.now())&&wake?.ambient)
   state.scene={actor:msg.user,until:this.now()+90000,remaining:3,pending:false,terms:topicTerms(msg.text+'\n'+replyText)};
 }
}
