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

# RHEL 系（含 Alibaba Cloud Linux 3）系统仓库不提供 nginx 包，
# 与面板应用中心保持一致：写入 nginx.org 官方源（默认禁用）后临时启用安装
install_nginx_rhel() {
  if rpm -q nginx >/dev/null 2>&1; then
    log "已检测到 nginx：$(nginx -v 2>&1)，跳过安装"
    return 0
  fi
  # alinux 的 VERSION_ID 是 2/3/4，不能直接当 $releasever 用（nginx.org 只发布 el7/8/9），
  # 需换算成 Enterprise Linux 大版本：alinux2=7、alinux3=8、alinux4=9
  local el
  el="$(. /etc/os-release 2>/dev/null; case "$ID" in alinux) echo $((VERSION_ID + 5)) ;; *) echo "${VERSION_ID%%.*}" ;; esac)"
  [ -n "$el" ] || el=8
  log "写入 nginx.org 官方源（el${el}）..."
  cat > /etc/yum.repos.d/nginx-official.repo <<EOF
[nginx-stable]
name=nginx repo
baseurl=https://nginx.org/packages/centos/${el}/\$basearch/
gpgcheck=1
enabled=0
gpgkey=https://nginx.org/keys/nginx_signing.key
# epel-modular 中存在同名 nginx 模块流，会按模块过滤隐藏这里的 nginx 包，
# 必须声明 module_hotfixes 才能从官方源装到 nginx
module_hotfixes=true
EOF
  rpm --import https://nginx.org/keys/nginx_signing.key || error "导入 nginx 官方 GPG 密钥失败"
  $PKG install -y --enablerepo=nginx-stable nginx || error "从 nginx.org 官方源安装 nginx 失败"
}

# 安装基础依赖
# 注意：RHEL 系的 sqlite3 命令由 sqlite 包提供，且系统仓库不含 nginx，需分别处理
log "安装基础依赖..."
if [ "$PKG" = "apt" ]; then
  apt update -y
  apt install -y curl wget git sqlite3 nginx
else
  $PKG install -y curl wget git sqlite
  install_nginx_rhel
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

# node-gyp 需要 Python 3.8+（3.6 无法解析新版 gyp 的语法），
# RHEL 系默认 python3 为 3.6，会导致 better-sqlite3 等原生模块编译失败，
# 这里检查并按需安装平行版本 python3.11 交给 npm 使用
ensure_python_for_gyp() {
  local py
  py="$(command -v python3 || true)"
  if [ -n "$py" ] && "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
    return 0
  fi
  log "当前 python3 版本过低，安装 python3.11 供 node-gyp 使用..."
  $PKG install -y python3.11 || error "安装 python3.11 失败"
  # npm 11 不再接受自定义 python 配置项（会报 not a valid npm option），
  # 改为通过 npm_config_python 环境变量传给 node-gyp
  export npm_config_python=/usr/bin/python3.11
}

# 安装项目依赖
log "安装项目依赖..."
ensure_python_for_gyp
cd "$REPO_DIR"
npm run install:all

# 原生模块 better-sqlite3 必须落到本机源码编译产物上：
# 1) npm 包内置的预编译包（prebuilds/）要求 glibc>=2.33，Alibaba Cloud Linux 3 仅 2.32，
#    加载会直接报 "GLIBC_2.33 not found"，而 lib/binding.js 会优先加载它；
# 2) npm 11 默认不执行依赖的安装脚本，需先 install-scripts approve 授权，
#    否则连编译都不会触发；
# 3) Node 大版本变化后也必须重编译，否则报 NODE_MODULE_VERSION 不匹配
BETTER_SQLITE_DIR="$REPO_DIR/server/node_modules/better-sqlite3"
if ! (cd "$REPO_DIR/server" && "$NODE_BIN" -e "require('better-sqlite3')" >/dev/null 2>&1); then
  log "从源码编译原生模块 better-sqlite3..."
  cd "$REPO_DIR/server"
  npm install-scripts approve better-sqlite3 >/dev/null 2>&1 || true
  rm -f "$BETTER_SQLITE_DIR"/prebuilds/*.node
  npm rebuild better-sqlite3 --build-from-source || error "better-sqlite3 编译失败"
  rm -f "$BETTER_SQLITE_DIR"/prebuilds/*.node
  "$NODE_BIN" -e "require('better-sqlite3')" >/dev/null 2>&1 || error "better-sqlite3 加载失败"
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
ADMIN_PASS="${ADMIN_PASS:-}"
# 重复执行安装脚本时沿用 .env 中已记录的凭据，避免回显的密码与已建账号不符
# （.env 中仍是示例默认值 admin123 时视为尚未初始化）
if [ -z "$ADMIN_PASS" ] && [ -f "$REPO_DIR/.env" ]; then
  ADMIN_PASS="$(sed -n 's/^DEFAULT_ADMIN_PASSWORD=//p' "$REPO_DIR/.env" | head -1)"
  [ "$ADMIN_PASS" = "admin123" ] && ADMIN_PASS=""
fi
ADMIN_PASS="${ADMIN_PASS:-$(openssl rand -hex 16)}"
# 同步管理员凭据到 .env：生产环境下 config 会拒绝 admin/admin123 等弱默认值，
# 不同步会导致 createAdmin 与面板服务启动时直接抛错退出
if [ -f "$REPO_DIR/.env" ]; then
  sed -i "s|^DEFAULT_ADMIN_USERNAME=.*|DEFAULT_ADMIN_USERNAME=$ADMIN_USER|" "$REPO_DIR/.env"
  sed -i "s|^DEFAULT_ADMIN_PASSWORD=.*|DEFAULT_ADMIN_PASSWORD=$ADMIN_PASS|" "$REPO_DIR/.env"
fi
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
