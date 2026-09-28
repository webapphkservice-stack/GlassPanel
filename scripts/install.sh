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

# Node.js 版本约束：统一使用 24 LTS，可用 NODE_MAJOR 覆盖
NODE_MAJOR="${NODE_MAJOR:-24}"
NODE_INSTALL_DIR="/usr/local"

# 解析 node 绝对路径：优先 /usr/local/bin/node（本脚本安装位置），
# 避免 PATH 中其他安装抢先，导致终端与 systemd 服务用到不同版本
resolve_node() {
  local cand
  for cand in "$NODE_INSTALL_DIR/bin/node" /usr/bin/node "$(command -v node 2>/dev/null)"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

node_major_of() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# 安装官方二进制包：直接取 nodejs.org 官方分发并校验 sha256 后解压到 /usr/local，
# 不依赖各发行版三方源，Ubuntu / Debian / RHEL 系（含 Alibaba Cloud Linux）统一路径
install_node() {
  local arch sums tarball sum tmp
  case "$(uname -m)" in
    x86_64) arch="linux-x64" ;;
    aarch64|arm64) arch="linux-arm64" ;;
    *) error "不支持的 CPU 架构：$(uname -m)" ;;
  esac

  local dist="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  log "获取 Node.js ${NODE_MAJOR}.x 官方下载信息（$arch）..."
  sums="$(curl -fsSL "$dist/SHASUMS256.txt")" || error "无法获取 Node.js ${NODE_MAJOR} 校验清单"
  # 用 awk 按空白切分，避免依赖 sha256sum 输出中的空格数量
  tarball="$(echo "$sums" | awk "/${arch}\\.tar\\.xz\$/{print \$2}")"
  [ -n "$tarball" ] || error "校验清单中未找到 ${arch} 安装包"
  sum="$(echo "$sums" | awk -v f="$tarball" '$2==f{print $1}')"

  tmp="$(mktemp -d)"
  log "下载 $tarball ..."
  curl -fsSL -o "$tmp/$tarball" "$dist/$tarball" || error "下载失败：$dist/$tarball"
  # 校验 sha256，防止安装包被篡改
  echo "${sum}  ${tmp}/${tarball}" | sha256sum -c - >/dev/null || error "Node.js 安装包 sha256 校验失败"
  tar -xJf "$tmp/$tarball" -C "$tmp" || error "解压 Node.js 安装包失败"
  # 先在临时目录确认可用，再落盘覆盖安装目录，避免解压异常导致 node 不可用
  "$tmp/${tarball%.tar.xz}/bin/node" -v >/dev/null || error "Node.js 解压结果不可用"
  tar -xJf "$tmp/$tarball" -C "$NODE_INSTALL_DIR" --strip-components=1 --overwrite \
    || error "安装 Node.js 到 $NODE_INSTALL_DIR 失败"
  rm -rf "$tmp"
}

if NODE_BIN="$(resolve_node)" && [ "$(node_major_of "$NODE_BIN")" -ge "$NODE_MAJOR" ]; then
  log "已检测到 Node.js $("$NODE_BIN" -v)，跳过安装"
else
  # 仅在缺失或低于目标大版本时安装，绝不降级已经更高的版本
  log "安装 Node.js ${NODE_MAJOR} LTS..."
  install_node
fi

NODE_BIN="$(resolve_node)" || error "未找到 node 可执行文件"
[ "$(node_major_of "$NODE_BIN")" -ge "$NODE_MAJOR" ] \
  || error "Node.js 版本过低（当前 $("$NODE_BIN" -v)），需要 ${NODE_MAJOR}.x 或更高"

# 把安装目录前置到 PATH，保证后续 npm 相关步骤与 systemd 服务使用同一个 Node
export PATH="$(dirname "$NODE_BIN"):$PATH"

log "Node 路径：$NODE_BIN"
log "Node 版本：$("$NODE_BIN" -v)"
log "NPM 版本：$(npm -v)"

# 安装项目依赖
log "安装项目依赖..."
cd "$REPO_DIR"
npm run install:all

# 原生模块（better-sqlite3）按 Node ABI 编译：Node 大版本变化后必须重编译，
# 否则启动会报 NODE_MODULE_VERSION 不匹配
if ! (cd "$REPO_DIR/server" && "$NODE_BIN" -e "require('better-sqlite3')" >/dev/null 2>&1); then
  log "重新编译原生模块 better-sqlite3..."
  cd "$REPO_DIR/server" && npm rebuild better-sqlite3 || error "better-sqlite3 重编译失败"
  cd "$REPO_DIR"
fi

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
ExecStart=$NODE_BIN $REPO_DIR/server/bin/www.js
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
