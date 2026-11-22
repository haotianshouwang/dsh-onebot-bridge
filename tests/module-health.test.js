import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleHealth} from '../src/admin/module-health.js';
import {builtinDefaults} from '../src/builtins/index.js';

function input() {
  return {
    data:{settings:{enabled:true,adminConsoleEnabled:true},framework:{ownerQQ:'10001',paused:false,builtins:builtinDefaults(),nativePackages:{}},extensions:{}},
    nativeLive:new Set(),extensionLive:new Set(),problems:()=>[], online:false,consoleRunning:true,auth:{configured:true,enrolled:true},secure:true,monitor:{},sampledAt:10
  };
}
const row=(env,id)=>moduleHealth(env).rows.find(item=>item.id===id);

test('inventory separates missing modules, disabled/removed packages, dependencies and quarantine',()=>{
  const env=input(), native=env.data.framework.nativePackages;
  assert.equal(row(env,'qq-memory').state,'fault');
  native['qq-memory']={enabled:true,manifest:{id:'qq-memory'}};
  assert.equal(row(env,'qq-memory').registered,false);
  env.nativeLive.add('qq-memory');assert.equal(row(env,'qq-memory').state,'pending');
  env.problems=()=>['缺少依赖 qq-memory'];assert.match(row(env,'qq-memory').reason,/缺少依赖/);
  native['qq-memory'].health={quarantined:true};assert.match(row(env,'qq-memory').reason,/隔离/);
  native['qq-memory'].health={};native['qq-memory'].enabled=false;assert.equal(row(env,'qq-memory').state,'off');
  env.nativeLive.delete('qq-memory');native['qq-memory'].uninstalled=true;assert.match(row(env,'qq-memory').reason,/卸载/);
  env.data.extensions.custom={enabled:false};assert.equal(row(env,'custom').state,'off');
  env.data.extensions.custom.enabled=true;assert.equal(row(env,'custom').state,'fault');
  env.extensionLive.add('custom');assert.equal(row(env,'custom').state,'pending');
  const health=moduleHealth(env);assert.equal(Object.values(health.counts).reduce((a,b)=>a+b,0),health.rows.length);
});

test('only confirmed delivery proves receipt, never registration or an older result on a disabled bridge',()=>{
  const env=input();assert.equal(row(env,'receipts').state,'pending');
  env.monitor.delivery={finalState:null};assert.doesNotMatch(row(env,'receipts').reason,/null|undefined/);
  for(const finalState of ['submitted','accepted','unknown','confirmed','failed']){
    env.monitor.delivery={finalState};env.data.settings.enabled=true;
    assert.equal(row(env,'receipts').state,finalState==='confirmed'?'ready':finalState==='failed'?'fault':'pending');
    env.data.settings.enabled=false;assert.equal(row(env,'receipts').state,'off');assert.match(row(env,'receipts').reason,/最近/);
  }
  env.online=true;assert.equal(row(env,'bridge').state,'off');
});

test('HTTPS enrollment and listener readiness are independent',()=>{
  const env=input();env.auth.enrolled=false;assert.equal(row(env,'web-auth').state,'fault');
  env.secure=false;assert.equal(row(env,'web-auth').state,'ready');
  env.consoleRunning=false;assert.equal(row(env,'web-console').state,'fault');
  env.auth.corrupt=true;assert.equal(row(env,'web-auth').state,'fault');
});
