import {chunks} from '../onebot/index.js';
const count=value=>Array.from(value).length;
export function splitReply(text,mode='natural',size=1500,source=text){
 const value=String(text||'');
 if(mode==='natural'){
  const lines=value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(/^\s*(?:\x60{3,}|~{3,})/m.test(String(source)))return chunks(value,size);
  const structured=/^\s*(?:\x60{3,}|~{3,}|[-*+]\s|\d+[.)、]\s|>|\|)/m.test(String(source))||/^\s*[\[{][\s\S]*[\]}]\s*$/.test(String(source));
  // A short conversation line is a message boundary. Lists and code stay together.
  if(!structured&&count(value)<=360&&lines.length>1&&lines.every(line=>count(line)<=120))return lines.flatMap(line=>chunks(line,size));
  if(!structured){
   const sentences=value.match(/[^。！？!?；;]+[。！？!?；;]+|[^。！？!?；;]+$/g)?.map(s=>s.trim()).filter(Boolean)||[];
   if(sentences.length>1&&count(value)>=60){
    const grouped=[];let current='';
    for(const sentence of sentences){
     const next=current?current+sentence:sentence;
     if(current&&count(current)<18){current=next;continue;}
     if(current)grouped.push(current);
     current=sentence;
    }
    if(current)grouped.push(current);
    if(grouped.length>1)return grouped.flatMap(line=>chunks(line,size));
   }
  }
  mode='paragraphs';
 }
 if(mode!=='paragraphs')return chunks(value,mode==='single'?4000:size);
 const paragraphs=[];let lines=[],fence=null;
 for(const line of value.split(/\r?\n/)){
  const marker=/^\s*(\x60{3,}|~{3,})/.exec(line)?.[1];
  if(marker){if(!fence)fence=marker;else if(marker[0]===fence[0]&&marker.length>=fence.length)fence=null;}
  if(!line.trim()&&!fence){if(lines.length){paragraphs.push(lines.join('\n').trim());lines=[];}}
  else lines.push(line);
 }
 if(lines.length)paragraphs.push(lines.join('\n').trim());
 return paragraphs.filter(Boolean).flatMap(p=>chunks(p,size));
}
export function replyParts(text,mode,size,maxParts,source=text){
 const cap=Math.max(1,Math.floor(maxParts)),pieces=splitReply(text,mode,size,source);
 if(pieces.length<=cap)return pieces;
 const combined=[...pieces.slice(0,cap-1),pieces.slice(cap-1).join(mode==='natural'?' ':'\n\n')];
 if(combined.every(p=>count(p)<=(mode==='single'?4000:size)))return combined;
 return chunks(String(text),mode==='single'?4000:size).slice(0,cap);
}
