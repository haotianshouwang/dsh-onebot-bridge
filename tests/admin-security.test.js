import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,scryptSync} from 'node:crypto';
import {AdminAuth,validatePassword} from '../src/web/admin-auth.js';
import {totp,matchCounter,base32} from '../src/web/admin-totp.js';
import {startAdminServer,adminEndpoint} from '../src/web/admin-server.js';
const password=()=>randomBytes(24).toString('base64url');
const meta={ip:'local-test'};
async function fixture(t, options={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'admin-security-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));const key=randomBytes(32);
  const opts={deviceKey:async()=>key,...options};const open=()=>new AdminAuth(dir,opts).open();const auth=await open();return {auth,open,dir};
}
test('TOTP uses standard six-digit truncation and refuses consumed windows',()=>{
  const seed=Buffer.from('12345678901234567890');assert.equal(base32(seed),'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');assert.equal(totp(seed,1),'287082');assert.equal(matchCounter(seed,'287082',-1,59000),1);assert.equal(matchCounter(seed,'287082',1,59000),null);
});
test('only one first provision wins; failed persistence preserves the previous session and hash',async t=>{
  const {auth}=await fixture(t),a=password(),b=password();assert.ok(validatePassword('too short'));assert.ok(validatePassword('123456789012345'));assert.equal(validatePassword('😀'.repeat(14)+'abc'),null);
  const attempts=await Promise.allSettled([auth.setPassword(a),auth.setPassword(b)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(auth.record.N,131072);assert.ok(await auth.verify(a));assert.ok(!await auth.verify(b));
  const session=await auth.login(a,'',false,meta);await rename(auth.file,auth.file+'.original');await mkdir(auth.file);
  await assert.rejects(auth.changePassword(session.token,a,b));assert.ok(auth.session(session.token));assert.ok(await auth.verify(a));
});
test('v1 scrypt passwords remain usable; damage must not reopen first provision',async t=>{
  const {auth,open}=await fixture(t),current=password(),salt=randomBytes(16);
  await writeFile(auth.file,JSON.stringify({version:1,algorithm:'scrypt',N:16384,r:8,p:1,salt:salt.toString('base64'),hash:scryptSync(current,salt,32,{N:16384}).toString('base64')}));
  const old=await open(),session=await old.login(current,'',false,meta);assert.ok(session.token);await old.changePassword(session.token,current,password());assert.equal(old.record.N,131072);assert.equal(old.session(session.token),null);
  for(const raw of ['','{}','{bad']){await writeFile(auth.file,raw);const broken=await open();assert.equal(broken.status().corrupt,true);await assert.rejects(broken.setPassword(password()));assert.equal((await broken.login(current,'',false,meta)).unavailable,true);}
});
test('bound factors are encrypted, single-use across restart and concurrency; replacing them revokes sessions',async t=>{
  let now=1700000000000;const {auth,open,dir}=await fixture(t,{now:()=>now}),pw=password();await auth.setPassword(pw);assert.equal((await auth.login(pw,'',true,meta)).unavailable,true);
  const before=await auth.login(pw,'',false,meta);const secret=await auth.beginEnrollment();const seed=Buffer.from(auth.pending.seed),counter=()=>Math.floor(now/30000);
  const codes=await auth.confirmEnrollment(totp(seed,counter()));assert.equal(codes.length,8);assert.equal(auth.session(before.token),null);
  now+=30000;const code=totp(seed,counter());assert.ok((await auth.login(pw,code,true,meta)).token);const restart=await open();assert.ok(!(await restart.login(pw,code,true,meta)).token);
  const both=await Promise.all([0,1].map(()=>restart.login(pw,codes[0],true,meta)));assert.equal(both.filter(x=>x.token).length,1);assert.equal((await open()).status().recoveryRemaining,7);
  const stored=(await readFile(auth.file,'utf8'))+(await readFile(auth.auditFile,'utf8'));assert.ok([secret,pw,...codes,before.token].every(s=>!stored.includes(s)));
  const wrong=await new AdminAuth(dir,{deviceKey:async()=>randomBytes(32)}).open();assert.equal(wrong.corrupt,true);await assert.rejects(wrong.setPassword(password()));
  await restart.beginEnrollment();await restart.confirmEnrollment(totp(restart.pending.seed,counter()));assert.equal(restart.session(both.find(x=>x.token).token),null);assert.ok(!(await restart.login(pw,codes[1],true,meta)).token);
  const damaged=JSON.parse(await readFile(auth.file,'utf8'));damaged.mfa.box.tag=randomBytes(16).toString('base64');await writeFile(auth.file,JSON.stringify(damaged));assert.ok((await open()).corrupt);
});
test('HTTPS mode validates origin, upstream headers, MFA, cookie flags and CSRF; web cannot enroll',async t=>{
  const {auth}=await fixture(t),pw=password(),origin='https://admin.example.test';const server=await startAdminServer({auth,port:0,publicOrigin:origin,action:()=>{throw Error('unexpected');}});t.after(()=>server.close());
  const address='http://127.0.0.1:'+server.port;const headers={host:'admin.example.test',origin,'x-forwarded-proto':'https','content-type':'application/json'};
  // Node fetch rewrites the Host header on some versions. Use the native HTTP client for the proxy hop.
  const http=await import('node:http');const req=(url,data,extra={})=>new Promise((resolve,reject)=>{const r=http.request(address+url,{method:data?'POST':'GET',headers:{...headers,...extra}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,h:res.headers,json:JSON.parse(text)}));});r.on('error',reject);r.end(data?JSON.stringify(data):undefined);});
  assert.throws(()=>adminEndpoint('http://admin.example.test',1));assert.equal((await req('/api/session',null,{host:'wrong.test'})).status,403);assert.equal((await req('/api/session',null,{'x-forwarded-proto':'http'})).status,403);assert.equal((await req('/api/login',{}, {origin:'https://other.test'})).status,403);
  assert.equal((await req('/api/setup',{password:pw})).status,403);await auth.setPassword(pw);assert.equal((await req('/api/login',{password:pw})).status,409);
  await auth.beginEnrollment();const codes=await auth.confirmEnrollment(totp(auth.pending.seed,Math.floor(Date.now()/30000)));const result=await req('/api/login',{password:pw,factor:codes[0]});assert.equal(result.status,200);
  const cookie=result.h['set-cookie'][0];for(const flag of ['__Host-qqadmin=','Secure','HttpOnly','SameSite=Strict','Path=/'])assert.ok(cookie.includes(flag));assert.ok(!cookie.includes('Domain='));const c={cookie:cookie.split(';')[0]},valid={...c,'x-csrf-token':result.json.csrf};assert.equal((await req('/api/action',{action:'webSecurity',op:'begin'},valid)).status,400);assert.equal((await req('/api/logout',{},c)).status,403);assert.equal((await req('/api/password',{current:pw,password:password()},c)).status,403);assert.equal((await req('/api/logout',{},valid)).status,200);assert.equal((await req('/api/session',null,c)).json.authenticated,false);
  for(let n=0;n<5;n++)assert.equal((await req('/api/login',{password:'invalid',factor:'invalid'})).status,401);assert.equal((await req('/api/login',{password:pw,factor:codes[1]})).status,429);
});