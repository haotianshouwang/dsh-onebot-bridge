import { randomUUID } from 'node:crypto';
import {adaptPersona} from '../session/style.js';
export const personaFields=['identity','personality','style','relationship','length','behavior','examples','instructions'];
const labels={identity:'身份与背景',personality:'性格',style:'说话风格',relationship:'称呼与关系',length:'回复长度',behavior:'行为约定',examples:'示例对话',instructions:'补充说明'};
export function personaPrompt(persona) {
  if(typeof persona.prompt==='string')return persona.prompt;
  return personaFields.filter(key=>String(persona[key]||'').trim()).map(key=>labels[key]+'：\n'+String(persona[key]).trim()).join('\n\n');
}
export function validatePersona(input, previous) {
  if(input.prompt!==undefined&&typeof input.prompt!=='string')throw new Error('提示词须为文字');
  const p={id:previous?.id||randomUUID(),version:(previous?.version||0)+1,name:String(input.name||'').trim(),prompt:personaPrompt(input)};
  if(!p.name||p.name.length>80)throw new Error('人设名称须为 1–80 字');
  if(p.prompt.length>30000)throw new Error('提示词不能超过 30000 字');
  p.updatedAt=new Date().toISOString();return p;
}
export function resolvePersona(data,key,bot) {
  const id=data.bindings[key]?.personaId||data.personaDefaults.bots[String(bot)]||data.personaDefaults.global;
  const p=data.personas.find(p=>p.id===id);
  if(!p)throw new Error('绑定的人设不存在，请在设置中重新绑定。');
  return structuredClone(p);
}
export function renderPersona(p,context={}) {
  return ['[QQ 人设 · '+p.name+' · v'+p.version+']',adaptPersona(personaPrompt(p)),'[QQ 场景]','这是 QQ '+(context.kind==='group'?'群聊':'私聊')+'。回复会以普通文本发送。'].filter(Boolean).join('\n\n');
}
export function assertCanDelete(data,id) {
  if(data.personas.length<=1)throw new Error('至少保留一个人设');
  if(data.personaDefaults.global===id||Object.values(data.personaDefaults.bots).includes(id)||Object.values(data.bindings).some(b=>b.personaId===id))throw new Error('请先解除默认人设和会话绑定，再删除该人设');
}
export function importPersona(text,format='json') {
  if(text.length>60000)throw new Error('导入内容过大');
  if(format==='json'){const obj=JSON.parse(text);return validatePersona(obj.persona||obj);}
  const title=text.match(/^#\s+(.+)$/m)?.[1]||'导入的人设';
  return validatePersona({name:title,prompt:text.replace(/^#\s+.+\r?\n/,'')});
}
