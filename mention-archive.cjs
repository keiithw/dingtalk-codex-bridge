/** 已登记群中 @机器人的本地归档；仅保留最近 100 条，不保存回调凭证或下载地址。 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const names={ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' };
function createArchive(base){
  const dir=path.join(base,'robot-mentions'),index=path.join(dir,'index.json');
  // 归档含群消息原文与图片，创建时限制为当前 Windows 用户。
  function ensure(){if(!fs.existsSync(dir)){fs.mkdirSync(dir,{recursive:false,mode:0o700});if(process.platform==='win32'){try{const account=process.env.USERDOMAIN+'\\'+process.env.USERNAME;execFileSync(path.join(process.env.SystemRoot,'System32','icacls.exe'),[dir,'/inheritance:r','/grant:r',account+':(OI)(CI)F'],{stdio:'ignore',windowsHide:true})}catch{try{fs.rmdirSync(dir)}catch{}throw new Error('无法限制归档目录访问权限')}}}}
  function list(){if(!fs.existsSync(index))return [];const rows=JSON.parse(fs.readFileSync(index,'utf8'));if(!Array.isArray(rows))throw new Error('归档索引格式错误');return rows;}
  async function append(message,group,loadImage){
    ensure();const id=crypto.createHash('sha256').update(String(message.msgId||'')).digest('hex');if(!message.msgId)throw new Error('消息缺少 ID');
    const previous=list();if(previous.some(x=>x.id===id))return;
    const kind=message.msgtype||message.msgType||'unknown',parts=Array.isArray(message.content?.richText)?message.content.richText:[];
    const text=kind==='richText'?parts.map(x=>typeof x.text==='string'?x.text:(x.type==='picture'?'[图片]':'')).join(''):typeof message.text?.content==='string'?message.text.content:'';
    const codes=kind==='picture'?[message.content?.downloadCode]:kind==='richText'?parts.filter(x=>x.type==='picture').map(x=>x.downloadCode||x.pictureDownloadCode):[];
    const item={id,group:group.name,sender:typeof message.senderNick==='string'?message.senderNick:'未知发送者',receivedAt:new Date().toISOString(),messageType:kind,text,images:[],imageErrors:[]};
    // 图片下载失败仍保留正文和失败标记；不记录临时下载链接。
    for(const [i,code] of codes.entries()){
      if(i>=5){item.imageErrors.push('超过单条 5 张的处理上限');break;}
      try{if(!code)throw new Error('图片下载码缺失');const image=await loadImage(code,message.robotCode);const match=/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image.url);if(!match)throw new Error('图片格式不支持');const file=id+'-'+i+'.'+names[match[1]];fs.writeFileSync(path.join(dir,file),Buffer.from(match[2],'base64'));item.images.push({file,mime:match[1]});}
      catch{item.imageErrors.push('第 '+(i+1)+' 张图片未能保存');}
    }
    const all=[item,...previous],kept=all.slice(0,100),removed=all.slice(100),temp=index+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(kept,null,2),'utf8');fs.renameSync(temp,index);
    // 仅清理被淘汰记录引用且名称符合本程序生成规则的图片。
    for(const record of removed)for(const image of record.images||[]){if(/^[a-f0-9]{64}-[0-4]\.(jpg|png|webp|gif)$/.test(image.file)){try{fs.unlinkSync(path.join(dir,image.file))}catch{}}}
  }
  function image(file){if(!/^[a-f0-9]{64}-[0-4]\.(jpg|png|webp|gif)$/.test(file))return null;const record=list().flatMap(x=>x.images||[]).find(x=>x.file===file);return record?{path:path.join(dir,file),mime:record.mime}:null;}
  return {dir,ensure,list,append,image};
}
module.exports={createArchive};
