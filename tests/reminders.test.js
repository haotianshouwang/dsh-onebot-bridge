import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TaskStore} from '../src/session/tasks.js';
import {ReminderScheduler,parseReminderRequest} from '../src/session/reminders.js';

const target={bot:'10000002',actor:'10000001',kind:'private',peer:'10000001',key:'10000002:private:10000001',messageId:'123'};
async function setup(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'qq-reminder-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let now=100000;const tasks=await new TaskStore(dir,{now:()=>now}).open(),sent=[];
 const scheduler=new ReminderScheduler({tasks,now:()=>now,available:()=>true,guard:()=>'',send:async reminder=>{sent.push(reminder.text);return {state:'submitted',outcome:'confirmed'};}});
 return {tasks,scheduler,sent,dir,now:value=>{now=value;}};
}
test('明确中文相对提醒被识别，引用、否定和含糊请求不自动执行',()=>{
 assert.equal(parseReminderRequest('一分钟后给我发个信息').delaySeconds,60);
 assert.equal(parseReminderRequest('2小时后提醒我喝水').text,'提醒你：喝水');
 for(const text of ['不要一分钟后给我发信息','他说“一分钟后给我发个信息”','你是不是不能一分钟后发信息','一分钟后帮我把文件发给群友'])assert.equal(parseReminderRequest(text),null);
});
test('提醒持久化并到点发送一次，重启后不会重发，提交不冒充已读',async t=>{
 const x=await setup(t);const task=await x.tasks.create({goal:'一分钟后联系',reminder:{...target,dueAt:160000,text:'时间到了'}});
 await x.scheduler.tick();assert.equal(x.sent.length,0);
 x.now(160000);await x.scheduler.tick();await x.scheduler.tick();assert.deepEqual(x.sent,['时间到了']);
 assert.equal(task.reminder.state,'submitted');assert.equal(task.status,'done');assert.match(task.verification.note,/已提交/);
 const restored=await new TaskStore(x.dir,{now:()=>200000}).open();assert.equal(restored.get(task.id).reminder.state,'submitted');
});
test('重启恢复待发提醒，停用/离线不发送，目标变化时停止',async t=>{
 const x=await setup(t);await x.tasks.create({goal:'提醒',reminder:{...target,dueAt:160000,text:'提醒'}});
 const tasks=await new TaskStore(x.dir,{now:()=>200000}).open();let online=false;
 const scheduler=new ReminderScheduler({tasks,now:()=>200000,available:()=>online,guard:()=> '主人已变化',send:async()=>{throw Error('不得发送');}});
 await scheduler.tick();assert.equal(tasks.tasks[0].status,'pending');online=true;await scheduler.tick();assert.equal(tasks.tasks[0].status,'cancelled');
});
test('发送结果未知不自动重试；崩溃时的发送意图恢复为未知',async t=>{
 const x=await setup(t);const task=await x.tasks.create({goal:'提醒',reminder:{...target,dueAt:160000,text:'提醒'}});x.now(160000);
 let count=0;x.scheduler.send=async()=>{count++;throw Error('connection lost');};await x.scheduler.tick();await x.scheduler.tick();
 assert.equal(count,1);assert.equal(task.reminder.state,'unknown');assert.equal(task.status,'failed');
 const second=await x.tasks.create({goal:'崩溃测试',reminder:{...target,messageId:'124',dueAt:200000,text:'提醒'}});
 second.reminder.state='sending';await x.tasks.persist();
 const restored=await new TaskStore(x.dir).open();assert.equal(restored.get(second.id).reminder.state,'unknown');
});

test('发送前的中断可以恢复；已持久化回执的中断只收尾不重发',async t=>{
 const x=await setup(t);const pending=await x.tasks.create({goal:'尚未发出',reminder:{...target,dueAt:160000,text:'提醒'}});
 await x.tasks.transition(pending.id,'analyzing');
 const submitted=await x.tasks.create({goal:'已有回执',reminder:{...target,dueAt:160000,text:'提醒'}});
 for(const state of ['analyzing','planning','executing'])await x.tasks.transition(submitted.id,state);
 submitted.reminder.state='submitted';await x.tasks.persist();
 const restored=await new TaskStore(x.dir,{now:()=>200000}).open();
 assert.equal(restored.get(pending.id).status,'pending');assert.equal(restored.get(submitted.id).status,'done');
 assert.match(restored.get(submitted.id).verification.note,/不代表对方已读/);
});

test('到点后发送前短暂离线，恢复在线后仍发送；取消的任务不发送',async t=>{
 const x=await setup(t);const task=await x.tasks.create({goal:'提醒',reminder:{...target,dueAt:160000,text:'提醒'}});x.now(160000);
 let checks=0;x.scheduler.available=()=>++checks<3;
 await x.scheduler.tick();assert.equal(task.status,'pending');assert.equal(task.reminder.state,'pending');assert.equal(x.sent.length,0);
 x.scheduler.available=()=>true;await x.scheduler.tick();assert.equal(x.sent.length,1);
 const cancelled=await x.tasks.create({goal:'取消提醒',reminder:{...target,dueAt:200000,text:'不发送'}});
 await x.tasks.transition(cancelled.id,'cancelled');x.now(200000);await x.scheduler.tick();assert.equal(x.sent.length,1);
});
