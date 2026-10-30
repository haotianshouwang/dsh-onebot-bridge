import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
// 用 DSH 安装里的真实裁剪组件验证阈值语义；找不到安装目录时显式跳过。
const DSH_ROOT=process.env.DSH_INSTALL||path.resolve(import.meta.dirname,'../../../dsh');
async function load(name){return import('file:///'+DSH_ROOT.replace(/\\/g,'/')+'/node_modules/@deepseek-ai/'+name+'/lib/index.js');}
async function prunerWith(config){
 const mod=await load('dsh-compaction-tool-result-pruner');
 const resolved=mod.resolveConfig(config);
 const instance=Object.create(mod.ToolResultPruner.prototype);
 instance.config=resolved;
 return {mod,resolved,instance};
}

test('裁剪保留首尾并插入标记，图片块原样保留',async t=>{
 let x;try{x=await prunerWith({thresholdChars:8192});}catch{t.skip('未找到 DSH 安装');return;}
 const big='【执行状态：权限被拒绝】'.repeat(1200); // 远超 8192 字符
 assert.ok(big.length>8192);
 const image={type:'image',attachment:{attachmentId:'sha256:x'}};
 const out=x.instance.pruneContent([{type:'text',text:big},image]);
 assert.ok(out,'超预算结果应被裁剪');
 assert.equal(out.filter(b=>b.type==='image').length,1,'非文本块必须原样保留');
 const text=out.filter(b=>b.type==='text').map(b=>b.text).join('');
 assert.ok(text.includes(x.mod.PRUNE_MARKER),'必须插入可识别的裁剪标记');
 assert.ok(text.length<=x.resolved.thresholdChars,'裁剪后不得超过阈值');
 assert.ok(text.startsWith(big.slice(0,64)),'开头（通常含状态与结论）应保留');
 assert.ok(text.endsWith(big.slice(-64)),'结尾应保留');
});

test('未超预算的结果不会被裁剪，短小的拒绝信息保持完整',async t=>{
 let x;try{x=await prunerWith({thresholdChars:8192});}catch{t.skip('未找到 DSH 安装');return;}
 assert.equal(x.instance.pruneContent([{type:'text',text:'此工具尚未向当前用户开放'}]),null);
 assert.equal(x.instance.pruneContent([{type:'text',text:'x'.repeat(8192)}]),null);
});

test('首尾预算超过阈值时真实组件会拒绝该配置',async t=>{
 let mod;try{mod=await load('dsh-compaction-tool-result-pruner');}catch{t.skip('未找到 DSH 安装');return;}
 assert.throws(()=>mod.resolveConfig({thresholdChars:1024}),/thresholdChars/);
 const ok=mod.resolveConfig({thresholdChars:8192});
 assert.equal(ok.thresholdChars,8192);
 assert.equal(ok.headChars,4096);
 assert.equal(ok.tailChars,1024);
});
