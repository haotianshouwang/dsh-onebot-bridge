import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {NativeDSH,SAFE_PRESET,presetRows,assertPresetRows} from '../src/session/native.js';

const groupOf=rows=>rows.find(r=>r.id==='qq-compaction');
const innerOf=rows=>groupOf(rows).config;

test('压缩组件必须包在 isolate 分组里，否则预设会整体挂载失败',()=>{
 const rows=assertPresetRows(presetRows());
 assert.deepEqual(rows.map(r=>r.id),['qq-native-tools','qq-compaction']);
 const group=groupOf(rows);
 assert.equal(group.name,'cordis:group');
 assert.equal(group.group,true);
 assert.deepEqual(group.isolate,{compaction:true,toolResultPruner:true});
 assert.deepEqual(innerOf(rows).map(r=>r.id),['compaction-basic','tool-result-pruner']);
});

test('压缩阈值与裁剪预算自洽',()=>{
 const rows=presetRows();
 const compaction=innerOf(rows).find(r=>r.id==='compaction-basic').config;
 assert.equal(compaction.thresholdRatio,0.25);
 assert.equal(compaction.retainRatio,0.08);
 assert.ok(compaction.retainRatio<compaction.thresholdRatio);
 const pruner=innerOf(rows).find(r=>r.id==='tool-result-pruner').config;
 assert.equal(pruner.thresholdChars,8192);
 assert.equal(pruner.headChars,4096);
 assert.equal(pruner.tailChars,1024);
});

test('漏挂压缩组件会让预设校验直接失败，而不是静默降级',()=>{
 const missing=presetRows();
 groupOf(missing).config=innerOf(missing).filter(r=>r.id!=='compaction-basic');
 assert.throws(()=>assertPresetRows(missing),/compaction-basic/);
 const noPruner=presetRows();
 groupOf(noPruner).config=innerOf(noPruner).filter(r=>r.id!=='tool-result-pruner');
 assert.throws(()=>assertPresetRows(noPruner),/tool-result-pruner/);
});

test('缺少 isolate 声明会被拒绝（线上故障回归点）',()=>{
 const rows=presetRows();
 delete groupOf(rows).isolate;
 assert.throws(()=>assertPresetRows(rows),/isolate/);
 const partial=presetRows();
 groupOf(partial).isolate={compaction:true};
 assert.throws(()=>assertPresetRows(partial),/isolate/);
});

test('预设不允许夹带额外组件或重复组件',()=>{
 const extra=presetRows();
 extra.push({id:'tool-bash',name:'@deepseek-ai/dsh-tool-bash'});
 assert.throws(()=>assertPresetRows(extra),/额外组件/);
 const duplicate=presetRows();
 duplicate.push({id:'qq-compaction',name:'cordis:group',group:true,isolate:{compaction:true,toolResultPruner:true},config:[]});
 assert.throws(()=>assertPresetRows(duplicate),/只能挂载一次/);
});

test('阈值或裁剪预算越界会被拒绝',()=>{
 const tooHigh=presetRows();
 innerOf(tooHigh).find(r=>r.id==='compaction-basic').config={thresholdRatio:0.8,retainRatio:0.16};
 assert.throws(()=>assertPresetRows(tooHigh),/阈值/);
 const inverted=presetRows();
 innerOf(inverted).find(r=>r.id==='compaction-basic').config={thresholdRatio:0.2,retainRatio:0.3};
 assert.throws(()=>assertPresetRows(inverted),/保留比例/);
 const badPruner=presetRows();
 innerOf(badPruner).find(r=>r.id==='tool-result-pruner').config={thresholdChars:1024,headChars:4096,tailChars:1024};
 assert.throws(()=>assertPresetRows(badPruner),/裁剪/);
});

async function fixture(t,{register}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-preset-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media);
 const calls=[];
 const ctx={tools:{guard:()=>()=>{}},agentPresets:{register:async definition=>{calls.push(definition);if(register)return register(definition);return()=>{};}}};
 const native=new NativeDSH(ctx,store,permissions,actions,null);
 return {store,permissions,actions,media,native,calls};
}

test('运行时注册给 DSH 的预设清单就是校验后的那份',async t=>{
 const x=await fixture(t);
 await x.native.start();
 t.after(()=>{x.native.active.clear();return x.native.stop();});
 const definition=x.calls[0];
 assert.equal(definition.id,SAFE_PRESET);
 assert.deepEqual(definition.plugins.map(r=>r.id),['qq-native-tools','qq-compaction']);
 assert.deepEqual(definition.plugins[1].isolate,{compaction:true,toolResultPruner:true});
 assert.deepEqual(definition.plugins[1].config.map(r=>r.id),['compaction-basic','tool-result-pruner']);
});

test('预设注册失败会中断启动，不会假装初始化成功',async t=>{
 const x=await fixture(t,{register:async()=>{throw new Error('agent preset mount failed');}});
 await assert.rejects(x.native.start(),/mount failed/);
});

// 用 DSH 安装里的真实组件校验配置，而不是只看我们自己写的常量。
const DSH_ROOT=process.env.DSH_INSTALL||path.resolve(import.meta.dirname,'../../../dsh');
async function loadDshModule(name){
 const url='file:///'+DSH_ROOT.replace(/\\/g,'/')+'/node_modules/@deepseek-ai/'+name+'/lib/index.js';
 return import(url);
}
test('压缩配置能通过 DSH 真实组件的配置校验',async t=>{
 let mod;
 try{mod=await loadDshModule('dsh-compaction-basic');}
 catch{ t.skip('未找到 DSH 安装，跳过真实组件校验'); return; }
 const Engine=mod.BasicCompactionEngine||mod.default;
 assert.ok(typeof Engine?.Config==='function','压缩组件应导出可校验的 Config');
 const row=innerOf(presetRows()).find(r=>r.id==='compaction-basic').config;
 const resolved=Engine.Config(row);
 assert.equal(resolved.thresholdRatio,0.25);
 assert.equal(resolved.retainRatio,0.08);
 assert.ok(resolved.retainRatio<resolved.thresholdRatio);
 assert.throws(()=>Engine.Config({thresholdRatio:'宽一点'}),/number|thresholdRatio/);
});
