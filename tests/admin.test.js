import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createServer} from 'node:net';
import {AdminAuth,validatePassword} from '../src/web/admin-auth.js';
import {startAdminServer} from '../src/web/admin-server.js';

async function temp(t){const dir=await mkdtemp(path.join(os.tmpdir(),'qq-admin-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function freePort(){return new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});}

test('管理密码策略：长度、重复字符和常见弱密码',()=>{
 assert.equal(validatePassword('short'),'密码至少 10 位');
 assert.equal(validatePassword('aaaaaaaaaaaa'),'密码太简单，请换一个');
 assert.equal(validatePassword('password123'),'密码太常见，请换一个');
 assert.equal(validatePassword('correct horse battery'),null);
});

test('scrypt 口令哈希、会话过期与登录限速',async t=>{
 const dir=await temp(t),auth=await new AdminAuth(dir).open();
 assert.equal(auth.configured,false);
 await assert.rejects(auth.setPassword('short'),/至少 10 位/);
 await auth.setPassword('correct horse battery');
 assert.equal(auth.configured,true);
 assert.equal(await auth.verify('correct horse battery'),true);
 assert.equal(await auth.verify('wrong password'),false);
 const stored=JSON.parse(await readFile(path.join(dir,'admin.json'),'utf8'));
 assert.equal(stored.algorithm,'scrypt');
 assert.ok(!JSON.stringify(stored).includes('correct horse battery'),'明文密码不能落盘');
 const {token,csrf}=auth.createSession({ip:'127.0.0.1'});
 assert.equal(auth.session(token).csrf,csrf);
 auth.session(token).created=Date.now()-13*3600000;
 assert.equal(auth.session(token),null);
 const idle=auth.createSession({});
 auth.session(idle.token).last=Date.now()-31*60000;
 assert.equal(auth.session(idle.token),null);
 for(let i=0;i<5;i++)auth.loginFailed('9.9.9.9');
 assert.ok(auth.loginBlocked('9.9.9.9')>0);
 auth.loginSucceeded('9.9.9.9');
 assert.equal(auth.loginBlocked('9.9.9.9'),0);
 await auth.audit({outcome:'login',ip:'127.0.0.1'});
 const audit=await readFile(path.join(dir,'audit.jsonl'),'utf8');
 assert.match(audit,/"outcome":"login"/);
});

test('管理站点：设置密码、登录会话、CSRF、动作白名单与退出',async t=>{
 const dir=await temp(t),port=await freePort(),calls=[];
 const server=await startAdminServer({dir,port,action:async body=>{calls.push(body);return {revision:7,framework:{enabledActions:[]},settings:{},status:{online:true}};},log:()=>{}});
 t.after(()=>server.close());
 const base='http://127.0.0.1:'+port;
 let response=await fetch(base+'/api/session');
 assert.equal((await response.json()).configured,false);
 response=await fetch(base+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'short'})});
 assert.equal(response.status,400);
 response=await fetch(base+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'correct horse battery'})});
 assert.equal(response.status,200);
 const setup=await response.json();
 const cookie=response.headers.getSetCookie()[0].split(';')[0];
 assert.match(cookie,/^qqadmin=/);
 assert.ok(setup.csrf.length>=20);
 response=await fetch(base+'/api/session',{headers:{cookie}});
 const session=await response.json();
 assert.equal(session.authenticated,true);
 assert.equal(session.csrf,setup.csrf);
 response=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({action:'snapshot'})});
 assert.equal(response.status,403);
 response=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json',cookie,'x-csrf-token':setup.csrf},body:JSON.stringify({action:'snapshot'})});
 assert.equal(response.status,200);
 assert.equal((await response.json()).value.revision,7);
 response=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json',cookie,'x-csrf-token':setup.csrf},body:JSON.stringify({action:'invokeAction',capability:'qq.message.send',arguments:{}})});
 assert.equal(response.status,400);
 response=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json',cookie,'x-csrf-token':setup.csrf},body:JSON.stringify({action:'configureBuiltin',id:'welcome',enabled:false,config:{}})});
 assert.equal(response.status,200);
 assert.equal(calls.at(-1).action,'configureBuiltin');
 response=await fetch(base+'/api/logout',{method:'POST',headers:{'content-type':'application/json',cookie,'x-csrf-token':setup.csrf},body:'{}'});
 assert.equal(response.status,200);
 response=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json',cookie,'x-csrf-token':setup.csrf},body:JSON.stringify({action:'snapshot'})});
 assert.equal(response.status,401);
 const page=await fetch(base+'/');
 assert.equal(page.status,200);
 assert.match(page.headers.get('content-security-policy'),/default-src 'none'/);
 assert.equal(page.headers.get('x-frame-options'),'DENY');
});

test('管理站点：Three.js 星图模块由本地静态资源提供',async t=>{
 const dir=await temp(t),port=await freePort();
 const server=await startAdminServer({dir,port,action:async()=>({}),log:()=>{}});
 t.after(()=>server.close());
 const response=await fetch('http://127.0.0.1:'+port+'/assets/three.module.js');
 assert.equal(response.status,200);
 assert.match(response.headers.get('content-type') || '',/^text\/javascript/);
 const source=await response.text();
 assert.match(source,/WebGLRenderer/);
 assert.match(source,/export/);
});

test('图片资源按管理会话鉴权，动作携带会话元数据，退出时通知锁定',async t=>{
 const dir=await temp(t),port=await freePort();let seen=null;const ended=[];
 const server=await startAdminServer({
  dir,port,
  action:async(body,meta)=>{seen={body,meta};return {revision:1};},
  asset:async({kind,id,url},meta)=>{
   assert.ok(meta.session);
   if(kind==='sticker')assert.equal(id,'x');
   if(kind==='qzone-image')assert.equal(url,'https://m.qpic.cn/a.jpg');
   if(kind==='qzone-avatar')assert.equal(id,'10001');
   return {mime:'image/png',bytes:Buffer.from([137,80,78,71])};
  },
  onSessionEnd:token=>ended.push(token),
  log:()=>{}
 });
 t.after(()=>server.close());
 const base='http://127.0.0.1:'+port;
 let response=await fetch(base+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'correct horse battery'})});
 const setup=await response.json();const cookie=response.headers.getSetCookie()[0].split(';')[0];
 response=await fetch(base+'/api/sticker-image?id=x',{headers:{cookie}});
 assert.equal(response.status,200);
 assert.equal(response.headers.get('content-type'),'image/png');
 assert.equal((await response.arrayBuffer()).byteLength,4);
 response=await fetch(base+'/api/qzone-image?url='+encodeURIComponent('https://m.qpic.cn/a.jpg'),{headers:{cookie}});
 assert.equal(response.status,200);
 response=await fetch(base+'/api/qzone-avatar?id=10001',{headers:{cookie}});
 assert.equal(response.status,200);
 response=await fetch(base+'/api/sticker-image?id=x');
 assert.equal(response.status,401);
 response=await fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json',cookie,'x-csrf-token':setup.csrf},body:JSON.stringify({action:'snapshot'})});
 assert.equal(response.status,200);
 assert.equal(seen.meta.adminSession,cookie.slice('qqadmin='.length));
 assert.equal(seen.meta.session,cookie.slice('qqadmin='.length));
 response=await fetch(base+'/api/logout',{method:'POST',headers:{'content-type':'application/json',cookie,'x-csrf-token':setup.csrf},body:'{}'});
 assert.equal(response.status,200);
 assert.deepEqual(ended,[cookie.slice('qqadmin='.length)]);
});

test('错误密码触发登录限速，成功后清除',async t=>{
 const dir=await temp(t),port=await freePort();
 const server=await startAdminServer({dir,port,action:async()=>({}),log:()=>{}});
 t.after(()=>server.close());
 const base='http://127.0.0.1:'+port;
 await fetch(base+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'correct horse battery'})});
 for(let i=0;i<5;i++){
  const response=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'wrong'+i})});
  assert.equal(response.status,401);
 }
 const blocked=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'wrong again'})});
 assert.equal(blocked.status,429);
 assert.ok(Number(blocked.headers.get('retry-after'))>0);
});
