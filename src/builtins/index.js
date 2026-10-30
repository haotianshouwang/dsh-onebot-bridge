import { resolvePersona,renderPersona } from './persona/index.js';
import {accepts} from './ai-chat/index.js';
import {pokeDefaults,validatePokeConfig} from './poke/index.js';
import {responses} from './welcome/index.js';
export const builtinDefinitions=[
 {id:'ai-chat',name:'AI 聊天',description:'控制普通用户的日常聊天。停用后，主人的机器人管理和已授权工具任务仍保留。'},
 {id:'persona',name:'人设',description:'用一段完整提示词设定角色，支持按聊天绑定。'},
 {id:'welcome',name:'入群欢迎',description:'在指定群回应新成员；不调用模型。'},
 {id:'poke',name:'戳一戳互动',description:'独立管理戳一戳：AI 或固定文字、回戳、概率、冷却及续聊。'},
 {id:'market',name:'插件市场',description:'浏览和安装声明式功能包。'}
];
export function builtinDefaults(){return {
 poke:{enabled:true,config:pokeDefaults()},'ai-chat':{enabled:true,config:{}},persona:{enabled:true,config:{}},
 welcome:{enabled:false,config:{groups:[],text:'欢迎新成员加入！'}},market:{enabled:true,config:{}}
};}
export class Builtins {
 constructor(store){this.store=store;}
 acceptsChat(message){return this.enabled('ai-chat')&&accepts(message);}
 welcome(event){const p=this.store.data.framework.builtins.welcome;return p.enabled?responses(p.config,event):[];}
 enabled(id){return this.store.data.framework.builtins[id]?.enabled===true&&!this.store.data.framework.builtins[id]?.uninstalled;}
 list(){return builtinDefinitions.map(d=>({...d,...this.store.data.framework.builtins[d.id],version:'1.0.0',builtin:true,removable:true}));}
 persona(msg){
  return this.enabled('persona')?resolvePersona(this.store.data,msg.key,msg.bot):{id:'core-neutral',name:'基础助手',version:1,prompt:'用自然、简洁、诚实的中文回复用户。'};
 }
 prompt(persona,msg){return renderPersona(persona,msg);}
 configure(id,enabled,config={}){
  if(!builtinDefinitions.some(d=>d.id===id))throw new Error('内置包不存在');
  if(id==='poke')config=validatePokeConfig(config);
  else if(id==='welcome'){
   if(!Array.isArray(config.groups)||config.groups.some(g=>!this.store.data.framework.listenGroups.includes(String(g))))throw new Error('欢迎群须在监听范围内');
   if(typeof config.text!=='string'||!config.text.trim()||config.text.length>500)throw new Error('欢迎内容须为 1–500 字');
   config={groups:[...new Set(config.groups.map(String))],text:config.text};
  }else config={};
  this.store.data.framework.builtins[id]={enabled:enabled===true,config};if(id==='poke'){this.store.data.settings.pokeReplyEnabled=enabled===true;this.store.data.settings.pokeReplyCooldown=config.cooldown;}
 }
 clearList(id){return id==='persona'?['默认人设选择及各聊天的人设绑定（保留人设正文库）']:id==='market'?['自定义市场源及市场包设置']:id==='ai-chat'?['接话与分条偏好、各聊天的背景和节奏覆盖（保留聊天资格及监听范围）']:['该内置包的设置与设置历史'];}
 remove(id,{deleteConfig=false}={}){
  const old=this.store.data.framework.builtins[id];if(!old)throw Error('内置包不存在');
  if(deleteConfig){
   if(id==='persona'){this.store.data.bindings={};this.store.data.personaDefaults={global:this.store.data.personas[0]?.id||'default',bots:{}};}
   if(id==='market')this.store.data.sources=[];
   if(id==='ai-chat'){
    Object.assign(this.store.data.settings,{intentRecognition:true,intentPerMinute:12,intentPerHour:180,actionTextMode:'allow',actionTextProbability:30,interjectionMode:'allow',interjectionProbability:30,groupReplyMode:'direct',groupReplyProbability:10,groupReplyCooldown:30,groupAutoLimit:2,botAliases:['机器人'],followupEnabled:true,followupWindowSec:120,followupMaxTurns:8,replySplit:'natural',replyQuoteMode:'off',sendInterval:1100,maxReplyChars:1800,replyTotalChars:240,replyMaxParts:2,mergeWindowMs:1200,maxCollectMs:5000,staleAfterSec:60,decisionEnabled:true});
    for(const profile of Object.values(this.store.data.chatProfiles||{}))for(const key of ['participation','mergeWindowMs','maxCollectMs','staleAfterSec','decisionEnabled','environment'])delete profile[key];
   }
   old.config=structuredClone(builtinDefaults()[id].config);old.settingsHistory=[];
  }
  old.enabled=false;old.uninstalled=true;
 }

}
