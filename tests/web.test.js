import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {PluginSDK} from '../src/sdk.js';import {activateWeb} from '../src/builtins/web/index.js';import {publicUrl,readPublic,searchResults,article} from '../src/builtins/web/network.js';
const bot='10000002',owner='10000001',other='12345678',group='88888',key=bot+':group:'+group;
import {imageResults} from '../src/builtins/web/network.js';
const message=(extra={})=>({bot,user:other,kind:'group',peer:group,key,id:'1',...extra});
const rss='<rss><channel><item><title>官方 &amp; 文档</title><link>https://example.com/docs</link><description><![CDATA[<b>结果摘要</b>]]></description></item><item><title>私网</title><link>https://127.0.0.1/</link></item></channel></rss>';
const meta=value=>JSON.stringify(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const imageHtml='<html><div class="dgControl"><a class="iusc" aria-label="候选图片" m="'+meta({purl:'https://example.com/source',murl:'https://cdn.example.com/animal.png?size=large',t:'一只鲸鱼',desc:'<b>候选图片说明</b>'})+'"><img src="preview"></a><a class="iusc" m="'+meta({purl:'https://example.com/http-image',murl:'http://cdn.example.com/no.png',t:'非 HTTPS'})+'"></a></div></html>';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
async function setupImages(t,read,download,hooks={}){
 process.env.QQBOT_OWNER=owner;
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-web-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();
 Object.assign(store.data.framework,{listenGroups:[group],listenPrivate:true,listenAllPrivate:true,enabledActions:['plugin.qq-web.search','plugin.qq-web.read','plugin.qq-web.image-search','plugin.qq-web.image-send','qq.image.send']});
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media),sent=[];
 actions.attach({status:{bot},request:async(action,params)=>{sent.push({action,params});return {outcome:'confirmed',data:{message_id:9000+sent.length}};}});
 const sdk=new PluginSDK({store,permissions,events,media,actions}),api=activateWeb(sdk.facade(),{read,download,...hooks});
 const item=store.data.framework.nativePackages['qq-web'];
 item.enabled=true;item.scope={private:true,allUsers:true,users:[],groups:[group]};
 t.after(()=>sdk.stop());
 return {store,permissions,actions,sdk,api,item,sent};
}
async function setup(t,read){process.env.QQBOT_OWNER=owner;const dir=await mkdtemp(path.join(os.tmpdir(),'qq-web-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=await new Store(dir).open();Object.assign(store.data.framework,{listenGroups:[group],listenPrivate:true,listenAllPrivate:true,enabledActions:['plugin.qq-web.search','plugin.qq-web.read']});const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media);actions.attach({status:{bot}});const sdk=new PluginSDK({store,permissions,events,media,actions}),api=activateWeb(sdk.facade(),{read});const item=store.data.framework.nativePackages['qq-web'];item.enabled=true;item.scope={private:true,allUsers:true,users:[],groups:[group]};t.after(()=>sdk.stop());return {store,permissions,actions,sdk,api,item};}
test('ordinary member searches and reads with URLs and timestamps, without mutation privileges',async t=>{const x=await setup(t,async url=>url.includes('/search?')?{url,body:rss,contentType:'text/xml'}:{url,body:'<title>官方</title><main>'+('正文事实 '.repeat(30))+'</main>',contentType:'text/html'}),c=x.permissions.issue(message(),'chat');const s=await x.actions.invoke('plugin.qq-web.search',{query:'公开问题'},c);assert.equal(s.ok,true);assert.equal(s.results[0].url,'https://example.com/docs');assert.equal(s.untrusted,true);assert.ok(s.retrievedAt);const r=await x.actions.invoke('plugin.qq-web.read',{url:s.results[0].url},c);assert.equal(r.ok,true);assert.match(r.text,/正文事实/);assert.ok(x.permissions.decision(x.actions.definitions.get('qq.message.send'),c));assert.equal(x.permissions.owner(c),false);});
test('scope, switch, explicit deny and zero-tool modes apply to the web package',async t=>{const x=await setup(t,async()=>{throw Error('must not run');}),cap=x.actions.definitions.get('plugin.qq-web.search'),c=x.permissions.issue(message(),'chat');for(const mode of ['observer','rewrite','poke','ambient'])assert.ok(x.permissions.decision(cap,x.permissions.issue(message(),mode)));x.item.enabled=false;assert.ok(x.permissions.decision(cap,c));x.item.enabled=true;x.item.scope.groups=[];assert.ok(x.permissions.decision(cap,c));x.item.scope.groups=[group];x.store.data.framework.grants.push({capability:cap.id,allUsers:true,users:[],groups:[group],private:false,deny:true});assert.match(x.permissions.decision(cap,c),/拒绝/);});
test('private public search has its own listening and scope boundary',async t=>{const x=await setup(t,async url=>({url,body:rss}));const m=message({kind:'private',peer:other,key:bot+':private:'+other}),c=x.permissions.issue(m,'chat'),cap=x.actions.definitions.get('plugin.qq-web.search');assert.equal(x.permissions.decision(cap,c),null);x.item.scope.private=false;assert.ok(x.permissions.decision(cap,c));});
test('network errors are reported honestly without quarantining the plugin; per-room budget is enforced',async t=>{const x=await setup(t,async()=>{throw Error('HTTP 503');}),c=x.permissions.issue(message(),'chat');x.item.config.perMinute=2;for(let i=0;i<2;i++){const r=await x.actions.invoke('plugin.qq-web.search',{query:'test'},c);assert.equal(r.ok,false);assert.match(r.error,/503/);}for(let i=0;i<3;i++)await assert.rejects(x.actions.invoke('plugin.qq-web.search',{query:'test'},c),/上限/);assert.equal(x.item.enabled,true);assert.equal(x.store.data.framework.nativePackages['qq-web'].health.quarantined,undefined);});
test('RSS and text parsing preserve provenance and reject non-RSS challenge pages',()=>{const r=searchResults(rss);assert.equal(r.length,1);assert.equal(r[0].title,'官方 & 文档');assert.equal(r[0].snippet,'结果摘要');assert.throws(()=>searchResults('<html>captcha</html>'),/RSS/);const a=article({url:'https://example.com/final',contentType:'text/html',body:'<title>标题</title><script>evil()</script><main>'+('正文 '.repeat(50))+'</main>'},50);assert.equal(a.url,'https://example.com/final');assert.equal(a.truncated,true);assert.ok(!a.text.includes('evil'));});
test('non-public URLs and credentials are rejected',()=>{for(const u of ['file:///c:/secret','http://example.com','https://localhost','https://127.0.0.1','https://169.254.169.254/','https://[::1]/','https://10.0.0.1','https://user:pass@example.com','https://example.com:8443'])assert.throws(()=>publicUrl(u));});
const resolver=async()=>[{address:'93.184.216.34',family:4}];
test('image search parses Bing metadata, strips markup and rejects non-HTTPS image URLs',()=>{
 const rows=imageResults(imageHtml);
 assert.equal(rows.length,1);
 assert.equal(rows[0].title,'一只鲸鱼');
 assert.equal(rows[0].description,'候选图片说明');
 assert.equal(rows[0].sourceUrl,'https://example.com/source');
 assert.equal(rows[0].imageUrl,'https://cdn.example.com/animal.png?size=large');
 assert.throws(()=>imageResults('<html>captcha</html>'),/图片搜索/);
});
test('image search returns opaque current-chat candidates and image-send validates and sends only those candidates',async t=>{
 const downloads=[];
 const x=await setupImages(t,async url=>({url,contentType:'text/html',body:imageHtml}),async(url,options)=>{downloads.push({url,options});return png;});
 const c=x.permissions.issue(message(),'chat'),search=await x.actions.invoke('plugin.qq-web.image-search',{query:'鲸鱼'},c);
 assert.equal(search.ok,true);
 assert.equal(search.results.length,1);
 assert.equal(search.results[0].title,'一只鲸鱼');
 assert.equal(search.results[0].sourceUrl,undefined);
 assert.equal(search.results[0].imageUrl,undefined);
 assert.match(search.instruction,/不要输出图片网址/);
 await assert.rejects(x.actions.invoke('plugin.qq-web.image-send',{imageId:search.results[0].imageId},c),/尚未向当前用户开放/);
 for(const capability of ['plugin.qq-web.image-send','qq.image.send'])x.store.data.framework.grants.push({capability,allUsers:false,users:[other],groups:[group],private:false,deny:false,perMinute:5});
 const sent=await x.actions.invoke('plugin.qq-web.image-send',{imageId:search.results[0].imageId},c);
 assert.equal(sent.ok,true);
 assert.equal(sent.sourceUrl,undefined);
 assert.match(sent.instruction,/不要输出图片网址/);
 assert.equal(downloads.length,2);
 assert.equal(downloads[0].url,'https://cdn.example.com/animal.png?size=large');
 assert.equal(downloads[1].url,'https://cdn.example.com/animal.png?size=large');
 assert.equal(downloads[1].options.maxBytes,6*1024*1024);
 assert.equal(x.sent.length,1);
 assert.equal(x.sent[0].action,'send_group_msg');
 assert.match(x.sent[0].params.message[0].data.file,/^base64:\/\//);
 const repeated=await x.actions.invoke('plugin.qq-web.image-send',{imageId:search.results[0].imageId},c);
 assert.equal(repeated.ok,false);
 assert.match(repeated.error,/当前用户/);
});
test('image replies can opt back into source links',async t=>{
 const x=await setupImages(t,async url=>({url,contentType:'text/html',body:imageHtml}),async()=>png);
 x.item.config.imageSourceLink=true;
 const c=x.permissions.issue(message(),'chat'),search=await x.actions.invoke('plugin.qq-web.image-search',{query:'鲸鱼'},c);
 assert.equal(search.results[0].sourceUrl,'https://example.com/source');
 for(const capability of ['plugin.qq-web.image-send','qq.image.send'])x.store.data.framework.grants.push({capability,allUsers:false,users:[other],groups:[group],private:false,deny:false,perMinute:5});
 const sent=await x.actions.invoke('plugin.qq-web.image-send',{imageId:search.results[0].imageId},c);
 assert.equal(sent.sourceUrl,'https://example.com/source');
});
test('image-send rejects arbitrary URLs and other users candidates, and reports invalid image bytes',async t=>{
 const x=await setupImages(t,async url=>({url,contentType:'text/html',body:imageHtml}),async()=>png);
 const c=x.permissions.issue(message(),'chat'),search=await x.actions.invoke('plugin.qq-web.image-search',{query:'鲸鱼'},c);
 for(const capability of ['plugin.qq-web.image-send','qq.image.send'])x.store.data.framework.grants.push({capability,allUsers:false,users:[other,'12345679'],groups:[group],private:false,deny:false,perMinute:5});
 await assert.rejects(x.actions.invoke('plugin.qq-web.image-send',{imageId:search.results[0].imageId,url:'https://evil.example/x.png'},c),/不支持的参数/);
 const otherContext=x.permissions.issue(message({user:'12345679',id:'2'}),'chat'),wrong=await x.actions.invoke('plugin.qq-web.image-send',{imageId:search.results[0].imageId},otherContext);
 assert.equal(wrong.ok,false);
 assert.match(wrong.error,/当前用户/);
 const invalid=await setupImages(t,async url=>({url,contentType:'text/html',body:imageHtml}),async()=>Buffer.from('not an image'));
 const c2=invalid.permissions.issue(message(),'chat'),found=await invalid.actions.invoke('plugin.qq-web.image-search',{query:'鲸鱼'},c2);
 for(const capability of ['plugin.qq-web.image-send','qq.image.send'])invalid.store.data.framework.grants.push({capability,allUsers:false,users:[other],groups:[group],private:false,deny:false,perMinute:5});
 const bad=await invalid.actions.invoke('plugin.qq-web.image-send',{imageId:found.results[0].imageId},c2);
 assert.equal(bad.ok,false);
 assert.match(bad.error,/图片/);
});
function transport(responses,seen=[]){return (url,opts,callback)=>{seen.push({url:url.href,opts});const req=new EventEmitter();req.destroy=e=>req.emit('error',e);req.end=()=>queueMicrotask(()=>{const next=responses.shift(),res=new PassThrough();res.statusCode=next.status||200;res.headers=next.headers||{'content-type':'text/html'};callback(res);if(!res.destroyed)res.end(next.body||'hello');});return req;};}
test('DNS private answers and redirect-to-private are blocked before connection',async()=>{let calls=0;await assert.rejects(readPublic('https://example.com',{resolve:async()=>[{address:'10.1.1.1',family:4}],request:()=>calls++}),/私网/);assert.equal(calls,0);const seen=[];await assert.rejects(readPublic('https://example.com',{resolve:resolver,request:transport([{status:302,headers:{location:'https://127.0.0.1/'}}],seen)}),/私网/);assert.equal(seen.length,1);});
test('public redirects retain final URL and DNS is pinned; files and oversized pages are rejected',async()=>{const seen=[],p=await readPublic('https://example.com',{resolve:resolver,request:transport([{status:302,headers:{location:'/final'}},{body:'page'}],seen)});assert.equal(p.url,'https://example.com/final');let address;seen[0].opts.lookup('example.com',{},(_e,a)=>address=a);assert.equal(address,'93.184.216.34');await assert.rejects(readPublic('https://example.com',{resolve:resolver,request:transport([{headers:{'content-type':'application/octet-stream'}}])}),/文件/);await assert.rejects(readPublic('https://example.com',{resolve:resolver,maxBytes:4,request:transport([{body:'12345'}])}),/大小/);});

test('room hourly and per-user minute limits are separate from owner privileges',async t=>{const x=await setup(t,async url=>({url,body:rss,contentType:'text/xml'}));x.item.config.userPerMinute=2;const c=x.permissions.issue(message(),'chat');for(let i=0;i<2;i++)await x.actions.invoke('plugin.qq-web.search',{query:'test'},c);await assert.rejects(x.actions.invoke('plugin.qq-web.search',{query:'test'},c),/用户.*上限/);x.item.config.perHour=2;const owner=x.permissions.issue(message({user:'10000001',id:'2'}),'chat');await assert.rejects(x.actions.invoke('plugin.qq-web.search',{query:'test'},owner),/小时上限/);});
test('联网发图成功后把资源交给自动收藏，且不因收藏失败影响发送',async t=>{
 const seen=[];
 const x=await setupImages(t,async url=>({url,contentType:'text/html',body:imageHtml}),async()=>png,{onStickerSent:async(id,ctx,meta)=>{seen.push({id,name:meta.name});}});
 const c=x.permissions.issue(message(),'chat'),search=await x.actions.invoke('plugin.qq-web.image-search',{query:'鲸鱼'},c);
 for(const capability of ['plugin.qq-web.image-send','qq.image.send'])x.store.data.framework.grants.push({capability,allUsers:false,users:[other],groups:[group],private:false,deny:false,perMinute:5});
 const sent=await x.actions.invoke('plugin.qq-web.image-send',{imageId:search.results[0].imageId},c);
 assert.equal(sent.ok,true);
 assert.equal(typeof sent.resourceId,'string','发图结果应带 resourceId 供表情包收藏');
 assert.equal(seen.length,1,'发图成功应触发一次自动收藏');
 assert.match(seen[0].name,/鲸鱼/);
});

test('自动收藏抛错时发送仍然成功',async t=>{
 const x=await setupImages(t,async url=>({url,contentType:'text/html',body:imageHtml}),async()=>png,{onStickerSent:async()=>{throw new Error('表情库满');}});
 const c=x.permissions.issue(message(),'chat'),search=await x.actions.invoke('plugin.qq-web.image-search',{query:'鲸鱼'},c);
 for(const capability of ['plugin.qq-web.image-send','qq.image.send'])x.store.data.framework.grants.push({capability,allUsers:false,users:[other],groups:[group],private:false,deny:false,perMinute:5});
 const sent=await x.actions.invoke('plugin.qq-web.image-send',{imageId:search.results[0].imageId},c);
 assert.equal(sent.ok,true);
});