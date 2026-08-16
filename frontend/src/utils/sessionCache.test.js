import { describe, it, expect } from 'vitest';
import { readCachedUser, writeCachedUser, clearCachedUser } from './sessionCache';

describe('sessionCache 身份缓存（X02）', () => {
  it('写入→读回', () => {
    const u = { id: 'u1', username: 'demo', avatar: '🐼', gameState: { xp: 10 } };
    writeCachedUser(u);
    expect(readCachedUser()).toEqual(u);
  });

  it('无缓存 → null', () => {
    expect(readCachedUser()).toBeNull();
  });

  it('缓存损坏（非法 JSON / 无 id）→ null 而非抛错', () => {
    localStorage.setItem('dlg_cached_user', '{broken');
    expect(readCachedUser()).toBeNull();
    localStorage.setItem('dlg_cached_user', JSON.stringify({ username: 'no-id' }));
    expect(readCachedUser()).toBeNull();
  });

  it('clear 后读回 null', () => {
    writeCachedUser({ id: 'u1' });
    clearCachedUser();
    expect(readCachedUser()).toBeNull();
  });
});
