import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {publicIP} from '../../core/media.js';
export function publicUrl(value){
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')throw Error('仅允许无凭据的公开 HTTPS 网页');
 const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||isIP(host)&&!publicIP(host))throw Error('不能访问本机、私网或保留地址');
 u.hash='';return u;
}
export async function readPublic(value,{signal,maxBytes=1500000,timeoutMs=12000,resolve=lookup,request=https.request}={}){
 const deadline=AbortSignal.timeout(timeoutMs);signal=signal?AbortSignal.any([signal,deadline]):deadline;
 let u=publicUrl(value);
 for(let hop=0;hop<5;hop++){
  signal.throwIfAborted();
  const host=u.hostname.replace(/^\[|\]$/g,'');
  // Resolve once, validate every answer and pin the connection to that answer.
  let addresses;
  if(isIP(host))addresses=[{address:host,family:isIP(host)}];
  else{let abortLookup;const aborted=new Promise((_,reject)=>{abortLookup=()=>reject(signal.reason);signal.addEventListener('abort',abortLookup,{once:true});if(signal.aborted)abortLookup();});try{addresses=await Promise.race([resolve(host,{all:true}),aborted]);}finally{signal.removeEventListener('abort',abortLookup);}}
  if(!addresses.length||addresses.some(a=>!publicIP(a.address)))throw Error('网页域名指向私网或保留地址');
  const target=addresses[0];
  const result=await new Promise((accept,reject)=>{
   const req=request(u,{method:'GET',agent:false,signal,timeout:timeoutMs,headers:{'User-Agent':'Mozilla/5.0 (compatible; QQWebReader/1.0)','Accept':'text/html,application/xhtml+xml,application/rss+xml,application/xml,text/xml,text/plain','Accept-Encoding':'identity'},lookup:(_host,options,cb)=>options.all?cb(null,[target]):cb(null,target.address,target.family)},res=>{
    if([301,302,303,307,308].includes(res.statusCode)){const location=res.headers.location;res.resume();if(!location)return reject(Error('网页跳转缺少地址'));return accept({redirect:location});}
    if(res.statusCode!==200){res.resume();return reject(Error('网页请求失败：HTTP '+res.statusCode));}
    const type=String(res.headers['content-type']||'').toLowerCase();
    if(!/^(text\/(html|plain|xml)|application\/(xhtml\+xml|rss\+xml|xml|json)|text\/json)(?:;|$)/.test(type)){res.resume();return reject(Error('仅支持网页、纯文本、RSS/XML 和 JSON，不能下载或执行文件'));}
    if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.resume();return reject(Error('网页使用了不支持的压缩格式'));}
    if(Number(res.headers['content-length'])>maxBytes){res.destroy();return reject(Error('网页超过读取大小限制'));}
    const chunks=[];let length=0;
    res.on('data',chunk=>{length+=chunk.length;if(length>maxBytes){res.destroy();reject(Error('网页超过读取大小限制'));}else chunks.push(chunk);});
    res.on('error',reject);res.on('end',()=>{try{const charset=/charset=["']?([\w-]+)/i.exec(type)?.[1]||'utf-8';accept({url:u.href,body:new TextDecoder(charset).decode(Buffer.concat(chunks)),contentType:type});}catch{reject(Error('网页字符编码不支持'));}});
   });req.on('timeout',()=>req.destroy(Error('网页请求超时')));req.on('error',reject);req.end();
  });
  if(!result.redirect)return result;
  u=publicUrl(new URL(result.redirect,u).href);
 }
 throw Error('网页跳转次数过多');
}
export function decode(value){return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_all,key)=>{if(key[0]==='#'){const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[key.toLowerCase()]||'';});}
export function plain(value){return decode(decode(value).replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ').replace(/<[^>]+>/g,' ')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/\s+/g,' ').trim();}
export function imageResults(html,count=6){
 if(typeof html!=='string'||!html.includes('iusc'))throw Error('图片搜索服务没有返回预期结构（页面可能要求验证或已改版）');
 const rows=[],seen=new Set();
 for(const match of html.matchAll(/<a\b[^>]*>/gi)){
  const tag=match[0];if(!/\bclass\s*=\s*(["'])[^"']*\biusc\b[^"']*\1/i.test(tag))continue;
  const encoded=/\bm\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2];if(!encoded)continue;
  let item;try{item=JSON.parse(decode(encoded));}catch{continue;}
  let imageUrl,sourceUrl;
  try{imageUrl=publicUrl(item.murl).href;sourceUrl=publicUrl(item.purl).href;}catch{continue;}
  if(seen.has(imageUrl))continue;seen.add(imageUrl);
  const title=plain(item.t||item.desc||'').replace(/[\ue000-\uf8ff]/g,' ').replace(/\s+/g,' ').trim();
  const description=plain(item.desc||'').replace(/[\ue000-\uf8ff]/g,' ').replace(/\s+/g,' ').trim();
  rows.push({title:title.slice(0,300)||'未命名图片',description:description.slice(0,700),sourceUrl,imageUrl});
  if(rows.length>=count)break;
 }
 if(!rows.length)throw Error('图片搜索没有返回可安全下载的 HTTPS 图片');
 return rows;
}
export function searchResults(xml,count=5){
 if(!/<rss\b/i.test(xml))throw Error('搜索服务没有返回 RSS 结构（页面可能要求验证或已改版）');
 const field=(s,name)=>new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i').exec(s)?.[1]||'';
 const rows=[],seen=new Set();for(const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)){
  const item=match[1];let url;try{url=publicUrl(decode(field(item,'link')).trim()).href;}catch{continue;}
  if(seen.has(url))continue;seen.add(url);rows.push({title:plain(field(item,'title')).slice(0,250),url,snippet:plain(field(item,'description')).slice(0,700)});if(rows.length>=count)break;
 }return rows;
}
function pageDate(body){
 const patterns=[
  /<meta\b[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
  /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i,
  /<meta\b[^>]*name=["'](?:date|pubdate|publish-date)["'][^>]*content=["']([^"']+)["']/i,
  /<time\b[^>]*datetime=["']([^"']+)["']/i,
  /"datePublished"\s*:\s*"([^"]+)"/i
 ];
 for(const pattern of patterns){const raw=pattern.exec(body)?.[1];if(!raw)continue;const value=Date.parse(raw);if(Number.isFinite(value))return value;}
 return 0;
}
export function article(page,maxChars=10000){
 const title=plain(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(page.body)?.[1]||'');
 const body=/text\/plain/.test(page.contentType)?page.body:page.body.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
 const region=/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)\s*>/i.exec(body)?.[1]||body;
 const text=/text\/plain/.test(page.contentType)?region.trim():plain(region);
 if(text.length<40)throw Error('页面没有足够正文，可能需要登录或 JavaScript，不能据此作答');
 return {title,url:page.url,text:text.slice(0,maxChars),truncated:text.length>maxChars,publishedAt:pageDate(page.body)};
}
