const $ = id => document.getElementById(id);
const bridge = window.chatBot;
let busy = false, ready = false, configured = false;
const messages = { INVALID_SETUP: '请核对 QQ 号与两次输入的密码', PASSWORD_LENGTH_12_TO_256: '密码需要 12 到 256 个字符', PREPARE_COMPONENTS_FIRST: '请先准备运行组件', COMPONENT_DOWNLOAD_FAILED: '组件下载未完成 请检查网络后重试', COMPONENT_HASH_MISMATCH: '组件校验失败 已停止安装', EXISTING_NAPCAT_CONFIG_REQUIRES_MANUAL_SETUP: '检测到已有 QQ 接入配置 请先在原管理器核对 避免覆盖', BACKEND_UNAVAILABLE: '本机服务正在启动 请稍后重试', UPDATE_FEED_NOT_READY: '当前测试包尚未接入正式更新源' };
function status(text) { $('status').textContent = text; }
messages.MANAGEMENT_PORT_IN_USE = '管理端口被其他程序占用 请退出本应用后重试';
messages.LOCAL_ACCESS_DENIED = '本机服务没有访问权限 请检查安装目录与本机端口权限';
messages.MANAGEMENT_NOT_READY = '管理服务尚未就绪 请稍后重新进入管理台';
async function call(action, payload) {
  const result = await bridge.call(action, payload);
  if (result?.error) throw Error(messages[result.error] ?? `操作未完成 ${result.error}`);
  return result;
}
async function run(action, payload) {
  if (busy) return;
  busy = true; document.querySelectorAll('button').forEach(button => button.disabled = true);
  try { return await call(action, payload); }
  catch (e) { status(e.message); }
  finally { busy = false; document.querySelectorAll('button').forEach(button => button.disabled = false); $('finish').disabled = !ready; }
}
async function refresh() {
  if (busy) return;
  try {
    const info = await call('status'); ready = info.componentsReady; configured = info.configured;
    $('setup').hidden = configured; $('open').hidden = !configured; $('finish').disabled = !ready;
    $('qq').hidden = !configured;
    $('mac').hidden = info.platform !== 'darwin';
    $('platform-note').textContent = info.platform === 'darwin' ? 'macOS 请先安装 QQ 到应用程序目录 再打开官方接入安装器并完成授权' : info.platform === 'linux' ? 'Ubuntu 的 QQ 接入需要 xvfb 与 xauth 首次使用前请安装对应系统软件包' : '首次下载可能需要几分钟 支持失败后重试';
    if ($('status').textContent === '正在连接本机服务') status(configured ? '已检测到本机配置' : '本机服务已就绪');
  } catch {}
}
$('prepare').onclick = async () => { if (!$('consent').checked) return status('请先确认非商业用途与组件许可'); const result = await run('prepare'); if (result?.ready) { ready = true; await refresh(); } };
$('model').onclick = () => run('modelLogin');
$('mac').onclick = () => run('macInstaller');
$('qq').onclick = () => run('qq');
$('open').onclick = () => run('open');
$('clear').onclick = () => run('clearData');
$('setup').onsubmit = async event => { event.preventDefault(); if (!ready) return status('请先准备组件'); if ($('password').value !== $('confirm').value) return status('两次输入的密码不一致'); await run('setup', { selfId: $('selfId').value.trim(), password: $('password').value, confirm: $('confirm').value }); $('password').value = ''; $('confirm').value = ''; };
bridge.onStatus(value => { status(value.text); if (value.leaving) document.body.classList.add('leaving'); else if (!busy) void refresh(); });
void refresh(); setInterval(refresh, 1800);
