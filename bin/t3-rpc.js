import WebSocket from 'ws';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
const token=execFileSync(request.cli,['auth','session','issue','--base-dir',request.baseDir,'--ttl','5m','--token-only'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const url=new URL('/ws',request.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('orchestrationProtocol','2');
const ws=new WebSocket(url,{headers:{Authorization:`Bearer ${token}`}});
const timer=setTimeout(()=>{console.error('T3 command timed out; inspect target state before retrying');process.exit(1)},30000);
let index=0;const results=[];
function send(){ws.send(JSON.stringify({_tag:'Request',id:String(index),tag:'orchestration.dispatchCommand',payload:{commandId:randomUUID(),...request.commands[index]},headers:[]}))}
ws.on('open',send);
ws.on('message',raw=>{for(const msg of [JSON.parse(raw.toString())].flat()){
 if(msg._tag!=='Exit'||msg.requestId!==String(index))continue;
 if(msg.exit._tag!=='Success'){console.error(JSON.stringify(msg.exit));process.exit(1)}
 results.push(msg.exit.value);index++;
 if(index<request.commands.length)send();else{clearTimeout(timer);console.log(JSON.stringify(results));ws.close()}
}});
ws.on('error',e=>{console.error(e.message);process.exit(1)});
