import { randomUUID } from 'node:crypto';
import { mkdir,writeFile,readFile,rm,readdir } from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import {imageDimensions} from './image-info.js';
const MAX=8*1024*1024;
export function publicIP(ip){
 if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19,51].includes(b)||a===203&&b===0);}
 if(isIP(ip)===6){if(!/^[23][0-9a-f]{3}:/i.test(ip)||/^(2002|3fff):/i.test(ip))return false;const parts=ip.split(':');return !(parts[0].toLowerCase()==='2001'&&(parseInt(parts[1]||'0',16)<=0x1ff||parseInt(parts[1],16)===0xdb8));}
 return false;
}
export async function safeDownload(url,{maxBytes=MAX,signal}={}){
 const deadline=AbortSignal.timeout(20000);signal=signal?AbortSignal.any([signal,deadline]):deadline;
 let current=url;
 for(let redirects=0;redirects<4;redirects++){
  const u=new URL(current);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')throw new Error('资源仅接受公开 HTTPS 地址');
  const host=u.hostname.replace(/^\[|\]$/g,''),addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
  if(!addresses.length||addresses.some(a=>!publicIP(a.address)))throw new Error('资源地址指向本机、私网或保留地址');
  const target=addresses[0];
  const result=await new Promise((resolve,reject)=>{
   const request=https.request(u,{method:'GET',agent:false,signal,timeout:15000,
    lookup:(_hostname,options,callback)=>options.all?callback(null,[target]):callback(null,target.address,target.family),
    headers:{'User-Agent':'DSH-QQ-Framework/0.2','Accept':'application/octet-stream'}},response=>{
     if([301,302,303,307,308].includes(response.statusCode)){response.resume();resolve({redirect:new URL(response.headers.location,u).href});return;}
     if(response.statusCode!==200){response.resume();reject(new Error('资源请求失败：HTTP '+response.statusCode));return;}
     if(Number(response.headers['content-length'])>maxBytes){response.destroy();reject(new Error('资源文件过大'));return;}
     const parts=[];let size=0;
     response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)response.destroy(new Error('资源文件过大'));else parts.push(chunk);});
     response.on('end',()=>resolve({bytes:Buffer.concat(parts)}));response.on('error',reject);
   });
   request.on('timeout',()=>request.destroy(new Error('资源请求超时')));request.on('error',reject);request.end();
  });
  if(result.bytes)return result.bytes;current=result.redirect;
 }
 throw new Error('资源重定向次数过多');
}
export function mediaType(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))return 'image/gif';
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
 if(bytes.subarray(0,6).toString()==='#!SILK'||bytes.subarray(1,7).toString()==='#!SILK')return 'audio/silk';
 if(bytes.subarray(0,4).toString()==='OggS')return 'audio/ogg';
 if(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&224)===224)return 'audio/mpeg';
 if(bytes.subarray(4,8).toString()==='ftyp')return 'video/mp4';
 return 'application/octet-stream';
}
export class Media {
 constructor(store){this.store=store;this.dir=path.join(store.dir,'media');this.items=new Map();}
 async start(){await mkdir(this.dir,{recursive:true});for(const name of await readdir(this.dir))if(/^[a-f0-9-]{36}\.bin$/.test(name))await rm(path.join(this.dir,name),{force:true});}
 async put(bytes,{key,plugin='core',name='resource',purpose='image'}){
  bytes=Buffer.from(bytes);if(!bytes.length||bytes.length>MAX)throw new Error('资源须为 1 字节–8 MB');
  if(!/^\d+:(private|group):\d+$/.test(key))throw new Error('资源必须绑定具体聊天');
  const mime=mediaType(bytes);const dimensions=mime.startsWith('image/')?imageDimensions(bytes,mime):{};if(purpose==='image'&&!mime.startsWith('image/'))throw new Error('图片只支持 PNG、JPEG、GIF、WebP');
  if(purpose==='audio'&&!mime.startsWith('audio/')||purpose==='video'&&!mime.startsWith('video/'))throw new Error('媒体类型与用途不符');
  if(!['image','audio','video','file'].includes(purpose))throw new Error('资源用途无效');
  await this.cleanup();if(this.items.size>=100)throw new Error('资源池已满，请稍后重试');
  const id=randomUUID();await mkdir(this.dir,{recursive:true});await writeFile(path.join(this.dir,id+'.bin'),bytes,{mode:0o600});
  const row={id,key,plugin,name:String(name).replace(/[^\p{L}\p{N} ._-]/gu,'_').slice(0,100).replace(/^\.+$/,'resource')||'resource',mime,...dimensions,size:bytes.length,purpose,expires:Date.now()+3600000};
  this.items.set(id,row);return {...row};
 }
 async resolve(id,c,purpose='image',plugin='core'){
  const r=this.items.get(id);if(!r||r.expires<Date.now()||r.key!==c.key||r.plugin!==plugin||r.purpose!==purpose)throw new Error('资源不存在、已过期或不属于当前聊天与插件');
  const bytes=await readFile(path.join(this.dir,r.id+'.bin'));if(bytes.length!==r.size||mediaType(bytes)!==r.mime)throw new Error('资源内容校验失败');
  return {row:r,file:'base64://'+bytes.toString('base64')};
 }
 async cleanup(){
  for(const [id,r]of this.items)if(r.expires<Date.now()){this.items.delete(id);await rm(path.join(this.dir,id+'.bin'),{force:true});}
 }
 async stop(){for(const id of this.items.keys())await rm(path.join(this.dir,id+'.bin'),{force:true});this.items.clear();}
}
