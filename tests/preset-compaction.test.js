import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {NativeDSH,SAFE_PRESET,presetRows,assertPresetRows} from '../src/session/native.js';

test('QQ 受限预设自带压缩组件，且阈值互相自洽',()=>{
 const rows=assertPresetRows(presetRows());
 const ids=rows.map(r=>r.id);
 assert.deepEqual(ids,['qq-native-tools','compaction-basic','tool-result-pruner']);
 const compaction=rows.find(r=>r.id==='compaction-basic');
 assert.equal(compaction.name,'@deepseek-ai/dsh-compaction-basic');
 assert.equal(compaction.config.thresholdRatio,0.25);
 assert.equal(compaction.config.retainRatio,0.08);
 assert.ok(compaction.config.retainRatio<compaction.config.thresholdRatio,'保留比例必须小于触发阈值');
 const pruner=rows.find(r=>r.id==='tool-result-pruner');
 assert.equal(pruner.config.thresholdChars,8192);
});

test('漏挂压缩组件会让预设校验直接失败，而不是静默降级',()=>{
 const missing=presetRows().filter(r=>r.id!=='compaction-basic');
 assert.throws(()=>assertPresetRows(missing),/compaction-basic/);
 const noPruner=presetRows().filter(r=>r.id!=='tool-result-pruner');
 assert.throws(()=>assertPresetRows(noPruner),/tool-result-pruner/);
});

test('预设不允许夹带额外组件或重复组件',()=>{
 const extra=presetRows();
 extra.push({id:'tool-bash',name:'@deepseek-ai/dsh-tool-bash'});
 assert.throws(()=>assertPresetRows(extra),/额外组件/);
 const duplicate=presetRows();
 duplicate.push({id:'compaction-basic',name:'@deepseek-ai/dsh-compaction-basic',config:{thresholdRatio:0.25,retainRatio:0.08}});
 assert.throws(()=>assertPresetRows(duplicate),/只能挂载一次/);
});

test('阈值配置越界会被拒绝',()=>{
 const tooHigh=presetRows();tooHigh.find(r=>r.id==='compaction-basic').config={thresholdRatio:0.8,retainRatio:0.16};
 assert.throws(()=>assertPresetRows(tooHigh),/阈值/);
 const inverted=presetRows();inverted.find(r=>r.id==='compaction-basic').config={thresholdRatio:0.2,retainRatio:0.3};
 assert.throws(()=>assertPresetRows(inverted),/保留比例/);
 const badPruner=presetRows();badPruner.find(r=>r.id==='tool-result-pruner').config={thresholdChars:10};
 assert.throws(()=>assertPresetRows(badPruner),/裁剪阈值/);
});

async function fixture(t,{register}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-preset-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media);
 const calls=[];
 const ctx={tools:{guard:()=>()=>{}},agentPresets:{register:async definition=>{calls.push(definition);if(register)return register(definition);return()=>{};}}};
 const native=new NativeDSH(ctx,store,permissions,actions,null);
 return {store,permissions,actions,media,native,calls,ctx};
}

test('运行时注册到 DSH 的预设清单就是校验后的那份',async t=>{
 const x=await fixture(t);
 await x.native.start();
 t.after(()=>x.native.stop());
 assert.equal(x.calls.length,1);
 const definition=x.calls[0];
 assert.equal(definition.id,SAFE_PRESET);
 assert.deepEqual(definition.plugins.map(r=>r.id),['qq-native-tools','compaction-basic','tool-result-pruner']);
 assert.deepEqual(definition.plugins.filter(r=>r.id==='compaction-basic')[0].config,{thresholdRatio:0.25,retainRatio:0.08});
 // 预设只挂展示层与压缩层，不夹带任何工具声明行
 assert.deepEqual(definition.plugins.map(r=>r.name).sort(),[
  '@deepseek-ai/dsh-agent-tool-presentation',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-compaction-tool-result-pruner'
 ].sort());
});

test('预设注册失败会中断启动，不会假装初始化成功',async t=>{
 const x=await fixture(t,{register:async()=>{throw new Error('agent preset mount failed');}});
 await assert.rejects(x.native.start(),/mount failed/);
});

// 用 DSH 安装里的真实组件校验配置，而不是只看我们自己写的常量。
// 找不到安装目录时显式跳过并说明，不伪装成通过。
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
 const row=presetRows().find(r=>r.id==='compaction-basic').config;
 const resolved=Engine.Config(row);
 assert.equal(resolved.thresholdRatio,0.25);
 assert.equal(resolved.retainRatio,0.08);
 assert.ok(resolved.retainRatio<resolved.thresholdRatio);
 // 真实 schema 会拒绝类型错误的配置（证明这项校验确实在工作）
 assert.throws(()=>Engine.Config({thresholdRatio:'宽一点'}),/number|thresholdRatio/);
});
