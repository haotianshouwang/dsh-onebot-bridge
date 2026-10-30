const qq=/^[1-9]\d{3,15}$/;
export function ownerIds(f={}){return [...new Set([f.ownerQQ,...(Array.isArray(f.ownerQQs)?f.ownerQQs:[])].filter(v=>typeof v==='string'&&qq.test(v)))];}
export function isOwner(f,user){return typeof user==='string'&&ownerIds(f).includes(user);}
export function validateOwners(input){if(!qq.test(String(input.ownerQQ||'')))throw Error('请填写有效的主要主人 QQ 号');const extra=input.ownerQQs===undefined?[]:input.ownerQQs;if(!Array.isArray(extra)||extra.length>20||extra.some(v=>typeof v!=='string'||!qq.test(v)))throw Error('主人列表须为最多 20 个有效 QQ 号');const ownerQQ=String(input.ownerQQ),ownerQQs=[...new Set([ownerQQ,...extra])];if(ownerQQs.length>20)throw Error('最多设置 20 位主人');return {ownerQQ,ownerQQs};}
