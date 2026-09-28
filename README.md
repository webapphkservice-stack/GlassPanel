# Glass Panel

玻璃液态风格轻量级服务器管理面板。基于 React + Express + SQLite，支持 Nginx、PHP-FPM、MySQL、Redis、Supervisor / PM2 进程守护、防火墙（ufw / firewalld）与 SSL（Let's Encrypt）管理。

## 功能特性

- 玻璃液态 UI，响应式布局
- JWT 登录认证
- 系统资源概览（CPU / 内存 / 磁盘）
- Nginx：状态、启停、配置测试、站点列表、在线编辑配置
- PHP：版本管理、FPM 启停
- MySQL：状态、数据库列表
- Redis：状态、INFO 信息
- Supervisor / PM2：进程查看、启停、新增、删除
- 防火墙：ufw / firewalld 状态、规则增删、开关
- SSL：Let's Encrypt 证书申请、续期、删除
- 审计日志

## 快速安装

在 root 权限下执行：

```bash
git clone <repo-url> glass-panel
cd glass-panel
chmod +x scripts/*.sh
./scripts/install.sh
```

安装脚本会自动：
- 安装 Node.js 20 LTS
- 安装项目依赖
- 生成 `.env` 配置
- 初始化管理员账号
- 构建前端
- 注册 systemd 服务

## 启动服务

```bash
systemctl start glass-panel
```

默认访问：`http://<服务器IP>:3000`

安装脚本会自动生成随机强密码并在终端回显，请妥善保存；生产环境请勿使用默认凭据。

## 开发运行

```bash
npm run install:all
npm run dev
```

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`

## 权限配置

面板需要执行系统命令，生产环境建议通过 sudoers 限制。在 `/etc/sudoers` 添加：

```text
Cmnd_Alias GLASS_PANEL = /usr/bin/systemctl *, /usr/sbin/service *, /usr/sbin/nginx, /usr/bin/php, /usr/bin/mysql, /usr/bin/mysqladmin, /usr/bin/redis-cli, /usr/bin/redis-server, /usr/bin/supervisorctl, /usr/bin/pm2, /usr/sbin/ufw, /usr/bin/firewall-cmd, /usr/bin/certbot, /usr/bin/openssl, /usr/bin/free, /usr/bin/df, /usr/bin/ps, /usr/sbin/ss

www-data ALL=(ALL) NOPASSWD: GLASS_PANEL
```

并将 `.env` 中 `USE_SUDO` 设为 `true`。

若直接以 root 运行服务，可将 `USE_SUDO` 保持为 `false`。

## 目录结构

```text
.
├── client          # React 前端
├── server          # Express 后端
├── scripts         # 安装与服务脚本
├── data            # SQLite 数据库
└── .env            # 环境配置
```

## 技术栈

- 前端：React 18、React Router 6、Zustand、Tailwind CSS、Monaco Editor、Lucide 风格图标
- 后端：Node.js 20、Express、better-sqlite3、JWT
- 部署：systemd、Nginx（可选反向代理）

## 安全提示

- 安装脚本会自动生成随机管理员密码与 JWT_SECRET，请勿使用默认凭据
- 生产环境 `JWT_SECRET` 长度不得小于 32 个字符，建议使用 `openssl rand -hex 32` 生成
- 首次登录后建议立即修改管理员密码
- 建议通过 HTTPS / 内网访问面板
- 避免将面板暴露在公网无防护端口

## License

MIT
