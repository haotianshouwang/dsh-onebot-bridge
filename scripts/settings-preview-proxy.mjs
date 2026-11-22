// Verification only. Temporary self-signed certificate, loopback bind, no access log.
import https from 'node:https';
import http from 'node:http';
import {readFile, unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
export async function previewProxy(root,ports){
  const key=path.join(root,'test-key.pem'), cert=path.join(root,'test-cert.pem');
  const program=process.env.OPENSSL_BIN || 'openssl';
  const run=spawnSync(program,['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{windowsHide:true,stdio:'ignore'});
  if(run.status!==0)throw Error('无法生成临时证书，请设置 OPENSSL_BIN');
  const tls={key:await readFile(key),cert:await readFile(cert)};await Promise.all([unlink(key),unlink(cert)]);
  const host=`127.0.0.1:${ports.tls}`;
  const server=https.createServer(tls,(req,res)=>{
    if(req.headers.host!==host){res.writeHead(403).end();return;}
    const headers={host,'x-forwarded-proto':'https'};
    for(const name of ['cookie','content-type','content-length','user-agent','origin','x-csrf-token','range']) if(req.headers[name])headers[name]=req.headers[name];
    const proxy=http.request({hostname:'127.0.0.1',port:ports.admin,path:req.url,method:req.method,headers},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);});
    proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(proxy);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(ports.tls,'127.0.0.1',resolve);});
  return ()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
}