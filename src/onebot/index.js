import { EventEmitter } from 'node:events';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import {faceText} from './faces.js';
const unescapeCQ=s=>String(s).replace(/&#44;/g,',').replace(/&#91;/g,'[').replace(/&#93;/g,']').replace(/&amp;/g,'&');
const id=value=>/^[1-9]\d{3,15}$/.test(String(value||''))?String(value):'';
export function segments(message) {
 if(Array.isArray(message))return message.filter(x=>x&&typeof x.type==='string'&&x.data&&typeof x.data==='object').slice(0,200).map(x=>({type:x.type,data:structuredClone(x.data)}));
 const list=[];let start=0;const raw=String(message||'').slice(0,100000);const re=/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g;
 for(const m of raw.matchAll(re)){
  if(m.index>start)list.push({type:'text',data:{text:unescapeCQ(raw.slice(start,m.index))}});
  const data={};for(const pair of m[2].slice(1).split(',')){const i=pair.indexOf('=');if(i>0)data[pair.slice(0,i)]=unescapeCQ(pair.slice(i+1));}
  list.push({type:m[1],data});start=m.index+m[0].length;
 }
 if(start<raw.length)list.push({type:'text',data:{text:unescapeCQ(raw.slice(start))}});return list.slice(0,200);
}
export function normalize(raw){
 if(raw.post_type!=='message'||!['private','group'].includes(raw.message_type))return null;
 const bot=id(raw.self_id),user=id(raw.user_id),kind=raw.message_type,peer=id(kind==='group'?raw.group_id:raw.user_id);
 if(!bot||!user||!peer||bot===user||raw.message_id==null)return null;
 const parts=segments(raw.message??raw.raw_message),names={image:'[图片]',record:'[语音]',video:'[视频]',file:'[文件]',forward:'[合并转发]',face:'[QQ 表情]'};
 const text=parts.map(p=>p.type==='text'?String(p.data.text||''):p.type==='face'?faceText(p.data.id):names[p.type]||'').join('').trim().slice(0,60000);
 return {type:'message',bot,user,kind,peer,key:bot+':'+kind+':'+peer,id:String(raw.message_id),subtype:String(raw.sub_type||''),
  time:Number(raw.time)||Date.now()/1000,text,mentions:parts.filter(p=>p.type==='at').map(p=>String(p.data.qq)),
  reply:parts.find(p=>p.type==='reply')?.data.id,sender:String(raw.sender?.card||raw.sender?.nickname||user).slice(0,80),parts};
}
export function normalizeEvent(raw){
 const msg=normalize(raw);if(msg)return msg;
 if(raw.post_type==='notice'&&['group_upload','offline_file'].includes(raw.notice_type)&&raw.file){const f=raw.file,value=normalize({...raw,post_type:'message',message_type:raw.group_id?'group':'private',message_id:raw.message_id??('upload-'+String(f.id||f.file_id||'')+'-'+String(raw.time||'')),message:[{type:'file',data:{file_id:String(f.id||f.file_id||''),name:String(f.name||f.file_name||'attachment'),size:f.size,url:f.url}}]});return value?{...value,replyable:false}:null;}
 const bot=id(raw.self_id);if(!bot)return null;
 if(raw.post_type==='meta_event')return {type:'meta',bot,name:String(raw.meta_event_type||''),online:raw.status?.online===true};
 if(!['notice','request'].includes(raw.post_type))return null;
 const user=id(raw.user_id),group=id(raw.group_id),kind=group?'group':'private',peer=group||user;if(!peer)return null;
 const event={type:raw.post_type,bot,user,kind,peer,key:bot+':'+kind+':'+peer,
  name:String(raw.notice_type||raw.request_type||''),subtype:String(raw.sub_type||''),operator:id(raw.operator_id),target:id(raw.target_id),
  id:String(raw.message_id??''),time:Number(raw.time)||Date.now()/1000};
 if(event.type==='request'){
  if(!['friend','group'].includes(event.name)||typeof raw.flag!=='string'||raw.flag.length>1000)return null;
  event.flag=raw.flag;event.comment=String(raw.comment||'').slice(0,500);
 }
 return event;
}
const error=(message,code)=>Object.assign(new Error(message),{code});
function matchesToken(a,b){a=Buffer.from(a||'');b=Buffer.from(b||'');return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);}
export class OneBot extends EventEmitter {
 constructor(settings,token,log=()=>{}){super();this.settings=settings;this.token=token;this.log=log;this.pending=new Map();this.sockets=new Map();this.status={state:'stopped',online:false};this.retry=0;this.closed=true;}
 async start(){
  this.closed=false;
  if(this.settings.mode!=='reverse'){this.connect();return;}
  if(!this.token)throw new Error('反向 WebSocket 必须设置 Access Token');
  this.server=new WebSocketServer({host:this.settings.reverseHost,port:this.settings.reversePort,maxPayload:1024*1024,
   verifyClient:({req},done)=>{
    const u=new URL(req.url,'http://localhost'),auth=(req.headers.authorization||'').replace(/^Bearer\s+/i,'')||u.searchParams.get('access_token')||'';
    const role=String(req.headers['x-client-role']||'universal').toLowerCase();
    done(u.pathname===this.settings.reversePath&&matchesToken(auth,this.token)&&['universal','api','event'].includes(role),401);
   }});
  await new Promise((resolve,reject)=>{this.server.once('listening',resolve);this.server.once('error',reject);});
  this.server.on('error',e=>this.fail(e));
  this.server.on('connection',(ws,req)=>{
   const role=String(req.headers['x-client-role']||'universal').toLowerCase(),expected=id(req.headers['x-self-id']);
   if(this.sockets.has(role)||role==='universal'&&this.sockets.size||role!=='universal'&&this.sockets.has('universal')){ws.close(1013,'role already connected');return;}
   this.attach(ws,role,expected);
  });
  this.status={state:'listening',online:false};
 }
 connect(){
  if(this.closed)return;this.status={...this.status,state:'connecting',online:false};
  this.attach(new WebSocket(this.settings.url,{headers:this.token?{Authorization:'Bearer '+this.token}:{},handshakeTimeout:10000,maxPayload:1024*1024}),'universal');
 }
 attach(ws,role='universal',expected=''){
  this.sockets.set(role,ws);if(role!=='event')this.ws=ws;
  let lastSeen=Date.now(),health;
  const opened=async()=>{
   if(this.closed)return;
   health=setInterval(()=>{if(Date.now()-lastSeen>90000)ws.terminate();else ws.ping();},30000);health.unref?.();
   if(role==='event')return;
   this.retry=0;this.status={state:'connected',online:false,connectedAt:new Date().toISOString(),role};
   try{
    const info=await this.call('get_login_info');if(!id(info.user_id)||expected&&expected!==String(info.user_id))throw new Error('OneBot 账号验证失败');
    const state=await this.call('get_status');
    this.status={...this.status,bot:String(info.user_id),nickname:String(info.nickname||''),online:state.online===true,good:state.good};
    try{this.status.version=await this.call('get_version_info');}catch{}
    this.status.features={};for(const [action,key]of [['can_send_image','image'],['can_send_record','record']])try{const value=await this.call(action);if(typeof value?.yes==='boolean')this.status.features[key]=value.yes;}catch{}
    this.log('info','OneBot 已连接');this.emit('ready',this.status);
   }catch(e){this.fail(e);ws.terminate();}
  };
  if(ws.readyState===WebSocket.OPEN)void opened();else ws.once('open',opened);
  ws.on('pong',()=>{lastSeen=Date.now();});
  ws.on('message',buffer=>{
   lastSeen=Date.now();let event;try{event=JSON.parse(buffer.toString());}catch{return;}
   if(role!=='event'&&event.echo!=null&&this.pending.has(String(event.echo))){
    const p=this.pending.get(String(event.echo));this.pending.delete(String(event.echo));p.cleanup();
    if(event.status==='ok'&&Number(event.retcode)===0)p.resolve({outcome:'confirmed',data:event.data,retcode:0});
    else if(event.status==='async'&&Number(event.retcode)===1)p.resolve({outcome:'accepted',data:event.data??null,retcode:1});
    else p.reject(error('OneBot API 失败，retcode='+String(event.retcode),'FAILED'));return;
   }
   if(role==='api'||this.status.state!=='connected'||!this.status.bot||String(event.self_id)!==this.status.bot||expected&&expected!==this.status.bot)return;
   if(event.post_type==='meta_event'&&event.meta_event_type==='heartbeat')this.status.online=event.status?.online===true;
   const e=normalizeEvent(event);if(e){this.emit('event',e);if(e.type==='message')this.emit('message',e);}
  });
  ws.on('error',e=>this.fail(e));
  ws.on('close',()=>{
   clearInterval(health);if(this.sockets.get(role)!==ws)return;this.sockets.delete(role);
   if(this.ws!==ws)return;this.ws=null;
   for(const p of this.pending.values()){p.cleanup();p.reject(error('OneBot 连接断开，已发请求的结果未知','UNKNOWN_OUTCOME'));}this.pending.clear();
   this.status={...this.status,state:this.closed?'stopped':this.settings.mode==='reverse'?'listening':'disconnected',online:false};
   if(!this.closed&&this.settings.mode==='forward'){
    this.reconnect=setTimeout(()=>this.connect(),Math.min(30000,1000*2**Math.min(this.retry++,5)));this.reconnect.unref?.();
   }
  });
 }
 fail(e){this.status.error=String(e.message||e).replaceAll(this.token||'\0','[已隐藏]');this.log('warn','OneBot：'+this.status.error);}
 request(action,params={},timeout=10000,signal){
  return new Promise((resolve,reject)=>{
   if(signal?.aborted)return reject(error('操作已取消','CANCELLED'));
   if(this.closed||this.ws?.readyState!==WebSocket.OPEN)return reject(error('OneBot 尚未连接','NOT_CONNECTED'));
   const echo=randomUUID(),wire=JSON.stringify({action,params,echo});if(Buffer.byteLength(wire)>12*1024*1024)return reject(error('OneBot 请求总大小超过 12 MiB','PAYLOAD_LIMIT'));
   const abort=()=>{const p=this.pending.get(echo);if(p){this.pending.delete(echo);p.cleanup();reject(error('请求已取消，发送结果未知','UNKNOWN_OUTCOME'));}};
   const timer=setTimeout(()=>{this.pending.delete(echo);signal?.removeEventListener('abort',abort);reject(error('OneBot API 超时，结果未知：'+action,'UNKNOWN_OUTCOME'));},timeout);
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
   this.pending.set(echo,{resolve,reject,cleanup});signal?.addEventListener('abort',abort,{once:true});
   this.ws.send(wire,e=>{if(e&&this.pending.delete(echo)){cleanup();reject(error(e.message,'UNKNOWN_OUTCOME'));}});
  });
 }
 async call(action,params={},timeout=10000,signal){
  const r=await this.request(action,params,timeout,signal);if(r.outcome!=='confirmed')throw error('网关已受理，尚未确认完成','ACCEPTED');return r.data;
 }
 async stop(){
  this.closed=true;clearTimeout(this.reconnect);
  for(const p of this.pending.values()){p.cleanup();p.reject(error('连接停止，发送结果未知','UNKNOWN_OUTCOME'));}this.pending.clear();
  for(const ws of this.sockets.values())ws.terminate();this.sockets.clear();this.ws=null;
  if(this.server)await new Promise(r=>this.server.close(r));this.status={state:'stopped',online:false};
 }
}
export const accessMessages={'bridge-disabled':'QQ 桥接已关闭','private-disabled':'私聊回复已关闭','group-disabled':'群聊回复已关闭','group-not-allowed':'该群不在群白名单中','user-not-allowed':'发送者不在用户白名单中','not-mentioned':'消息没有 @机器人','paused':'回复已暂停','chat-disabled':'AI 聊天包已停用'};
export function accessReason(s,msg){
 if(!s.enabled)return 'bridge-disabled';
 if(msg.kind==='group'){if(!s.groupEnabled)return 'group-disabled';if(!s.allowedGroups.includes(msg.peer))return 'group-not-allowed';}
 else if(!s.privateEnabled)return 'private-disabled';
 if((msg.kind==='group'?s.groupAudience:s.privateAudience)!=='all'&&!s.allowedUsers.includes(msg.user))return 'user-not-allowed';
 if(msg.kind==='group'&&s.groupMentionOnly&&!msg.mentions.includes(msg.bot))return 'not-mentioned';return null;
}
export const allowed=(s,msg)=>accessReason(s,msg)===null;
export function chunks(text,size){const chars=Array.from(text),result=[];for(let i=0;i<chars.length;i+=size)result.push(chars.slice(i,i+size).join(''));return result;}
