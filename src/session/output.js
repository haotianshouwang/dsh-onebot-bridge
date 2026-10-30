export function publicText(value,{secrets=[]}={}){
 let text=String(value||'');
 for(const secret of secrets)if(typeof secret==='string'&&secret.length>=6)text=text.split(secret).join('[凭据已隐藏]');
 text=text.replace(/\b[A-Za-z]:[\\/][^\s<>"'\x60，。；！？）)\]}]+/g,'[本机路径已隐藏]')
  .replace(/\\\\[^\s\\/]+[\\/][^\s<>"'\x60，。；！？]+/g,'[本机路径已隐藏]')
  .replace(/(^|[\s("'\x60：:])\/(?:home|Users|root|etc|tmp|var|mnt|opt)\/[^\s<>"'\x60，。；！？）)\]}]*/g,'$1[本机路径已隐藏]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi,'Bearer [凭据已隐藏]')
  .replace(/((?:access[_ -]?token|api[_ -]?key|password|secret)\s*[=:：]\s*["']?)[^\s"'，。；]{4,}/gi,'$1[凭据已隐藏]');
 return text.replace(/\[CQ:/gi,'[CQ：');
}
export function chatBreaks(value){
 let fenced=false;
 return String(value||'').split(/\r?\n/).map(line=>{
  if(/^\s*(?:\x60\x60\x60|~~~)/.test(line)){fenced=!fenced;return line;}
  if(fenced||/https?:\/\//i.test(line))return line;
  return line.split(/(\x60[^\x60]*\x60)/).map((part,i)=>i%2?part:part.replace(/([\u3400-\u9fff。！？?!～…」』）])\s+\/\s+(?=[\u3400-\u9fff“「『？?!])/g,'$1\n')).join('');
 }).join('\n');
}
export function quoteReply(msg,mode='off'){return msg.kind==='group'&&msg.replyable!==false&&/^-?\d{1,20}$/.test(String(msg.id||''))&&(mode==='always'||mode==='follow'&&!!msg.reply);}
export function qqPlain(value,{legacyBreaks=true}={}){
 return (legacyBreaks?chatBreaks(value):String(value||'')).replace(/\x60\x60\x60[^\n]*\n?/g,'').replace(/\*\*([^*\n]+)\*\*/g,'$1')
  .replace(/^#{1,6}\s+/gm,'').replace(/\x60([^\x60\n]+)\x60/g,'$1').replace(/\n{3,}/g,'\n\n').trim();
}
const limit=(n,fallback,min,max)=>Number.isInteger(Number(n))&&Number(n)>=min&&Number(n)<=max?Number(n):fallback;
export function replyLimits(settings={}){return {chars:limit(settings.replyTotalChars,240,1,4000),parts:limit(settings.replyMaxParts,2,1,6)};}
export function boundedReply(value,settings={},secrets=[]){
 const limits=replyLimits(settings),chars=Math.min(limits.chars,limits.parts*(settings.replySplit==='single'?4000:limit(settings.maxReplyChars,1800,200,4000))),text=qqPlain(publicText(value,{secrets})),points=Array.from(text);
 if(points.length<=chars)return text;
 const head=points.slice(0,chars-1).join(''),cut=Math.max(head.lastIndexOf('。'),head.lastIndexOf('！'),head.lastIndexOf('？'),head.lastIndexOf('\n'));
 return (cut>=head.length*0.65?head.slice(0,cut+1):head).trimEnd()+'…';
}
