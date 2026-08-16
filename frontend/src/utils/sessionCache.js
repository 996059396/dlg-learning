// X02 离线身份缓存
//
// 离线启动时 getMe 会网络失败，GameProvider 原来会把用户降级成 demo —— 那样离线
// 完成的课程走 demo 分支（只写 localStorage），永远不会入队同步，离线学习等于没
// 做。这里把「最近一次成功鉴权拿到的身份」缓存进 localStorage：离线启动时恢复真实
// 身份，LessonPlayer 才会把完成记录入队，联网后由服务端判分。
//
// 只缓存非敏感身份字段（id/username/avatar + gameState 快照），绝不缓存 token
// （token 仍在 dlg_token 里）。401/登出/换号时清缓存 —— 缓存身份绝不能顶替鉴权。

const CACHE_KEY = 'dlg_cached_user';

export function readCachedUser() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return c && typeof c === 'object' && c.id ? c : null;
  } catch {
    return null;
  }
}

export function writeCachedUser(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('[sessionCache] 写入失败:', e);
  }
}

export function clearCachedUser() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch (e) {
    /* ignore */
  }
}
