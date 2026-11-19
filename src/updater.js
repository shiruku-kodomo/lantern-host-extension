export const VERSION='0.3.5';
export const REPOSITORY='https://github.com/shiruku-kodomo/lantern-host-extension';
const OFFICIAL='github.com/shiruku-kodomo/lantern-host-extension';
export function officialRemote(remote){
  const value=String(remote||'').replace(/^git@github\.com:/,'https://github.com/').replace(/\/+$/,'').replace(/\.git$/,'');
  try{const url=new URL(value);return ['https:','ssh:'].includes(url.protocol)&&`${url.hostname}${url.pathname}`.toLowerCase()===OFFICIAL;}catch{return false;}
}
export class ExtensionUpdater {
  constructor(bridge){this.bridge=bridge;}
  async scope(){
    const all=await this.bridge.http('/api/extensions/discover');
    const own=all.filter(e=>e.name==='third-party/lantern-host-extension'||e.name==='lantern-host-extension');
    const loaded=own.length>1?await this.bridge.extensionType?.('lantern-host-extension'):own[0]?.type;
    const selected=own.find(e=>e.type===loaded);
    if(own.length>1&&!selected)throw new Error('检测到全局和账号两份安装，但酒馆未确认实际加载范围，已停止更新以避免改错目录。');
    if(!selected)throw new Error('酒馆未识别主持扩展安装范围。');
    return {extensionName:'lantern-host-extension',global:selected.type==='global'};
  }
  async check(){
    const scope=await this.scope();let version;
    try{version=await this.bridge.http('/api/extensions/version',scope);}catch(error){throw new Error(`无法检查GitHub更新，当前状态未知：${error.message}`);}
    if(!version?.currentCommitHash||!version.remoteUrl)return {version:VERSION,managed:false,state:'manual',scope,message:'当前为压缩包安装，无法自动更新。请使用酒馆扩展安装入口安装正式仓库的 stable 分支。'};
    if(!officialRemote(version.remoteUrl))throw new Error('安装来源与正式仓库不符，未调用远程更新。');
    const state=version.currentBranchName!=='stable'?'branch':version.isUpToDate===true?'latest':version.isUpToDate===false?'available':'unknown';
    const message={branch:'当前分支不是 stable，安装更新时将切换到 stable。',latest:'已连接GitHub，stable 分支已是最新。',available:'GitHub 上有更新，可以安装。',unknown:'GitHub 未返回明确更新状态，请重试。'}[state];
    return {...version,version:VERSION,managed:true,state,scope,message};
  }
  async install(){
    const status=await this.check();
    if(!status.managed||status.state==='unknown')throw new Error(status.message);
    if(status.currentBranchName!=='stable'){await this.bridge.http('/api/extensions/branches',status.scope);await this.bridge.http('/api/extensions/switch',{...status.scope,branch:'origin/stable'});}
    const result=await this.bridge.http('/api/extensions/update',status.scope);
    const next=await this.bridge.http('/api/extensions/version',status.scope);
    if(!officialRemote(next?.remoteUrl)||!next.currentCommitHash||next.currentBranchName!=='stable'||next.isUpToDate!==true)throw new Error('更新后版本未确认，请重试；本局记录仍保留。');
    const installed=await this.bridge.fetch('/scripts/extensions/third-party/lantern-host-extension/manifest.json',{cache:'no-store',headers:this.bridge.headers()});
    if(!installed.ok)throw new Error('更新文件已下载，版本文件尚未读回；请重试核对。');
    const manifest=await installed.json();
    if(!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(manifest.version||''))throw new Error('更新后的版本文件无效。');
    return {result,next,version:manifest.version};
  }
}
