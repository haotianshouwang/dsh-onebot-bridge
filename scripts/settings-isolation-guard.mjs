// Test-only outbound TCP guard: permit IPC and the three preview endpoints, never a real adapter.
import net from 'node:net';
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const raw=Array.isArray(args[0])?args[0]:args;
  const o=typeof raw[0]==='object'?raw[0]:{port:raw[0],host:typeof raw[1]==='string'?raw[1]:'localhost'};
  if(o.port!=null && (!['localhost','127.0.0.1','::1','::ffff:127.0.0.1'].includes(o.host||'localhost') || !['43880','43897','43898'].includes(String(o.port)))) {
    const error=Object.assign(new Error('隔离预览禁止连接该地址'),{code:'EACCES'});process.nextTick(()=>this.destroy(error));return this;
  }
  return connect.apply(this,args);
};
