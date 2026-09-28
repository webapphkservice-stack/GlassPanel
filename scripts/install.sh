#!/usr/bin/env bash
set -e

# 玻璃液态服务器面板安装脚本
# 支持 Ubuntu / Debian / CentOS / AlmaLinux

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="/tmp/glass-panel-install.log"

log() {
  echo -e "\033[36m[Glass Panel]\033[0m $1" | tee -a "$LOG_FILE"
}

error() {
  echo -e "\033[31m[错误]\033[0m $1" | tee -a "$LOG_FILE"
  exit 1
}

if [ "$EUID" -ne 0 ]; then
  error "请使用 root 权限运行安装脚本"
fi

log "安装目录：$REPO_DIR"

# 检测包管理器
if command -v apt >/dev/null 2>&1; then
  PKG="apt"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"
else
  error "不支持的系统，请使用 apt/yum/dnf 包管理器"
fi

# 安装基础依赖
log "安装基础依赖..."
if [ "$PKG" = "apt" ]; then
  apt update -y
  apt install -y curl wget git sqlite3 nginx
else
  $PKG install -y curl wget git sqlite3 nginx
fi

# 安装 Node.js 20 LTS
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" != "20" ]; then
  log "安装 Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  if [ "$PKG" = "apt" ]; then
    apt install -y nodejs
  else
    $PKG install -y nodejs
  fi
fi

log "Node 版本：$(node -v)"
log "NPM 版本：$(npm -v)"

# 安装项目依赖
log "安装项目依赖..."
cd "$REPO_DIR"
npm run install:all

# 生成环境配置
if [ ! -f "$REPO_DIR/.env" ]; then
  log "创建 .env 配置文件..."
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  SECRET=$(openssl rand -hex 32)
  sed -i "s|JWT_SECRET=.*|JWT_SECRET=$SECRET|" "$REPO_DIR/.env"
  sed -i 's|NODE_ENV=development|NODE_ENV=production|' "$REPO_DIR/.env"
  sed -i 's|USE_SUDO=false|USE_SUDO=true|' "$REPO_DIR/.env"
fi

# 初始化管理员：安装脚本必须生成随机强密码，绝不使用默认密码
log "初始化管理员账号..."
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-$(openssl rand -hex 16)}"
cd "$REPO_DIR/server" && node scripts/createAdmin.js "$ADMIN_USER" "$ADMIN_PASS"
echo ""
echo "============================================================"
echo "  管理员账号：$ADMIN_USER"
echo "  管理员密码：$ADMIN_PASS"
echo "  请妥善保存以上密码，首次登录后建议立即修改。"
echo "============================================================"

# 构建前端
log "构建前端..."
cd "$REPO_DIR" && npm run build

# 创建数据目录
mkdir -p "$REPO_DIR/data"

# 安装 systemd 服务
if command -v systemctl >/dev/null 2>&1; then
  log "注册 systemd 服务..."
  SERVICE_FILE="/etc/systemd/system/glass-panel.service"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Glass Panel Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$REPO_DIR/server
ExecStart=/usr/bin/node $REPO_DIR/server/bin/www.js
Restart=on-failure
# 只杀主进程：面板重启（如右上角重启按钮）时不连带杀掉后台任务
# （源码编译、系统更新等），否则任务会被腰斩且退出码丢失
KillMode=process
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable glass-panel.service
  log "服务已注册，使用 systemctl start glass-panel 启动"
fi

log "安装完成"
log "管理员账号已生成，请查看上方输出的账号密码"
log "请及时修改默认密码并配置防火墙与 sudo 权限"
