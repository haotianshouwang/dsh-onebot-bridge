import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {zipSync,strToU8} from 'fflate';
import {ReplyGate} from '../src/session/reply-gate.js';
import {IncomingMedia,decodeFile,pdfText,videoFrames} from '../src/session/incoming.js';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {normalizeEvent} from '../src/onebot/index.js';
const bot='10000002',owner='10000001',msg=(extra={})=>({type:'message',bot,user:owner,kind:'group',peer:'88888',key:bot+':group:88888',id:'1001',time:Date.now()/1000,text:'普通聊天',mentions:[],parts:[],...extra});
const config={groupReplyMode:'smart',groupReplyProbability:10,groupReplyCooldown:30,groupAutoLimit:2,botAliases:['肥鱼'],followupEnabled:true};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cLxkAAAAASUVORK5CYII=','base64');
async function setup(t){
 process.env.QQBOT_OWNER=owner;const dir=await mkdtemp(path.join(os.tmpdir(),'qq-phase4-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();store.data.settings.mergeWindowMs=0;store.data.framework.ownerQQ=owner;store.data.framework.listenGroups=['88888'];const permissions=new Permissions(store),incoming=new IncomingMedia(store,permissions),calls=[],uploads=[];
 incoming.attach({status:{bot},request:async(action,args)=>{calls.push({action,args});return {outcome:'confirmed',data:action==='fetch_ptt_text'?{text:'语音识别测试'}:action==='ocr_image'?{texts:[{text:'OCR 测试'}]}:{base64:png.toString('base64')}};}});
 const ctx={llm:{resolveModelInfo:async()=>({inputModalities:['text','image']})},sessionController:{agents:{selectionFor:()=>({current:{provider:'test',model:'vision'}})}},fileUploads:{upload:async(_agent,request)=>{uploads.push(request);return {receiptId:'receipt-'+uploads.length};}}};
 return {store,permissions,incoming,calls,uploads,ctx,agent:{id:'test-agent'},dir};
}
test('smart reply probability, cooldown, pending turn and per-group cap prevent replying to every message',()=>{
 let now=100000;const gate=new ReplyGate({now:()=>now,random:()=>0.05});
 const first=gate.decide(msg(),config);assert.equal(first.ambient,true);assert.equal(gate.decide(msg({id:'2'}),config).allow,false);first.release();
 assert.match(gate.decide(msg({id:'3'}),config).reason,/冷却/);now+=31000;gate.decide(msg({id:'4'}),config).release();now+=31000;
 assert.equal(gate.decide(msg({key:bot+':group:77777',peer:'77777'}),config).allow,true);
 const miss=new ReplyGate({random:()=>0.99});assert.equal(miss.decide(msg(),config).allow,false);
});
test('explicit mentions, known quoted bot messages and configured aliases bypass random chance, not identity checks',()=>{
 const gate=new ReplyGate({random:()=>0.99}),s={...config,groupReplyMode:'direct'};
 for(const m of [msg({mentions:[bot]}),msg({text:'肥鱼，看看这张图'})])assert.equal(gate.decide(m,s).allow,true);
 assert.equal(gate.decide(msg(),s,{quoted:true}).allow,true);assert.equal(gate.decide(msg(),s).allow,false);
 assert.equal(gate.decide(msg({mentions:['123456']}),config).allow,false);assert.equal(gate.decide(msg({text:'[图片]'}),config).allow,false);
 assert.equal(gate.decide(msg({kind:'private',key:bot+':private:'+owner,peer:owner}),config).allow,true);
});
test('configured short follow-up limits remain same-actor and expire after its idle window',()=>{
 const limits={...config,followupWindowSec:30,followupMaxTurns:2};let now=100000;const gate=new ReplyGate({now:()=>now,random:()=>1}),m=msg({mentions:[bot]}),wake=gate.decide(m,limits);gate.replied(m,wake,limits);
 assert.equal(gate.decide(msg({user:'999999'}),limits).allow,false);
 assert.equal(gate.decide(msg(),limits).reason,'followup');assert.equal(gate.decide(msg(),limits).reason,'followup');assert.equal(gate.decide(msg(),limits).allow,false);
 now+=31000;assert.equal(gate.decide(msg(),limits).allow,false);
});
test('ambient reply receipts cannot execute even an owner-enabled status tool',async t=>{
 const x=await setup(t),c=x.permissions.issue(msg(),'ambient');
 assert.match(x.permissions.decision({id:'core.status'},c),/只聊天/);
});
test('group upload and offline-file notices normalize as attachments with their original actor',()=>{
 const group=normalizeEvent({post_type:'notice',notice_type:'group_upload',self_id:bot,group_id:88888,user_id:owner,time:123,file:{id:'file1',name:'测试.txt',size:4}});
 assert.equal(group.type,'message');assert.equal(group.parts[0].type,'file');assert.equal(group.user,owner);assert.equal(group.replyable,false);
 const privateFile=normalizeEvent({post_type:'notice',notice_type:'offline_file',self_id:bot,user_id:owner,time:123,file:{id:'file2',name:'文档.pdf',size:8}});assert.equal(privateFile.kind,'private');
});
test('vision input contains actual base64 image content, not only a placeholder',async t=>{
 const x=await setup(t),m=msg({text:'看图 [图片]',parts:[{type:'image',data:{file:'hash.png'}}]}),context=x.permissions.issue(m);
 const result=await x.incoming.build(m,{...x,context});const image=result.content.find(c=>c.type==='image');
 assert.ok(image);assert.equal(image.data,png.toString('base64'));assert.equal(image.mediaType,'image/png');assert.equal(result.summary[0].interpreted,true);
});
test('text-only models receive OCR with explicit limits and a durable file receipt',async t=>{
 const x=await setup(t);x.ctx.llm.resolveModelInfo=async()=>({inputModalities:['text']});
 const m=msg({parts:[{type:'image',data:{file:'hash.png'}}]}),r=await x.incoming.build(m,{...x,context:x.permissions.issue(m)});
 assert.ok(!r.content.some(c=>c.type==='image'));assert.ok(r.content.some(c=>c.type==='file'&&c.receiptId));assert.match(r.content.map(c=>c.text||'').join(''),/仅为 OCR/);assert.equal(x.uploads.length,1);
});
test('voice is transcribed by original message ID and attached through the DSH file upload API',async t=>{
 const x=await setup(t),m=msg({parts:[{type:'record',data:{file:'voice-id'}}]}),r=await x.incoming.build(m,{...x,context:x.permissions.issue(m)});
 assert.equal(x.calls.find(c=>c.action==='fetch_ptt_text').args.message_id,m.id);assert.match(r.content.map(c=>c.text||'').join(''),/语音识别测试/);assert.ok(r.content.some(c=>c.type==='file'));
});
test('files with content are extracted as text; arbitrary gateway-local paths are never read',async t=>{
 const x=await setup(t),m=msg({parts:[{type:'file',data:{file_id:'fileid',name:'report.txt'}}]});
 x.incoming.bot.request=async()=>({outcome:'confirmed',data:{base64:Buffer.from('正文 42').toString('base64')}});
 const r=await x.incoming.build(m,{...x,context:x.permissions.issue(m)});assert.match(r.content.map(c=>c.text||'').join(''),/正文 42/);assert.equal(r.summary[0].attached,true);
 x.incoming.bot.request=async()=>({outcome:'confirmed',data:{file:'C:\\private\\secret.txt',url:'C:\\private\\secret.txt'}});
 const failed=await x.incoming.build(m,{...x,context:x.permissions.issue(m)});assert.equal(failed.summary[0].attached,false);assert.match(failed.summary[0].error,/未返回附件字节/);
});
test('attachment follow-up cache cannot cross actors or chat scopes',async t=>{
 const x=await setup(t),first=msg({parts:[{type:'record',data:{file:'voice-id'}}]});x.incoming.capture(first);
 const later=msg({id:'1002',text:'请处理刚才的附件'}),merged=x.incoming.withRecent(later,{ambient:false});
 assert.equal(merged.parts.length,1);assert.equal(x.incoming.withRecent({...later,user:'999999'},{ambient:false}).parts.length,0);
 const r=await x.incoming.build(merged,{...x,context:x.permissions.issue(merged)});assert.equal(x.calls.find(c=>c.action==='fetch_ptt_text').args.message_id,'1001');assert.ok(r.summary[0].interpreted);
 assert.equal(x.incoming.withRecent(later,{ambient:true}).parts.length,0);
});
test('disabled media and forged context fail without reading arbitrary input',async t=>{
 const x=await setup(t);x.store.data.settings.mediaImages=false;const m=msg({parts:[{type:'image',data:{file:'C:\\secret.png'}}]});
 const r=await x.incoming.build(m,{...x,context:x.permissions.issue(m)});assert.match(r.summary[0].error,/已关闭/);assert.equal(x.calls.length,0);
 await assert.rejects(x.incoming.build(m,{...x,context:{...x.permissions.issue(m),actor:'999999'}}),/无效|变化/);
});
test('DOCX extraction is bounded and never executes scripts or fetches linked content',()=>{
 const bytes=zipSync({'word/document.xml':strToU8('<w:p><w:t>文档测试 &amp; 42</w:t></w:p>')});assert.match(decodeFile(bytes,'test.docx'),/文档测试 & 42/);assert.throws(()=>decodeFile(Buffer.from([1,0,2]),'test.txt'),/二进制/);
});
test('short videos yield bounded images using fixed ffmpeg arguments',async t=>{
 const x=await setup(t),file=path.join(x.dir,'fixture.mp4'),made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=64x64:d=2','-c:v','libx264','-movflags','+faststart','-y',file],{windowsHide:true});assert.equal(made.status,0,made.stderr?.toString());
 const frames=await videoFrames(await readFile(file),x.dir);assert.ok(frames.length>=1&&frames.length<=3);assert.equal(frames[0][0],255);
});
test('PDF text is parsed in a bounded worker without granting filesystem tools',async t=>{
 const x=await setup(t);let pdf='%PDF-1.4\n',offset=[0];const add=s=>{offset.push(Buffer.byteLength(pdf));pdf+=offset.length-1+' 0 obj\n'+s+'\nendobj\n';};
 add('<< /Type /Catalog /Pages 2 0 R >>');add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
 const stream='BT /F1 12 Tf 20 100 Td (PHASE4 PDF CHECK) Tj ET';add('<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream');add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
 const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offset.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
 assert.match(await pdfText(Buffer.from(pdf)),/PHASE4 PDF CHECK/);
});

test('host shutdown leaves a scoped deny guard on previously prepared QQ agents',async()=>{
 const {NativeDSH}=await import('../src/session/native.js');let deny,removed=0;
 const native=new NativeDSH({}, {data:{sessions:{},framework:{retiredSessions:[]}}},{},{});
 native.sections.set('s',{agent:{id:'shutdown-test',ctx:{tools:{guard:fn=>{deny=fn;return()=>{};}}}},tools:[()=>removed++],disposers:[()=>removed++]});
 await native.stop();assert.match(deny({agent:{id:'shutdown-test'}}),/禁止/);assert.equal(deny({agent:{id:'ordinary-dsh-session'}}),undefined);assert.equal(removed,2);
});
