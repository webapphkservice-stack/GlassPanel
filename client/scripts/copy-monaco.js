// 将 monaco-editor 的 AMD 资源复制到 public/monaco/vs，由面板自身静态托管。
// 默认 CDN 会被面板的 CSP（script-src 'self'）拦截，导致编辑器一直停留在 Loading...
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../node_modules/monaco-editor/min/vs');
const publicDir = path.resolve(here, '../public/monaco');
const dest = path.join(publicDir, 'vs');

if (!fs.existsSync(src)) {
  console.error('[monaco] 未找到 monaco-editor/min/vs，请先安装前端依赖');
  process.exit(1);
}

fs.rmSync(publicDir, { recursive: true, force: true });
fs.mkdirSync(publicDir, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log('[monaco] 本地资源已复制到 client/public/monaco/vs');
