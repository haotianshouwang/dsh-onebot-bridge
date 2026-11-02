import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Store,validateSettings} from '../src/host/store.js';
import {Permissions,invalidate} from '../src/core/permissions.js';
import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';
import {Builtins} from '../src/builtins/index.js';import {Extensions} from '../src/extensions/index.js';import {Router} from '../src/session/router.js';
import {Conversation} from '../src/session/conversation.js';
import {chatBreaks,qqPlain,quoteReply} from '../src/session/output.js';
import {adaptPersona,styleAdvice,reviewReply} from '../src/session/style.js';
import {renderPersona} from '../src/personas/index.js';
const bot='10000002',owner='10000001',group='88888';
const message=(extra={})=>({type:'message',bot,user:owner,kind:'group',peer:group,key:bot+':group:'+group,id:'101',time:Date.now()/1000,text:'你加了什么？',sender:'主人',mentions:[bot],parts:[],...extra});
async function setup(t){
 process.env.QQBOT_OWNER=owner;const dir=await mkdtemp(path.join(os.tmpdir(),'qq-natural-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();store.data.settings.mergeWindowMs=0;Object.assign(store.data.settings,{groupEnabled:true,allowedGroups:[group],groupAudience:'all',sendInterval:500,replySplit:'paragraphs'});Object.assign(store.data.framework,{ownerQQ:owner,listenGroups:[group],enabledActions:['core.status']});
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media),builtins=new Builtins(store),extensions=new Extensions(store,()=>{}),sent=[],runs=[];
 const gateway={status:{bot,online:true},request:async(a,p)=>{sent.push({a,p});return {outcome:'confirmed',data:{message_id:6000+sent.length}};},call:async()=>({})};
 const native={create:async m=>({sessionId:'s'+(runs.length+1),generation:store.data.framework.generation,chatKey:m.key}),reset:async()=>{},run:async(id,job,prompt,c)=>{runs.push({id,job,prompt,c});return '测试回复';},stop:async()=>{},revoke:async()=>{}};
 const router=new Router(store,native,extensions,()=>{},{permissions,events,actions,builtins});router.attach(gateway);t.after(()=>media.stop());return {store,permissions,events,media,actions,builtins,router,native,gateway,sent,runs};
}
test('automatic quote is off by default; explicit quote preferences remain available',()=>{
 const m=message();assert.equal(quoteReply(m),false);assert.equal(quoteReply(m,'always'),true);assert.equal(quoteReply(m,'follow'),false);assert.equal(quoteReply({...m,reply:'100'},'follow'),true);
 for(const changed of [{kind:'private'},{replyable:false},{id:'poke-event'}])assert.equal(quoteReply({...m,...changed},'always'),false);
});
test('legacy conversational slashes become newlines without altering URLs, math or code',()=>{
 assert.equal(qqPlain('我是鲸鱼不是菜 / 片我？先看看你的刀工吧'),'我是鲸鱼不是菜\n片我？先看看你的刀工吧');
 for(const s of ['10 / 2 = 5','输入/输出','https://example.com/a/b','a / b','2026/10/29'])assert.equal(chatBreaks(s),s);
 assert.equal(chatBreaks('~~~js\nconst x = a / b;\n~~~'),'~~~js\nconst x = a / b;\n~~~');
 assert.equal(chatBreaks('算式 \x60a / b\x60，别改这里'),'算式 \x60a / b\x60，别改这里');
});
test('persona compilation adapts legacy sending protocol while retaining saved identity and traits',()=>{
 const raw='你是小鲸鱼，偶尔喜欢白饭。\n一条只发一行，用 send_message 数组分条。\n九、回复示例（斜杠＝分成两条消息发送）\n　　你好 / 我来了';
 const p={id:'p',name:'小鲸鱼',version:5,prompt:raw},rendered=renderPersona(p,{kind:'group'});
 assert.equal(p.prompt,raw);assert.match(rendered,/你是小鲸鱼/);assert.match(rendered,/喜欢白饭/);assert.ok(!rendered.includes('send_message'));assert.ok(!rendered.includes('斜杠＝'));assert.match(rendered,/你好\n我来了/);
 assert.equal(adaptPersona('正常人设\n不照搬示例'),'正常人设\n不照搬示例');
});
test('stale food jokes are discouraged for unrelated messages but not actual food questions',()=>{
 const recent=['底层代码第一行：先吃饭','没白饭我就不干活'];
 assert.equal(styleAdvice(recent,'你加了什么？').foodLock,true);assert.equal(reviewReply('还是那一碗白饭',recent,'你加了什么？').repeat,true);
 assert.equal(styleAdvice(recent,'今天吃了什么？').foodLock,false);assert.equal(reviewReply('今天吃了一碗白饭呀',recent,'今天吃了什么？').repeat,false);
 assert.equal(styleAdvice(recent,'不要再提吃饭了').foodLock,true);
});
test('用户已经回答饮食问题后，不再重复追问',()=>{
 const advice=styleAdvice([], '没有吃，刚忙完', ['没有吃，刚忙完']);
 assert.equal(advice.foodAnswered,true);
 assert.equal(reviewReply('那你吃饭了吗？', [], '没有吃，刚忙完', ['没有吃，刚忙完']).repeat,true);
 assert.equal(reviewReply('那先忙完再吃点东西吧。', [], '没有吃，刚忙完', ['没有吃，刚忙完']).repeat,false);
});
test('duplicate checks allow explicit repetitions and factual identifiers',()=>{
 const old='这次我给你介绍一下当前的群聊功能。';
 assert.equal(reviewReply(old,[old],'你再说一遍原话').repeat,false);assert.equal(reviewReply(old,[old],'换个话题吧').repeat,true);
 assert.equal(reviewReply(old+'呀',[old],'换个话题吧').repeat,true);
 assert.equal(reviewReply('GROUP4821',['GROUP4821'],'你还记得测试口令吗？').repeat,false);
 assert.equal(reviewReply('先吃饭',['先吃饭','白饭好吃'],'把原话重复一遍').repeat,false);
});
test('group context preserves human statements while limiting old self-dialogue',()=>{
 const c=new Conversation({data:{}}),m=message();for(let i=0;i<8;i++){c.remember({...m,id:'u'+i,text:'群友消息'+i});c.sent({...m,id:String(100+i)},900+i,i<4?'重复的同一句老梗':'不同的机器人表达'+i);}
 const rows=c.context({...m,id:'current'}).split('\n').slice(1).map(l=>JSON.parse(l));assert.equal(rows.filter(r=>r.speaker!=='我').length,8);assert.ok(rows.filter(r=>r.speaker==='我').length<=3);assert.equal(c.find(m,'900').text,'重复的同一句老梗');
});

test('private follow-ups retain the original speakers behind a proactive group story', () => {
  const conversation = new Conversation({data: {}});
  const msg = message({kind: 'private', peer: owner, key: bot + ':private:' + owner});
  conversation.sent(msg, 'story-1', '群里有人说鱼要鲨人了', {
    key: bot + ':group:' + group,
    sources: [{id: 'source-1', user: '12345678', text: '鱼要鲨人了', time: Date.now() / 1000}]
  });
  const background = conversation.context({...msg, id: 'question', text: '谁说的'});
  assert.match(background, /12345678/);
  assert.match(background, /鱼要鲨人了/);
  assert.match(background, /原消息/);
  assert.equal(conversation.context({...msg, key: bot + ':private:77777'}), '');
});
test('text-only child contexts retain identity, deny tools and expire with the original lease',async t=>{
 const x=await setup(t),parent=x.permissions.issue(message()),child=x.permissions.textOnly(parent);
 assert.equal(child.actor,parent.actor);assert.equal(child.key,parent.key);assert.equal(child.mode,'rewrite');assert.match(x.permissions.decision(x.actions.definitions.get('core.status'),child),/改写/);
 x.permissions.close(parent);assert.match(x.permissions.valid(child),/失效/);const next=x.permissions.issue(message({id:'2'})),another=x.permissions.textOnly(next);invalidate(x.store);assert.match(x.permissions.valid(another),/撤销/);
});
test('a repeated draft gets one text-only rewrite and only the revised reply is sent without quote',async t=>{
 const x=await setup(t),old='底层代码第一行：先吃饭',m=message();x.router.conversation.sent({...m,id:'90'},5000,old);x.router.conversation.sent({...m,id:'91'},5001,'别的功能都是白饭附赠的');
 let attempts=0;x.native.run=async(_s,_j,_p,c)=>{attempts++;if(attempts===2){assert.equal(c.mode,'rewrite');assert.match(x.permissions.decision(x.actions.definitions.get('core.status'),c),/改写/);return '刚才那句是玩笑，具体改了哪些功能得看实际更新。';}return old;};
 await x.router.receive(m);await Promise.all([...x.router.queues.values()]);assert.equal(attempts,2);assert.equal(x.sent.length,1);assert.ok(x.sent[0].p.message.every(p=>p.type!=='reply'));assert.ok(!x.sent[0].p.message.at(-1).data.text.includes('白饭'));assert.equal(x.store.data.inbox.at(-1).styleReview.redrafted,true);
});
test('a second repeated draft is skipped instead of sending it or retrying endlessly',async t=>{
 const x=await setup(t),old='底层代码第一行：先吃饭',m=message();x.router.conversation.sent({...m,id:'90'},5000,old);x.router.conversation.sent({...m,id:'91'},5001,'白饭才是我的动力');let attempts=0;x.native.run=async()=>{attempts++;return old;};
 await x.router.receive(m);await Promise.all([...x.router.queues.values()]);assert.equal(attempts,2);assert.equal(x.sent.length,0);assert.equal(x.store.data.inbox.at(-1).status,'skipped');
});
test('completed tool operations are not repeated by style redrafting',async t=>{
 const x=await setup(t),old='机器人当前在线，可以继续接收群消息。',m=message({text:'查一下机器人运行状态'});x.router.conversation.sent({...m,id:'90'},5000,old);let attempts=0;x.native.run=async(_s,_j,_p,c)=>{attempts++;await x.actions.invoke('core.status',{},c);return old;};
 await x.router.receive(m);await Promise.all([...x.router.queues.values()]);assert.equal(attempts,1);assert.equal(x.sent.length,1);
});
test('quote settings reject invalid modes',async t=>{const x=await setup(t);assert.throws(()=>validateSettings({...x.store.data.settings,replyQuoteMode:'guess'}),/引用/);});

test('automatic chat converts legacy separators but explicit send tools preserve requested text',async t=>{
 const x=await setup(t),m=message();x.native.run=async()=> '我是鲸鱼不是菜 / 片我？先看看你的刀工吧';
 await x.router.receive(m);await Promise.all([...x.router.queues.values()]);assert.match(x.sent[0].p.message.at(-1).data.text,/不是菜\n片我/);
 x.store.data.framework.enabledActions.push('qq.message.send');const c=x.permissions.issue(message({id:'202'})),literal='文件夹甲 / 文件夹乙；10 / 2';
 await x.actions.invoke('qq.message.send',{segments:[{type:'text',data:{text:literal}}]},c);assert.equal(x.sent.at(-1).p.message[0].data.text,literal);
});
