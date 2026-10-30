import {parentPort,workerData} from 'node:worker_threads';
try{
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:new Uint8Array(workerData),isEvalSupported:false,disableFontFace:true,useSystemFonts:false,useWorkerFetch:false,verbosity:0,stopAtErrors:true});
 const doc=await task.promise;let text='';const pages=Math.min(doc.numPages,10);
 for(let n=1;n<=pages&&text.length<20000;n++){const page=await doc.getPage(n),content=await page.getTextContent();text+=content.items.map(x=>x.str||'').join(' ')+'\n';page.cleanup();}
 await task.destroy();parentPort.postMessage({text:text.slice(0,20000),pages,truncated:doc.numPages>pages||text.length>20000});
}catch(e){parentPort.postMessage({error:String(e.message||e).slice(0,180)});}
