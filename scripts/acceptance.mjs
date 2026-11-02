#!/usr/bin/env node
// 真实 QQ 验收记录工具：只记录、不发送，不把模拟结果伪装成真实验收。
//
// 用法：
//   node scripts/acceptance.mjs init
//   node scripts/acceptance.mjs list
//   node scripts/acceptance.mjs record private-text real-pass --account 测试号 --evidence "截图:evidence/private.png; message_id=123"
//   node scripts/acceptance.mjs report
//
// 记录写到 QQ_ACCEPTANCE_DIR（默认 ./acceptance-runs）的 latest.json，并归档 <runId>.json。
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const STATUSES = Object.freeze(['unit-pass', 'mock-pass', 'real-pass', 'real-fail', 'untested', 'blocked']);

export const CHECKS = Object.freeze([
  {id: 'ws-connect', title: 'WebSocket 连接与账号绑定', requiresAccount: true},
  {id: 'ws-reconnect', title: '断线与重连恢复', requiresAccount: true},
  {id: 'private-text', title: '私聊文本收发', requiresAccount: true},
  {id: 'group-text', title: '群聊文本收发（@、分条）', requiresAccount: true},
  {id: 'image-recv', title: '图片接收（视觉/OCR）', requiresAccount: true},
  {id: 'image-send', title: '图片发送', requiresAccount: true},
  {id: 'voice-recv', title: '语音接收（转写）', requiresAccount: true},
  {id: 'voice-send', title: '本地语音生成与发送', requiresAccount: true},
  {id: 'file-recv', title: '文件接收（TXT/DOCX/PDF）', requiresAccount: true},
  {id: 'file-send', title: '文件发送', requiresAccount: true},
  {id: 'recall', title: '撤回自己 2 分钟内的消息', requiresAccount: true},
  {id: 'group-info', title: '群资料查询', requiresAccount: true},
  {id: 'request-approve', title: '好友/加群请求审批', requiresAccount: true},
  {id: 'restart-recovery', title: 'DSH 重启后的任务恢复', requiresAccount: true},
  {id: 'proactive-send', title: '主动联系真实送达', requiresAccount: true},
  {id: 'memory-recall', title: '记忆写入与回忆', requiresAccount: true}
]);

const checkById = id => CHECKS.find(check => check.id === id);

export function createRun(now = Date.now()) {
  const at = new Date(now).toISOString();
  const date = new Date(now), pad = value => String(value).padStart(2, '0');
  const runId = 'acc-' + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
    'T' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  return {
    version: 1,
    id: runId,
    startedAt: at,
    updatedAt: at,
    results: Object.fromEntries(CHECKS.map(check => [check.id, {status: 'untested', evidence: '', note: '', account: '', by: '', at: ''}]))
  };
}

export function recordResult(run, id, {status, evidence = '', note = '', account = '', by = 'operator', at = new Date().toISOString()} = {}) {
  const check = checkById(id);
  if (!check) throw new Error('未知检查项：' + id);
  if (!STATUSES.includes(status)) throw new Error('状态无效：' + status);
  if (status === 'real-pass' && !String(evidence).trim()) throw new Error('real-pass 必须提供证据（--evidence）');
  if (status === 'real-pass' && check.requiresAccount && !String(account).trim()) throw new Error('该检查项需要真实账号（--account）');
  const next = structuredClone(run);
  next.results[id] = {
    status,
    evidence: String(evidence).slice(0, 500),
    note: String(note).slice(0, 300),
    account: String(account).slice(0, 40),
    by: String(by).slice(0, 40),
    at
  };
  next.updatedAt = at;
  return next;
}

export function summarize(run) {
  const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  for (const check of CHECKS) counts[run.results?.[check.id]?.status || 'untested'] += 1;
  return counts;
}

export function renderReport(run) {
  const counts = summarize(run);
  const lines = [
    '# 真实 QQ 验收报告',
    '',
    '- 运行：' + run.id,
    '- 开始：' + run.startedAt,
    '- 更新：' + run.updatedAt,
    '- 统计：' + STATUSES.map(status => status + '=' + counts[status]).join('，'),
    '',
    '| 检查项 | 状态 | 账号 | 证据 | 备注 |',
    '|---|---|---|---|---|'
  ];
  for (const check of CHECKS) {
    const row = run.results?.[check.id] || {};
    const cell = value => String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    lines.push('| ' + check.id + ' ' + check.title + ' | ' + (row.status || 'untested') + ' | ' + cell(row.account) + ' | ' + cell(row.evidence) + ' | ' + cell(row.note) + ' |');
  }
  lines.push('', '> `real-pass` 必须同时有账号和证据；没有证据的行不得对外宣称已验收。');
  return lines.join('\n');
}

const dir = process.env.QQ_ACCEPTANCE_DIR || path.resolve(process.cwd(), 'acceptance-runs');
const latest = path.join(dir, 'latest.json');

async function load() {
  return JSON.parse(await readFile(latest, 'utf8'));
}

async function save(run) {
  await mkdir(dir, {recursive: true});
  const text = JSON.stringify(run, null, 2);
  await writeFile(latest, text, {encoding: 'utf8', mode: 0o600});
  await writeFile(path.join(dir, run.id + '.json'), text, {encoding: 'utf8', mode: 0o600});
  return run;
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2), next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help') {
    console.log('用法：node scripts/acceptance.mjs <init|list|record|report> [参数]');
    console.log('  init                              新建一轮验收');
    console.log('  list                              列出检查项');
    console.log('  record <id> <status> [--evidence] [--note] [--account] [--by]');
    console.log('  report                            输出 Markdown 报告');
    return;
  }
  if (command === 'init') {
    const run = await save(createRun());
    console.log('已创建 ' + run.id + '（' + Object.keys(run.results).length + ' 项，全部 untested）');
    return;
  }
  if (command === 'list') {
    const run = await load().catch(() => createRun());
    for (const check of CHECKS) console.log(check.id.padEnd(16) + ' ' + (run.results?.[check.id]?.status || 'untested').padEnd(10) + ' ' + check.title);
    return;
  }
  if (command === 'record') {
    const [id, status] = rest;
    const options = flags(rest.slice(2));
    if (!id || !status) throw new Error('用法：record <id> <status> ...');
    const run = await save(recordResult(await load(), id, {status, evidence: options.evidence, note: options.note, account: options.account, by: options.by}));
    console.log('已记录 ' + id + ' = ' + run.results[id].status);
    return;
  }
  if (command === 'report') {
    console.log(renderReport(await load()));
    return;
  }
  throw new Error('未知命令：' + command);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'acceptance.mjs') {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
