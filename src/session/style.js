import {qqPlain} from './output.js';
const food=/白饭|吃饭|饭团|饭勺|干饭|开饭|喂饭|先吃|没饭|三碗|一碗/g;
const foodQuestion=/吃|饭|饿|饮食|食物|餐|饱|馋/;
const foodAsk=/(?:吃饭|吃了吗|吃了没有|吃什么|吃了什么|中午吃|午饭吃|晚饭吃|早饭吃|饿不饿|要不要吃)/;
const foodAnswer=/(?:没(?:有)?吃|还没吃|不吃饭|吃过了|已经吃|吃了(?:饭|午饭|晚饭|早饭|东西|一|两|些|点))/;
const foodComplaint=/(?:别|不要|不许|停止|总|一直|老是|每次|每句|十句|10句|九句|9句|复读|重复).{0,18}(?:吃|饭)|(?:吃|饭).{0,18}(?:重复|复读|没完)/;
const compact=value=>String(value||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const containsFood=value=>{food.lastIndex=0;return food.test(value);};
export function adaptPersona(text){
 const legacy=/斜杠.{0,4}[＝=].{0,20}(?:分|消息)/.test(text);
 return String(text||'').split(/\r?\n/).map(line=>{
  if(/send_message/.test(line)&&/数组|分条|一行|换行/.test(line))return '短句自然表达，必要时正常换行；消息分条由框架处理，正文不写发送工具或数组协议。';
  if(/斜杠.{0,4}[＝=].{0,20}(?:分|消息)/.test(line))return '回复示例（只参考语气，不照搬内容、口头禅或当前话题）：';
  return legacy&&/^[\s　]+/.test(line)?qqPlain(line):line;
 }).join('\n');
}
const askedRepeat=current=>/(?:再|重新)(?:说|发|讲|重复)|重复(?:一下|一遍)|复述|原话|原文/.test(current)&&!/(?:不要|别|停止).{0,8}(?:重复|复读)/.test(current);
export function styleAdvice(recent,current,incoming=[]){
 const rows=recent.slice(-6),count=rows.filter(containsFood).length;
 const currentText=String(current||''),incomingRows=Array.isArray(incoming)?incoming:[];
 const foodAnswered=foodAnswer.test(currentText)||incomingRows.some(text=>foodAnswer.test(String(text||'')));
 const foodLock=foodComplaint.test(currentText)||(count>=2&&!foodQuestion.test(currentText)&&!askedRepeat(currentText));
 const lines=['优先接住本轮最新一句的意思；前面的话题已经结束就跟着换话题，不把任何一个梗变成固定收尾。',
  '日常聊天直接返回正文，由框架发送；不要为排版或分条调用发送工具。',
  '人设中的喜好、道具和示例是背景，不是每条回复必须出现的内容。示例只参考语气，不照搬台词。',
  '自然分条时，只有打算作为另一条独立消息的完整短句才换行；一句话内部用逗号停顿，不为排版随意换行。不用 / 充当分条标记，不输出发送消息的工具协议。',
  '别人问实际功能就根据实际可用能力回答；没有依据不要把玩笑编成代码实现或已完成的操作。'];
 if(foodAnswered)lines.push('用户已经回答过当前是否吃饭；本轮不要再次追问“吃饭了吗、吃了什么、饿不饿”等同一问题，除非用户明确重新询问饮食。可以简短回应已知答案，然后自然换到用户的新话题。');
 if(foodLock)lines.push('最近饮食梗已过多，或用户正在要求停止复读。本轮不要再提吃饭、白饭、饭团等相关梗，也不用解释自己不提了；直接回应当前话题。');
 return {text:lines.join('\n'),foodLock,foodAnswered};
}
const grams=value=>{const out=new Set();for(let i=0;i<value.length-2;i++)out.add(value.slice(i,i+3));return out;};
export function reviewReply(text,recent,current,incoming=[]){
 const advice=styleAdvice(recent,current,incoming),plain=qqPlain(text);
 if(advice.foodAnswered&&foodAsk.test(plain)&&!askedRepeat(current))return {repeat:true,reason:'用户已经回答过饮食问题，本轮不再重复追问'};
 if(askedRepeat(current)&&!foodComplaint.test(current))return {repeat:false};
 if(advice.foodLock&&containsFood(plain))return {repeat:true,reason:'饮食梗已过多，本轮应直接回答当前话题'};
 if(/(?:再|重新)(?:说|发|讲|重复)|重复(?:一下|一遍)|复述|原话|原文/.test(current)&&!/(?:不要|别|停止).{0,8}(?:重复|复读)/.test(current))return {repeat:false};
 const value=compact(plain);if(value.length<9)return {repeat:false};
 if(/^[A-Za-z0-9_-]+$/.test(plain.trim())&&/口令|代号|编号|数字|号码/.test(current))return {repeat:false};
 const a=grams(value);
 for(const previous of recent.slice(-6)){
  const old=compact(previous);if(old.length<9)continue;
  if(value===old)return {repeat:true,reason:'与近期已发送回复重复'};
  const b=grams(old),intersection=[...a].filter(x=>b.has(x)).length;
  if(2*intersection/(a.size+b.size)>=0.8)return {repeat:true,reason:'与近期已发送回复过于相似'};
 }
 return {repeat:false};
}
