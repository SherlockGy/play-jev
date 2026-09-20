// 外部服务可能在异常中回显凭据；在进入面板、HTTP 响应和控制台前统一隐藏。
export function safeError(error, env = process.env) {
  let message = String(error?.message || error);
  for (const [name, value] of Object.entries(env)) {
    if (value && /KEY|TOKEN|SECRET|PASSWORD/i.test(name)) {
      message = message.split(value).join('[已隐藏]');
      message = message.split(encodeURIComponent(value)).join('[已隐藏]');
    }
  }
  // 扩展临时生成的连接令牌可能尚未存在于环境变量中。
  message = message.replace(/([?&](?:[^\s=&#]*token|api[_-]?key|password|secret)=)[^\s&#"'<>]+/gi, '$1[已隐藏]');
  return message.slice(0, 1400);
}
