import test from 'node:test';import assert from 'node:assert/strict';import {access,mkdtemp,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {PluginSDK} from '../src/sdk.js';
import {activateTTS,defaultConfig,manifest,speechPayload,isAudio,synthesizeVoice,synthesizeLocal,LOCAL_SCRIPT} from '../src/builtins/tts/index.js';
import {migrateConfig} from '../src/core/package-model.js';

const bot='10000002',owner='10000001',other='12345678',group='88888',key=bot+':group:'+group;
const msg=(extra={})=>({bot,user:owner,kind:'group',peer:group,key,id:'m1',...extra});
// 最小可识别的 MP3 头（ID3 + 一帧同步），足够通过核心的资源类型校验。
const mp3=Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00\xff\xfb\x90\x64AAAAAAAA','latin1');

async function setup(t,{synthesize,sendOutcome='confirmed',sendState='submitted'}={}){
 process.env.QQBOT_OWNER=owner;
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-tts-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();
 Object.assign(store.data.framework,{listenGroups:[group],enabledActions:['plugin.qq-tts.speak','qq.audio.send']});
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media);
 actions.attach({status:{bot,online:true},request:async()=>({outcome:'confirmed',data:{}})});
 const invokes=[],synthCalls=[];
 const originalInvoke=actions.invoke.bind(actions);
 actions.invoke=async(id,args,c,signal)=>{
  if(id.startsWith('plugin.qq-tts.'))return originalInvoke(id,args,c,signal);
  invokes.push({id,args});
  if(id==='qq.audio.send')return {outcome:sendOutcome,state:sendOutcome==='unknown'?'unknown':sendState,verified:sendState==='confirmed'};
  throw new Error('unexpected invoke '+id);
 };
 const sdk=new PluginSDK({store,permissions,events,media,actions});
 const api=activateTTS(sdk.facade(),{synthesize:async(text,config,options)=>{
  synthCalls.push({text,config,options});
  return synthesize?await synthesize(text,config,options):{bytes:mp3,provider:config.provider,voice:options.voice||config.netVoice||config.localVoice,seconds:1.2};
 }});
 const item=store.data.framework.nativePackages['qq-tts'];
 t.after(()=>{media.stop();return sdk.stop();});
 return {store,permissions,actions,media,sdk,api,item,invokes,synthCalls,
  enable(extra={}){item.enabled=true;item.scope={private:true,allUsers:false,users:[owner],groups:[group]};Object.assign(item.config,extra);},
  context:(extra={})=>permissions.issue(msg(extra),'chat')};
}

test('manifest 与默认配置能被核心校验，默认使用本地语音',()=>{
 const config=migrateConfig(undefined,manifest);
 assert.equal(config.provider,'local');
 assert.equal(config.localVoice,'Microsoft Huihui Desktop');
 assert.equal(config.maxChars,200);
 assert.equal(defaultConfig().cooldownSec,5);
 assert.equal(manifest.dependencies.framework,'>=0.9.0');
 assert.ok(manifest.settings.sections.length>=3);
});

test('语音包默认停用，普通用户没有动作权限',async t=>{
 const x=await setup(t);
 await assert.rejects(x.actions.invoke('plugin.qq-tts.speak',{text:'你好呀'},x.context()),/功能包已停用|范围/);
 x.enable();
 await assert.rejects(x.actions.invoke('plugin.qq-tts.speak',{text:'你好呀'},x.context({user:other})),/未对当前聊天开放|主人|授权/);
 assert.equal(x.invokes.length,0);
});

test('speak 合成后作为语音资源发送到当前聊天',async t=>{
 const x=await setup(t);x.enable();
 const result=await x.actions.invoke('plugin.qq-tts.speak',{text:'  你好呀，我是大肥鱼。  '},x.context());
 assert.equal(result.ok,false);
 assert.equal(result.state,'submitted');
 assert.equal(result.submitted,true);
 assert.equal(result.chars,10);
 assert.equal(result.seconds,1.2);
 assert.match(result.instruction,/已提交|不要自动重发/);
 assert.equal(x.synthCalls[0].text,'你好呀，我是大肥鱼。');
 assert.equal(x.invokes.length,1);
 assert.equal(x.invokes[0].id,'qq.audio.send');
 const resource=x.media.items.get(x.invokes[0].args.resourceId);
 assert.equal(resource.purpose,'audio');
 assert.equal(resource.mime,'audio/mpeg');
 assert.equal(resource.key,key);
 const recent=x.store.data.framework.pluginData['qq-tts'].recent;
 assert.equal(recent.length,1);
 assert.equal(recent[0].ok,false);
 assert.equal(recent[0].state,'submitted');
 assert.equal(recent[0].chars,10);
});

test('语音发送结果未知时不能声称已经发出',async t=>{
 const x=await setup(t,{sendOutcome:'unknown'});x.enable();
 const result=await x.actions.invoke('plugin.qq-tts.speak',{text:'测试语音'},x.context());
 assert.equal(result.ok,false);
 assert.equal(result.outcome,'unknown');
 assert.match(result.instruction,/未确认|不要声称/);
 const recent=x.store.data.framework.pluginData['qq-tts'].recent;
 assert.equal(recent[0].ok,false);
 assert.equal(recent[0].outcome,'unknown');
});

test('拒绝空文本与超长文本，并在冷却期内拒绝重复发送',async t=>{
 const x=await setup(t);x.enable();
 await assert.rejects(x.actions.invoke('plugin.qq-tts.speak',{text:'   '},x.context()),/朗读的文字/);
 x.item.config.maxChars=20;
 await assert.rejects(x.actions.invoke('plugin.qq-tts.speak',{text:'一'.repeat(21)},x.context()),/最多 20/);
 x.item.config.maxChars=200;
 await x.actions.invoke('plugin.qq-tts.speak',{text:'第一句'},x.context());
 await assert.rejects(x.actions.invoke('plugin.qq-tts.speak',{text:'第二句'},x.context()),/冷却/);
 x.item.config.cooldownSec=0;
 await x.actions.invoke('plugin.qq-tts.speak',{text:'第二句'},x.context());
 assert.equal(x.invokes.length,2);
});

test('合成失败不会发送，并记录失败原因',async t=>{
 const x=await setup(t,{synthesize:async()=>{throw new Error('本机没有可用的语音引擎');}});x.enable();
 await assert.rejects(x.actions.invoke('plugin.qq-tts.speak',{text:'你好'},x.context()),/语音引擎/);
 assert.equal(x.invokes.length,0);
 const recent=x.store.data.framework.pluginData['qq-tts'].recent;
 assert.equal(recent[0].ok,false);
 assert.match(recent[0].error,/语音引擎/);
 assert.equal(x.store.data.framework.pluginData['qq-tts'].cooldowns[key],undefined);
});

test('voice 参数覆盖本次音色，并透传给合成器',async t=>{
 const x=await setup(t);x.enable();
 await x.actions.invoke('plugin.qq-tts.speak',{text:'换一个声音',voice:'Microsoft Huihui Desktop'},x.context());
 assert.equal(x.synthCalls[0].options.voice,'Microsoft Huihui Desktop');
 assert.equal(x.store.data.framework.pluginData['qq-tts'].recent[0].voice,'Microsoft Huihui Desktop');
});

test('设置页数据返回统计与最近记录',async t=>{
 const x=await setup(t);x.enable();
 await x.actions.invoke('plugin.qq-tts.speak',{text:'你好'},x.context());
 const page=await x.sdk.pageData('qq-tts',{offset:0});
 assert.equal(page.stats[0].label,'今日语音');
 assert.equal(page.stats[0].value,1);
 assert.equal(page.rows.length,1);
 assert.equal(page.rows[0].result,'已提交，未确认送达');
 assert.ok(page.columns.some(c=>c.key==='time'&&c.format==='datetime'));
});

test('网络请求体使用 OpenAI 兼容字段，密钥只进 Authorization 头',async()=>{
 const config={...defaultConfig(),provider:'siliconflow',apiUrl:'https://api.siliconflow.cn/v1/audio/speech',model:'FunAudioLLM/CosyVoice2-0.5B',netVoice:'FunAudioLLM/CosyVoice2-0.5B:alex',apiKey:'sk-test-key',speed:1.25};
 assert.deepEqual(speechPayload('你好',config),{model:'FunAudioLLM/CosyVoice2-0.5B',input:'你好',voice:'FunAudioLLM/CosyVoice2-0.5B:alex',response_format:'mp3',speed:1.25,stream:false});
 let seen;
 const fetchImpl=async(url,init)=>{seen={url:String(url),init};return new Response(mp3,{status:200,headers:{'content-type':'audio/mpeg'}});};
 const result=await synthesizeVoice('你好',config,{fetchImpl});
 assert.equal(result.provider,'siliconflow');
 assert.ok(isAudio(result.bytes));
 assert.equal(seen.init.method,'POST');
 assert.equal(seen.init.headers.authorization,'Bearer sk-test-key');
 assert.ok(!JSON.stringify(seen.init.body).includes('sk-test-key'));
 assert.deepEqual(JSON.parse(seen.init.body).input,'你好');
});

test('网络错误、JSON 错误体和超限都变成可读错误',async()=>{
 delete process.env.SILICONFLOW_API_KEY;delete process.env.TTS_API_KEY;
 const base={...defaultConfig(),provider:'siliconflow',apiKey:'sk-secret-value'};
 await assert.rejects(synthesizeVoice('你好',{...base,apiUrl:'not a url'},{fetchImpl:async()=>{throw new Error('should not run');}}),/地址无效/);
 await assert.rejects(synthesizeVoice('你好',{...base,apiUrl:'https://example.com/v1/audio/speech'},{fetchImpl:async()=>new Response('{"message":"invalid key"}',{status:401,headers:{'content-type':'application/json'}})}),error=>/HTTP 401/.test(error.message)&&!/sk-secret-value/.test(error.message));
 await assert.rejects(synthesizeVoice('你好',{...base,apiUrl:'https://example.com/v1/audio/speech'},{fetchImpl:async()=>new Response('{"error":"no audio"}',{status:200,headers:{'content-type':'application/json'}})}),/不是音频/);
 await assert.rejects(synthesizeVoice('你好',{...base,apiUrl:'https://example.com/v1/audio/speech',apiKey:''},{fetchImpl:async()=>{throw new Error('should not run');}}),/密钥/);
});

test('isAudio 只接受已知音频容器',()=>{
 assert.ok(isAudio(mp3));
 assert.ok(isAudio(Buffer.from('OggS....','latin1')));
 assert.ok(isAudio(Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ','latin1')));
 assert.ok(!isAudio(Buffer.from('{"error":"x"}','latin1')));
 assert.ok(!isAudio(Buffer.from('PNG','latin1')));
});

test('本地语音脚本按文件流、内存流、System.Speech 依次回退并写诊断',()=>{
 assert.match(LOCAL_SCRIPT,/SAPI\.SpFileStream/);
 assert.match(LOCAL_SCRIPT,/SAPI\.SpMemoryStream/);
 assert.match(LOCAL_SCRIPT,/System\.Speech/);
 assert.match(LOCAL_SCRIPT,/voice-probe failed/);
 assert.match(LOCAL_SCRIPT,/ConvertTo-Json/);
 assert.match(LOCAL_SCRIPT,/GetData\(\)/);
});

test('本地合成失败时把引擎、HRESULT 和音色诊断带进错误',async()=>{
 const run=async(_command,args)=>{
  const index=args.indexOf('-OutFile'),wav=args[index+1],dir=path.dirname(wav);
  await writeFile(path.join(dir,'voice.wav.debug'),'start\nsapi-file failed: 0x80045040\nsapi-memory failed: 0x80045040\ndotnet failed: 0x80045040\n','utf8');
  await writeFile(path.join(dir,'voice.wav.json'),JSON.stringify({engine:'',hresult:'0x80045040',voices:['Microsoft Huihui Desktop','Microsoft Zira Desktop'],is64:true,ps:'5.1'}),'utf8');
  await writeFile(path.join(dir,'error.txt'),'本机语音引擎没有生成音频 0x80045040','utf8');
 };
 await assert.rejects(synthesizeLocal('你好',{...defaultConfig(),localVoice:'Microsoft Huihui Desktop'},{run,keepOnFailure:false}),error=>{
  assert.match(error.message,/0x80045040/);
  assert.match(error.message,/sapi-file|诊断目录/);
  assert.match(error.message,/voices=2/);
  return true;
 });
});

test('ffmpeg 失败也保留脱敏诊断，并删除正文、脚本和音频',async t=>{
 let calls=0;
 const run=async(_command,args)=>{
  calls+=1;
  const index=args.indexOf('-OutFile'),wav=args[index+1],dir=path.dirname(wav);
  if(calls===1){
   const bytes=Buffer.alloc(144);bytes.write('RIFF',0,'ascii');bytes.write('WAVE',8,'ascii');
   await writeFile(wav,bytes);
   await writeFile(path.join(dir,'voice.wav.debug'),'sapi-file bytes=144\n','utf8');
   await writeFile(path.join(dir,'voice.wav.json'),JSON.stringify({engine:'sapi-file',bytes:144,hresult:'',voices:['Huihui']}),'utf8');
   return {stderr:''};
  }
  throw new Error('ffmpeg 转码失败');
 };
 let kept='';
 await assert.rejects(synthesizeLocal('敏感朗读正文',{...defaultConfig()},{run}),error=>{
  const match=error.message.match(/诊断目录已保留：(qq-tts-[^；\s]+)/);
  assert.ok(match,error.message);kept=match[1];assert.match(error.message,/ffmpeg/);return true;
 });
 const dir=path.join(os.tmpdir(),kept);t.after(()=>rm(dir,{recursive:true,force:true}));
 await access(path.join(dir,'voice.wav.debug'));
 await access(path.join(dir,'voice.wav.json'));
 for(const name of ['text.txt','speak.ps1','voice.wav','voice.mp3'])await assert.rejects(access(path.join(dir,name)));
});
