import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { frameworkDefaults,migrate } from './migrate.js';
import { personaFields,personaPrompt } from '../personas/index.js';
const baseDefaults = () => ({
  schema: 1, revision: 0,
  settings: { enabled: true, mode: 'forward', url: process.env.QQBOT_WS_URL || 'ws://127.0.0.1:3001',
    reverseHost: '127.0.0.1', reversePort: 3002, reversePath: '/onebot/v11',
    privateEnabled: true, groupEnabled: false, allowedUsers: (process.env.QQBOT_ALLOWED_USERS||'').split(/[\s,]+/).filter(Boolean), allowedGroups: [],
    groupMentionOnly: true, workspacePath: path.resolve(process.cwd(), 'qqbot-chats'),
    preset: '', provider: '', model: '', reasoningEffort: '', turnTimeout: 180,
    sendInterval: 1100, maxReplyChars: 1800 },
  personas: [{id:'default',version:1,name:'默认助手',prompt:'你是一位通过 QQ 与用户交流的助手。\n友善、坦诚、有耐心，使用自然的中文，先回答重点。\n默认简洁，复杂问题按需展开。不了解的内容明确说明，不要编造已执行的操作，也不要输出模型内部思考。',updatedAt:new Date().toISOString()}],
  personaDefaults: { global:'default', bots:{} }, bindings:{},
  sessions:{}, inbox:[], recent:[], extensions:{}, sources:[], logs:[]
});
export function defaults(){const data=baseDefaults();data.schema=2;data.framework=frameworkDefaults(data.settings);return data;}
export class Store {
  constructor(dir) { this.dir=dir; this.file=path.join(dir,'state.json'); this.tail=Promise.resolve(); }
  async open() {
    await mkdir(this.dir,{recursive:true});
    try { this.data=JSON.parse((await readFile(this.file,'utf8')).replace(/^\uFEFF/,'')); }
    catch(e) { if(e.code!=='ENOENT') throw new Error('插件状态文件无法读取；已停止启动，请恢复 state.json.bak。');
      this.data=defaults(); await this.persist(); }
    if(this.data.schema===1){try{await copyFile(this.file,path.join(this.dir,'state.before-framework-v2.json'),constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}}
    if(!this.data.framework)this.data.framework=frameworkDefaults(this.data.settings);
    migrate(this.data);await this.persist();
    if(this.data.personas.some(p=>typeof p.prompt!=='string')) {
      try{await copyFile(this.file,path.join(this.dir,'state.before-simple-personas.json'),constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
      for(const p of this.data.personas) {
        if(typeof p.prompt!=='string'){p.prompt=personaPrompt(p);for(const key of personaFields)delete p[key];}
      }
      await this.persist();
    }
    // Sending may have reached QQ before a crash: do not repeat it automatically.
    for(const job of this.data.inbox) if(job.status==='sending') {job.status='uncertain';job.error='进程退出时发送结果未知，请人工检查 QQ。';}
    return this;
  }
  persist() {
    const json=JSON.stringify(this.data,null,2);
    const task=this.tail.then(async()=>{
      const tmp=this.file+'.tmp';
      await writeFile(tmp,json,{encoding:'utf8',mode:0o600});
      try { await copyFile(this.file,this.file+'.bak'); } catch(e) { if(e.code!=='ENOENT') throw e; }
      await rename(tmp,this.file);
    });
    this.tail=task.catch(()=>{}); return task;
  }
  async change(revision, fn) {
    if(revision!==this.data.revision) throw new Error('配置已被其他页面修改，请刷新后重试。');
    fn(this.data); this.data.revision++; await this.persist();
  }
  log(level,message,detail) {
    const record={time:new Date().toISOString(),level,message,detail};
    this.data.logs.push(record);
    if(this.data.logs.length>240) this.data.logs.splice(0,this.data.logs.length-240);
    return record;
  }
}
export function ids(value) {
  const values=Array.isArray(value)?value:String(value||'').trim().split(/[\s,，]+/).filter(Boolean);
  if(values.some(x=>!/^[1-9]\d{3,15}$/.test(String(x)))) throw new Error('QQ 号/群号必须是 4–16 位数字');
  return [...new Set(values.map(String))];
}
export function validateSettings(input) {
  const s={...input};
  s.groupReplyMode??=s.groupMentionOnly?'direct':'smart';if(!['smart','direct','all'].includes(s.groupReplyMode))throw new Error('群聊参与方式无效');
  for(const [key,value,min,max]of [['groupReplyProbability',10,0,100],['groupReplyCooldown',30,0,600],['groupAutoLimit',2,1,10]]){s[key]??=value;if(!/^\d+$/.test(String(s[key]))||!Number.isInteger(Number(s[key]))||Number(s[key])<min||Number(s[key])>max)throw new Error('群聊回复概率或节奏范围无效');s[key]=Number(s[key]);}
  s.intentRecognition??=true;if(typeof s.intentRecognition!=='boolean')throw Error('语义识别开关无效');for(const [key,fallback,min,max]of [['intentPerMinute',12,1,30],['intentPerHour',180,1,600]]){s[key]??=fallback;if(!Number.isInteger(s[key])||s[key]<min||s[key]>max)throw Error('意图判断预算范围无效');}
  for(const key of ['actionText','interjection']){s[key+'Mode']??='allow';if(!['allow','off','probability'].includes(s[key+'Mode']))throw Error('表达方式无效');s[key+'Probability']??=30;const n=s[key+'Probability'];if(!Number.isInteger(n)||n<0||n>100)throw Error('表达概率须为 0–100 的整数');}
  s.botAliases??=[];if(!Array.isArray(s.botAliases)||s.botAliases.length>10||s.botAliases.some(a=>typeof a!=='string'||!a.trim()||a.length>30))throw new Error('机器人称呼须为最多十个短名称');
  s.pokeReplyEnabled??=true;if(typeof s.pokeReplyEnabled!=='boolean')throw Error('戳一戳开关无效');s.pokeReplyCooldown??=30;if(!/^\d+$/.test(String(s.pokeReplyCooldown))||Number(s.pokeReplyCooldown)<5||Number(s.pokeReplyCooldown)>600)throw Error('戳一戳冷却须为 5–600 秒');s.pokeReplyCooldown=Number(s.pokeReplyCooldown);
  s.followupWindowSec??=120;s.followupMaxTurns??=8;for(const [key,min,max]of [['followupWindowSec',15,300],['followupMaxTurns',1,20]])if(!Number.isInteger(s[key])||s[key]<min||s[key]>max)throw Error('续聊时长或轮数范围无效');
  s.followupEnabled??=true;s.groupMentionOnly=s.groupReplyMode==='direct';
  for(const key of ['privateAudience','groupAudience']){s[key]??='allowlist';if(!['allowlist','all'].includes(s[key]))throw new Error('请选择有效的聊天用户范围');}
  for(const [key,value,min,max]of [['mergeWindowMs',1200,0,5000],['maxCollectMs',5000,1000,10000],['staleAfterSec',60,15,180]]){s[key]??=value;if(!Number.isInteger(s[key])||s[key]<min||s[key]>max)throw Error('聊天等待或有效期范围无效');}if(s.maxCollectMs<s.mergeWindowMs)throw Error('最长等待不能小于合并窗口');s.decisionEnabled??=true;if(typeof s.decisionEnabled!=='boolean')throw Error('参与判断开关无效');
  s.replyQuoteMode??='off';if(!['off','follow','always'].includes(s.replyQuoteMode))throw Error('引用回复方式无效');
  s.replyTotalChars??=240;s.replyMaxParts??=2;
  for(const [key,min,max]of [['replyTotalChars',80,4000],['replyMaxParts',1,6]]){if(!/^\d+$/.test(String(s[key]))||Number(s[key])<min||Number(s[key])>max)throw Error(key==='replyTotalChars'?'每轮总字数须为 80–4000':'每轮条数须为 1–6');s[key]=Number(s[key]);}
  s.replySplit??='natural';if(!['natural','single','paragraphs','length'].includes(s.replySplit))throw new Error('请选择有效的分条方式');
  s.allowedUsers=ids(s.allowedUsers);s.allowedGroups=ids(s.allowedGroups);
  for(const key of ['enabled','privateEnabled','groupEnabled','groupMentionOnly']) s[key]=Boolean(s[key]);
  if(!['forward','reverse'].includes(s.mode)) throw new Error('连接方式无效');
  let url;try{url=new URL(s.url);}catch{throw new Error('WebSocket 地址无效，请检查地址和端口（1–65535）');}
  if(!['ws:','wss:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw new Error('请输入不含密码和查询参数的 ws:// 或 wss:// 地址');
  if(url.port && (Number(url.port)<1||Number(url.port)>65535))throw new Error('WebSocket 端口须为 1–65535');
  if(!['127.0.0.1','::1','localhost'].includes(s.reverseHost)) throw new Error('反向 WS 当前仅监听本机回环地址');
  if(!/^\/[a-zA-Z0-9/_-]+$/.test(s.reversePath)) throw new Error('反向 WS 路径无效');
  for(const [key,min,max] of [['reversePort',1024,65535],['turnTimeout',15,1800],['sendInterval',500,30000],['maxReplyChars',200,4000]]) {
    const label={reversePort:'监听端口',turnTimeout:'回复超时',sendInterval:'发送间隔',maxReplyChars:'每段字数'}[key];
    if(s[key]===null||s[key]===undefined||String(s[key]).trim()==='')throw new Error(label+'不能为空');
    if(!/^\d+$/.test(String(s[key])))throw new Error(label+'只能填写整数');
    s[key]=Number(s[key]);if(!Number.isSafeInteger(s[key])||s[key]<min||s[key]>max)throw new Error(label+'须为 '+min+'–'+max+' 之间的整数');
  }
  if(!path.isAbsolute(s.workspacePath)) throw new Error('工作区必须使用绝对路径');
  for(const key of ['preset','provider','model','reasoningEffort']) s[key]=String(s[key]||'').trim().slice(0,200);
  if(Boolean(s.provider)!==Boolean(s.model)) throw new Error('模型与提供方须同时填写，或同时留空以继承 DSH 默认模型');
  return s;
}
