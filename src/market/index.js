import { readFile, mkdir, writeFile, rename, rm, stat,readdir } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import path from 'node:path';
import { zipSync,unzipSync,strToU8 } from 'fflate';
import { validateManifest,validateConfig,validateRules,contentHash } from '../extensions/index.js';
import {safeDownload} from '../core/media.js';
import {packagesFor,migrateConfig} from '../core/package-model.js';
const packageSnapshot=item=>{const {history,...snapshot}=structuredClone(item);return snapshot;};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const maxBytes=8*1024*1024;
export function unpack(bytes) {
  let size=0,count=0;
  const files=unzipSync(bytes,{filter:entry=>{
    size+=entry.originalSize;count++;
    if(count>64||size>maxBytes)throw new Error('扩展解压后体积或文件数超限');
    const name=entry.name;
    if(!name||name.includes('\\')||name.startsWith('/')||name.includes(':')||name.split('/').some(p=>p==='..'||p==='.')||name.includes('\0'))throw new Error('扩展压缩包含不安全路径');
    return true;
  }});
  if(!files['manifest.json']||!files['rules.json'])throw new Error('声明式插件缺少 manifest.json 或 rules.json');
  if(Object.keys(files).some(name=>!['manifest.json','rules.json'].includes(name)))throw new Error('声明式插件包只能包含 manifest.json 和 rules.json');
  const manifest=validateManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(files['manifest.json'])));
  validateRules(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(files['rules.json'])),manifest);
  return {files,manifest};
}
export class Market {
  constructor(store,extensions,examples,log){this.store=store;this.extensions=extensions;this.examples=examples;this.log=log;this.builtin=new Map();this.catalogCache=[];}
  async start(){
    for(const id of ['qq-help','qq-keyword']){
      const dir=path.join(this.examples,id);
      const manifest=validateManifest(JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8')));
      const bytes=zipSync({'manifest.json':strToU8(JSON.stringify(manifest)),'rules.json':new Uint8Array(await readFile(path.join(dir,'rules.json')))},{level:6});
      this.builtin.set(id,{...manifest,sha256:sha(bytes),bytes,source:'builtin',url:'builtin:'+id});
    }
  }
  async catalog(){
    const result=[...this.builtin.values()].map(({bytes,...item})=>item);const errors=[];
    for(const source of this.store.data.sources){
      try {
        const local=source.kind==='local';let bytes;
        if(local){if(!path.isAbsolute(source.location))throw new Error('本地市场索引必须是绝对路径');if((await stat(source.location)).size>1024*1024)throw new Error('市场索引过大');bytes=await readFile(source.location);}
        else bytes=await safeDownload(source.location,{maxBytes:1024*1024,signal:AbortSignal.timeout(20000)});
        const index=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
        if(index.schema!==1||!Array.isArray(index.extensions)||index.extensions.length>300)throw new Error('市场索引格式无效');
        for(const entry of index.extensions) {
          validateManifest(entry);
          if(!/^[a-f0-9]{64}$/i.test(entry.sha256))throw new Error('扩展缺少 SHA-256');
          if(local){
            if(typeof entry.url!=='string'||path.isAbsolute(entry.url)||entry.url.includes('\\')||entry.url.split('/').includes('..')||!entry.url.endsWith('.zip'))throw new Error('本地扩展路径须位于索引同目录');
          }else{const u=new URL(entry.url,source.location);if(u.protocol!=='https:'||u.username||u.password)throw new Error('扩展下载地址必须为 HTTPS');}
          result.push({...entry,url:local?path.resolve(path.dirname(source.location),entry.url):new URL(entry.url,source.location).href,source:source.id});
        }
      }catch(e){errors.push({source:source.id,error:e.message});}
    }
    this.catalogCache=result;
    return {items:result,errors};
  }
  async install(source,id,version) {
    const catalog=await this.catalog();const entry=catalog.items.find(e=>e.source===source&&e.id===id&&e.version===version);
    if(!entry)throw new Error('市场条目不存在或版本已变更，请刷新');
    let bytes;
    if(source==='builtin')bytes=this.builtin.get(id).bytes;
    else {const s=this.store.data.sources.find(s=>s.id===source);
      if(s.kind==='local'){if((await stat(entry.url)).size>maxBytes)throw new Error('扩展包过大');bytes=await readFile(entry.url);}
      else bytes=await safeDownload(entry.url,{maxBytes,signal:AbortSignal.timeout(20000)});
    }
    if(sha(bytes)!==entry.sha256.toLowerCase())throw new Error('扩展 SHA-256 不匹配，已中止安装');
    const parsed=unpack(bytes);
    if(parsed.manifest.id!==id||parsed.manifest.version!==version)throw new Error('扩展内容与市场条目不匹配');
    return this.commit(parsed,entry);
  }
  async commit({files,manifest},entry) {
    validateManifest(manifest);validateRules(JSON.parse(Buffer.from(files['rules.json']).toString('utf8')),manifest);
    if(Object.keys(files).some(n=>!['manifest.json','rules.json'].includes(n)))throw new Error('声明式插件包包含不允许的文件');
    const id=manifest.id,old=this.store.data.extensions[id]&&structuredClone(this.store.data.extensions[id]),integrity=contentHash(files);
    const packages=packagesFor(this.store);packages.assert(manifest,{candidate:true});packages.protect(id,manifest.version);
    if(old?.manifest.version===manifest.version&&old.integrity){if(old.integrity!==integrity)throw new Error('同一版本内容发生变化，请提升插件版本');if(old.uninstalled)return this.restore(id);return old;}
    const config=old?.manifest.hostApiVersion===2?migrateConfig(old,manifest):validateConfig(manifest,old?.config||{});
    const root=path.resolve(this.store.dir,'extensions'),dest=path.resolve(root,id);
    if(path.dirname(dest)!==root)throw new Error('扩展目录越界');
    const generation=randomUUID(),stage=path.join(root,'.stage-'+generation),versionDir=path.join(dest,generation);
    if(path.dirname(path.resolve(stage))!==root)throw new Error('暂存目录越界');
    await mkdir(stage,{recursive:true});let installed=false;
    try{
      for(const [name,bytes]of Object.entries(files))await writeFile(path.join(stage,name),bytes);
      await this.extensions.unload(id);await mkdir(dest,{recursive:true});await rename(stage,versionDir);installed=true;
      const snapshot=old&&old.manifest.hostApiVersion===2?packageSnapshot(old):null;
      const history=[...snapshot?[snapshot]:[],...(old?.history||[])].slice(0,3);
      this.store.data.extensions[id]={manifest,enabled:false,config,configVersion:manifest.configVersion??1,
        scope:old?.scope||{private:true,users:[...this.store.data.settings.allowedUsers],groups:[...this.store.data.framework.listenGroups]},
        source:entry.source,sha256:entry.sha256,integrity,generation,runtimeDir:generation,installedAt:new Date().toISOString(),error:null,history,settingsHistory:old?.settingsHistory||[]};
      await this.store.persist();this.log('info','插件已安装：'+manifest.name+' '+manifest.version+'；请确认设置后启用');
      await this.prune(id);
    }catch(e){
      await this.extensions.unload(id);
      if(old){this.store.data.extensions[id]=old;if(old.enabled)try{await this.extensions.load(id);}catch{}}
      else delete this.store.data.extensions[id];
      if(installed)await this.removeGeneration(dest,generation);
      await this.store.persist();throw e;
    }finally{await rm(stage,{recursive:true,force:true});}
    return this.store.data.extensions[id];
  }
  async removeGeneration(root,generation){
    if(!/^[a-f0-9-]{36}$/.test(generation))return;
    const base=path.resolve(root),target=path.resolve(base,generation);
    if(path.dirname(target)!==base||target===base)throw new Error('版本清理目录越界');
    await rm(target,{recursive:true,force:true});
  }
  async prune(id){
    const item=this.store.data.extensions[id],root=path.resolve(this.store.dir,'extensions',id),keep=new Set([item.runtimeDir,...(item.history||[]).map(p=>p.runtimeDir)]);
    for(const entry of await readdir(root,{withFileTypes:true}))if(entry.isDirectory()&&!keep.has(entry.name))await this.removeGeneration(root,entry.name);
  }
  async rollback(id,generation){
    const item=this.store.data.extensions[id];if(!item||item.uninstalled)throw new Error('插件不存在或已卸载，请先重新安装');
    const old=structuredClone(item),target=item.history?.find(p=>p.generation===generation);if(!target)throw new Error('没有该历史版本');
    validateManifest(target.manifest);packagesFor(this.store).assert(target.manifest,{candidate:true});packagesFor(this.store).protect(id,target.manifest.version);
    const dir=path.resolve(this.store.dir,'extensions',id,target.runtimeDir);
    if(!/^[a-f0-9-]{36}$/.test(target.runtimeDir))throw new Error('历史版本目录无效');
    const files={'manifest.json':await readFile(path.join(dir,'manifest.json')),'rules.json':await readFile(path.join(dir,'rules.json'))};
    const integrity=contentHash(files);if(target.integrity&&integrity!==target.integrity)throw new Error('历史版本文件完整性校验失败');
    validateRules(JSON.parse(files['rules.json'].toString('utf8')),target.manifest);
    const config=validateConfig(target.manifest,target.config);
    await this.extensions.unload(id);
    this.store.data.extensions[id]={...structuredClone(target),config,integrity,enabled:false,error:null,
      history:[packageSnapshot(item),...(item.history||[]).filter(p=>p.generation!==generation)].slice(0,3),rolledBackAt:new Date().toISOString()};
    try{await this.store.persist();await this.prune(id);}
    catch(e){this.store.data.extensions[id]=old;if(old.enabled)await this.extensions.load(id);await this.store.persist();throw e;}
    return this.store.data.extensions[id];
  }
  async restore(id){
    const item=this.store.data.extensions[id];validateManifest(item?.manifest);if(!item.uninstalled)throw Error('此包未卸载');packagesFor(this.store).assert(item.manifest,{candidate:true});
    if(!/^[a-f0-9-]{36}$/.test(item.runtimeDir||''))throw Error('本地安装目录无效，请重新下载安装');
    const root=path.resolve(this.store.dir,'extensions',id),dir=path.resolve(root,item.runtimeDir);if(path.dirname(dir)!==root)throw Error('安装目录越界');
    const files={'manifest.json':await readFile(path.join(dir,'manifest.json')),'rules.json':await readFile(path.join(dir,'rules.json'))};
    if(item.integrity&&contentHash(files)!==item.integrity)throw Error('保留的插件文件完整性校验失败');
    const manifest=validateManifest(JSON.parse(files['manifest.json']));if(manifest.id!==id||manifest.version!==item.manifest.version)throw Error('保留文件与登记版本不一致');validateRules(JSON.parse(files['rules.json']),manifest);
    item.uninstalled=false;item.enabled=false;item.error=item.configDeleted?'配置已删除，请检查并保存新设置。':null;await this.store.persist();return item;
  }
  async remove(id){
    const item=this.store.data.extensions[id];validateManifest(item?.manifest);packagesFor(this.store).protect(id);await this.extensions.unload(id);item.enabled=false;item.uninstalled=true;await this.store.persist();
  }
}
