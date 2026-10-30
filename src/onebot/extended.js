const string=(description,maxLength=200)=>({type:'string',description,maxLength});
const integer=(description,minimum,maximum)=>({type:'integer',description,minimum,maximum});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text=x=>String(x??'').slice(0,4000);
export function registerExtended(api){
 const folders=new Map(),cooldowns=new Map(),cache=new Map();api.pokeCooldowns=cooldowns;
 const group=(c,requested)=>{
  const id=requested||(c.kind==='group'?c.peer:'');
  if(!/^[1-9]\d{3,15}$/.test(id)||!api.store.data.framework.listenGroups.includes(id)||c.kind==='group'&&id!==c.peer||c.kind==='private'&&!api.permissions.owner(c))throw new Error('群查询超出当前授权范围');
  return id;
 };
 const cached=async(key,load)=>{
  const existing=cache.get(key);if(existing&&Date.now()-existing.at<30000)return existing.data;
  const data=await load();cache.set(key,{at:Date.now(),data});if(cache.size>100)cache.delete(cache.keys().next().value);return data;
 };
 api.add('qq.forward.send','向当前聊天发送机器人整理的合并转发',object({nodes:{type:'array',maxItems:10,items:{type:'object',additionalProperties:true},description:'每个节点为 {segments:[消息段]}，发送者固定为机器人'}}),async(a,c)=>{
  api.requireNapCat();if(!a.nodes.length)throw new Error('转发节点不能为空');const messages=[];let chars=0;
  for(const node of a.nodes){
   if(!node||Object.keys(node).some(k=>k!=='segments')||!Array.isArray(node.segments)||node.segments.length>5)throw new Error('转发节点仅支持受控消息段，不能自定义发送者或引用任意消息 ID');
   for(const p of node.segments)chars+=p?.type==='text'?String(p.data?.text||'').length:0;if(chars>12000)throw new Error('转发文字总长度超过 12000 字');
   messages.push({type:'node',data:{user_id:c.bot,nickname:text(api.bot.status.nickname||'QQ 机器人').slice(0,60),content:await api.message(node.segments,c)}});
  }
  const result=await api.request(c.kind==='group'?'send_group_forward_msg':'send_private_forward_msg',{[c.kind==='group'?'group_id':'user_id']:c.peer,messages},c);
  if(result.outcome==='confirmed')api.remember(c,result.data?.message_id);return result;
 },{mutating:true,extension:true});
 api.add('qq.files.list','浏览指定授权群的文件与目录',object({groupId:string('群号；在当前群内可留空',16),folderId:string('根目录留空；其他目录须来自之前的浏览结果',200),count:integer('返回条数',1,100)}),async(a,c)=>{
  api.requireNapCat();const id=group(c,a.groupId),key=c.bot+':'+id,known=folders.get(key);
  if(a.folderId&&(!known||Date.now()-known.at>600000||!known.ids.has(a.folderId)))throw new Error('文件夹 ID 不是当前群最近浏览过的目录');
  const data=await api.query(a.folderId?'get_group_files_by_folder':'get_group_root_files',{group_id:id,...a.folderId?{folder_id:a.folderId}:{},file_count:a.count});
  const subfolders=(data?.folders||[]).slice(0,a.count).map(f=>({id:String(f.folder_id||'').slice(0,200),name:text(f.folder_name).slice(0,150),fileCount:Number(f.total_file_count)||0}));
  const ids=new Set(known?.ids||[]);for(const f of subfolders)if(f.id)ids.add(f.id);
  folders.set(key,{at:Date.now(),ids:new Set([...ids].slice(-500))});if(folders.size>100)folders.delete(folders.keys().next().value);
  return {groupId:id,folderId:a.folderId,files:(data?.files||[]).slice(0,a.count).map(f=>({id:String(f.file_id||'').slice(0,200),name:text(f.file_name).slice(0,150),size:Number(f.file_size)||0,uploader:String(f.uploader||'')})),folders:subfolders};
 },{extension:true});
 api.add('qq.poke','戳一戳当前消息发起者',object({}),async(_a,c)=>{
  api.requireNapCat();const target=c.kind==='private'?c.peer:c.actor,key=c.bot+':'+target,now=Date.now();
  if(now-(cooldowns.get(key)||0)<60000)throw new Error('戳一戳冷却中，同一对象每分钟最多一次');
  cooldowns.set(key,now);if(cooldowns.size>500)cooldowns.delete(cooldowns.keys().next().value);
  return api.request(c.kind==='group'?'group_poke':'friend_poke',{user_id:target,...c.kind==='group'?{group_id:c.peer}:{}},c);
 },{mutating:true,extension:true});
 api.add('qq.announcements.list','查询指定授权群的公告',object({groupId:string('群号；在当前群内可留空',16),count:integer('返回条数',1,20)}),async(a,c)=>{
  api.requireNapCat();const id=group(c,a.groupId),rows=await cached(c.bot+':notice:'+id,()=>api.query('_get_group_notice',{group_id:id}));
  if(!Array.isArray(rows))throw new Error('网关公告响应格式无效');
  return {groupId:id,items:rows.slice(0,a.count).map(r=>({id:String(r.notice_id||'').slice(0,200),sender:String(r.sender_id||''),time:Number(r.publish_time)||0,text:text(r.message?.text),pinned:r.pinned===true})),untrusted:true};
 },{extension:true});
 api.add('qq.essence.list','查询指定授权群的精华消息',object({groupId:string('群号；在当前群内可留空',16),count:integer('返回条数',1,20)}),async(a,c)=>{
  api.requireNapCat();const id=group(c,a.groupId),rows=await cached(c.bot+':essence:'+id,()=>api.query('get_essence_msg_list',{group_id:id}));
  if(!Array.isArray(rows))throw new Error('网关精华响应格式无效');
  return {groupId:id,items:rows.slice(0,a.count).map(r=>({messageId:String(r.message_id||''),sender:String(r.sender_id||''),operator:String(r.operator_id||''),time:Number(r.operator_time)||0,
   content:(Array.isArray(r.content)?r.content:[]).slice(0,30).map(p=>p.type==='text'?{type:'text',text:text(p.data?.text)}:{type:String(p.type||'unknown')})})),untrusted:true};
 },{extension:true});
}
