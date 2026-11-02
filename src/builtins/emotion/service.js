// 角色心情与社交见闻：来源仅取宿主已接收的聊天，模型决定不能代替消息证据。
import {createHash} from 'node:crypto';

export const MOODS = ['平静', '开心', '好奇', '期待', '失落', '烦躁', '疲倦'];
const MAX_AGE = 6 * 3600000;
const clean = (value, max = 180) => String(value || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const topicOf = value => clean(value, 40).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function moodAt(value, at, halfLifeMinutes = 60) {
  if (!value || !MOODS.includes(value.mood)) return {mood: '平静', intensity: 0};
  const elapsed = Math.max(0, at - Number(value.at || 0));
  const intensity = Number((Math.min(1, Math.max(0, Number(value.intensity) || 0))
    * Math.pow(0.5, elapsed / (Math.max(5, halfLifeMinutes) * 60000))).toFixed(3));
  return intensity < 0.05 ? {mood: '平静', intensity: 0} : {mood: value.mood, intensity};
}

function factsFor(rows, bot, at) {
  const own = rows.findLast(row => row.user === bot);
  if (!own) return {response: 'no_pending_message'};
  const after = rows.slice(rows.indexOf(own) + 1).filter(row => row.user !== bot);
  const answered = after.some(row => row.reply === own.id || row.mentions?.includes(bot));
  const ageSeconds = Math.max(0, Math.floor(at / 1000 - own.time));
  const response = answered ? 'replied' : ageSeconds >= 120 && after.length >= 3
    ? 'not_directly_answered' : !after.length && ageSeconds >= 300 ? 'group_quiet' : 'waiting';
  return {response, ownMessageId: own.id, ageSeconds, humanMessagesAfter: after.length};
}

export class EmotionService {
  constructor({read, write, active, config, scope, identity, rooms, decide, notify, deliveryStatus, now = Date.now, log = () => {}}) {
    Object.assign(this, {read, write, active, config, scope, identity, rooms, decide, notify, deliveryStatus, now, log});
    this.running = false;
    this.lastAttemptAt = 0;
    this.lastError = '';
  }

  identityKey() {
    const {bot, owner} = this.identity();
    return bot && owner ? bot + ':' + owner : '';
  }

  allowed(key) {
    const [bot, kind, peer] = String(key || '').split(':');
    const scope = this.scope();
    return this.active() && bot === this.identity().bot && (kind === 'group'
      ? scope.groups.includes(peer) : kind === 'private' && scope.private
        && (scope.allUsers === true || scope.users.includes(peer)));
  }

  current() {
    const data = this.read();
    return data.identity === this.identityKey() ? data : {version: 1, identity: this.identityKey(), rooms: {}, cursors: {}, events: []};
  }

  transcript(key) {
    const at = this.now();
    return (this.rooms()[key]?.rows || []).filter(row => row.id && row.time * 1000 <= at + 5000
      && row.time * 1000 >= at - MAX_AGE).slice(-16).map(row => ({
      id: String(row.id), user: String(row.user), sender: clean(row.sender || row.user, 80), text: clean(row.text, 450), time: Number(row.time),
      reply: String(row.reply || ''), mentions: (row.mentions || []).map(String).slice(0, 10)
    }));
  }

  candidate() {
    const data = this.current();
    return Object.keys(this.rooms()).filter(key => this.allowed(key)).map(key => {
      const rows = this.transcript(key);
      if (!rows.length) return null;
      const facts = factsFor(rows, this.identity().bot, this.now());
      const signature = rows.at(-1).id + ':' + facts.response;
      const cursor = data.cursors?.[key];
      return cursor?.signature === signature ? null : {key, rows, facts, signature, previousAt: cursor?.at || 0};
    }).filter(Boolean).sort((a, b) => a.previousAt - b.previousAt)[0];
  }

  async tick() {
    if (this.running || !this.active() || !this.identityKey()) return;
    this.running = true;
    try {
      await this.flush();
      const cfg = this.config();
      if (cfg.autoObserve !== true || this.now() - this.lastAttemptAt < (cfg.observeIntervalSec || 60) * 1000) return;
      const input = this.candidate();
      if (!input) return;
      this.lastAttemptAt = this.now();
      const guard = JSON.stringify([this.identity(), this.scope(), cfg]);
      const recentShares=(this.current().events||[]).filter(event=>event.key===input.key).slice(0,6).map(({topic,summary,sources,state})=>({topic,summary,sources,state}));
      const result = await this.decide({...input, recentShares, identity: {bot: this.identity().bot, owner: this.identity().owner}, current: this.publicState(input.key), now: this.now()});
      if (!this.allowed(input.key) || guard !== JSON.stringify([this.identity(), this.scope(), this.config()])) return;
      await this.apply(input, result);
      this.lastError = '';
      await this.flush();
    } catch {
      this.lastError = '情绪观察未完成，保留上次状态；稍后继续观察。';
      this.log('warn', this.lastError);
    } finally {
      this.running = false;
    }
  }

  sources(input, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 4) throw Error('缺少真实消息来源');
    const unique = [...new Set(ids.map(String))];
    if (unique.some(id => !input.rows.some(row => row.id === id))) throw Error('消息来源不属于本次观察');
    return unique;
  }

  shareEvent(input, share, data) {
    if (!share || this.config().shareWithOwner !== true || !input.key.includes(':group:')) return null;
    if (!['interesting', 'unanswered'].includes(share.kind)) throw Error('分享类型无效');
    if (share.kind === 'unanswered' && (this.config().shareUnanswered !== true || input.facts.response !== 'not_directly_answered')) return null;
    const sourceIds = this.sources(input, share.sourceIds);
    if (share.kind === 'unanswered' && !sourceIds.includes(input.facts.ownMessageId)) return null;
    const topic = topicOf(share.topic);
    const summary = clean(share.summary, 240);
    if (!topic || !summary) throw Error('分享内容缺失');
    if (data.events.some(event => event.key === input.key && event.topic === topic && this.now() - event.at < MAX_AGE)) return null;
    const eventKey = hash([this.identityKey(), input.key, share.kind, sourceIds.join(',')].join('|'));
    if (data.events.some(event => event.eventKey === eventKey)) return null;
    const sources = sourceIds.map(id => {
      const row = input.rows.find(item => item.id === id);
      return {id, user: row.user, sender: row.sender, time: row.time, text: clean(row.text, 450)};
    });
    return {eventKey, key: input.key, topic, kind: share.kind, summary, sourceIds, sources, at: this.now(),
      ownMessageId: input.facts.ownMessageId || '', bot: this.identity().bot, owner: this.identity().owner, state: 'pending'};
  }

  async apply(input, result) {
    if (!result || typeof result !== 'object') throw Error('观察结果无效');
    const data = this.current();
    let mood;
    if (result.mood != null) {
      if (!MOODS.includes(result.mood) || !Number.isFinite(result.intensity) || result.intensity < 0 || result.intensity > 1) throw Error('心情字段无效');
      const sourceIds = this.sources(input, result.sourceIds);
      mood = {mood: result.mood, intensity: result.intensity, reason: clean(result.reason), sourceIds, at: this.now(),
        actor: input.rows.findLast(row => row.user !== this.identity().bot)?.user || '', key: input.key};
    }
    const event = this.shareEvent(input, result.share, data);
    await this.write(previous => {
      const next = previous.identity === data.identity ? previous : data;
      next.rooms ||= {};
      next.cursors ||= {};
      next.events ||= [];
      if (mood) {
        next.global = mood;
        next.rooms[input.key] = mood;
      }
      next.cursors[input.key] = {signature: input.signature, at: this.now()};
      if (event) next.events.unshift(event);
      next.rooms = Object.fromEntries(Object.entries(next.rooms).sort((a, b) => b[1].at - a[1].at).slice(0, 16));
      next.cursors = Object.fromEntries(Object.entries(next.cursors).sort((a, b) => b[1].at - a[1].at).slice(0, 48));
      next.events = next.events.filter(row => this.now() - row.at < 86400000).slice(0, 32);
      while (next.events.length && Buffer.byteLength(JSON.stringify(next)) > 58000) next.events.pop();
      return next;
    });
  }

  canShare(event) {
    const cfg = this.config();
    const scope = this.scope();
    if (!this.active() || cfg.shareWithOwner !== true || !scope.private
      || !(scope.allUsers === true || scope.users.includes(this.identity().owner))) return false;
    const record = this.current().events?.find(row => row.eventKey === event.eventKey);
    if (!record || !['pending', 'queued'].includes(record.state) || !this.allowed(record.key)
      || record.bot !== this.identity().bot || record.owner !== this.identity().owner || this.now() - record.at > MAX_AGE) return false;
    if (record.sourceIds.some(id => !record.sources?.some(row => row.id === id))) return false;
    const rows = (this.rooms()[record.key]?.rows || []).slice(-60);
    if (record.kind === 'unanswered') {
      const facts = factsFor(rows, record.bot, this.now());
      if (cfg.shareUnanswered !== true || facts.ownMessageId !== record.ownMessageId || facts.response !== 'not_directly_answered') return false;
    }
    return true;
  }

  async flush() {
    if (!this.active()) return;
    for (const record of this.current().events || []) {
      if (['pending', 'queued'].includes(record.state)) {
        const state = this.deliveryStatus?.(record.eventKey);
        if (state && state !== 'processing') {
          if (state !== record.state) await this.delivery(record, state);
          continue;
        }
      }
      if (record.state !== 'pending') continue;
      if (!this.canShare(record)) {
        await this.delivery(record, 'cancelled');
        continue;
      }
      const event = {reason: 'social', eventKey: record.eventKey, title: record.kind === 'unanswered' ? '群里暂时没接上话' : '想分享的群聊见闻',
        summary: record.summary, at: record.at, evidence: {key: record.key, bot: record.bot, owner: record.owner, sourceIds: record.sourceIds, sources: record.sources, kind: record.kind}};
      if (await this.notify(event)) await this.delivery(record, 'queued');
    }
  }

  async delivery(event, state) {
    if (!this.active()) return;
    await this.write(data => {
      const row = data.events?.find(item => item.eventKey === event.eventKey);
      if (row) {
        row.state = clean(state, 20);
        row.updatedAt = this.now();
      }
      return data;
    });
  }

  publicState(key) {
    const data = this.current();
    const local = data.rooms?.[key];
    const cfg = this.config();
    return {global: moodAt(data.global, this.now(), cfg.halfLifeMinutes),
      local: {...moodAt(local, this.now(), cfg.halfLifeMinutes),
        reason: local && moodAt(local, this.now(), cfg.halfLifeMinutes).intensity > 0 ? local.reason : '',
        actor: local?.actor || '', at: local?.at || null}};
  }

  context(input) {
    if (!this.allowed(input.key)) return '';
    return '[她此刻的角色情绪状态，仅为表达参考]\n' + JSON.stringify(this.publicState(input.key))
      + '\n心情属于你自己；local 的原因只对应当前聊天，actor 只标记相关互动者，不代表那个人的心情。当前消息优先，不能把历史心情当成他人仍生气的事实。自然影响语气、表情和话题即可，不必播报数值，不用情绪催促别人回复。';
  }

  overview() {
    const data = this.current();
    const current = moodAt(data.global, this.now(), this.config().halfLifeMinutes);
    return {stats: [{label: '当前心情', value: data.global ? current.mood : '尚无观察记录'},
      {label: '观察到的聊天', value: Object.keys(data.cursors || {}).length},
      {label: '分享事件', value: data.events?.length || 0}, {label: '观察状态', value: this.lastError || (this.running ? '观察中' : '等待新消息')}],
      columns: [{key: 'at', label: '时间', format: 'datetime'}, {key: 'chat', label: '来源聊天'}, {key: 'summary', label: '见闻'}, {key: 'state', label: '发送状态'}],
      rows: (data.events || []).map(event => ({at: new Date(event.at).toISOString(), chat: '群 ' + event.key.split(':')[2], summary: event.summary, state: event.state}))};
  }
}
