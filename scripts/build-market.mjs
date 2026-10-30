import {readFile,mkdir,writeFile}from 'node:fs/promises';
import {fileURLToPath}from 'node:url';
import path from 'node:path';
import {createHash}from 'node:crypto';
import {zipSync,strToU8}from 'fflate';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'market-dist');
await mkdir(out,{recursive:true});const extensions=[];
for(const id of ['qq-help','qq-keyword']){
 const dir=path.join(root,'examples',id),manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
 const bytes=zipSync({'manifest.json':strToU8(JSON.stringify(manifest)),'rules.json':new Uint8Array(await readFile(path.join(dir,'rules.json')))},{level:6});
 const url=id+'-'+manifest.version+'.zip';await writeFile(path.join(out,url),bytes);
 extensions.push({...manifest,url,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await writeFile(path.join(out,'index.json'),JSON.stringify({schema:1,extensions},null,2));
console.log('Local market created:',path.join(out,'index.json'));
