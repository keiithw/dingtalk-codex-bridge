/** 按需运行的本机控制台；空闲关闭并只读取脱敏状态快照。 */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFile,execFileSync}=require('node:child_process');
const readline=require('node:readline');
const {createArchive}=require('./mention-archive.cjs');
const secret=crypto.randomBytes(32).toString('hex');
// 新安装使用用户数据目录；旧安装沿用原配置，避免影响已有桥接。
const legacyConfig=path.resolve(__dirname,'../../work/bridge-config.json');
const defaultConfig=path.join(process.env.LOCALAPPDATA||__dirname,'DingTalkCodexBridge','bridge-config.json');
const resolvedConfig=process.env.BRIDGE_CONFIG|| (fs.existsSync(legacyConfig)?legacyConfig:defaultConfig);
const statusFile=path.join(path.dirname(resolvedConfig),'bridge-monitor.json');
const newPrivateSessionPath=path.join(path.dirname(statusFile),'new-private-session.request');
const configFile=resolvedConfig;
const mentionArchive=createArchive(path.dirname(statusFile));
const modelSelectionPath=path.join(path.dirname(statusFile),'bridge-model.json');
const instanceFile=path.join(path.dirname(statusFile),'console-instance.json');
const page=fs.readFileSync(path.join(__dirname,'console.html'));
let lastAccess=Date.now();
// 按需查询 Codex 会话，只展示本桥接创建的记录，避免泄露桌面其他会话。
async function listBridgeThreads(mode='threads'){
  const cfg=JSON.parse(fs.readFileSync(configFile,'utf8'));
  const child=spawn(cfg.codexExe,['app-server'],{stdio:['pipe','pipe','ignore'],windowsHide:true});
  const pending=new Map();let id=0;
  const read=readline.createInterface({input:child.stdout});
  read.on('line',line=>{try{const msg=JSON.parse(line),entry=pending.get(msg.id);if(entry){pending.delete(msg.id);clearTimeout(entry.timer);msg.error?entry.reject(new Error('Codex 查询失败')):entry.resolve(msg.result)}}catch{}});
  child.on('error',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex 启动失败'))}pending.clear()});
  function rpc(method,params){return new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error('Codex 查询超时'))},15000);pending.set(n,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:n,method,params})+'\n')})}
  try{
    await rpc('initialize',{clientInfo:{name:'dingtalk_bridge_console',version:'0.1.0'}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    if(mode==='models'){
      let cursor=null;const models=[];let pages=0;
      do{const result=await rpc('model/list',{limit:100,cursor});for(const m of result.data||[]){if(!m.hidden)models.push({id:m.model||m.id,name:m.displayName||m.model||m.id,isDefault:!!m.isDefault,defaultEffort:m.defaultReasoningEffort,efforts:(m.supportedReasoningEfforts||[]).map(e=>({value:e.reasoningEffort,description:e.description}))})}cursor=result.nextCursor;pages++}while(cursor&&pages<10);
      let selected='',effort='';if(fs.existsSync(modelSelectionPath)){const saved=JSON.parse(fs.readFileSync(modelSelectionPath,'utf8'));if(typeof saved.model==='string')selected=saved.model;if(typeof saved.effort==='string')effort=saved.effort}
      return {models,selected,effort,truncated:!!cursor};
    }
    let cursor=null;const threads=[];let pages=0;
    do{const result=await rpc('thread/list',{cwd:cfg.cwd,sourceKinds:['vscode'],sortKey:'updated_at',limit:100,cursor});for(const t of result.data||[]){if(t.originator==='dingtalk_codex_bridge')threads.push({id:t.id,title:(t.name||t.preview||'未命名会话').slice(0,80),updatedAt:t.updatedAt})}cursor=result.nextCursor;pages++}while(cursor&&pages<10);
    return {threads,truncated:!!cursor};
  }finally{read.close();child.kill();}
}
const server=http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method==='GET' && req.url==='/'){lastAccess=Date.now();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return;}
  // 图标是固定本地资源，不暴露任意文件读取接口。
  if(req.method==='GET' && req.url==='/farm-logo.png'){res.setHeader('Content-Type','image/png');fs.createReadStream(path.join(__dirname,'farm-logo.png')).pipe(res);return;}
  // 仅提供预置的离线状态插图。
  if(req.method==='GET' && ['/bird-search.png','/farmer-sleep.png','/bird-settings.png'].includes(req.url)){res.setHeader('Content-Type','image/png');fs.createReadStream(path.join(__dirname,req.url.slice(1))).pipe(res);return;}
  // 同源 GET 通常不携带 Origin；写操作仍要求浏览器提供匹配的 Origin。
  const expectedOrigin=`http://127.0.0.1:${server.address().port}`;
  const originAllowed=req.headers.origin===expectedOrigin || (req.method==='GET' && !req.headers.origin);
  if(req.headers['x-console-token']!==secret || !originAllowed){res.writeHead(403);res.end();return;}
  lastAccess=Date.now();
  // 启动器通过一次短请求确认实例和随机令牌均匹配。
  if(req.method==='GET' && req.url==='/instance'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({kind:'dingtalk-bridge-console',pid:process.pid}));return;}
  // 仅返回非秘密配置；密码框留空表示沿用同一应用的已有密钥。
  if(req.method==='GET' && req.url==='/robot-config'){
    try{const c=JSON.parse(fs.readFileSync(configFile,'utf8'));res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({clientId:c.clientId||'',hasSecret:!!c.clientSecret}));}catch{res.writeHead(500);res.end();}return;
  }
  if(req.method==='POST' && ['/robot-test','/robot-config'].includes(req.url)){
    let raw='';req.on('data',part=>{raw+=part;if(raw.length>8192)req.destroy()});req.on('end',async()=>{
      try{
        const incoming=JSON.parse(raw),clientId=typeof incoming.clientId==='string'?incoming.clientId.trim():'',supplied=typeof incoming.clientSecret==='string'?incoming.clientSecret.trim():'';
        const original=fs.readFileSync(configFile,'utf8'),old=JSON.parse(original);
        if(!clientId||clientId.length>256||supplied.length>1024||(!supplied&&clientId!==old.clientId)||(!supplied&&!old.clientSecret))throw new Error('请填写有效的 Client ID 和对应的 Secret');
        const clientSecret=supplied||old.clientSecret;
        if(req.url==='/robot-test'){
          const response=await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appKey:clientId,appSecret:clientSecret}),signal:AbortSignal.timeout(15000)});
          const result=await response.json();
          if(!response.ok||!result.accessToken)throw new Error('钉钉未接受凭证，请检查 Client ID、Secret 和应用状态');
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:true,message:'凭证验证成功；Stream 接收能力仍需重启后实测。'}));return;
        }
        // 仅替换原 JSON 中两项字符串，保留文件原有 ACL 和其他设置。
        let updated=original;
        for(const [key,value] of [['clientId',clientId],['clientSecret',clientSecret]]){
          const pattern=new RegExp('(\\"'+key+'\\"\\s*:\\s*)(\\"(?:\\\\.|[^\\"\\\\])*\\")','g');let count=0;
          updated=updated.replace(pattern,(_,prefix)=>{count++;return prefix+JSON.stringify(value)});if(count!==1)throw new Error('配置格式不支持自动修改');
        }
        const next=JSON.parse(updated);if(next.clientId!==clientId||next.clientSecret!==clientSecret)throw new Error('配置校验失败');
        const fd=fs.openSync(configFile,'r+');try{fs.writeFileSync(fd,updated,{encoding:'utf8'});fs.ftruncateSync(fd,Buffer.byteLength(updated,'utf8'));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:true,changedRobot:clientId!==old.clientId,message:'已保存。请重启桥接以加载配置。'}));
      }catch(error){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:false,message:['AbortError','TimeoutError'].includes(error.name)?'连接钉钉超时，请检查网络':error.message?.startsWith('请填写')||error.message?.startsWith('钉钉未接受')||error.message?.startsWith('配置')?error.message:'操作失败，请检查本机配置和网络'}));}
    });return;
  }
  if(req.method==='GET' && req.url==='/status'){
    try{const data=JSON.parse(fs.readFileSync(statusFile,'utf8'));data.stale=Date.now()-Date.parse(data.updatedAt)>45000;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));}
    catch{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({stale:true,events:[]}));}return;
  }
  // 仅经本机令牌授权后返回归档及其被索引的图片。
  if(req.method==='GET' && req.url==='/mentions'){
    try{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({messages:mentionArchive.list(),directory:mentionArchive.dir}));}catch{res.writeHead(500);res.end();}return;
  }
  if(req.method==='GET' && req.url.startsWith('/mention-image/')){
    try{const image=mentionArchive.image(req.url.slice('/mention-image/'.length));if(!image){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':image.mime});fs.createReadStream(image.path).on('error',()=>res.destroy()).pipe(res);}catch{res.writeHead(500);res.end();}return;
  }
  if(req.method==='GET' && req.url==='/threads'){
    listBridgeThreads().then(data=>{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data))}).catch(()=>{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'历史会话读取失败'}))});return;
  }
  // 模型目录由本机 app-server 按需提供；目录本身不保证当前账号拥有调用权限。
  if(req.method==='GET' && req.url==='/models'){
    listBridgeThreads('models').then(data=>{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data))}).catch(()=>{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'模型列表读取失败'}))});return;
  }
  if(req.method==='POST' && req.url==='/model'){
    let raw='';req.on('data',part=>{raw+=part;if(raw.length>2048)req.destroy()});req.on('end',async()=>{try{const {model,effort=''}=JSON.parse(raw);if(typeof model!=='string'||model.length>200||typeof effort!=='string'||effort.length>40)throw Error();const catalog=await listBridgeThreads('models');const selected=catalog.models.find(m=>m.id===model);if(model&&!selected)throw Error();if(effort&&(!selected||!selected.efforts.some(e=>e.value===effort)))throw Error();const tmp=modelSelectionPath+'.tmp';fs.writeFileSync(tmp,JSON.stringify({model,effort}),'utf8');fs.renameSync(tmp,modelSelectionPath);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}))}catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false}))}});return;
  }
  // 换号后排队新建私聊并重启进程；正在运行的任务不被中断。
  if(req.method==='POST' && req.url==='/refresh-account'){
    try{const status=JSON.parse(fs.readFileSync(statusFile,'utf8'));if(status.active>0){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'有任务正在处理，请完成后再刷新账号。'}));return;}
      fs.writeFileSync(newPrivateSessionPath,'requested\n',{encoding:'utf8',flag:'w'});
      const executable=path.join(process.env.SystemRoot,'System32','schtasks.exe');
      execFile(executable,['/end','/tn','\\CodexDingTalkBridge'],()=>execFile(executable,['/run','/tn','\\CodexDingTalkBridge'],error=>{res.writeHead(error?500:202,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:!error,message:error?'启动失败，请检查计划任务；新会话请求已保留。':'已请求重启，下一条私聊将开启新会话。'}))}));
    }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'读取桥接状态失败，请检查桥接配置。'}));}return;
  }
  if(req.method==='POST' && req.url==='/restart'){
    const executable=path.join(process.env.SystemRoot,'System32','schtasks.exe');
    execFile(executable,['/end','/tn','\\CodexDingTalkBridge'],()=>execFile(executable,['/run','/tn','\\CodexDingTalkBridge'],(error)=>{res.writeHead(error?500:202,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:!error}));}));return;
  }
  // 只投递私聊会话切换请求；由桥接进程按消息队列处理，避免并发覆盖会话状态。
  if(req.method==='POST' && req.url==='/new-private-session'){
    try{fs.writeFileSync(newPrivateSessionPath,'requested\n',{encoding:'utf8',flag:'w'});res.writeHead(202,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}));}
    catch{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false}));}return;
  }
  if(req.method==='POST' && req.url==='/switch-private-session'){
    let raw='';req.on('data',part=>{raw+=part;if(raw.length>2048)req.destroy()});req.on('end',async()=>{try{const {threadId}=JSON.parse(raw);if(typeof threadId!=='string'||threadId.length>100)throw Error();const found=await listBridgeThreads();if(!found.threads.some(t=>t.id===threadId))throw Error();fs.writeFileSync(newPrivateSessionPath,JSON.stringify({threadId}),'utf8');res.writeHead(202,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}))}catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false}))}});return;
  }
  res.writeHead(404);res.end();
});
// 在当前 Windows 用户私有的实例文件中发布地址和令牌，启动器先校验再复用。
function openPage(port,token){spawn('rundll32.exe',['url.dll,FileProtocolHandler',`http://127.0.0.1:${port}/#${token}`],{detached:true,stdio:'ignore',windowsHide:true}).unref();}
function alive(pid){try{process.kill(pid,0);return true}catch(e){return e.code==='EPERM'}}
async function existingInstance(){
  try{const info=JSON.parse(fs.readFileSync(instanceFile,'utf8'));if(!Number.isInteger(info.port)||info.port<1||info.port>65535||!Number.isInteger(info.pid)||!/^([a-f0-9]{64})$/.test(info.token))return null;
    const response=await fetch(`http://127.0.0.1:${info.port}/instance`,{headers:{'X-Console-Token':info.token},signal:AbortSignal.timeout(1500)});if(!response.ok)return null;const body=await response.json();return body.kind==='dingtalk-bridge-console'&&body.pid===info.pid?info:null;
  }catch{return null}
}
async function launch(){
  for(let attempt=0;attempt<30;attempt++){
    let fd;
    try{fd=fs.openSync(instanceFile,'wx');}
    catch(e){if(e.code!=='EEXIST')throw e;const existing=await existingInstance();if(existing){openPage(existing.port,existing.token);return;}
      // 只有确认发布者已退出且实例文件稳定过期，才清理残留文件。
      try{const stat=fs.statSync(instanceFile);let info;try{info=JSON.parse(fs.readFileSync(instanceFile,'utf8'))}catch{}if(Date.now()-stat.mtimeMs>10000 && (!info?.pid||!alive(info.pid)))fs.unlinkSync(instanceFile);}catch{}
      await new Promise(resolve=>setTimeout(resolve,200));continue;
    }
    try{
      if(process.platform==='win32'){
        const account=process.env.USERDOMAIN+'\\'+process.env.USERNAME;
        execFileSync(path.join(process.env.SystemRoot,'System32','icacls.exe'),[instanceFile,'/inheritance:r','/grant:r',account+':(F)'],{stdio:'ignore',windowsHide:true});
      }
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
      fs.writeFileSync(fd,JSON.stringify({pid:process.pid,port:server.address().port,token:secret}),'utf8');fs.closeSync(fd);fd=undefined;
      const clean=()=>{try{const info=JSON.parse(fs.readFileSync(instanceFile,'utf8'));if(info.pid===process.pid&&info.token===secret)fs.unlinkSync(instanceFile)}catch{}};
      server.on('close',clean);process.on('exit',clean);
      openPage(server.address().port,secret);
      setInterval(()=>{if(Date.now()-lastAccess>10*60*1000)server.close(()=>process.exit(0));},60000).unref();return;
    }catch(error){if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(instanceFile)}catch{}server.close();throw error}
  }
  throw new Error('已有控制台实例正在启动或无响应，请稍后重试。');
}
launch().catch(()=>{console.error('控制台启动失败，请检查本地实例状态和文件权限。');process.exitCode=1});
