import {safeDownload} from './media.js';
import {publicText,qqPlain,replyLimits} from '../session/output.js';
import {registerExtended} from '../onebot/extended.js';
const str=(description,maxLength=200)=>({type:'string',description,maxLength});
const schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const empty=schema({});
const groupSchema=properties=>{const value=schema(properties);value.required=value.required.filter(k=>k!=='groupId');return value;};
const publicQueries=new Set(['core.status','qq.group.info','qq.members.list','qq.member.info','qq.message.get','qq.forward.get','qq.history.get','qq.files.list','qq.announcements.list','qq.essence.list']);
function parse(args,s){
 if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('动作参数须为对象');
 for(const key of Object.keys(args))if(!Object.hasOwn(s.properties,key))throw new Error('不支持的参数：'+key);
 for(const key of s.required||[])if(args[key]===undefined)throw new Error('缺少参数：'+key);
 for(const [key,type]of Object.entries(s.properties)){
  const value=args[key];if(value===undefined)continue;
  if(type.type==='string'&&(typeof value!=='string'||value.length>(type.maxLength||200)||type.minLength&&value.length<type.minLength))throw new Error('文字参数无效：'+key);
  if(type.type==='boolean'&&typeof value!=='boolean')throw new Error('布尔参数无效：'+key);
  if(type.type==='integer'&&(!Number.isInteger(value)||value<type.minimum||value>type.maximum))throw new Error('数字参数无效：'+key);
  if(type.type==='array'&&(!Array.isArray(value)||value.length>(type.maxItems||30)))throw new Error('数组参数无效：'+key);
 }
 return structuredClone(args);
}
const textMessage=data=>(Array.isArray(data?.message)?data.message:[]).map(p=>p.type==='text'?{type:'text',data:{text:String(p.data?.text||'').slice(0,12000)}}:p.type==='at'?{type:'at',data:{qq:String(p.data?.qq||'')}}:p.type==='reply'?{type:'reply',data:{id:String(p.data?.id||'')}}:{type:String(p.type),data:{}}).slice(0,100);
export class Actions {
 constructor(store,permissions,events,media){
  this.store=store;this.permissions=permissions;this.events=events;this.media=media;this.definitions=new Map();this.sent=new Map();this.executions=new WeakMap();this.outputUsage=new Map();this.deliveries=new WeakSet();
  this.add('core.status','查看机器人运行状态',empty,async()=>({connection:this.bot?.status?.state,online:this.bot?.status?.online,paused:store.data.framework.paused,packages:Object.entries(store.data.framework.builtins).filter(([,v])=>v.enabled).map(([id])=>id)}));
  this.add('qq.login','查看机器人账号',empty,()=>this.query('get_login_info'));
  this.add('qq.capabilities','查看 QQ 网关能力',empty,async()=>this.capabilities());
  this.add('qq.friends.list','查看好友列表',empty,async()=>((await this.query('get_friend_list'))||[]).slice(0,1000).map(x=>({user_id:x.user_id,nickname:x.nickname,remark:x.remark})),{ownerOnly:true});
  this.add('qq.groups.list','查看已监听群列表',empty,async()=>((await this.query('get_group_list'))||[]).filter(x=>store.data.framework.listenGroups.includes(String(x.group_id))).map(x=>({group_id:x.group_id,group_name:x.group_name,member_count:x.member_count})),{ownerOnly:true});
  this.add('qq.members.list','查看当前群成员',empty,async(a,c)=>{
   if(c.kind!=='group')throw new Error('只能查询当前群成员');
   const rows=await this.query('get_group_member_list',{group_id:Number(c.peer)});
   return (rows||[]).slice(0,3000).map(x=>({user_id:x.user_id,nickname:x.nickname,card:x.card,role:x.role}));
  });
  this.add('qq.media.receive','将当前聊天收到的图片或媒体保存为受控资源',schema({messageId:str('原消息 ID',60),index:{type:'integer',minimum:0,maximum:19}}),async(a,c,signal)=>{
   const observed=events.observed.get(c.bot+':'+a.messageId),item=observed?.media?.[a.index];
   if(!events.hasMessage(c,a.messageId)||!item)throw new Error('媒体不属于当前聊天已收到的消息');
   let url=item.url;if(!url&&item.type==='image'){const data=await this.query('get_image',{file:item.file});url=data?.url;}
   if(typeof url!=='string'||!url.startsWith('https://'))throw new Error('网关没有提供可安全下载的 HTTPS 资源');
   const bytes=await safeDownload(url,{signal}),purpose=item.type==='image'?'image':item.type==='record'?'audio':'video';
   return media.put(bytes,{key:c.key,plugin:c.plugin,purpose});
  });
  this.add('qq.group.info','查看当前群资料',empty,async(a,c)=>{if(c.kind!=='group')throw new Error('只能查询当前群');const d=await this.query('get_group_info',{group_id:Number(c.peer)});return {group_id:d.group_id,group_name:d.group_name,member_count:d.member_count,max_member_count:d.max_member_count};});
  this.add('qq.member.info','查看当前群的指定成员',schema({userId:str('群成员 QQ',16)}),async(a,c)=>{if(c.kind!=='group'||!(/^[1-9]\d{3,15}$/).test(a.userId))throw new Error('成员或群范围无效');const d=await this.query('get_group_member_info',{group_id:Number(c.peer),user_id:Number(a.userId)});return {user_id:d.user_id,nickname:d.nickname,card:d.card,role:d.role,title:d.title};});
  this.add('qq.message.get','查看当前聊天已收到的消息',schema({id:str('消息 ID',60)}),async(a,c)=>{
   if(!events.hasMessage(c,a.id))throw new Error('只能查询当前聊天最近收到的消息');
   const data=await this.query('get_msg',{message_id:this.messageId(a.id)});
   this.verifyMessage(data,c);return {message_id:data.message_id,user_id:data.user_id,message:textMessage(data)};
  });
  this.add('qq.forward.get','解析当前聊天收到的合并转发',schema({messageId:str('包含转发的原消息 ID',60),forwardId:str('转发 ID',200)}),async(a,c)=>{
   const observed=events.observed.get(c.bot+':'+a.messageId);
   if(!events.hasMessage(c,a.messageId)||!observed?.forwards?.includes(a.forwardId))throw new Error('转发不属于当前聊天已收到的消息');
   const data=await this.query('get_forward_msg',{id:a.forwardId});
   return {messages:(data?.messages||[]).slice(0,30).map(x=>({sender:String(x.sender?.nickname||'转发内容'),content:textMessage({message:x.content||x.message})})),untrusted:true};
  });
  this.add('qq.message.recall','撤回当前聊天由框架发送的消息',schema({id:str('消息 ID',60)}),async(a,c)=>{
   const record=this.sent.get(c.bot+':'+a.id);
   if(!record||record.key!==c.key||Date.now()-record.time>120000)throw new Error('只能撤回框架在当前聊天最近两分钟发送的消息');
   return this.request('delete_msg',{message_id:this.messageId(a.id)},c);
  },{mutating:true});
  this.add('qq.message.send','向当前聊天发送文字或图片消息链',schema({segments:{type:'array',description:'每段必须为 {type,data}。真实@示例：{type:"at",data:{qq:"12345678"}}；文字示例：{type:"text",data:{text:"你好"}}。禁止用普通文字@代替at段。',maxItems:20,items:{type:'object',required:['type','data'],additionalProperties:false,properties:{type:{type:'string',enum:['text','image','at','reply','face']},data:{type:'object',description:'按type填写：text:{text}、image:{resourceId}、at:{qq}、reply:{id}、face:{id}',additionalProperties:true}}}}}),async(a,c)=>{
   const message=await this.message(a.segments,c);return this.send(c,message);
  },{mutating:true});
  for(const [id,type,segment]of [['qq.image.send','image','image'],['qq.audio.send','audio','record'],['qq.video.send','video','video']]){
   this.add(id,'向当前聊天发送'+({image:'图片',audio:'语音',video:'视频'}[type]),schema({resourceId:str('当前聊天的资源 ID',60)}),async(a,c)=>{
    const {file}=await media.resolve(a.resourceId,c,type,c.plugin);
    return this.send(c,[{type:segment,data:{file}}]);
   },{mutating:true});
  }
  this.add('qq.file.send','向当前聊天发送受控文件',schema({resourceId:str('文件资源 ID',60)}),async(a,c)=>{
   this.requireNapCat();const {file,row}=await media.resolve(a.resourceId,c,'file',c.plugin);
   return this.request(c.kind==='group'?'upload_group_file':'upload_private_file',{[c.kind==='group'?'group_id':'user_id']:Number(c.peer),file,name:row.name},c);
  },{mutating:true,extension:true});
  this.add('qq.profile.avatar','修改机器人头像',schema({resourceId:str('图片资源 ID',60)}),async(a,c)=>{
   this.requireNapCat();const {file}=await media.resolve(a.resourceId,c,'image',c.plugin);return this.request('set_qq_avatar',{file},c);
  },{ownerOnly:true,mutating:true,extension:true});
  this.add('qq.profile.nickname','修改机器人昵称',schema({nickname:{...str('新的机器人昵称',36),minLength:1}}),async(a,c)=>{
   this.requireNapCat();if(!a.nickname.trim()||/[\x00-\x1f]/.test(a.nickname))throw new Error('昵称内容无效');
   const outcome=await this.request('set_qq_profile',{nickname:a.nickname.trim()},c);
   if(outcome.outcome==='confirmed')try{const info=await this.query('get_login_info');outcome.visible=info.nickname===a.nickname.trim();}catch{}
   return outcome;
  },{ownerOnly:true,mutating:true,extension:true});
  this.add('qq.group.selfCard','修改机器人在指定群的名片',groupSchema({groupId:str('群内留空即当前群；私聊填写已监听群号',16),card:str('新名片',60)}),async(a,c)=>{
   a.groupId=this.groupTarget(a.groupId,c);return this.request('set_group_card',{group_id:Number(a.groupId),user_id:Number(c.bot),card:a.card},c);
  },{ownerOnly:true,mutating:true});
  this.add('qq.group.name','修改指定群名称',groupSchema({groupId:str('群内留空即当前群；私聊填写已监听群号',16),name:{...str('新群名称',60),minLength:1}}),async(a,c)=>{
   a.groupId=this.groupTarget(a.groupId,c);return this.request('set_group_name',{group_id:Number(a.groupId),group_name:a.name},c);
  },{ownerOnly:true,mutating:true});
  this.add('qq.request.decide','处理好友或加群请求',schema({requestId:str('请求收件箱 ID',60),approve:{type:'boolean'},reason:str('拒绝原因或好友备注',100)}),async(a,c)=>{
   const row=events.requests.find(x=>x.requestId===a.requestId&&x.bot===c.bot);
   if(!row||row.state!=='pending'||Date.now()-row.receivedAt>86400000)throw new Error('请求不存在、已处理或已过期');
   if(row.kind==='group'&&!store.data.framework.listenGroups.includes(row.peer))throw new Error('请求已离开监听范围');
   row.state='submitting';
   try{
    const result=await this.request(row.name==='friend'?'set_friend_add_request':'set_group_add_request',{
     flag:row.flag,approve:a.approve,...row.name==='friend'?{remark:a.reason}:{sub_type:row.subtype,reason:a.reason}
    },c);row.state=result.outcome==='confirmed'?'handled':'accepted';return result;
   }catch(e){row.state=e.code==='FAILED'?'pending':'unknown';throw e;}
  },{ownerOnly:true,mutating:true});
  this.add('qq.history.get','查看当前聊天近期历史',schema({count:{type:'integer',minimum:1,maximum:20}}),async(a,c)=>{
   this.requireNapCat();const data=await this.query(c.kind==='group'?'get_group_msg_history':'get_friend_msg_history',{[c.kind==='group'?'group_id':'user_id']:Number(c.peer),count:a.count});
   return {messages:(data?.messages||[]).slice(-a.count).map(x=>({user_id:x.user_id,time:x.time,message:textMessage(x)})),untrusted:true};
  },{extension:true});
  registerExtended(this);
 }
 installTaskActions(tasks){
  if(!tasks)throw new Error('任务存储不可用');
  if(this.tasks)return;
  this.tasks=tasks;
  const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
  this.add('qq.task.create','创建一条持久化任务，记录目标、完成条件和计划。仅主人可用；创建不等于执行。',object({
   goal:str('任务目标',500),reason:str('创建原因',300),completion:str('完成条件',300),
   plan:{type:'array',maxItems:20,items:{type:'string',maxLength:300}},
   maxSteps:{type:'integer',minimum:1,maximum:50}
  },['goal']),async a=>tasks.create(a),{ownerOnly:true,mutating:true});
  this.add('qq.task.list','列出持久化任务及真实状态；不会把计划当成已完成。',object({
   status:{type:'string',enum:['','pending','analyzing','planning','waiting_approval','executing','verifying','done','failed','cancelled']},
   limit:{type:'integer',minimum:1,maximum:100}
  },[]),async a=>({items:tasks.list(a),stats:tasks.status()}),{ownerOnly:true});
  this.add('qq.task.get','读取一条任务的计划、步骤、验证和历史。',object({id:str('任务 ID',100)},['id']),async a=>{
   const task=tasks.get(a.id);if(!task)throw new Error('任务不存在');return {task};
  },{ownerOnly:true});
  this.add('qq.task.plan','修改尚未执行任务的计划；不会自动执行。',object({
   id:str('任务 ID',100),steps:{type:'array',maxItems:50,items:{type:'string',maxLength:300}}
  },['id','steps']),async a=>({task:await tasks.setPlan(a.id,a.steps)}),{ownerOnly:true,mutating:true});
  this.add('qq.task.transition','按状态机推进任务；非法跳转会被拒绝。',object({
   id:str('任务 ID',100),status:{type:'string',enum:['analyzing','planning','waiting_approval','executing','verifying','done','failed','cancelled']},note:str('状态说明',160)
  },['id','status']),async a=>({task:await tasks.transition(a.id,a.status,a.note)}),{ownerOnly:true,mutating:true});
  this.add('qq.task.step','给执行中的任务追加一个真实步骤结果。',object({
   id:str('任务 ID',100),title:str('步骤',200),tool:str('工具',100),status:{type:'string',enum:['pending','running','done','failed','skipped']},outcome:str('结果摘要',200),note:str('备注',200)
  },['id','title']),async a=>({step:await tasks.addStep(a.id,a)}),{ownerOnly:true,mutating:true});
  this.add('qq.task.verify','给验证中的任务写入人工/程序验证结果。',object({
   id:str('任务 ID',100),ok:{type:'boolean'},note:str('验证依据',300)
  },['id','ok']),async a=>({task:await tasks.verify(a.id,a)}),{ownerOnly:true,mutating:true});
  this.add('qq.task.attach-memory','把任务关联到一条真实记忆；不复制记忆正文。',object({
   id:str('任务 ID',100),memoryId:str('记忆 ID',100)
  },['id','memoryId']),async a=>({task:await tasks.attachMemory(a.id,a.memoryId)}),{ownerOnly:true,mutating:true});
 }
 add(id,description,parameters,run,options={}){
  if(this.definitions.has(id))throw new Error('能力 ID 冲突');
  if(!parameters||parameters.type!=='object'||typeof parameters.properties!=='object')throw new Error('动作必须声明对象参数 Schema');
  const item={id,description,parameters,run,...options};item.publicSafe=!item.ownerOnly&&!item.mutating&&(options.publicSafe===true||publicQueries.has(id));item.available=()=>this.definitions.get(id)===item&&(!options.available||options.available());this.definitions.set(id,item);return()=>this.definitions.delete(id);
 }
 attach(bot){this.bot=bot;}
 catalog(){return [...this.definitions.values()].map(({run,available,...item})=>({...item,enabled:this.store.data.framework.enabledActions.includes(item.id)}));}
 capabilities(){return {protocol:'OneBot 11',gateway:this.bot?.status.version||{},features:this.bot?.status.features||{},napcat:this.isNapCat(),actions:this.catalog().map(x=>({id:x.id,support:x.extension?(this.isNapCat()?'gateway-declared':'unsupported'):'protocol',verified:'not-probed',enabled:x.enabled}))};}
 isNapCat(){return /napcat/i.test(String(this.bot?.status?.version?.app_name||''));}
 requireNapCat(){if(!this.isNapCat())throw new Error('当前网关未声明支持 NapCat 扩展');}
 checkBot(c){if(this.bot?.status?.bot!==c.bot)throw new Error('机器人账号已变更');}
 async invoke(id,args,c,signal){
  const cap=this.definitions.get(id);this.permissions.assert(cap,c,true);
  const parsed=parse(args,cap.parameters);this.checkBot(c);if(signal?.aborted)throw new Error('操作已取消');
  this.permissions.audit('started',id,c);
  if(this.executions.has(c))throw new Error('同一执行上下文不能并发调用动作');
  this.executions.set(c,{cap,signal});
  try{
   const result=await cap.run(parsed,c,signal);
   this.permissions.assert(cap,c);this.checkBot(c);if(signal?.aborted)throw new Error('操作已取消');
   this.permissions.audit('completed',id,c);return result??null;
  }catch(e){this.permissions.audit(e.code==='UNKNOWN_OUTCOME'?'unknown':'failed',id,c,e.message);throw e;}
  finally{this.executions.delete(c);await this.store.persist();}
 }
 outputKey(c){return [c.boot,c.generation,c.key,c.actor,c.messageId].join('|');}
 remainingOutput(c){const limits=replyLimits(this.store.data.settings),used=this.outputUsage.get(this.outputKey(c))||{chars:0,parts:0};return {chars:Math.max(0,limits.chars-used.chars),parts:Math.max(0,limits.parts-used.parts)};}
 async request(action,params,c,signal){
  const reason=this.permissions.valid(c);if(reason)throw new Error(reason);this.checkBot(c);
  const execution=this.executions.get(c);if(execution)this.permissions.assert(execution.cap,c);
  signal=signal||execution?.signal;if(signal?.aborted)throw new Error('操作已取消');
  let sentText='';
  if(['send_group_msg','send_private_msg'].includes(action)){
   const left=this.remainingOutput(c);if(!left.parts)throw Error('本轮发送条数已用完');
   let available=left.chars;const message=structuredClone(params.message);
   for(const p of message)if(p.type==='text'){const raw=qqPlain(publicText(p.data.text,{secrets:[this.bot?.token]}),{legacyBreaks:!execution}),points=Array.from(raw);if(points.length&&!available)throw Error('本轮发送字数已用完');p.data.text=points.length<=available?raw:points.slice(0,Math.max(0,available-1)).join('')+'…';available-=Array.from(p.data.text).length;sentText+=p.data.text;}
   params={...params,message};const key=this.outputKey(c),used=this.outputUsage.get(key)||{chars:0,parts:0};this.outputUsage.set(key,{chars:used.chars+left.chars-available,parts:used.parts+1});if(this.outputUsage.size>2000)this.outputUsage.delete(this.outputUsage.keys().next().value);
  }
  const result=await this.bot.request(action,params,15000,signal);
  if(['send_group_msg','send_private_msg'].includes(action)&&['confirmed','accepted'].includes(result.outcome))this.deliveries.add(c);
  if(result.outcome==='confirmed'&&['send_group_msg','send_private_msg'].includes(action)){this.remember(c,result.data?.message_id);this.onSent?.(c,result.data?.message_id,sentText||'[媒体消息]');}
  return result;
 }
 query(action,params={}){return this.bot.call(action,params);}
 groupTarget(id,c){id=id||(c.kind==='group'?c.peer:'');if(!this.store.data.framework.listenGroups.includes(id)||c.kind==='group'&&c.peer!==id)throw new Error('目标群超出当前授权范围');return id;}
 messageId(id){if(!/^-?\d{1,20}$/.test(id))throw new Error('消息 ID 无效');const n=Number(id);if(!Number.isSafeInteger(n))throw new Error('消息 ID 超出范围');return n;}
 verifyMessage(data,c){if(data?.message_type&&data.message_type!==c.kind||c.kind==='group'&&String(data?.group_id)!==c.peer||c.kind==='private'&&String(data?.user_id??data?.sender?.user_id)!==c.peer)throw new Error('消息不属于当前聊天');}
 hasSent(c){return this.deliveries.has(c);}
 async message(parts,c){
  if(!parts.length||parts.length>20)throw new Error('消息段数量无效');const result=[];
  for(const p of parts){
   if(!p||!['text','image','at','reply','face'].includes(p.type))throw new Error('此消息段尚未开放');
   const d=p.data;if(!d||typeof d!=='object')throw new Error('消息段数据无效');
   if(p.type==='text'){if(typeof d.text!=='string'||d.text.length>4000)throw new Error('文字消息过长');result.push({type:'text',data:{text:d.text}});}
   if(p.type==='image'){const {file}=await this.media.resolve(d.resourceId,c,'image',c.plugin);result.push({type:'image',data:{file}});}
   if(p.type==='at'){if(c.kind!=='group'||!/^\d{4,16}$/.test(String(d.qq)))throw new Error('不支持 @全体或跨聊天 @');result.push({type:'at',data:{qq:String(d.qq)}});}
   if(p.type==='reply'){if(!this.events.hasMessage(c,String(d.id)))throw new Error('只能引用当前聊天最近消息');result.push({type:'reply',data:{id:String(d.id)}});}
   if(p.type==='face'){if(!/^\d{1,4}$/.test(String(d.id)))throw new Error('表情 ID 无效');result.push({type:'face',data:{id:String(d.id)}});}
  }return result;
 }
 remember(c,id){if(id==null)return;this.sent.set(c.bot+':'+id,{key:c.key,time:Date.now()});if(this.sent.size>1000)this.sent.delete(this.sent.keys().next().value);}
 async send(c,message){const result=await this.request(c.kind==='group'?'send_group_msg':'send_private_msg',{[c.kind==='group'?'group_id':'user_id']:Number(c.peer),message},c);if(result.outcome==='confirmed')this.remember(c,result.data?.message_id);return result;}
}
