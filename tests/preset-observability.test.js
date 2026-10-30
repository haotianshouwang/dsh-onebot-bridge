import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Store} from '../src/host/store.js';import {Permissions} from '../src/core/permissions.js';import {Actions} from '../src/core/actions.js';import {Events} from '../src/core/events.js';import {Media} from '../src/core/media.js';import {NativeDSH,SAFE_PRESET} from '../src/session/native.js';

async function fixture(t,{resolve}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-preset-audit-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new Store(dir).open();
 const permissions=new Permissions(store),events=new Events(store,()=>{}),media=new Media(store),actions=new Actions(store,permissions,events,media);
 const ctx={tools:{guard:()=>()=>{}},agentPresets:{register:async()=>()=>{},...(resolve?{resolve}:{})}};
 const native=new NativeDSH(ctx,store,permissions,actions,null);
 return {store,native,ctx};
}
const lastLog=store=>store.data.logs.at(-1);

test('注册成功但挂载失败时，审计把 broken 记成错误而不是当成已启用',async t=>{
 const x=await fixture(t,{resolve:async()=>({id:SAFE_PRESET,broken:'compaction-basic: BasicCompactionConfig: retainRatio must be less than thresholdRatio'})});
 const status=await x.native.auditPreset();
 assert.equal(status.checked,true);
 assert.match(status.broken,/compaction-basic/);
 assert.equal(lastLog(x.store).level,'error');
 assert.match(lastLog(x.store).message,/挂载异常/);
});

test('挂载正常时审计给出明确的已挂载记录',async t=>{
 const x=await fixture(t,{resolve:async()=>({id:SAFE_PRESET})});
 const status=await x.native.auditPreset();
 assert.equal(status.checked,true);
 assert.equal(status.broken,null);
 assert.equal(lastLog(x.store).level,'info');
 assert.match(lastLog(x.store).message,/已挂载/);
});

test('DSH 不提供诊断接口时如实记为未检查，不假装成功',async t=>{
 const x=await fixture(t);
 const status=await x.native.auditPreset();
 assert.equal(status.checked,false);
 assert.equal(status.broken,undefined);
});

test('诊断调用本身失败时记录错误，不抛出中断启动',async t=>{
 const x=await fixture(t,{resolve:async()=>{throw new Error('loader still settling');}});
 const status=await x.native.auditPreset();
 assert.equal(status.checked,false);
 assert.match(status.error,/settling/);
});
