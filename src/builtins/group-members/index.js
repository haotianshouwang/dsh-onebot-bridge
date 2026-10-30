import {createHash} from 'node:crypto';
const kinds={group_increase:'加入群聊',group_decrease:'离开群聊',group_admin:'管理员变更'};
export const manifest={
 id:'qq-group-members',name:'群成员动态',version:'1.0.0',bundled:true,description:'按群记录成员变化，支持有限保存和单独开启的欢迎消息。',
 dependencies:{framework:'>=0.3.0'},configVersion:1,eventTimeoutMs:30000,storagePolicy:{collection:'records',timestamp:'t',group:'g',daysField:'retentionDays',limitField:'maxRecords'},capabilities:['events','storage','actions','automatic-replies'],
 configSchema:{
  retentionDays:{type:'number',title:'保存天数',default:7,min:1,max:90,integer:true},
  maxRecords:{type:'number',title:'最多记录条数',default:150,min:20,max:250,integer:true},
  recordAdminChanges:{type:'boolean',title:'记录管理员变化',default:false},
  welcomeEnabled:{type:'boolean',title:'自动发送入群欢迎',default:false},
  welcomeText:{type:'string',title:'欢迎内容',description:'可使用 {qq} 和 {group}，内容以普通文字发送。',default:'欢迎 {qq} 加入群聊！',maxLength:300}
 },
 settings:{title:'群成员动态',description:'只记录所选群的成员通知，不采集群聊天正文。',sections:[{title:'记录与保存',fields:['retentionDays','maxRecords','recordAdminChanges']},{title:'欢迎消息',fields:['welcomeEnabled','welcomeText']}]},
 automations:[{id:'welcome',event:'group_increase',title:'允许自动发送欢迎消息',configGate:'welcomeEnabled'}]
};
export function activateGroupMembers(framework){
 const api=framework.registerTrustedPackage(manifest);
 const filtered=(data,config,groups)=>{const cutoff=Date.now()-config.retentionDays*86400000;return (Array.isArray(data.records)?data.records:[]).filter(r=>r.t>=cutoff&&groups.includes(r.g)).slice(0,config.maxRecords);};
 api.on(['notice'],async(event,_execution,signal)=>{
  const config=api.getConfig(),groups=api.getScope().groups;
  if(!kinds[event.name]||event.kind!=='group'||!groups.includes(event.peer)||event.name==='group_admin'&&!config.recordAdminChanges)return;
  if(Math.abs(Date.now()/1000-event.time)>300)return;
  const row={id:createHash('sha256').update([event.bot,event.peer,event.user,event.operator,event.name,event.subtype,event.time].join(':')).digest('hex').slice(0,24),b:event.bot,g:event.peer,u:event.user,o:event.operator||'',k:event.name,s:event.subtype||'',t:Math.floor(event.time*1000)};
  let added=false;
  await api.storage.update(data=>{
   const records=filtered(data,config,groups);if(records.some(r=>r.id===row.id))return {schema:1,records};
   records.unshift(row);added=true;while(records.length>config.maxRecords||Buffer.byteLength(JSON.stringify(records))>58000)records.pop();return {schema:1,records};
  });
  if(added&&event.name==='group_increase'&&event.user!==event.bot&&config.welcomeEnabled&&!signal.aborted){
   const text=config.welcomeText.replaceAll('{qq}',event.user).replaceAll('{group}',event.peer);
   try{await api.automaticReply(event,'welcome',text);}catch(error){if(!/未授权|失效|上限|过期/.test(error.message))throw error;}
  }
 });
 const rows=query=>{
  const config=api.getConfig(),groups=api.getScope().groups;
  if(query.groupId&&!groups.includes(String(query.groupId)))api.reject('查询群不在插件作用范围');
  const records=filtered(api.storage.get(),config,groups).filter(r=>!query.groupId||r.g===String(query.groupId));
  const offset=Number(query.offset||0);if(!Number.isInteger(offset)||offset<0||offset>1000)api.reject('分页参数无效');
  return {records,offset,groups};
 };
 api.settings(manifest.settings,query=>{
  const {records,offset,groups}=rows(query);
  return {stats:[{label:'当前范围记录',value:records.length},{label:'记录群数',value:groups.length},{label:'保存天数',value:api.getConfig().retentionDays}],
   columns:[{key:'time',label:'时间',format:'datetime'},{key:'group',label:'群'},{key:'event',label:'变化'},{key:'user',label:'成员 QQ'},{key:'operator',label:'操作人'}],
   rows:records.slice(offset,offset+30).map(r=>({time:new Date(r.t).toISOString(),group:r.g,event:r.k==='group_decrease'&&r.u===r.b?'机器人离群':kinds[r.k]+(r.s?' · '+r.s:''),user:r.u,operator:r.o||'—'})),
   groups,total:records.length,offset,hasMore:offset+30<records.length};
 });
 api.action('recent',{description:'查询指定群最近的成员变化',ownerOnly:true,parameters:{type:'object',properties:{groupId:{type:'string',maxLength:16,description:'插件已配置的群号'},count:{type:'integer',minimum:1,maximum:20}},required:['groupId','count'],additionalProperties:false}},
 async(args,execution)=>{
  const groups=api.getScope().groups;if(!groups.includes(args.groupId)||execution.kind==='group'&&args.groupId!==execution.peer)api.reject('查询超出当前群范围');
  const {records}=rows({groupId:args.groupId});return {group:args.groupId,records:records.slice(0,args.count).map(r=>({time:r.t,event:kinds[r.k],user:r.u,operator:r.o})),retentionDays:api.getConfig().retentionDays};
 });
 return api;
}
