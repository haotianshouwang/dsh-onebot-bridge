import {freeMode} from '../core/freedom.js';
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
export function validateProfile(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('聊天设置无效');
 const p={};for(const key of ['replyEnabled','decisionEnabled'])if(own(input,key)){if(typeof input[key]!=='boolean')throw Error('开关值无效');p[key]=input[key];}
 if(!['inherit','direct','smart','all'].includes(input.participation??'inherit'))throw Error('参与方式无效');p.participation=input.participation??'inherit';
 for(const [key,min,max,defaultValue]of [['mergeWindowMs',0,5000,1200],['maxCollectMs',1000,10000,5000],['staleAfterSec',15,180,60]]){
  const value=input[key]??defaultValue;if(!Number.isInteger(value)||value<min||value>max)throw Error('等待或有效期范围无效');p[key]=value;
 }
 if(p.maxCollectMs<p.mergeWindowMs)throw Error('最长等待不能小于合并窗口');
 const environment=input.environment??'';if(typeof environment!=='string'||environment.length>2000)throw Error('聊天背景最多 2000 字');p.environment=environment;
 p.audience=input.audience??'inherit';if(!['inherit','all','selected'].includes(p.audience))throw Error('聊天成员范围无效');
 const users=input.users??[];if(!Array.isArray(users)||users.length>200||users.some(v=>typeof v!=='string'||!/^\d{4,16}$/.test(v)))throw Error('请选择有效聊天成员');p.users=[...new Set(users)];return p;
}
export function chatSettings(store,msg){
 const s={...store.data.settings,freeMode:freeMode(store)},p=store.data.chatProfiles?.[msg.key];if(!p)return s;
 for(const k of ['mergeWindowMs','maxCollectMs','staleAfterSec','decisionEnabled'])if(own(p,k))s[k]=p[k];
 if(p.participation&&p.participation!=='inherit')s.groupReplyMode=p.participation;
 if(p.audience==='all'){s[msg.kind==='group'?'groupAudience':'privateAudience']='all';}
 if(p.audience==='selected'){s[msg.kind==='group'?'groupAudience':'privateAudience']='allowlist';s.allowedUsers=p.users||[];}
 return s;
}
