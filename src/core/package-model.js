export const FRAMEWORK_VERSION='0.13.0';
const keyPattern=/^[a-zA-Z]\w{0,40}$/;
const safeKey=k=>keyPattern.test(k)&&!['__proto__','constructor','prototype'].includes(k);
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
export function versionTuple(v){if(!/^\d+\.\d+\.\d+$/.test(String(v)))throw new Error('版本须为 x.y.z');const parts=v.split('.').map(Number);if(parts.some(n=>!Number.isSafeInteger(n)||n>1000000))throw new Error('版本范围无效');return parts;}
export function compareVersions(a,b){const x=versionTuple(a),y=versionTuple(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);return 0;}
export function satisfies(version,range){
 try{
  versionTuple(version);if(range==='*')return true;
  const m=/^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(range);if(!m)return false;
  const op=m[1]||'=',base=m[2],cmp=compareVersions(version,base),t=versionTuple(base);
  if(op==='=')return cmp===0;if(op==='>=')return cmp>=0;if(op==='<=')return cmp<=0;if(op==='>')return cmp>0;if(op==='<')return cmp<0;
  const upper=op==='~'?[t[0],t[1]+1,0]:t[0]>0?[t[0]+1,0,0]:t[1]>0?[0,t[1]+1,0]:[0,0,t[2]+1];
  return cmp>=0&&compareVersions(version,upper.join('.'))<0;
 }catch{return false;}
}
export function dependencies(value={}){
 if(!plain(value)||Object.keys(value).length>20)throw new Error('依赖声明须为对象，最多 20 项');
 const result={};for(const [id,range]of Object.entries(value)){
  if(!/^(framework|ai-chat|persona|welcome|market|qq-[a-z0-9][a-z0-9-]{0,55})$/.test(id)||typeof range!=='string'||range!=='*'&&!/^(\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+$/.test(range))throw new Error('依赖 ID 或版本范围无效');
  result[id]=range;
 }return result;
}
export function validateSchema(schema={}){
 if(!plain(schema)||Object.keys(schema).length>40)throw new Error('设置字段格式无效，最多 40 项');
 for(const [key,f]of Object.entries(schema)){
  if(!safeKey(key)||!plain(f)||!['string','boolean','number','string[]'].includes(f.type))throw new Error('插件配置 Schema 无效');
  for(const [label,max]of [['title',80],['description',500]])if(f[label]!=null&&(typeof f[label]!=='string'||f[label].length>max))throw new Error('设置字段说明无效');
  for(const flag of ['integer','required','multiline'])if(f[flag]!=null&&typeof f[flag]!=='boolean')throw new Error('设置字段标记无效');
  if(f.format!=null&&(f.type!=='string[]'||f.format!=='qq'))throw new Error('设置列表格式无效');
  if(f.enum&&(f.type!=='string'||!Array.isArray(f.enum)||f.enum.length>30||f.enum.some(v=>typeof v!=='string')))throw new Error('枚举选项无效');
  for(const n of ['min','max','maxLength','maxItems'])if(f[n]!=null&&(!Number.isFinite(f[n])||n!=='min'&&n!=='max'&&f[n]<0))throw new Error('设置边界无效');
  if(f.min!=null&&f.max!=null&&f.min>f.max)throw new Error('设置边界无效');
 }return schema;
}
export function validateConfig(manifest,input={}){
 if(!plain(input))throw new Error('插件设置须为对象');
 const result={};for(const [key,f]of Object.entries(validateSchema(manifest.configSchema||{}))){
  const value=input[key]??f.default;
  if(value===undefined){if(f.required)throw new Error('缺少设置：'+(f.title||key));continue;}
  if(f.type==='string'){
   if(typeof value!=='string'||value.length>Math.min(f.maxLength??20000,20000)||f.required&&!value.trim()||f.enum&&!f.enum.includes(value))throw new Error('文字设置无效：'+(f.title||key));
  }else if(f.type==='boolean'){if(typeof value!=='boolean')throw new Error('布尔设置无效：'+(f.title||key));}
  else if(f.type==='number'){
   if(typeof value!=='number'||!Number.isFinite(value)||f.integer&&!Number.isInteger(value)||f.min!=null&&value<f.min||f.max!=null&&value>f.max)throw new Error('数值设置无效：'+(f.title||key));
  }else{
   if(!Array.isArray(value)||value.length>Math.min(f.maxItems??100,100)||value.some(v=>typeof v!=='string'||v.length>200||f.format==='qq'&&!/^[1-9]\d{3,15}$/.test(v)))throw new Error('列表设置无效：'+(f.title||key));
  }
  result[key]=structuredClone(value);
 }return result;
}
export const PACKAGE_API_VERSION=2;
const PACKAGE_TYPES=new Set(['native-source','declarative','builtin','market']);
export function validatePackageMetadata(m){
 if(typeof m.name!=='string'||!m.name.trim()||m.name.length>80||m.description!=null&&(typeof m.description!=='string'||m.description.length>2000))throw new Error('插件名称或说明无效');
 if(m.apiVersion!=null&&m.apiVersion!==PACKAGE_API_VERSION)throw new Error('插件 apiVersion 必须是 2');
 if(m.type!=null&&!PACKAGE_TYPES.has(m.type))throw new Error('插件 type 无效');
 if(m.entry!=null&&(typeof m.entry!=='string'||!m.entry||m.entry.length>200||m.entry.includes('..')||m.entry.startsWith('/')||m.entry.startsWith('\\')))throw new Error('插件 entry 必须是包内相对路径');
 if(m.permissions!=null&&(!Array.isArray(m.permissions)||m.permissions.length>20||m.permissions.some(p=>typeof p!=='string'||!/^[a-z][a-z0-9.-]{0,40}$/.test(p))))throw new Error('插件 permissions 无效');
 versionTuple(m.version);
 dependencies(m.dependencies);
 const v=m.configVersion??1;if(!Number.isInteger(v)||v<1||v>100)throw new Error('configVersion 须为 1–100');
 validateSchema(m.configSchema||{});
 if(m.storagePolicy){
  const p=m.storagePolicy;
  if(!plain(p)||![p.collection,p.timestamp,p.daysField,p.limitField,...p.group?[p.group]:[]].every(safeKey)||m.configSchema?.[p.daysField]?.type!=='number'||m.configSchema?.[p.limitField]?.type!=='number')throw new Error('存储保留策略无效');
 }
 if(m.settings){
  if(!plain(m.settings)||typeof m.settings.title!=='string'||m.settings.title.length>60)throw new Error('设置页标题无效');
  if(m.settings.description!=null&&(typeof m.settings.description!=='string'||m.settings.description.length>1000))throw new Error('设置页说明无效');
  const sections=m.settings.sections||[];
  if(!Array.isArray(sections)||sections.length>10)throw new Error('设置页分组无效');
  for(const s of sections)if(!plain(s)||typeof s.title!=='string'||s.title.length>80||!Array.isArray(s.fields)||s.fields.length>40||s.fields.some(k=>!Object.hasOwn(m.configSchema||{},k)))throw new Error('设置页引用了未声明字段');
 }
 if(m.configMigrations){
  if(!Array.isArray(m.configMigrations)||m.configMigrations.length>99||new Set(m.configMigrations.map(s=>s.to)).size!==m.configMigrations.length)throw new Error('配置迁移格式无效');
  for(const step of m.configMigrations){
   if(!plain(step)||!Number.isInteger(step.to)||step.to<2||step.to>v)throw new Error('配置迁移目标无效');
   if(step.rename!=null&&!plain(step.rename)||step.defaults!=null&&!plain(step.defaults)||step.remove!=null&&(!Array.isArray(step.remove)||step.remove.length>40))throw new Error('配置迁移字段格式无效');
   for(const [a,b]of Object.entries(step.rename||{}))if(!safeKey(a)||!safeKey(b))throw new Error('配置迁移字段无效');
   for(const k of [...Object.keys(step.defaults||{}),...(step.remove||[])])if(!safeKey(k))throw new Error('配置迁移字段无效');
  }
 }return m;
}
export function migrateConfig(old,next){
 validatePackageMetadata(next);if(!old)return validateConfig(next,{});
 const from=old.configVersion??old.manifest.configVersion??1,to=next.configVersion??1;let config=structuredClone(old.config||{});
 if(from>to)throw new Error('配置版本不可隐式降级，请使用版本回滚');
 if(from===to)for(const [key,f]of Object.entries(old.manifest.configSchema||{}))if(!Object.hasOwn(next.configSchema||{},key)||next.configSchema[key].type!==f.type)throw new Error('删除字段或修改类型需要提升 configVersion 并声明迁移');
 for(let v=from+1;v<=to;v++){
  const step=(next.configMigrations||[]).find(x=>x.to===v);if(!step)throw new Error('缺少迁移步骤：'+(v-1)+' → '+v);
  for(const [a,b]of Object.entries(step.rename||{}))if(Object.hasOwn(config,a)){if(Object.hasOwn(config,b)&&a!==b)throw new Error('迁移字段冲突：'+b);config[b]=config[a];if(a!==b)delete config[a];}
  for(const [key,value]of Object.entries(step.defaults||{}))if(config[key]===undefined)config[key]=structuredClone(value);
  for(const key of step.remove||[])delete config[key];
 }
 return validateConfig(next,config);
}
export function rememberSettings(item){
 return [{at:new Date().toISOString(),packageVersion:item.manifest.version,configVersion:item.configVersion??item.manifest.configVersion??1,config:structuredClone(item.config||{}),scope:structuredClone(item.scope),automationGrants:[...(item.automationGrants||[])]},...(item.settingsHistory||[])].slice(0,5);
}
export class Packages {
 constructor(store){this.store=store;}
 records(){
  const f=this.store.data.framework,result=new Map([['framework',{version:FRAMEWORK_VERSION,enabled:true,installed:true}]]);
  for(const [id,p]of Object.entries(f.builtins))result.set(id,{version:'1.0.0',enabled:p.enabled&&!p.uninstalled,installed:!p.uninstalled,manifest:{dependencies:{}}});
  for(const [id,p]of Object.entries(this.store.data.extensions))result.set(id,{version:p.manifest.version,enabled:p.enabled&&!p.uninstalled,installed:!p.uninstalled,manifest:p.manifest});
  for(const [id,p]of Object.entries(f.nativePackages||{}))result.set(id,{version:p.manifest.version,enabled:p.enabled&&!p.uninstalled&&!p.health?.quarantined,installed:p.registered===true&&!p.uninstalled,manifest:p.manifest});
  return result;
 }
 problems(manifest,{enabled=false,candidate}={}){
  const all=this.records();if(candidate)all.set(manifest.id,{version:manifest.version,enabled:true,installed:true,manifest});
  const errors=[];for(const [id,range]of Object.entries(dependencies(manifest.dependencies))){
   const p=all.get(id);if(!p?.installed)errors.push('缺少依赖 '+id+' '+range);
   else if(!satisfies(p.version,range))errors.push('依赖版本不兼容：'+id+' 需要 '+range+'，当前 '+p.version);
   else if(enabled&&!p.enabled)errors.push('请先启用依赖 '+id);
  }
  const seen=new Set(),visiting=new Set();
  const walk=id=>{if(visiting.has(id)){errors.push('存在循环依赖：'+id);return;}if(seen.has(id))return;visiting.add(id);for(const [d,range]of Object.entries(all.get(id)?.manifest?.dependencies||{})){const p=all.get(d);if(!p?.installed)errors.push('缺少依赖 '+d+' '+range);else if(!satisfies(p.version,range))errors.push('依赖版本不兼容：'+d+' 需要 '+range);else if(enabled&&!p.enabled)errors.push('请先启用依赖 '+d);if(d!=='framework'&&p?.installed)walk(d);}visiting.delete(id);seen.add(id);};
  all.set(manifest.id,{...(all.get(manifest.id)||{}),manifest});walk(manifest.id);
  return [...new Set(errors)];
 }
 assert(manifest,options){const errors=this.problems(manifest,options);if(errors.length)throw new Error(errors.join('；'));}
 protect(id,nextVersion){
  const users=[];for(const [other,p]of this.records())if(other!==id&&p.enabled&&p.manifest?.dependencies?.[id]&&(!nextVersion||!satisfies(nextVersion,p.manifest.dependencies[id])))users.push(other);
  if(users.length)throw new Error('请先停用依赖此包的插件：'+users.join('、'));
 }
}
export const packagesFor=store=>store.packages||(store.packages=new Packages(store));
