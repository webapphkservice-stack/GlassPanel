# Glass Panel

玻璃液态风格轻量级服务器管理面板。基于 React + Express + SQLite，浏览器中即可完成 Nginx、PHP-FPM、MySQL、Redis、进程守护、防火墙、Fail2ban 与 SSL 证书的日常运维。

## 功能特性

**概览**
- CPU / 内存 / 磁盘资源概览
- 系统信息与关键服务运行状态
- 面板服务自重启（右上角）

**应用中心**
- 覆盖 Nginx、PHP、MySQL、Redis、Supervisor、FFmpeg、Fail2ban、3x-ui 及系统软件包更新
- 安装时可选择官方源版本或跟随系统仓库默认版本
- 自动检查可用更新，支持一键更新与卸载（卸载会同时清理数据、配置、日志与编译目录）
- 安装 / 更新 / 卸载均以后台任务执行，弹窗内实时输出终端日志，关闭弹窗不中断
- 安装完成后自动同步运行状态与访问入口，可直接打开应用面板

**Nginx**
- 状态查看与启动 / 停止 / 重载，配置语法测试
- 站点列表（域名、监听端口、SSL、根目录、配置文件路径）
- 新建站点：静态 HTML / PHP / 反向代理，可同时申请 SSL 证书并按需创建数据库
- 删除站点：联动清理关联数据库、数据库用户与 SSL 证书（网站目录保留）
- 伪静态规则模板（无 / WordPress / Laravel / ThinkPHP）
- 配置文件在线编辑（Monaco Editor），保存后可自动重载
- **站点文件管理**：浏览目录、上传、下载、新建目录、删除，严格限定在该站点根目录内

**PHP**
- PHP-FPM 状态与多版本管理（源码编译 / 包管理器安装的版本并存）
- 扩展安装与卸载（PECL 与 PHP 自带扩展，以共享模块方式编译，后台任务执行）
- 上传限制、禁用函数、常用 php.ini 配置项在线修改（自动备份并重载）
- 错误日志与慢日志查看、清空及慢日志阈值配置

**MySQL / Redis**
- MySQL：运行状态、数据库列表
- Redis：运行状态、完整 INFO 信息

**进程守护（Supervisor / PM2）**
- 进程列表查看、启动、停止、新增与删除

**防火墙**
- 自动探测后端：ufw → firewalld → iptables
- 状态查看、规则添加与删除、防火墙开启 / 关闭

**Fail2ban**
- 服务状态与封禁列表
- 站点保护、服务保护
- IP 白名单与黑名单管理（黑名单立即永久封禁）、一键解封

**SSL**
- Let's Encrypt 证书申请、续期与删除

**安全设置**
- TOTP 双因素认证（兼容 Google Authenticator，遵循 RFC 6238）
- 首次绑定展示二维码与一次性恢复码（仅显示一次），关闭 / 重置需二次验证密码与动态码
- 登录与动态码校验限流、审计日志

**其他**
- 玻璃液态 UI、响应式布局
- 界面多语言：简体中文 / 繁体中文 / English

## 环境要求

- Linux 服务器（Ubuntu / Debian / CentOS / AlmaLinux 等，需 `apt` / `yum` / `dnf` 之一）
- root 权限
- systemd（用于注册面板服务）

## 快速安装

以 root 权限执行：

```bash
git clone https://github.com/webapphkservice-stack/GlassPanel.git glass-panel
cd glass-panel
chmod +x scripts/*.sh
./scripts/install.sh
```

安装脚本会依次完成：

1. 通过包管理器安装基础依赖（curl、wget、git、sqlite3、nginx）
2. 安装 Node.js 24 LTS（取自 nodejs.org 官方二进制并校验 sha256，安装到 `/usr/local`；已检测到 ≥ 24 时跳过，不会降级更高版本）
3. 安装前后端依赖（`npm run install:all`）
4. 由 `.env.example` 生成 `.env`，自动写入随机 `JWT_SECRET` 并切换为生产配置（已存在 `.env` 时不会覆盖）
5. 初始化管理员账号，**随机生成强密码并回显在终端**（可用 `ADMIN_USER` / `ADMIN_PASS` 环境变量指定）
6. 构建前端并创建数据目录
7. 注册 systemd 服务 `glass-panel`

安装日志同时写入 `/tmp/glass-panel-install.log`。

> 请务必保存终端回显的管理员密码，脚本不会重复输出。

## 启动与访问

安装脚本只注册服务，不会自动启动：

```bash
systemctl start glass-panel
```

默认访问地址：`http://<服务器IP>:3000`（端口取自 `.env` 中的 `PORT`）。

生产环境建议通过 Nginx 反向代理并启用 HTTPS；若需上传较大文件，请同时调整反代配置中的 `client_max_body_size`。

## 服务管理

`scripts/setup-service.sh` 提供常用的服务操作：

```bash
./scripts/setup-service.sh install   # 注册并启用 systemd 服务
./scripts/setup-service.sh start     # 启动
./scripts/setup-service.sh stop      # 停止
./scripts/setup-service.sh restart   # 重启
./scripts/setup-service.sh status    # 查看状态
./scripts/setup-service.sh update    # 重新构建前端并重启
```

## 开发运行

```bash
npm run install:all
npm run dev
```

- 前端（Vite）：`http://localhost:5173`
- 后端（Express）：`http://localhost:3000`

## 权限配置

面板通过内置命令白名单执行系统命令（见 `server/services/commandRunner.js`），命中白名单以外的命令会被拒绝。

默认以 root 运行服务（`User=root`），此时无需额外授权。若希望改以普通用户运行，需将 `.env` 中的 `USE_SUDO` 设为 `true`（`install.sh` 生成的 `.env` 已写入 `true`），并允许该用户免密执行白名单中的命令：

```text
Cmnd_Alias GLASS_PANEL = \
  /usr/bin/systemctl *, /usr/sbin/service *, \
  /usr/sbin/nginx *, /usr/bin/php *, /usr/sbin/php-fpm *, \
  /usr/bin/mysql *, /usr/bin/mysqladmin *, \
  /usr/bin/redis-cli *, /usr/bin/redis-server *, \
  /usr/bin/supervisorctl *, /usr/bin/pm2 *, \
  /usr/bin/fail2ban-client *, /usr/local/bin/fail2ban-client *, \
  /usr/sbin/ufw *, /usr/bin/firewall-cmd *, \
  /usr/sbin/iptables *, /usr/sbin/iptables-save *, /usr/sbin/iptables-restore *, \
  /usr/bin/certbot *, /usr/bin/openssl *, \
  /usr/bin/free *, /usr/bin/df *, /usr/bin/ps *, /usr/sbin/ss *, \
  /usr/bin/dnf *, /usr/bin/yum *, /usr/bin/rpm *, \
  /usr/bin/apt *, /usr/bin/apt-get *, /usr/bin/apt-cache *, /usr/bin/dpkg *, \
  /usr/bin/curl *, /usr/bin/bash *, /usr/bin/uname *, \
  /usr/local/bin/ffmpeg *, /usr/local/bin/ffprobe *, /usr/bin/pip3 *

www-data ALL=(ALL) NOPASSWD: GLASS_PANEL
```

> 注意：白名单中包含 `bash`、`curl` 与包管理器等命令，实际已接近 root 等价权限，sudoers 仅能约束误操作，不能防止恶意使用。请务必限制面板的访问来源，不要直接暴露在公网无防护端口。

## 目录结构

```text
.
├── client          # React 前端（源码）
│   ├── src         # 页面、组件、API 封装、i18n 词条
│   └── dist        # 构建产物（运行时生成，已忽略）
├── server          # Express 后端
│   ├── routes      # 各模块 API 路由
│   ├── services    # 业务实现（Nginx / PHP / MySQL / 防火墙 / Fail2ban 等）
│   └── models      # SQLite 数据访问
├── scripts         # 安装与服务管理脚本
├── data            # SQLite 数据库（运行时生成，已忽略）
└── .env            # 环境配置（安装时生成，已忽略）
```

`data/`（内含密码哈希与 TOTP 密钥）、`.env` 与服务器私钥等敏感内容均已通过 `.gitignore` 排除，请勿提交。

## 技术栈

- 前端：React 18、React Router 6、Zustand、Tailwind CSS 3、Vite 5、Monaco Editor、i18next、axios
- 后端：Node.js 24、Express 4、better-sqlite3、jsonwebtoken、bcryptjs、speakeasy（TOTP）、helmet、express-rate-limit
- 部署：systemd、Nginx（可选反向代理）

## 安全说明

- 安装脚本自动生成随机管理员密码与 `JWT_SECRET`，请勿使用默认凭据
- `JWT_SECRET` 长度不得小于 32 个字符，建议使用 `openssl rand -hex 32` 生成
- 首次登录后建议立即修改管理员密码，并启用 TOTP 双因素认证
- 建议通过 HTTPS 或内网访问面板，避免直接暴露在公网
- 面板具备系统管理能力，一旦凭据泄露等同服务器失守，请谨慎授权

## License

MIT