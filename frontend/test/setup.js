// vitest 全局 polyfill：node 环境没有 localStorage，也没有全局 fetch 的响应
// 语义（fetch 由各测试注入 mock）。给一个最小 in-memory localStorage 即可。
class MemStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
  clear() { this.#m.clear(); }
  get length() { return this.#m.size; }
}

Object.defineProperty(globalThis, 'localStorage', { value: new MemStorage(), writable: true });

// 每次测试前清空，避免用例间串状态。
import { beforeEach } from 'vitest';
beforeEach(() => {
  globalThis.localStorage.clear();
});
