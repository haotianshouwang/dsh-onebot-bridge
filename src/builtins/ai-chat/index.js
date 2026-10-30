export const manifest={id:'ai-chat',apiVersion:2,name:'AI 聊天',version:'1.0.0',services:['ordinary-chat']};
export function accepts(message){return message.type==='message'&&typeof message.text==='string'&&!!message.text.trim();}
export const settings={};
