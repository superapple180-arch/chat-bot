export let csrf='';
export function setCsrf(value:string){csrf=value;}
export async function api<T=any>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
  const response=await fetch('/api'+path,{method,credentials:'same-origin',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),'x-csrf-token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();
  if(!response.ok){if(response.status===401&&path!=='/login')window.dispatchEvent(new Event('session-expired'));throw Error(data.code??'REQUEST_FAILED');}
  return data;
}
const labels:Record<string,string>={
  CONTROL_CANCELLED:'此前的恢复操作已被后续暂停取消',
  UNAUTHORIZED:'请先登录',INVALID_PASSWORD:'密码不正确',LOGIN_RATE_LIMIT:'尝试次数过多 请稍后重试',INVALID_CSRF:'会话校验失败 请重新登录',INVALID_ORIGIN:'访问地址未获允许',INVALID_HOST:'访问地址未获允许',WEB_PASSWORD_NOT_CONFIGURED:'请先运行 setup-web.cmd 设置管理密码',
  BRIDGE_NOT_RUNNING:'请先启动桥接',BRIDGE_ALREADY_RUNNING:'桥接已被其他窗口占用 请先在原控制台输入 q 退出',BRIDGE_EXITED:'桥接已退出 请查看诊断记录',PAUSED:'机器人已暂停 请先恢复运行',QQ_NOT_CONNECTED:'QQ 尚未连接 请检查 NapCat',TASK_STILL_STOPPING:'上一个任务正在停止 请稍后恢复',CONNECTION_CONFIG_RESTART_REQUIRED:'连接或记忆设置已变化 请重启桥接',CONFIG_CHANGED_EXTERNALLY:'配置已被其他程序修改 请重新载入后编辑',INVALID_MANUAL_MESSAGE:'消息或目标格式不正确',MANUAL_TARGET_NOT_KNOWN:'只能回复已记录的会话或当前好友',QUEUE_FULL:'任务队列已满',MEMORY_NOT_ENABLED:'长期记忆未启用',QZONE_NOT_ENABLED:'QQ 空间功能未启用',LOCAL_ACTION_ONLY:'此操作需要在机器人电脑上完成',NAPCAT_ALREADY_RUNNING:'NapCat 管理端口已占用 请使用现有本机管理页面',NAPCAT_NOT_INSTALLED:'未找到项目内 NapCat',NAPCAT_START_ALREADY_REQUESTED:'已请求启动 NapCat 请查看本机管理页面',REQUEST_FAILED:'操作未完成 请检查输入或诊断记录',OPERATION_TIMEOUT:'等待操作超时 请核对状态 不要重复发送',STARTUP_TIMEOUT:'启动等待超时 请检查进程状态',INVALID_OWNER_COMMAND:'请填写有效的好友调度指令',SEND_RATE_LIMIT:'已达到发送频率限制',QQ_SEND_UNCERTAIN:'发送结果不明 请在 QQ 中核对 不会自动重发',QQ_SEND_REJECTED:'QQ 拒绝了本次发送',QQ_ACCOUNT_MISMATCH:'QQ 登录账号与配置不一致',ANTIGRAVITY_TOOLS_NOT_DISABLED:'模型工具限制未验证 请查看诊断',INVALID_CONFIG_FIELDS:'配置包含不支持的字段',INVALID_REPLY_CONFIG:'回复设置不正确',INVALID_VOICE_CONFIG:'请填写有效音色编号 例如 zh-CN-XiaoxiaoNeural',ACCESS_TOKEN_REQUIRED_MIN_16:'访问令牌至少需要16个字符',SELF_ID_REQUIRED:'机器人 QQ 号不能为空',INVALID_ALLOWLIST:'白名单必须填写有效的 QQ 号或群号',INVALID_CONVERSATION_PROBABILITY:'概率必须介于0和1之间',INVALID_SESSION_PERSONAS:'会话性格格式不正确',INVALID_LIMIT:'运行限制必须为正整数',LIMIT_TOO_LARGE:'运行限制超过允许范围',INVALID_FRIEND_ADMIN:'管理员账号或模型模式不正确',ONEBOT_MUST_USE_LITERAL_LOOPBACK_WS:'OneBot 地址必须使用本机 ws 地址'
};
export const explain=(e:unknown)=>{const code=e instanceof Error?e.message:String(e);return labels[code]??`操作未完成 · ${code}`;};
export const statusLabel=(s:string)=>({received:'已接收',accepted:'排队中',generating:'生成中',generated:'已生成',sending:'发送中',sent:'已送达','dry-run':'干跑 · 未发送',failed:'失败',uncertain:'结果不明',cancelled:'已取消',completed:'已完成',pending:'待审批',processing:'处理中',approved:'已同意',rejected:'已拒绝',queued:'等待处理','not-requested':'今日未触发',interrupted:'已中断'}[s]??s);
export const dateText=(t:string|number)=>new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'});
