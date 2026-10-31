import https from 'node:https';
const endpoints={list:'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6',comment:'https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds'};
export function parseResponse(text){let raw=String(text).trim();if(!raw.startsWith('{')){const m=/^[\w.$]+\s*\(([\s\S]*)\)\s*;?$/.exec(raw);if(!m)throw Error('空间返回登录验证或不支持的响应');raw=m[1];}let data;try{data=JSON.parse(raw);}catch{throw Error('空间响应不是有效JSON');}if(!data||typeof data!=='object'||Array.isArray(data)||![0,'0'].includes(data.code))throw Error('空间拒绝请求，可能未登录、无访问权限或需要验证');return data;}
// Fixed Tencent endpoints only. Cookies are never returned, persisted or logged.
export function qzoneRequest(url,{cookie,method='GET',body='',signal,referer,request=https.request}={}){
 if(!Object.values(endpoints).some(e=>url.startsWith(e+'?')))throw Error('空间端点未授权');
 const deadline=AbortSignal.timeout(15000),combined=signal?AbortSignal.any([signal,deadline]):deadline;
 return new Promise((resolve,reject)=>{const req=request(url,{method,signal:combined,agent:false,headers:{Cookie:cookie,Referer:referer,Origin:'https://user.qzone.qq.com','User-Agent':'Mozilla/5.0','Accept-Encoding':'identity',...method==='POST'?{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}:{}}},res=>{if(res.statusCode!==200){res.resume();return reject(Error('空间请求失败'));}let size=0;const parts=[];res.on('data',chunk=>{size+=chunk.length;if(size>1500000){res.destroy();reject(Error('空间响应过大'));}else parts.push(chunk);});res.on('error',()=>reject(Error('空间连接中断，操作结果可能未知')));res.on('end',()=>{try{resolve(parseResponse(Buffer.concat(parts).toString('utf8')));}catch(e){reject(e);}});});req.on('error',()=>reject(Error('空间网络失败，操作结果未知；不要自动重试')));if(body)req.write(body);req.end();});
}
function httpsImageUrl(value){
 const text=String(value||'').trim();
 if(!text)return '';
 try{const url=new URL(text);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
function parseComments(value){
 if(!Array.isArray(value))return [];
 return value.slice(0,20).map(row=>({
  id:String(row?.commentid||row?.id||'').slice(0,80),
  userId:String(row?.uin||'').slice(0,16),
  name:String(row?.name||row?.nickname||'').slice(0,80),
  text:String(row?.content||'').slice(0,1000),
  time:Number(row?.createTime||row?.create_time||0)||0
 })).filter(row=>row.text);
}
function parseLikes(value){
 if(!Array.isArray(value))return [];
 return value.slice(0,50).map(row=>({
  userId:String(row?.uin||row?.user_id||'').slice(0,16),
  name:String(row?.name||row?.nickname||'').slice(0,80),
  time:Number(row?.createTime||row?.create_time||0)||0
 })).filter(row=>row.userId||row.name);
}
function parsePost(x,userId){
 const content=String(x?.content||'').trim();
 const images=(Array.isArray(x?.pic)?x.pic:[]).map(pic=>httpsImageUrl(pic?.url1||pic?.url2||pic?.url3||pic?.url)).filter(Boolean).slice(0,9);
 const comments=parseComments(x?.commentlist||x?.comments);
 const likes=parseLikes(x?.likelist||x?.likes);
 return {
  id:String(x.tid),userId,
  userName:String(x.name||x.nickname||'').slice(0,80),
  text:content.slice(0,3000),
  time:Number(x.created_time||x.create_time||0)||0,
  url:'https://user.qzone.qq.com/'+userId+'/mood/'+encodeURIComponent(x.tid),
  images,
  comments,
  likes,
  likeCount:Number(x.likenum??x.like_count??likes.length)||0,
  commentCount:Number(x.cmtnum??x.comment_count??comments.length)||0,
  liked:x.islike===1||x.isLike===1||x.islike===true||x.isLike===true
 };
}
export function createQzoneBackend(bot,{request=qzoneRequest}={}){
 const gateway=()=>{const b=bot();if(!b?.status?.bot||!/napcat/i.test(String(b.status.version?.app_name||'')))throw Error('QQ空间需要已连接的NapCat网关');return b;};
 const auth=async signal=>{const b=gateway(),r=await b.call('get_cookies',{domain:'qzone.qq.com'},10000,signal);if(!r?.cookies||!/^\d+$/.test(String(r.bkn||'')))throw Error('空间登录凭据不可用，需要在QQ端重新登录');return {cookie:r.cookies,gtk:String(r.bkn),bot:b.status.bot};};
 return {
  async list(userId,count,signal,offset=0){const a=await auth(signal),u=new URL(endpoints.list);for(const [k,v]of Object.entries({uin:userId,hostUin:userId,pos:Math.max(0,Number(offset)||0),num:count,replynum:1,format:'json',code_version:1,need_comment:1,need_private_comment:0,g_tk:a.gtk}))u.searchParams.set(k,String(v));const data=await request(u.href,{cookie:a.cookie,signal,referer:'https://user.qzone.qq.com/'+userId});const rows=data.msglist??data.data?.msglist;if(rows!=null&&!Array.isArray(rows))throw Error('空间列表格式不支持');return (rows||[]).slice(0,count).filter(x=>typeof x.tid==='string'&&/^[\w-]{1,100}$/.test(x.tid)&&(!x.uin||String(x.uin)===userId)).map(x=>parsePost(x,userId));},
  async publish(content,visibility,signal){const b=gateway(),r=await b.request('send_qzone_msg',{content,images:[],ugc_right:visibility,target_uins:[]},20000,signal);return {outcome:r.outcome,...typeof r.data?.tid==='string'?{id:r.data.tid,url:'https://user.qzone.qq.com/'+b.status.bot+'/mood/'+encodeURIComponent(r.data.tid)}:{}};},
  async comment(post,content,signal){const a=await auth(signal),u=new URL(endpoints.comment);u.searchParams.set('g_tk',a.gtk);const body=new URLSearchParams({topicId:post.userId+'_'+post.id+'__1',uin:a.bot,hostUin:post.userId,feedsType:'100',inCharset:'utf-8',outCharset:'utf-8',plat:'qzone',source:'ic',platformid:'50',format:'json',ref:'feeds',content,private:'0',paramstr:'1',isSignIn:'0',richval:'',richtype:'',appid:'311',busi_param:'{}',qzreferrer:post.url}).toString();await request(u.href,{cookie:a.cookie,method:'POST',body,signal,referer:post.url});return {outcome:'confirmed',url:post.url};}
 };
}
