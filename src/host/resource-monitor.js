// 进程/主机资源采样。网卡数据来自 OS，明确区别于 OneBot 应用消息字节。
import os from 'node:os';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

function cpuTicks() {
  return os.cpus().reduce((value, cpu) => {
    value.idle += cpu.times.idle;
    value.total += Object.values(cpu.times).reduce((sum, time) => sum + time, 0);
    return value;
  }, {idle: 0, total: 0});
}

export async function readNetworkCounters() {
  if (process.platform === 'win32') {
    const command = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); @(Get-NetAdapter -Physical -ErrorAction Stop | Where-Object Status -eq 'Up' | Get-NetAdapterStatistics -ErrorAction Stop | Select-Object Name,ReceivedBytes,SentBytes) | ConvertTo-Json -Compress";
    const {stdout} = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide: true, timeout: 7000, maxBuffer: 65536, encoding: 'utf8'});
    const rows = JSON.parse(stdout.trim() || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map(row => ({name: String(row.Name).slice(0, 80), receivedBytes: Number(row.ReceivedBytes), sentBytes: Number(row.SentBytes)}));
  }
  if (process.platform === 'linux') {
    return (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2).flatMap(line => {
      const [name, fields] = line.trim().split(':');
      if (!fields || name === 'lo') return [];
      const values = fields.trim().split(/\s+/).map(Number);
      return [{name, receivedBytes: values[0], sentBytes: values[8]}];
    });
  }
  throw new Error('当前系统未提供网卡采样');
}

export function networkDelta(previous, current, elapsedMs) {
  const prior = new Map((previous || []).map(row => [row.name, row]));
  return current.map(row => {
    const before = prior.get(row.name);
    const valid = before && elapsedMs > 0 && row.receivedBytes >= before.receivedBytes && row.sentBytes >= before.sentBytes;
    return {...row, receivePerSecond: valid ? (row.receivedBytes - before.receivedBytes) * 1000 / elapsedMs : null,
      sendPerSecond: valid ? (row.sentBytes - before.sentBytes) * 1000 / elapsedMs : null};
  });
}

export class ResourceMonitor {
  constructor({now = Date.now, network = readNetworkCounters, intervalMs = 10000} = {}) {
    Object.assign(this, {now, network, intervalMs});
    this.startedAt = now();
    this.last = {at: now(), cpu: cpuTicks(), process: process.cpuUsage()};
    this.samples = [];
    this.networkState = {available: false, sampledAt: null, error: '正在读取网卡数据', interfaces: []};
  }

  start() {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  sample() {
    if (this.stopped) return;
    const at = this.now();
    const cpu = cpuTicks();
    const processCpu = process.cpuUsage();
    const wall = at - this.last.at;
    const total = cpu.total - this.last.cpu.total;
    const memory = process.memoryUsage();
    this.current = {
      at, processCpuPercent: wall > 0 ? Math.min(100, (processCpu.user + processCpu.system - this.last.process.user - this.last.process.system) / (wall * 1000 * Math.max(1, os.cpus().length)) * 100) : null,
      hostCpuPercent: total > 0 ? Math.max(0, Math.min(100, (1 - (cpu.idle - this.last.cpu.idle) / total) * 100)) : null,
      rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
      hostMemoryTotal: os.totalmem(), hostMemoryUsed: os.totalmem() - os.freemem(), uptimeSeconds: process.uptime()
    };
    this.last = {at, cpu, process: processCpu};
    this.samples.push({...this.current});
    if (this.samples.length > 360) this.samples.shift();
    void this.sampleNetwork();
  }

  async sampleNetwork() {
    if (this.networkPending || this.stopped) return;
    this.networkPending = true;
    try {
      const rows = await this.network();
      if (this.stopped) return;
      if (!rows.length || rows.some(row => !Number.isFinite(row.receivedBytes) || !Number.isFinite(row.sentBytes) || row.receivedBytes < 0 || row.sentBytes < 0)) throw new Error('无可用网卡计数');
      const at = this.now();
      const interfaces = networkDelta(this.previousNetwork?.rows, rows, at - (this.previousNetwork?.at || at));
      this.previousNetwork = {at, rows};
      this.networkState = {available: true, sampledAt: at, error: '', scope: process.platform === 'win32' ? 'host-physical-adapters' : 'host-interfaces', interfaces};
    } catch {
      if (!this.stopped) this.networkState = {...this.networkState, available: false, error: '网卡数据暂不可用', receivePerSecond: null, sendPerSecond: null};
    } finally {
      this.networkPending = false;
    }
  }

  snapshot() {
    return {startedAt: this.startedAt, intervalMs: this.intervalMs, scope: 'dsh-process-and-host', processId: process.pid,
      cores: os.cpus().length, current: this.current || null, network: this.networkState, samples: this.samples.slice(-60)};
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
