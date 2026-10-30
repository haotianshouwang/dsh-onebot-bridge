import { builtinDefaults } from '../builtins/index.js';
import {ownerIds} from '../core/owners.js';
export function frameworkDefaults(settings){
 const ownerQQ=String(process.env.QQBOT_OWNER||process.env.QQBOT_ALLOWED_USERS?.split(/[\s,]+/).find(Boolean)||'');
 return {version:2,generation:1,ownerQQ,ownerQQs:ownerQQ?[ownerQQ]:[],paused:false,listenPrivate:settings.privateEnabled,
  listenUsers:[...settings.allowedUsers],listenGroups:[...settings.allowedGroups],listenNotices:true,listenRequests:true,
  enabledActions:['core.status'],grants:[],builtins:builtinDefaults(),audit:[],retiredSessions:[]};
}
export function migrate(data){
 if(data.schema===1){
  data.framework=frameworkDefaults(data.settings);
  data.framework.retiredSessions=Object.values(data.sessions||{}).map(s=>({sessionId:s.sessionId,reason:'0.1.x 不受控工具会话'}));
  data.sessions={};
  for(const e of Object.values(data.extensions||{})){e.enabled=false;e.error='旧版 JavaScript 插件已停用，请从市场重新安装 API 2 声明式版本。';}
  data.schema=2;
 }
 if(data.schema!==2)throw new Error('不支持的插件状态版本');
 for(const job of data.inbox||[])if(['collecting','deciding','observing','queued','running','reply-ready'].includes(job.status)){job.status='cancelled';job.error='重启后原执行身份已失效，未自动重放。';}
 if((data.framework.featuresVersion||0)<6){
  data.framework.retiredSessions??=[];for(const s of Object.values(data.sessions||{}))if(s.sessionId&&!data.framework.retiredSessions.some(x=>x.sessionId===s.sessionId))data.framework.retiredSessions.push({...s,reason:'0.5.0 上下文与人设修复，归档旧提示词会话'});
  data.sessions={};
 }
 data.continuations??={};data.settings.followupWindowSec??=120;data.settings.followupMaxTurns??=8;
 data.chatProfiles??={};data.settings.mergeWindowMs??=1200;data.settings.maxCollectMs??=5000;data.settings.staleAfterSec??=60;data.settings.decisionEnabled??=true;
 data.framework.builtins.poke??={enabled:data.settings.pokeReplyEnabled!==false,config:{...builtinDefaults().poke.config,cooldown:Math.min(600,Math.max(5,Math.round(Number(data.settings.pokeReplyCooldown)||30)))}};
 data.framework.ownerQQs=ownerIds(data.framework);data.settings.intentRecognition??=true;data.settings.intentPerMinute??=12;data.settings.intentPerHour??=180;
 for(const key of ['actionText','interjection']){data.settings[key+'Mode']??='allow';data.settings[key+'Probability']??=30;}
 data.framework.featuresVersion=10;delete data.settings.walletReplyEnabled;data.settings.replyQuoteMode??='off';data.conversations??={};data.settings.replyTotalChars??=240;data.settings.replyMaxParts??=2;
 for(const key of ['mediaImages','mediaAudio','mediaFiles','mediaVideo'])data.settings[key]??=true;
 data.settings.groupReplyMode??=data.settings.groupMentionOnly?'direct':'smart';data.settings.groupReplyProbability??=10;data.settings.groupReplyCooldown??=30;data.settings.groupAutoLimit??=2;data.settings.botAliases??=['机器人'];data.settings.followupEnabled??=true;
 data.settings.pokeReplyEnabled??=true;data.settings.pokeReplyCooldown??=30;
 data.framework.listenAllPrivate??=false;
 data.settings.privateAudience??='allowlist';data.settings.groupAudience??='allowlist';data.settings.replySplit??='natural';
 for(const p of Object.values(data.framework.nativePackages||{}))p.registered=false;
 for(const job of data.framework.automaticOutbox||[])if(['queued','sending'].includes(job.status)){job.status=job.status==='sending'?'unknown':'cancelled';job.error='重启后不自动重放事件动作';}
 data.framework.generation++;
 return data;
}
