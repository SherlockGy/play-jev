import test from 'node:test';
import assert from 'node:assert/strict';
import { safeError } from '../src/errors.js';

test('隐藏环境密钥与扩展临时连接令牌，保留错误上下文', () => {
  const result = safeError(new Error('连接失败 https://example.test/?mcpToken=temporary-value&tab=2 key=a/b encoded=a%2Fb'), { TYPESAFE_API_KEY: 'a/b' });
  assert.doesNotMatch(result, /temporary-value|a\/b|a%2Fb/);
  assert.match(result, /连接失败/);
  assert.match(result, /&tab=2/);
});
