// 把仓库根目录的网页资源拷进 www/，避免两份代码各改各的
const fs=require('fs'),path=require('path');
const SRC=path.resolve(__dirname,'..'), DST=path.join(__dirname,'www');
const FILES=['index.html','pd-backup.js','pp-backup.js','sw.js','manifest.webmanifest','icon.svg','control-cards.pdf'];
const DIRS=['vendor'];
fs.rmSync(DST,{recursive:true,force:true});
fs.mkdirSync(DST,{recursive:true});
for(const f of FILES){
  const s=path.join(SRC,f);
  if(fs.existsSync(s)){fs.copyFileSync(s,path.join(DST,f));console.log('  +',f)}
}
for(const d of DIRS){
  const s=path.join(SRC,d);
  if(!fs.existsSync(s))continue;
  fs.mkdirSync(path.join(DST,d),{recursive:true});
  for(const f of fs.readdirSync(s)){fs.copyFileSync(path.join(s,f),path.join(DST,d,f));console.log('  +',d+'/'+f)}
}
// APK 里不需要 Service Worker（原生壳本来就离线），留着反而会缓存旧版
const idx=path.join(DST,'index.html');
let h=fs.readFileSync(idx,'utf8');
h=h.replace("if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});",
            "/* APK 内不注册 Service Worker */");
fs.writeFileSync(idx,h);
console.log('www/ 同步完成');
