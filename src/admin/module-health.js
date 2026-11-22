// Read-only inventory. Registration, enablement and runtime proof are independent.
import {builtinDefinitions} from '../builtins/index.js';
export const bundledNative = {
  'qq-group-members':'群成员动态', 'qq-media-agent':'网页媒体', 'qq-sticker':'表情包', 'qq-web':'联网查资料',
  'qq-official-bot':'QQ 官方机器人', 'qq-qzone':'QQ 空间', 'qq-tts':'发语音',
  'qq-memory':'长期记忆', 'qq-autonomy':'自主时间', 'qq-emotion':'情绪'
};
const rank = ['fault','pending','off','ready'];
export function moduleHealth({data, nativeLive, extensionLive, problems, online, consoleRunning, auth, secure, monitor, sampledAt = Date.now()}) {
  const rows = [];
  const add = (id,name,group,enabled,registered,state,reason,web,dsh) => rows.push({id,name,group,enabled,registered,state,reason,web,dsh});
  const core = (...args) => add(args[0],args[1],'核心服务',...args.slice(2));
  const consoleOn = data.settings.adminConsoleEnabled !== false;
  core('bridge','OneBot 连接',data.settings.enabled,true,!data.settings.enabled?'off':online?'ready':'fault',!data.settings.enabled?'桥接已停用，不会连接账号。':online?'当前连接已上报在线。':'未收到在线状态，请检查连接地址和网关。','connection','settings');
  core('web-console','网页控制台',consoleOn,true,!consoleOn?'off':consoleRunning?'ready':'fault',!consoleOn?'已关闭网页监听。':consoleRunning?'HTTP 服务已监听。':'未能启动监听，请检查端口和配置。','account','security');
  const ok = auth.configured && (!secure || auth.enrolled);
  core('web-auth','网页登录保护',consoleOn,true,auth.corrupt?'fault':!consoleOn?'off':!ok?'fault':'ready',auth.corrupt?'认证记录或凭据密钥不可用，请恢复备份。':!consoleOn?'网页控制台已关闭。':!auth.configured?'在 DSH 的「网页安全」设置首个密码。':secure && !auth.enrolled?'HTTPS 登录需要先绑定认证器。':auth.enrolled?'密码与二次验证已配置。':'已设置本机登录密码。','account','security');
  core('replies','回复与工具任务',!data.framework.paused,true,data.framework.paused?'off':!data.framework.ownerQQ?'fault':'pending',data.framework.paused?'已暂停；不会执行回复或工具任务。':!data.framework.ownerQQ?'尚未指定主人 QQ。':'策略已配置，真实收发请对照消息回执。','permissions','permissions');
  const final = monitor.delivery?.finalState;
  const states = {confirmed:'已确认投递',submitted:'已提交，未确认投递',accepted:'网关已接受，未确认投递',unknown:'结果未知',failed:'投递失败',cancelled:'已取消'};
  const history = !monitor.delivery ? '还没有真实投递回执。' : !final ? '最近一条消息尚无最终结果。' : '最近一条：'+(states[final] || '没有确认投递')+'。';
  const receiptState = !data.settings.enabled ? 'off' : final==='confirmed' ? 'ready' : final==='failed' ? 'fault' : 'pending';
  core('receipts','消息投递回执',data.settings.enabled,true,receiptState,(data.settings.enabled?'':'桥接已停用。')+history,'logs','activity');
  function item(id,name,group,p,registered,web='plugins',dsh='plugins') {
    const dep = p?.enabled && p.manifest ? problems(p.manifest,{enabled:true}) : [];
    const [state, reason] = p?.uninstalled ? ['off','已卸载，可在插件页恢复。'] : !p ? ['fault','应有模块没有注册记录。'] : p.health?.quarantined ? ['fault','模块已隔离，请检查错误后再恢复。'] : p.migrationError || p.error ? ['fault',p.migrationError?'配置迁移失败，请检查插件配置。':'模块报告错误，请在插件页查看诊断。'] : dep.length ? ['fault',dep.join('；')] : !registered && (group !== '声明式扩展' || p.enabled) ? ['fault','没有当前宿主的加载记录，请检查启动诊断。'] : !p.enabled ? ['off','开关已关闭；保留当前配置。'] : ['pending','已加载并启用；尚无本模块的端到端运行凭据。'];
    add(id,name,group,p?.enabled===true,registered,state,reason,web,dsh);
  }
  for (const {id,name} of builtinDefinitions) item(id,name,'内置模块',data.framework.builtins[id],Boolean(data.framework.builtins[id]));
  const native = data.framework.nativePackages;
  const pages = {'qq-sticker':'sticker','qq-qzone':'qzone','qq-memory':'memory','qq-autonomy':'autonomy'};
  for (const id of new Set([...Object.keys(bundledNative), ...Object.keys(native)])) item(id,native[id]?.manifest?.name || bundledNative[id] || id,'原生模块',native[id],nativeLive.has(id),pages[id] || 'plugins');
  for (const [id,p] of Object.entries(data.extensions)) item(id,p.manifest?.name || id,'声明式扩展',p,extensionLive.has(id));
  rows.sort((a,b) => rank.indexOf(a.state)-rank.indexOf(b.state));
  const counts = Object.fromEntries(rank.map(k => [k,rows.filter(r => r.state === k).length]));
  return {sampledAt, counts, rows};
}
