const fs = require('fs');
const path = require('path');
const { run } = require('./commandRunner');
const official = require('./officialSources');
const jobService = require('./jobService');
const nginxService = require('./nginxService');
const sslService = require('./sslService');

// 系统仓库/remi 无正式二进制包的版本 → 走源码编译（release → 具体版本号）
const SOURCE_BUILD = {
  php: { '8.5': '8.5.11' },
  redis: { '8.0': '8.0.6' },
  ffmpeg: { '9.0.2': '9.0.2' },
  fail2ban: { '1.1.0': '1.1.0' },
};
// 需通过 pip 安装的版本（release → pip 版本约束）
const PIP_INSTALL = {
  supervisor: { '4.3': 'supervisor==4.3.0' },
};
// 源码编译 / pip 安装后的版本标记文件（供面板识别已安装版本与服务名）
const INSTALL_MARKERS = {
  php: '/opt/glass-panel/data/php-compiled-version',
  redis: '/opt/glass-panel/data/redis-compiled-version',
  supervisor: '/opt/glass-panel/data/supervisor-pip-version',
  ffmpeg: '/opt/glass-panel/data/ffmpeg-compiled-version',
  fail2ban: '/opt/glass-panel/data/fail2ban-compiled-version',
  '3x-ui': '/opt/glass-panel/data/3xui-version',
};
const PHP_COMPILE_MARKER = INSTALL_MARKERS.php;

function readMarker(key) {
  const p = INSTALL_MARKERS[key];
  if (!p || !fs.existsSync(p)) return '';
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

// 版本号按段数值比较（8.5.11 > 8.5.9）
function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// ---- 3x-ui 专用：GitHub Release 版本获取 ----
let xuiReleasesCache = null;
let xuiReleasesCacheAt = 0;
const XUI_CACHE_TTL = 5 * 60 * 1000;

async function fetch3xuiReleases() {
  const now = Date.now();
  if (xuiReleasesCache && now - xuiReleasesCacheAt < XUI_CACHE_TTL) {
    return xuiReleasesCache;
  }
  const result = await run('curl', [
    '-fsSL', '-A', 'glass-panel',
    'https://api.github.com/repos/MHSanaei/3x-ui/releases?per_page=20',
  ], { timeout: 60000 });
  if (result.exitCode !== 0) {
    throw new Error('无法获取 3x-ui 发行版本：' + (result.stderr || result.stdout || '网络错误'));
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error('解析 3x-ui 发行版本失败');
  }
  const versions = (Array.isArray(data) ? data.map((r) => r.tag_name).filter(Boolean) : []);
  xuiReleasesCache = versions;
  xuiReleasesCacheAt = now;
  return versions;
}

async function fetch3xuiLatest() {
  const releases = await fetch3xuiReleases();
  return releases[0] || '';
}

function readXuiPort() {
  try {
    const env = fs.readFileSync('/etc/x-ui/install-result.env', 'utf8');
    const m = env.match(/^XUI_PANEL_PORT=(\S+)/m);
    if (m) return m[1].trim();
  } catch (e) {
    // ignore
  }
  try {
    const p = fs.readFileSync('/opt/glass-panel/data/3xui-port', 'utf8').trim();
    if (p) return p;
  } catch (e) {
    // ignore
  }
  return '2255';
}

// 自动反代成功后写入的网关信息，供「打开面板」按钮生成本机真实访问地址
const GATEWAY_FILE = '/opt/glass-panel/data/3xui-gateway.json';

function read3xuiGateway() {
  try {
    return JSON.parse(fs.readFileSync(GATEWAY_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function write3xuiGateway(info) {
  try {
    fs.mkdirSync(path.dirname(GATEWAY_FILE), { recursive: true });
    fs.writeFileSync(GATEWAY_FILE, JSON.stringify(info, null, 2), 'utf8');
  } catch (e) {
    // 写入失败不影响安装结果
  }
}

// 安装脚本在 /etc/x-ui/install-result.env 记录的官方访问地址（host:port）
function readXuiAccessHost() {
  try {
    const env = fs.readFileSync('/etc/x-ui/install-result.env', 'utf8');
    const m = env.match(/^XUI_ACCESS_URL=https?:\/\/([^/\s]+)/m);
    if (m) return m[1];
  } catch (e) {
    // ignore
  }
  return '';
}

// 安装脚本记录的隐藏路径（新装会被清空，历史安装可能残留）
function readXuiBasePath() {
  try {
    const env = fs.readFileSync('/etc/x-ui/install-result.env', 'utf8');
    const m = env.match(/^XUI_WEB_BASE_PATH=(\S+)/m);
    if (m) return m[1].trim();
  } catch (e) {
    // ignore
  }
  return '';
}

function build3xuiInstallScript(version, port) {
  return `#!/usr/bin/env bash
set -e
PORT="${port}"
mkdir -p /tmp/3xui-install
cd /tmp/3xui-install
rm -f install.sh
curl -fsSL -A "glass-panel" -o install.sh "https://raw.githubusercontent.com/MHSanaei/3x-ui/main/install.sh"
chmod +x install.sh
echo "=== 安装 3x-ui ${version}（端口 \${PORT}）==="
XUI_NONINTERACTIVE=1 XUI_PANEL_PORT="\${PORT}" bash install.sh "${version}"
# 安装脚本可能已存在安装，显式再设置一次端口确保一致
if [ -x /usr/local/x-ui/x-ui ]; then
  /usr/local/x-ui/x-ui setting -port "\${PORT}" >/dev/null 2>&1 || true
  # 非交互安装会随机生成隐藏路径，按面板反代约定收敛为根路径（https://域名 直接打开）
  /usr/local/x-ui/x-ui setting -webBasePath "/" >/dev/null 2>&1 || true
  systemctl restart x-ui || echo "[提示] x-ui 服务重启失败"
fi
mkdir -p /opt/glass-panel/data
echo "${version}" > "/opt/glass-panel/data/3xui-version"
echo "${port}" > "/opt/glass-panel/data/3xui-port"
echo "=== 3x-ui 安装完成 ==="
if [ -f /etc/x-ui/install-result.env ]; then
  echo "[面板] 访问信息："
  sed 's/^/  /' /etc/x-ui/install-result.env || true
fi
`;
}

function xuiUninstallLines() {
  return [
    'echo "=== 卸载 3x-ui ==="',
    'systemctl stop x-ui 2>/dev/null || true',
    'systemctl disable x-ui 2>/dev/null || true',
    'rm -f /etc/systemd/system/x-ui.service',
    'rm -rf /usr/local/x-ui /etc/x-ui /var/log/x-ui.log',
    'rm -f /opt/glass-panel/data/3xui-version /opt/glass-panel/data/3xui-port /opt/glass-panel/data/3xui-gateway.json',
    'systemctl daemon-reload',
    'echo "=== 3x-ui 卸载完成 ==="',
  ];
}

// ---- 3x-ui 面板集成缓存 ----
const XUI_CACHE_DIR = '/opt/glass-panel/packages/3x-ui';
// 面板集成提供最近 N 个版本（离线安装候选与一键同步范围）
const XUI_INTEGRATED_COUNT = 5;

function getCached3xuiVersions() {
  try {
    if (!fs.existsSync(XUI_CACHE_DIR)) return [];
    return fs.readdirSync(XUI_CACHE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      // 只统计完整缓存（含二进制包），与 is3xuiCached 判定保持一致，避免残留半成品目录被误认为已缓存
      .filter((name) => is3xuiCached(name))
      .sort((a, b) => compareVersions(b.replace(/^v/, ''), a.replace(/^v/, '')));
  } catch (e) {
    return [];
  }
}

function is3xuiCached(version) {
  const dir = path.join(XUI_CACHE_DIR, version);
  try {
    if (!fs.existsSync(dir)) return false;
    const files = fs.readdirSync(dir);
    return files.some((f) => f.endsWith('.tar.gz'));
  } catch (e) {
    return false;
  }
}

async function sync3xuiPackage(version) {
  const tag = version;
  const dir = path.join(XUI_CACHE_DIR, tag);
  // 清理历史同步中断留下的半成品目录，避免判定与实际内容不一致
  if (fs.existsSync(dir) && !is3xuiCached(tag)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });

  // 下载官方 install.sh
  const installShResult = await run('curl', [
    '-fsSL', '-A', 'glass-panel',
    '-o', path.join(dir, 'install.sh'),
    `https://raw.githubusercontent.com/MHSanaei/3x-ui/${tag}/install.sh`,
  ], { timeout: 60000 });
  if (installShResult.exitCode !== 0) {
    throw new Error('下载 install.sh 失败：' + (installShResult.stderr || '网络错误'));
  }

  // 检测架构并下载二进制包
  const archResult = await run('uname', ['-m']);
  const arch = (archResult.stdout || '').trim();
  const archMap = { x86_64: 'amd64', aarch64: 'arm64', armv7l: 'armv7' };
  const goarch = archMap[arch] || 'amd64';

  const binUrl = `https://github.com/MHSanaei/3x-ui/releases/download/${tag}/x-ui-linux-${goarch}.tar.gz`;
  const binResult = await run('curl', [
    '-fsSL', '-A', 'glass-panel',
    '-o', path.join(dir, `x-ui-linux-${goarch}.tar.gz`),
    binUrl,
  ], { timeout: 120000 });
  if (binResult.exitCode !== 0) {
    throw new Error(`下载 3x-ui ${tag} (${goarch}) 二进制包失败`);
  }

  return { version: tag, arch: goarch };
}

// 一键同步最近 N 个版本到面板缓存：已缓存的跳过，失败的记录原因，不因单个失败中断其余版本
async function sync3xuiLatest(count = XUI_INTEGRATED_COUNT) {
  const releases = await fetch3xuiReleases();
  const targets = releases.slice(0, count);
  const synced = [];
  const failed = [];
  for (const tag of targets) {
    if (is3xuiCached(tag)) {
      synced.push(tag);
      continue;
    }
    try {
      await sync3xuiPackage(tag);
      synced.push(tag);
    } catch (e) {
      failed.push({ version: tag, error: e.message });
    }
  }
  return { targets, synced, failed };
}

// 依赖安装辅助：优先系统源，回退到 EPEL / 官方源
function buildDepInstallStep() {
  return `
# === 依赖安装：优先系统源，无则尝试 EPEL ===
install_dep() {
  local dep="$1"
  if command -v dnf >/dev/null 2>&1; then
    if dnf list --installed "$dep" >/dev/null 2>&1; then
      echo "[面板] $dep 已安装"
      return 0
    fi
    if dnf install -y "$dep" 2>/dev/null; then
      echo "[面板] 从系统源安装 $dep 成功"
      return 0
    fi
    echo "[面板] 系统源无 $dep，尝试 EPEL..."
    dnf install -y epel-release 2>/dev/null || true
    if dnf --disablerepo=* --enablerepo=epel install -y "$dep" 2>/dev/null; then
      echo "[面板] 从 EPEL 安装 $dep 成功"
      return 0
    fi
    echo "[面板] $dep 安装失败（非关键依赖，继续）"
    return 1
  elif command -v apt-get >/dev/null 2>&1; then
    if dpkg -l "$dep" >/dev/null 2>&1; then
      echo "[面板] $dep 已安装"
      return 0
    fi
    apt-get update -qq 2>/dev/null || true
    if apt-get install -y "$dep" 2>/dev/null; then
      echo "[面板] 安装 $dep 成功"
      return 0
    fi
    echo "[面板] $dep 安装失败（非关键依赖，继续）"
    return 1
  fi
}

for dep in curl tar; do
  install_dep "$dep"
done
`;
}

// 面板集成安装脚本：使用本地缓存的包（不依赖 GitHub）
function build3xuiLocalInstallScript(version, port) {
  return `#!/usr/bin/env bash
set -e
PORT="${port}"
CACHE_DIR="${XUI_CACHE_DIR}/${version}"

# 检测架构
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  GOARCH="amd64" ;;
  aarch64) GOARCH="arm64" ;;
  armv7l)  GOARCH="armv7" ;;
  *)       echo "[面板] 不支持的架构: $ARCH"; exit 1 ;;
esac

echo "=== 安装 3x-ui ${version}（面板集成 / 端口 \${PORT} / 架构 \${GOARCH}）==="

# 检查缓存
if [ ! -f "$CACHE_DIR/x-ui-linux-$GOARCH.tar.gz" ]; then
  echo "[面板] 错误：未找到缓存的安装包（$CACHE_DIR/x-ui-linux-$GOARCH.tar.gz）"
  echo "[面板] 请先在面板中点击「同步缓存」下载该版本的安装包"
  exit 1
fi

${buildDepInstallStep()}

# 停止旧服务
systemctl stop x-ui 2>/dev/null || true

# 创建目录
mkdir -p /usr/local/x-ui /etc/x-ui

# 解压安装
cd /tmp
rm -rf /tmp/x-ui-local-install
mkdir -p /tmp/x-ui-local-install
cd /tmp/x-ui-local-install
tar xzf "$CACHE_DIR/x-ui-linux-$GOARCH.tar.gz"

# 移动文件
if [ -d x-ui ]; then
  cp -f x-ui/x-ui /usr/local/x-ui/ 2>/dev/null || true
  cp -f x-ui/bin/* /usr/local/x-ui/bin/ 2>/dev/null || true
  cp -f x-ui/xray-bin/* /usr/local/x-ui/bin/ 2>/dev/null || true
elif [ -f x-ui ]; then
  cp -f x-ui /usr/local/x-ui/
fi
chmod +x /usr/local/x-ui/x-ui 2>/dev/null || true
chmod +x /usr/local/x-ui/bin/* 2>/dev/null || true

# 写入 systemd 服务
cat > /etc/systemd/system/x-ui.service << 'SERVICEEOF'
[Unit]
Description=x-ui service
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/x-ui/x-ui
Restart=on-failure

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable x-ui

# 设置端口
if [ -x /usr/local/x-ui/x-ui ]; then
  /usr/local/x-ui/x-ui setting -port "\${PORT}" >/dev/null 2>&1 || true
  # 非交互安装会随机生成隐藏路径，按面板反代约定收敛为根路径（https://域名 直接打开）
  /usr/local/x-ui/x-ui setting -webBasePath "/" >/dev/null 2>&1 || true
fi

# 启动服务
systemctl start x-ui || echo "[提示] x-ui 服务启动失败"

# 写入面板标记
mkdir -p /opt/glass-panel/data
echo "${version}" > "/opt/glass-panel/data/3xui-version"
echo "${port}" > "/opt/glass-panel/data/3xui-port"

echo "=== 3x-ui ${version} 安装完成（面板集成）==="
if [ -f /etc/x-ui/install-result.env ]; then
  echo "[面板] 访问信息："
  sed 's/^/  /' /etc/x-ui/install-result.env || true
fi

# 清理
rm -rf /tmp/x-ui-local-install
`;
}

// 由具体版本号反推 release 键（8.5.10 → 8.5；ffmpeg / fail2ban 的版本号即 release）
function releaseOf(key, version) {
  if (key === 'ffmpeg' || key === 'fail2ban') return version;
  return version.split('.').slice(0, 2).join('.');
}

// 当前 release 配置的最新可用版本（源码编译 / pip），无配置返回空
function latestTargetVersion(key, installed) {
  const release = releaseOf(key, installed);
  const source = (SOURCE_BUILD[key] || {})[release];
  if (source) return source;
  const pip = (PIP_INSTALL[key] || {})[release];
  if (pip) return pip.split('==')[1] || '';
  return '';
}

// 源码编译安装结果对应的 systemd 服务名（php → php-fpm-8.5，redis → redis-8.0）
function compiledServiceName(key, version) {
  const major = version.replace(/\.\d+$/, '');
  if (key === 'php') return `php-fpm-${major}`;
  if (key === 'redis') return `redis-${major}`;
  if (key === 'fail2ban') return 'fail2ban';
  return '';
}

// 生成 PHP 源码编译安装脚本（写盘后由 bash 执行）
function buildPhpCompileScript(release, version) {
  const prefix = `/usr/local/php/${version}`;
  const major = version.replace(/\.\d+$/, ''); // 8.5.10 → 8.5，系统服务名按大版本
  const serviceUnit = `php-fpm-${major}`;
  const workDir = `/opt/phpbuild/php-${version}`;
  const markDir = path.dirname(PHP_COMPILE_MARKER);
  return `#!/usr/bin/env bash
set -e
PHP_VERSION="${version}"
PREFIX="${prefix}"
WORK="${workDir}"
mkdir -p "\${WORK}"
cd "\${WORK}"

if [ ! -f "php-\${PHP_VERSION}.tar.gz" ]; then
  curl -fSL -o "php-\${PHP_VERSION}.tar.gz" "https://www.php.net/distributions/php-\${PHP_VERSION}.tar.gz"
fi

# 编译与 remi 模块无关；已启用的 php:remi-8.5 缺少 platform:el9 会导致 dnf 失败，先复位
dnf module reset php -y >/dev/null 2>&1 || true
dnf module disable php -y >/dev/null 2>&1 || true

# 构建依赖（幂等）
dnf -y install dnf-plugins-core >/dev/null 2>&1
dnf -y groupinstall "Development Tools" "Development Libraries" >/dev/null 2>&1 || true
dnf -y install gcc gcc-c++ make autoconf pkgconfig libxml2-devel openssl-devel oniguruma-devel bzip2-devel libcurl-devel libicu-devel sqlite-devel zlib-devel readline-devel file libtool lksctp-tools-devel >/dev/null

tar xzf "php-\${PHP_VERSION}.tar.gz"
cd "php-\${PHP_VERSION}"

if [ ! -f Makefile ]; then
  ./configure \\
    --prefix="\${PREFIX}" \\
    --with-config-file-path="\${PREFIX}/etc" \\
    --with-config-file-scan-dir="\${PREFIX}/etc/conf.d" \\
    --enable-fpm --with-fpm-user=nobody --with-fpm-group=nobody \\
    --enable-mbstring --enable-bcmath --enable-opcache \\
    --with-pdo-mysql --with-mysqli --with-pdo-sqlite \\
    --with-curl --with-openssl --with-zlib --with-bz2 \\
    --enable-sockets --enable-pcntl --enable-intl
fi

if [ ! -f "\${PREFIX}/bin/php" ]; then
  make -j"\$(nproc)"
  make install
fi

mkdir -p "\${PREFIX}/etc/conf.d"
if [ ! -f "\${PREFIX}/etc/php.ini" ]; then
  cp php.ini-production "\${PREFIX}/etc/php.ini"
fi

# php-fpm 配置：自带的 php-fpm.conf.default 中 include 是被注释的相对路径，
# 直接复制会导致 fpm 找不到 pool 与日志路径而启动失败，这里生成确定性的绝对路径配置
phpFpmConf="\${PREFIX}/etc/php-fpm.conf"
phpFpmD="\${PREFIX}/etc/php-fpm.d"
mkdir -p "\${phpFpmD}" "\${PREFIX}/var/log" "\${PREFIX}/var/run"
if [ ! -f "\${phpFpmConf}" ]; then
  cat > "\${phpFpmConf}" <<EOS
[global]
error_log = ${prefix}/var/log/php-fpm.log
pid = ${prefix}/var/run/php-fpm.pid
daemonize = no
include = ${prefix}/etc/php-fpm.d/*.conf
EOS
fi
# 兼容旧版本已复制的默认配置：补齐 include 与 error_log
grep -q "^include" "\${phpFpmConf}" || echo "include = \${phpFpmD}/*.conf" >> "\${phpFpmConf}"
grep -q "^error_log" "\${phpFpmConf}" || echo "error_log = \${PREFIX}/var/log/php-fpm.log" >> "\${phpFpmConf}"
if [ ! -f "\${phpFpmD}/www.conf" ]; then
  cat > "\${phpFpmD}/www.conf" <<EOS
[www]
user = nobody
group = nobody
listen = 127.0.0.1:9001
listen.allowed_clients = 127.0.0.1
pm = dynamic
pm.max_children = 20
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 5
pm.max_requests = 500
EOS
fi
sed -i "s#^listen = .*#listen = 127.0.0.1:9001#" "\${phpFpmD}/www.conf" 2>/dev/null || true

# systemd 服务
cat > /etc/systemd/system/${serviceUnit}.service <<'EOS'
[Unit]
Description=PHP-FPM ${version}
After=network.target
[Service]
Type=simple
ExecStart=${prefix}/sbin/php-fpm --nodaemonize --fpm-config=${prefix}/etc/php-fpm.conf
ExecReload=/bin/kill -USR2 $MAINPID
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOS
systemctl daemon-reload
systemctl enable ${serviceUnit} >/dev/null 2>&1 || true

mkdir -p "${markDir}"
echo "${version}" > "${PHP_COMPILE_MARKER}"

echo "=== BUILD OK: PHP \${PHP_VERSION} → \${PREFIX} ==="
"\${PREFIX}/bin/php" -v

# 启动服务（失败仅提示，不影响安装结果，便于面板上手动排查）
"\${PREFIX}/sbin/php-fpm" -t || echo "[提示] php-fpm 配置校验失败"
systemctl restart ${serviceUnit} || echo "[提示] ${serviceUnit} 启动失败，请检查 \${PREFIX}/var/log/php-fpm.log"
systemctl is-active ${serviceUnit} || true
`;
}

// ---- 任务脚本构建 ----
// 所有安装/更新/卸载都转成 bash 脚本交给 jobService 后台执行，输出实时落盘供前端展示终端

// MySQL 数据目录降级自愈：面板卸载不会删除 /var/lib/mysql，若此前装过更高版本（如 8.4）
// 再由系统源装回低版本（如 8.0.46），mysqld 会报 "Invalid MySQL server downgrade" 启动失败，
// 面板就显示「已安装但服务 inactive」。此处检测到该情况时备份旧数据目录并重建。
function mysqlDowngradeHealLines() {
  return [
    '',
    'if [ "$(systemctl is-active mysqld 2>/dev/null)" != "active" ]; then',
    '  ERRLOG=$(ls -t /var/lib/mysql/*.err /var/log/mysqld.log 2>/dev/null | head -1)',
    '  if [ -n "$ERRLOG" ] && grep -q "Invalid MySQL server downgrade" "$ERRLOG"; then',
    '    TS=$(date +%Y%m%d%H%M%S)',
    '    echo "[面板] 数据目录由更高版本 MySQL 初始化，不支持降级："',
    '    grep -o "Cannot downgrade from [0-9]* to [0-9]*" "$ERRLOG" | head -1 || true',
    '    echo "[面板] 备份旧数据目录 → /var/lib/mysql.bak.$TS"',
    '    mv /var/lib/mysql "/var/lib/mysql.bak.$TS"',
    '    mkdir -p /var/lib/mysql',
    '    chown mysql:mysql /var/lib/mysql',
    '    chmod 750 /var/lib/mysql',
    '    if systemctl start mysqld >/dev/null 2>&1; then',
    '      echo "[面板] 数据目录已重建，服务 mysqld 已启动"',
    '    else',
    '      echo "[面板] 服务 mysqld 仍启动失败，请查看 /var/lib/mysql/*.err"',
    '    fi',
    '  fi',
    'fi',
  ];
}

// 启用并启动服务的脚本片段（失败仅提示，不中断任务）
function enableServiceLines(service, key) {
  if (!service) return [];
  const lines = [
    `if systemctl enable --now ${service} >/dev/null 2>&1; then`,
    `  echo "[提示] 服务 ${service} 已启动"`,
    'else',
    `  echo "[提示] 服务 ${service} 启动失败，可在对应页面手动启动"`,
    'fi',
  ];
  if (key === 'mysql') lines.push(...mysqlDowngradeHealLines());
  return lines;
}

// 包管理器安装脚本（dnf/yum/apt）
function buildPackageInstallScript(installLine, service, key) {
  return `#!/usr/bin/env bash
set -e
${installLine}
${enableServiceLines(service, key).join('\n')}
`;
}

// 软件源（第三方官方源）安装脚本。
// 安装前先用 tsflags=test 做依赖预检：依赖不满足时按「系统源优先」策略回退到系统发行版源安装；
// 系统源也没有该包时才中止。例：nginx 官方 el9 包要求 libssl.so.3(OPENSSL_3.2.0/3.5.0)，
// 而 alinux4 全仓库只有 openssl 3.0.12，官方包必然装不上，此时回退系统源的 nginx。
function buildOfficialSourceInstallScript({ precheckLine, installLine, fallbackLine, fallbackPkg, disable, service, key }) {
  const disableOpt = disable ? `--disablerepo=${disable} ` : '';
  return `#!/usr/bin/env bash
set -e

echo "=== 安装前依赖预检（软件源）==="
PRECHECK_LOG=/tmp/panel-dep-precheck.log
if ${precheckLine} >"$PRECHECK_LOG" 2>&1; then
  echo "[面板] 依赖预检通过，从软件源安装"
  ${installLine}
else
  echo "[面板] 软件源依赖不满足："
  grep -E 'nothing provides|conflicts between|Problem:' "$PRECHECK_LOG" | head -5 || true
  if dnf -q ${disableOpt}list ${fallbackPkg} 2>/dev/null | grep -q "^${fallbackPkg}\\."; then
    echo "[面板] 系统源存在该软件包，按系统源优先策略回退安装"
    ${fallbackLine}
  else
    echo "[面板] 系统源也没有该软件包，安装中止"
    rm -f "$PRECHECK_LOG"
    exit 1
  fi
fi
rm -f "$PRECHECK_LOG"

${enableServiceLines(service, key).join('\n')}
`;
}

// 生成 Fail2ban 源码安装脚本。
// 不走 EPEL9 RPM：其 fail2ban-server 依赖 python(abi)=3.9（el9 系统 python），
// alinux4 只有 python3.11，依赖预检必然失败；且 RPM 会把包装进
// /usr/lib/python3.9/site-packages，python3.11 无法 import。
// 三个必须显式处理的点（均为本机实测结论）：
// 1) banaction 必须写 iptables-multiport —— EPEL/发行版默认走 firewallcmd-*，而本机
//    firewalld inactive，会导致 jail 看似正常但一条封禁规则都下不去（静默失效）；
// 2) backend 显式用 polling + /var/log/secure —— 无需 python3-systemd（rsyslog 已在运行）；
// 3) mode 不能用 aggressive —— 本机跨境链路丢包会产生 "Connection closed by <HOST> [preauth]"，
//    aggressive 会匹配该行，把面板自己的出口 IP 封掉。
function buildFail2banCompileScript(version) {
  const serviceUnit = 'fail2ban';
  const workDir = `/opt/fail2banbuild/fail2ban-${version}`;
  const marker = INSTALL_MARKERS.fail2ban;
  return `#!/usr/bin/env bash
set -e
F2B_VERSION="${version}"
WORK="${workDir}"
mkdir -p "\${WORK}"
cd "\${WORK}"

if [ ! -f "src.tar.gz" ]; then
  curl -fSL -o src.tar.gz "https://codeload.github.com/fail2ban/fail2ban/tar.gz/refs/tags/\${F2B_VERSION}" \\
    || curl -fSL -o src.tar.gz "https://github.com/fail2ban/fail2ban/archive/refs/tags/\${F2B_VERSION}.tar.gz"
fi
rm -rf "fail2ban-\${F2B_VERSION}"
tar xzf src.tar.gz
cd "fail2ban-\${F2B_VERSION}"

echo "=== 安装 Fail2ban \${F2B_VERSION} 到 /usr/local（\$(python3 -V 2>&1)）==="
# 必须显式 --install-lib：默认的 /usr/local/lib/pythonX.Y/site-packages 不在 alinux4
# 自带 python 的 sys.path 上，装进去会 import fail2ban 失败
PYLIB=\$(python3 -c 'import sysconfig;print(sysconfig.get_paths()["purelib"])')
echo "[面板] python 第三方包目录：\${PYLIB}"
python3 setup.py install --prefix=/usr/local --install-lib="\${PYLIB}" >/dev/null
# 上游 setup.py 会把生成的服务单元写到 bin 目录，本脚本自带单元，清掉避免混淆
rm -f /usr/local/bin/fail2ban.service /usr/local/bin/fail2ban-openrc.init

mkdir -p /etc/fail2ban /var/lib/fail2ban /run/fail2ban

echo "=== 写入 /etc/fail2ban/jail.local ==="
cat > /etc/fail2ban/jail.local <<'EOS'
[DEFAULT]
# 回环与阿里云 Workbench 内网段放行，作为误封后的兜底通道
ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10
# 本机 firewalld 未运行，必须显式走 iptables，否则封禁静默失效
banaction = iptables-multiport
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
# 22 与 2222 并行监听，默认只覆盖 22，必须显式补齐
port = 22,2222
filter = sshd
# 显式 polling + /var/log/secure：不依赖 python3-systemd
backend = polling
logpath = /var/log/secure
# 不能用 aggressive：链路丢包会误判并封禁自己
mode = normal
EOS

# 把最近若干次成功登录 SSH 的来源 IP 加入白名单（取最近 5 个不同 IP），确保运维自己能连通
OPIPS=\$(grep ' Accepted ' /var/log/secure 2>/dev/null | tail -300 | sed -n 's/.* from \\([0-9a-fA-F.:]*\\) port.*/\\1/p' | tac | awk '!seen[\$0]++' | head -5 | tr '\\n' ' ')
if [ -n "\$OPIPS" ]; then
  sed -i "s#^ignoreip = .*#& \$OPIPS#" /etc/fail2ban/jail.local
  echo "[面板] 最近成功登录来源 IP 已加入 ignoreip 白名单：\$OPIPS"
fi

echo "=== 注册 systemd 服务 ==="
cat > /etc/systemd/system/${serviceUnit}.service <<'EOS'
[Unit]
Description=Fail2ban Service (panel build)
After=network.target

[Service]
Type=simple
Environment="PYTHONNOUSERSITE=1"
ExecStartPre=/bin/mkdir -p /run/fail2ban
ExecStart=/usr/local/bin/fail2ban-server -c /etc/fail2ban -xf start
ExecStop=/usr/local/bin/fail2ban-client -c /etc/fail2ban stop
ExecReload=/usr/local/bin/fail2ban-client -c /etc/fail2ban reload
PIDFile=/run/fail2ban/fail2ban.pid
Restart=on-failure
RestartPreventExitStatus=0 255

[Install]
WantedBy=multi-user.target
EOS
systemctl daemon-reload
systemctl enable ${serviceUnit} >/dev/null 2>&1 || true

mkdir -p "$(dirname "${marker}")"
echo "${version}" > "${marker}"

echo "=== 启动 Fail2ban 并复验 ==="
systemctl restart ${serviceUnit} || echo "[提示] fail2ban 启动失败，请查看 journalctl -u fail2ban"
sleep 3
systemctl is-active ${serviceUnit} || true
/usr/local/bin/fail2ban-client -c /etc/fail2ban --version || true
/usr/local/bin/fail2ban-client -c /etc/fail2ban status sshd || echo "[提示] sshd jail 暂未生效，请查看 journalctl -u fail2ban"
echo "[面板] sshd jail 白名单："
/usr/local/bin/fail2ban-client -c /etc/fail2ban get sshd ignoreip || true
echo "[面板] 当前 iptables 中的 f2b 规则："
iptables -S 2>/dev/null | grep -i f2b || echo "[面板] 暂无（需有攻击触发封禁后才生成）"
echo "=== INSTALL OK: Fail2ban \${F2B_VERSION} ==="
`;
}

// fail2ban 卸载专用：先停服务再清理 iptables 封禁链。
// 卸载不会自动删除 f2b-* 链及其 DROP 规则，残留规则可能把本机 IP 永久拒之门外。
function fail2banUninstallLines() {
  return [
    'echo "=== 停止 fail2ban 并清理 iptables 封禁规则 ==="',
    'systemctl stop fail2ban 2>/dev/null || true',
    'systemctl disable fail2ban 2>/dev/null || true',
    'for ch in $(iptables -S 2>/dev/null | sed -n "s/^-N \\(f2b-.*\\)$/\\1/p"); do',
    '  echo "[面板] 清理 iptables 链 $ch"',
    '  iptables -F "$ch" 2>/dev/null || true',
    '  iptables -X "$ch" 2>/dev/null || true',
    'done',
    'for ch in $(iptables -S INPUT 2>/dev/null | sed -n "s/^-A INPUT -j \\(f2b-.*\\)$/\\1/p"); do',
    '  echo "[面板] 移除 INPUT 跳转规则 → $ch"',
    '  iptables -D INPUT -j "$ch" 2>/dev/null || true',
    'done',
    'iptables -S 2>/dev/null | grep -i f2b || echo "[面板] 已无 f2b 残留规则"',
    'echo "=== 清理面板托管的 fail2ban 配置与状态 ==="',
    'for f in /opt/glass-panel/data/fail2ban-sites.json /opt/glass-panel/data/fail2ban-services.json \\',
    '         /opt/glass-panel/data/fail2ban-whitelist.json /opt/glass-panel/data/fail2ban-blacklist.json \\',
    '         /opt/glass-panel/data/fail2ban-blacklist.log \\',
    '         /etc/fail2ban/filter.d/panel-blacklist.conf /etc/fail2ban/filter.d/panel-nginx-404.conf; do',
    '  if [ -e "$f" ]; then',
    '    echo "[面板] 删除 $f"',
    '    rm -f "$f"',
    '  fi',
    'done',
  ];
}

// 源码编译 / pip 安装对应的具体版本号（用于安装成功后写标记文件），非此类安装返回空
function markerVersionFor(key, version) {
  const m = /^官方:(.+)$/.exec(String(version || ''));
  if (!m) return '';
  const release = m[1];
  if ((SOURCE_BUILD[key] || {})[release]) return SOURCE_BUILD[key][release];
  const pip = (PIP_INSTALL[key] || {})[release];
  if (pip) return pip.split('==')[1] || '';
  return '';
}

// 包管理器安装的软件：dnf remove 只删包内文件，不会删运行时产生的目录（数据/配置/日志/缓存）。
// 这些残留会在重装时引发问题（典型：MySQL 旧数据目录导致降级失败、服务启动不了），故卸载时一并清理。
const UNINSTALL_DIRS = {
  nginx: ['/etc/nginx', '/var/log/nginx', '/var/cache/nginx', '/var/lib/nginx', '/var/www'],
  mysql: [
    '/var/lib/mysql',
    '/var/lib/mysql.bak.*',
    '/var/lib/mysql-files',
    '/var/log/mysqld.log',
    '/var/run/mysqld',
    '/etc/my.cnf',
    '/etc/my.cnf.d',
  ],
  redis: ['/etc/redis', '/etc/redis.conf', '/var/lib/redis', '/var/log/redis', '/var/run/redis'],
  supervisor: [
    '/etc/supervisord.conf',
    '/etc/supervisord.d',
    '/var/lib/supervisor',
    '/var/log/supervisor',
    '/var/run/supervisor',
  ],
  php: [],
  ffmpeg: [],
  fail2ban: ['/etc/fail2ban', '/var/lib/fail2ban', '/var/log/fail2ban.log', '/run/fail2ban'],
};

// 卸载时清理应用运行时目录（数据/配置/日志/缓存）
function runtimeCleanupLines(key) {
  const dirs = UNINSTALL_DIRS[key] || [];
  if (!dirs.length) return [];
  return [
    'echo "=== 清理运行时目录（数据/配置/日志/缓存）==="',
    ...dirs.map((d) => `echo "[面板] 删除 ${d}"`),
    `rm -rf ${dirs.join(' ')} 2>/dev/null || true`,
    'echo "[面板] 运行时目录清理完成"',
  ];
}

// 源码编译 / pip 安装产物的清理脚本片段（含停止服务、删除目录与标记）
function compiledCleanupLines(key) {
  const marker = readMarker(key);
  if (!marker) return [];
  const linkHelper = [
    'clean_link() {',
    '  dir="$1"; shift',
    '  for b in "$@"; do',
    '    if [ -L "$dir/$b" ] && [ ! -e "$dir/$b" ]; then rm -f "$dir/$b"; fi',
    '  done',
    '}',
  ];
  const unit = compiledServiceName(key, marker);
  const bodies = {
    php: [
      `echo "[面板] 停止并移除服务 ${unit}"`,
      `systemctl stop ${unit} 2>/dev/null || true`,
      `systemctl disable ${unit} 2>/dev/null || true`,
      `rm -f /etc/systemd/system/${unit}.service`,
      `rm -rf /etc/systemd/system/${unit}.service.d`,
      'systemctl daemon-reload',
      `echo "[面板] 删除编译目录 /usr/local/php/${marker}"`,
      `rm -rf /usr/local/php/${marker}`,
      `echo "[面板] 删除编译工作目录 /opt/phpbuild/php-${marker}"`,
      `rm -rf /opt/phpbuild/php-${marker}`,
    ],
    redis: [
      `echo "[面板] 停止并移除服务 ${unit}"`,
      `systemctl stop ${unit} 2>/dev/null || true`,
      `systemctl disable ${unit} 2>/dev/null || true`,
      `rm -f /etc/systemd/system/${unit}.service`,
      `rm -rf /etc/systemd/system/${unit}.service.d`,
      'systemctl daemon-reload',
      `echo "[面板] 删除编译目录与配置/数据目录"`,
      `rm -rf /usr/local/redis/${marker} /etc/redis-${marker} /var/lib/redis-${marker} /var/log/redis-${marker}`,
      `echo "[面板] 删除编译工作目录 /opt/redisbuild/redis-${marker}"`,
      `rm -rf /opt/redisbuild/redis-${marker}`,
      'echo "[面板] 清理软链接"',
      'clean_link /usr/bin redis-cli redis-server redis-sentinel',
    ],
    supervisor: [
      'echo "[面板] 停止并移除服务 supervisord"',
      'systemctl stop supervisord 2>/dev/null || true',
      'systemctl disable supervisord 2>/dev/null || true',
      'rm -f /etc/systemd/system/supervisord.service',
      'systemctl daemon-reload',
      'echo "[面板] 卸载 pip 包 supervisor"',
      'pip3 uninstall -y supervisor >/dev/null 2>&1 || true',
      'rm -f /etc/supervisord.conf /etc/systemd/system/supervisord.service.d',
      'echo "[面板] 清理软链接"',
      'clean_link /usr/bin supervisord supervisorctl',
    ],
    ffmpeg: [
      `echo "[面板] 删除编译目录 /usr/local/ffmpeg/${marker}"`,
      `rm -rf /usr/local/ffmpeg/${marker}`,
      `echo "[面板] 删除编译工作目录 /opt/ffmpegbuild/ffmpeg-${marker}"`,
      `rm -rf /opt/ffmpegbuild/ffmpeg-${marker}`,
      'echo "[面板] 清理软链接"',
      'clean_link /usr/local/bin ffmpeg ffprobe',
    ],
    fail2ban: [
      `echo "[面板] 停止并移除服务 ${unit}"`,
      `systemctl stop ${unit} 2>/dev/null || true`,
      `systemctl disable ${unit} 2>/dev/null || true`,
      `rm -f /etc/systemd/system/${unit}.service`,
      'systemctl daemon-reload',
      'echo "[面板] 卸载 python 安装包与命令"',
      // python 包装在系统 purelib（--install-lib 指定），/usr/local 是历史写法，两处都清
      'rm -rf /usr/local/lib/python3.*/site-packages/fail2ban* /usr/lib/python3.*/site-packages/fail2ban* 2>/dev/null || true',
      'rm -f /usr/local/bin/fail2ban-client /usr/local/bin/fail2ban-server /usr/local/bin/fail2ban-regex 2>/dev/null || true',
      `echo "[面板] 删除编译工作目录 /opt/fail2banbuild/fail2ban-${marker}"`,
      `rm -rf /opt/fail2banbuild/fail2ban-${marker}`,
      'echo "[面板] 清理软链接"',
      'clean_link /usr/local/bin fail2ban-client fail2ban-server fail2ban-regex',
    ],
  };
  const body = bodies[key];
  if (!body) return [];
  const lines = [
    `echo "=== 清理源码编译产物（版本 ${marker}）==="`,
    ...body,
    `echo "[面板] 删除版本标记文件"`,
    `rm -f ${INSTALL_MARKERS[key]}`,
  ];
  // php 无需处理软链接，其余工具用 clean_link 清理失效链接
  return key === 'php' ? lines : [...linkHelper, ...lines];
}

// 更新后处理：迁移配置/数据 → 重启服务 → 清理旧版本目录
function buildPostUpdateScript(key, from, to) {
  const lines = ['', 'echo "=== 迁移配置并重启服务 ==="'];
  if (key === 'php') {
    lines.push(`[ -f "/usr/local/php/${from}/etc/php.ini" ] && cp -f "/usr/local/php/${from}/etc/php.ini" "/usr/local/php/${to}/etc/php.ini" || true`);
    lines.push(`[ -d "/usr/local/php/${from}/etc/php-fpm.d" ] && cp -rf "/usr/local/php/${from}/etc/php-fpm.d/." "/usr/local/php/${to}/etc/php-fpm.d/" || true`);
  }
  if (key === 'redis') {
    lines.push(`[ -d "/var/lib/redis-${from}" ] && cp -a "/var/lib/redis-${from}/." "/var/lib/redis-${to}/" || true`);
  }
  const service = key === 'supervisor' ? 'supervisord' : compiledServiceName(key, to);
  if (service) lines.push(`systemctl restart ${service} || echo "[警告] 服务 ${service} 重启失败"`);
  const oldBin = {
    php: `/usr/local/php/${from}`,
    redis: `/usr/local/redis/${from}`,
    ffmpeg: `/usr/local/ffmpeg/${from}`,
  }[key];
  if (oldBin) lines.push(`rm -rf ${oldBin}`);
  return lines.join('\n');
}

// 根据所选版本生成对应的安装脚本与任务名
async function buildInstallScript(key, version, config = {}) {
  const app = APPS.find((a) => a.key === key);
  if (!app) throw new Error('未知应用');

  // 3x-ui：支持两种安装源（GitHub 官方 / 面板集成缓存）
  if (key === '3x-ui') {
    let tag = version;
    if (!tag || tag === 'latest') tag = await fetch3xuiLatest();
    if (!tag) throw new Error('无法获取 3x-ui 最新版本');
    const port = String(config.port || readXuiPort() || '2255');
    const source = String(config.source || 'github');

    if (source === 'panel') {
      // 面板集成安装：使用本地缓存，不依赖 GitHub 网络
      if (!is3xuiCached(tag)) {
        throw new Error(`版本 ${tag} 尚未缓存到面板，请在安装弹窗中点击「同步缓存」，或使用「一键同步最近五个版本」下载后重试`);
      }
      return { script: build3xuiLocalInstallScript(tag, port), label: `安装 3x-ui ${tag}（面板集成）` };
    }
    // GitHub 官方安装
    return { script: build3xuiInstallScript(tag, port), label: `安装 3x-ui ${tag}` };
  }

  const pkg = detectPkgManager();
  const officialSelected = /^官方:(.+)$/.exec(String(version || ''));

  if (officialSelected && app.hasOfficial) {
    const release = officialSelected[1];
    if (pkg !== 'dnf' && pkg !== 'yum') throw new Error('官方源当前仅支持 RHEL/dnf 系系统');
    // 无二进制包的版本优先走源码编译 / pip 安装（不触碰 dnf 仓库与模块流）
    if ((SOURCE_BUILD[key] || {})[release]) {
      if (key === 'php') return { script: buildPhpCompileScript(release, SOURCE_BUILD.php[release]), label: `编译安装 PHP ${SOURCE_BUILD.php[release]}` };
      if (key === 'redis') return { script: buildRedisCompileScript(SOURCE_BUILD.redis[release]), label: `编译安装 Redis ${SOURCE_BUILD.redis[release]}` };
      if (key === 'ffmpeg') return { script: buildFfmpegCompileScript(SOURCE_BUILD.ffmpeg[release]), label: `编译安装 FFmpeg ${SOURCE_BUILD.ffmpeg[release]}` };
      if (key === 'fail2ban') return { script: buildFail2banCompileScript(SOURCE_BUILD.fail2ban[release]), label: `编译安装 Fail2ban ${SOURCE_BUILD.fail2ban[release]}` };
    }
    if ((PIP_INSTALL[key] || {})[release]) {
      return { script: buildSupervisorInstallScript(PIP_INSTALL.supervisor[release]), label: `pip 安装 Supervisor ${PIP_INSTALL.supervisor[release]}` };
    }
    const configure = { nginx: official.configureNginx, mysql: official.configureMysql, php: official.configurePhp };
    const cfg = await configure[key](release);
    const binName = app.officialPackage || app.package;
    const cmd = pkg === 'dnf' ? 'dnf' : 'yum';
    const srcOpts = key === 'php'
      ? (cfg.dnfArgs || []).join(' ')
      : `--setopt=${cfg.repo}.priority=1 --enablerepo=${cfg.repo}`;
    const installLine = key === 'php'
      ? `${cmd} ${srcOpts} install -y ${binName}`
      : `${cmd} install -y ${srcOpts} ${binName}`;
    // 依赖预检：与真实安装同源同包，仅做事务测试不落盘
    const precheckLine = key === 'php'
      ? `${cmd} ${srcOpts} -y --setopt=tsflags=test install ${binName}`
      : `${cmd} install -y --setopt=tsflags=test ${srcOpts} ${binName}`;
    // 预检失败时回退到系统发行版源（排除面板托管的官方源）
    const repos = official.officialRepoIds(key);
    const disable = repos.join(',');
    const fallbackLine = `${cmd} install -y ${disable ? `--disablerepo=${disable} ` : ''}${app.package}`;
    return {
      script: buildOfficialSourceInstallScript({
        precheckLine, installLine, fallbackLine, fallbackPkg: app.package, disable, service: app.service, key,
      }),
      label: `安装 ${app.name} ${release}`,
    };
  }

  // 系统仓库版本
  const target = version && version !== 'latest' && version !== 'auto'
    ? (pkg === 'apt' ? `${app.package}=${version}` : `${app.package}-${version}`)
    : app.package;
  if (pkg === 'dnf' || pkg === 'yum') {
    // 显式禁用面板托管的官方源：否则系统包会与官方包混装（如 alinux 的 mysql-server
    // 依赖 mysql → 被解析到 mysql-community-client，与 mysql-server 同带
    // /usr/bin/mysql_migrate_keyring，导致 transaction test 冲突失败）
    const repos = official.officialRepoIds(key);
    const disable = repos.length ? `--disablerepo=${repos.join(',')} ` : '';
    return { script: buildPackageInstallScript(`${pkg} install -y ${disable}${target}`, app.service, key), label: `安装 ${app.name}` };
  }
  if (pkg === 'apt') {
    return { script: buildPackageInstallScript(`apt-get update && apt-get install -y ${target}`, app.service, key), label: `安装 ${app.name}` };
  }
  throw new Error('未检测到支持的包管理器');
}

function writeMarker(key, version) {
  const p = INSTALL_MARKERS[key];
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${version}\n`, 'utf8');
}

// 生成 Redis 源码编译安装脚本（官方仓库无 el9 的 redis 二进制包）
function buildRedisCompileScript(version) {
  const prefix = `/usr/local/redis/${version}`;
  const serviceUnit = compiledServiceName('redis', version);
  const confDir = `/etc/redis-${version}`;
  const dataDir = `/var/lib/redis-${version}`;
  const logDir = `/var/log/redis-${version}`;
  const port = 6380; // 与系统源 redis(6379) 并存
  return `#!/usr/bin/env bash
set -e
VERSION="${version}"
PREFIX="${prefix}"
WORK="/opt/redisbuild"
mkdir -p "\${WORK}"
cd "\${WORK}"
if [ ! -f "redis-\${VERSION}.tar.gz" ]; then
  curl -fSL -o "redis-\${VERSION}.tar.gz" "https://download.redis.io/releases/redis-\${VERSION}.tar.gz"
fi
dnf -y install gcc gcc-c++ make >/dev/null
tar xzf "redis-\${VERSION}.tar.gz"
cd "redis-\${VERSION}"
if [ ! -f "\${PREFIX}/bin/redis-server" ]; then
  make -j"\$(nproc)" MALLOC=libc
  make PREFIX="\${PREFIX}" install
fi

mkdir -p "${confDir}" "${dataDir}" "${logDir}"
if [ ! -f "${confDir}/redis.conf" ]; then
  cp redis.conf "${confDir}/redis.conf"
fi
sed -i "s#^port .*#port ${port}#" "${confDir}/redis.conf"
sed -i "s#^dir .*#dir ${dataDir}#" "${confDir}/redis.conf"
sed -i "s#^logfile .*#logfile ${logDir}/redis.log#" "${confDir}/redis.conf"
sed -i "s#^daemonize .*#daemonize no#" "${confDir}/redis.conf"
sed -i "s#^bind .*#bind 127.0.0.1#" "${confDir}/redis.conf" || true

cat > /etc/systemd/system/${serviceUnit}.service <<EOS
[Unit]
Description=Redis ${version}
After=network.target

[Service]
Type=simple
ExecStart=${prefix}/bin/redis-server ${confDir}/redis.conf
ExecStop=${prefix}/bin/redis-cli -p ${port} shutdown nosave
Restart=always
LimitNOFILE=10032

[Install]
WantedBy=multi-user.target
EOS
systemctl daemon-reload
systemctl enable ${serviceUnit} >/dev/null 2>&1 || true

# 面板统一按 /usr/bin 调用 redis-cli / redis-server，系统源未安装时才补链接
[ -e /usr/bin/redis-cli ] || ln -sf "${prefix}/bin/redis-cli" /usr/bin/redis-cli
[ -e /usr/bin/redis-server ] || ln -sf "${prefix}/bin/redis-server" /usr/bin/redis-server
[ -e /usr/bin/redis-sentinel ] || ln -sf "${prefix}/bin/redis-sentinel" /usr/bin/redis-sentinel

echo "${version}" > "${INSTALL_MARKERS.redis}"
echo "=== BUILD OK: Redis \${VERSION} → \${PREFIX} (端口 ${port}) ==="
"\${PREFIX}/bin/redis-server" --version
`;
}

// 生成 FFmpeg 源码编译安装脚本（官方只提供源码包）
function buildFfmpegCompileScript(version) {
  const prefix = `/usr/local/ffmpeg/${version}`;
  return `#!/usr/bin/env bash
set -e
VERSION="${version}"
PREFIX="${prefix}"
WORK="/opt/ffmpegbuild"
mkdir -p "\${WORK}"
cd "\${WORK}"
if [ ! -f "ffmpeg-\${VERSION}.tar.xz" ]; then
  curl -fSL -o "ffmpeg-\${VERSION}.tar.xz" "https://ffmpeg.org/releases/ffmpeg-\${VERSION}.tar.xz"
fi
dnf -y install gcc gcc-c++ make nasm yasm pkgconfig xz tar >/dev/null
# 有 x264/x265 则启用 H.264/H.265 编码，装不上就按基础版编译
EXTRA=""
dnf -y install x264-devel libx265-devel >/dev/null 2>&1 && EXTRA="--enable-gpl --enable-libx264 --enable-libx265" || EXTRA=""
tar xf "ffmpeg-\${VERSION}.tar.xz"
cd "ffmpeg-\${VERSION}"
if [ ! -f "\${PREFIX}/bin/ffmpeg" ]; then
  ./configure --prefix="\${PREFIX}" --disable-doc \${EXTRA}
  make -j"\$(nproc)"
  make install
fi
ln -sf "\${PREFIX}/bin/ffmpeg" /usr/local/bin/ffmpeg
ln -sf "\${PREFIX}/bin/ffprobe" /usr/local/bin/ffprobe

echo "${version}" > "${INSTALL_MARKERS.ffmpeg}"
echo "=== BUILD OK: FFmpeg \${VERSION} → \${PREFIX} ==="
"\${PREFIX}/bin/ffmpeg" -version | head -1
`;
}

// 生成 Supervisor pip 安装脚本（系统仓库最高 4.2，4.3 需 pip）
function buildSupervisorInstallScript(pipSpec) {
  const version = pipSpec.split('==')[1] || pipSpec;
  return `#!/usr/bin/env bash
set -e
dnf -y install python3-pip >/dev/null 2>&1 || true
pip3 install --upgrade --no-cache-dir "${pipSpec}"

mkdir -p /etc/supervisord.d /var/log/supervisor /var/run/supervisor
if [ ! -f /etc/supervisord.conf ]; then
cat > /etc/supervisord.conf <<'EOS'
[unix_http_server]
file=/var/run/supervisor/supervisor.sock

[supervisord]
logfile=/var/log/supervisor/supervisord.log
pidfile=/var/run/supervisor/supervisord.pid
nodaemon=false

[supervisorctl]
serverurl=unix:///var/run/supervisor/supervisor.sock

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[include]
files = /etc/supervisord.d/*.ini
EOS
fi

SUPERVISORD="\$(command -v supervisord || echo /usr/local/bin/supervisord)"
SUPERVISORCTL="\$(command -v supervisorctl || echo /usr/local/bin/supervisorctl)"
# 面板按 /usr/bin 路径调用，缺失时补链接
[ -e /usr/bin/supervisord ] || ln -sf "\$SUPERVISORD" /usr/bin/supervisord
[ -e /usr/bin/supervisorctl ] || ln -sf "\$SUPERVISORCTL" /usr/bin/supervisorctl

cat > /etc/systemd/system/supervisord.service <<EOS
[Unit]
Description=Supervisor process control system
After=network.target

[Service]
Type=forking
ExecStart=\$SUPERVISORD -c /etc/supervisord.conf
ExecStop=\$SUPERVISORCTL -c /etc/supervisord.conf shutdown
ExecReload=\$SUPERVISORCTL -c /etc/supervisord.conf reload
Restart=always

[Install]
WantedBy=multi-user.target
EOS
systemctl daemon-reload
systemctl enable supervisord >/dev/null 2>&1 || true

echo "${version}" > "${INSTALL_MARKERS.supervisor}"
echo "=== INSTALL OK: Supervisor \${VERSION} (pip) ==="
"\$SUPERVISORCTL" version
`;
}

// 核心软件定义：包名 + 对应 systemd 服务 + 管理端页面路径
// versions: 允许选择的安装版本候选（latest 表示跟随仓库默认）
const APPS = [
  {
    key: 'nginx',
    name: 'Nginx',
    desc: '高性能 Web 服务器 / 反向代理',
    package: 'nginx',
    officialPackage: 'nginx',
    hasOfficial: true,
    service: 'nginx',
    versionCmd: { nginx: ['-v'] },
    page: '/nginx',
    icon: 'Globe',
  },
  {
    key: 'php',
    name: 'PHP-FPM',
    desc: '动态脚本语言运行时',
    package: 'php-fpm',
    officialPackage: 'php-fpm',
    hasOfficial: true,
    service: 'php-fpm',
    versionCmd: { phpFpm: ['-v'] },
    page: '/php',
    icon: 'Server',
  },
  {
    key: 'mysql',
    name: 'MySQL',
    desc: '关系型数据库',
    package: 'mysql-server',
    officialPackage: 'mysql-community-server',
    hasOfficial: true,
    service: 'mysqld',
    versionCmd: { mysql: ['--version'] },
    page: '/mysql',
    icon: 'Database',
  },
  {
    key: 'redis',
    name: 'Redis',
    desc: '内存键值存储 / 缓存',
    package: 'redis',
    officialPackage: 'redis',
    hasOfficial: true,
    service: 'redis',
    versionCmd: { redisCli: ['--version'] },
    page: '/redis',
    icon: 'Cpu',
  },
  {
    key: 'supervisor',
    name: 'Supervisor',
    desc: '进程守护管理器',
    package: 'supervisor',
    officialPackage: 'supervisor',
    hasOfficial: true,
    service: 'supervisord',
    versionCmd: { supervisorctl: ['version'] },
    page: '/supervisor',
    icon: 'Activity',
  },
  {
    key: 'ffmpeg',
    name: 'FFmpeg',
    desc: '音视频转码处理工具',
    package: 'ffmpeg',
    officialPackage: 'ffmpeg',
    hasOfficial: true,
    service: null,
    // 命令行工具无常驻服务，以二进制可执行性作为状态依据
    binaryCheck: 'ffmpeg',
    versionCmd: { ffmpeg: ['-version'] },
    page: null,
    icon: 'Film',
  },
  {
    key: 'fail2ban',
    name: 'Fail2ban',
    desc: 'SSH 防爆破，自动封禁恶意 IP',
    package: 'fail2ban',
    officialPackage: 'fail2ban',
    hasOfficial: true,
    service: 'fail2ban',
    versionCmd: { fail2banClient: ['--version'] },
    page: '/fail2ban',
    icon: 'Shield',
  },
  {
    key: '3x-ui',
    name: '3x-ui',
    desc: 'Xray 代理面板，支持多协议多用户管理',
    package: null,
    officialPackage: null,
    hasOfficial: false,
    service: 'x-ui',
    versionCmd: null,
    page: null,
    icon: 'Box',
  },
  {
    key: 'system',
    name: '系统更新',
    desc: 'alinux4 系统软件包更新',
    package: null,
    officialPackage: null,
    hasOfficial: false,
    service: null,
    page: null,
    icon: 'RefreshCw',
    // 特殊应用：不对应具体软件包，只检查并安装系统发行版（alinux4）更新
    systemUpdate: true,
  },
];

// 系统发行版名（如 Alibaba Cloud Linux 4）
function osVersion() {
  try {
    const os = fs.readFileSync('/etc/os-release', 'utf8');
    return (os.match(/^PRETTY_NAME="?([^"\n]+)/m) || [])[1] || '';
  } catch (err) {
    return '';
  }
}

// 查询系统可用更新（dnf check-update：0=无更新，100=有更新，其他=失败）
async function checkSystemUpdates() {
  const pm = detectPkgManager();
  if (pm !== 'dnf' && pm !== 'yum') return { count: -1, packages: [] };
  const result = await run(pm, ['-q', 'check-update'], { timeout: 120000 });
  const packages = (result.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Obsoleting') && l.split(/\s+/).length >= 3)
    .map((l) => l.split(/\s+/)[0]);
  if (result.exitCode === 100) return { count: packages.length, packages };
  if (result.exitCode === 0) return { count: 0, packages: [] };
  return { count: -1, packages: [] };
}

function detectPkgManager() {
  if (fs.existsSync('/usr/bin/dnf')) return 'dnf';
  if (fs.existsSync('/usr/bin/yum')) return 'yum';
  if (fs.existsSync('/usr/bin/apt-get')) return 'apt';
  return 'unknown';
}

// 以系统包管理器安装记录判定软件是否真实安装（避免客户端二进制误判为 server 已装）
// 支持传入多个候选包名（如系统源包名 + 官方源包名），任一已装即视为已安装
async function isPackageInstalled(packageNames) {
  const names = Array.isArray(packageNames) ? packageNames : [packageNames];
  const pm = detectPkgManager();
  if (pm === 'unknown') return false;
  for (const name of names) {
    if (!name) continue;
    if (pm === 'dnf' || pm === 'yum') {
      // 用 rpm 本地查询，避免 dnf 并发锁/缓存导致的间歇性失败
      const result = await run('rpm', ['-q', name], { timeout: 60000 });
      if (result.exitCode === 0 && !/not installed/.test((result.stdout || result.stderr || '').trim())) return true;
    } else {
      // deb：dpkg -s 输出含 "Status: install ok installed"
      const result = await run('dpkg', ['-s', name], { timeout: 60000 });
      if (/^Status:\s+install ok installed/m.test(result.stdout)) return true;
    }
  }
  return false;
}

function parseRpmVersions(stdout) {
  const lines = stdout.split('\n');
  const map = {};
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)/);
    if (m) map[m[1].trim()] = map[m[1].trim()] || [];
  }
  return map;
}

// 查询某个包在仓库中的可用版本（按真实仓库数据）
async function listAppVersions(key) {
  const app = APPS.find((a) => a.key === key);
  if (!app) throw new Error('未知应用');
  // 系统更新不对应具体软件包，无版本可选
  if (app.systemUpdate) return { versionCmdBin: null, pkgVersionSyntax: 'dash', versions: [] };
  // 3x-ui：从 GitHub Release 拉取可选版本，同时标记哪些已缓存
  if (key === '3x-ui') {
    const releases = await fetch3xuiReleases();
    const cached = getCached3xuiVersions();
    // 面板仅集成最近 N 个版本；已缓存但不在最近的版本仍保留，保证离线可装
    const recent = releases.slice(0, XUI_INTEGRATED_COUNT);
    const versions = [...recent, ...cached.filter((v) => !recent.includes(v))];
    return {
      versionCmdBin: null,
      pkgVersionSyntax: 'dash',
      versions: versions.length ? versions : [],
      cached,
    };
  }
  const pkg = detectPkgManager();
  let versions = [];
  let result;
  if (pkg === 'dnf' || pkg === 'yum') {
    const cmd = pkg === 'dnf' ? 'dnf' : 'yum';
    result = await run(cmd, ['--showduplicates', 'list', 'available', app.package], { timeout: 60000 });
    const perPkg = parseRpmVersions(result.stdout);
    // 从每个相同包名中提取版本号（第二列）
    versions = (result.stdout || '')
      .split('\n')
      .map((l) => { const m = l.match(/^(\S+)\s+([0-9][^\s]*)/); return m ? m[2].trim() : null; })
      .filter(Boolean);
    versions = [...new Set(versions)];
  } else if (pkg === 'apt') {
    result = await run('aptCache', ['madison', app.package], { timeout: 60000 });
    versions = (result.stdout || '')
      .split('\n')
      .map((l) => { const m = l.match(/^\S+\|\s*([^\s]+)/); return m ? m[1].trim() : null; })
      .filter(Boolean);
  }
  // 保证始终包含跟随默认的选项
  const officialVersions = app.hasOfficial ? official.getOfficialVersions(app.key) : [];
  const merged = [...versions, ...officialVersions.map((v) => `官方:${v}`)];
  return { versionCmdBin: null, pkgVersionSyntax: pkg === 'apt' ? 'equals' : 'dash', versions: [...new Set(merged)] };
}

async function getServiceStatus(service) {
  const result = await run('systemctl', ['is-active', service]);
  return result.exitCode === 0 ? result.stdout.trim() : 'inactive';
}

// 无 systemd 服务的命令行工具（如 ffmpeg）：以二进制可执行性作为运行状态
async function getBinaryStatus(cmd) {
  const result = await run(cmd, ['-version']);
  return result.exitCode === 0 ? 'running' : 'inactive';
}

async function getInstalledVersion(key) {
  const app = APPS.find((a) => a.key === key);
  if (!app) return '';
  // 源码编译 / pip 安装的版本优先读取标记文件（如 PHP 8.5.10、Redis 8.0.6）
  const marked = readMarker(app.key);
  if (marked) return marked;
  if (!app.versionCmd) return '';
  const [cmd, args] = Object.entries(app.versionCmd)[0];
  const result = await run(cmd, args);
  // 仅在命令真正成功（exitCode 0）时才读取版本，避免把错误提示误当版本
  if (result.exitCode !== 0) return '';
  const text = (result.stdout || result.stderr).trim();
  const first = text.split('\n')[0] || '';
  // 各软件版本输出格式不同，提取纯版本号
  const patterns = {
    php: /PHP\s+([\d.]+)/,
    nginx: /nginx\/([\d.]+)/,
    mysql: /Ver\s+([\d.]+)/,
    redis: /([\d]+\.[\d]+\.[\d]+)/,
    supervisor: /([\d]+\.[\d]+\.[\d]+)/,
    ffmpeg: /ffmpeg version ([\d.]+)/,
    fail2ban: /Fail2[Bb]an v([\d.]+)/,
  };
  const m = (patterns[app.key] || /([\d]+\.[\d]+\.[\d]+)/).exec(text);
  if (m) return m[1];
  return first;
}

async function listApps() {
  const pkg = detectPkgManager();
  const apps = [];
  for (const app of APPS) {
    // 系统更新卡片：只统计可用更新数量，不涉及服务与包安装状态
    if (app.systemUpdate) {
      const info = await checkSystemUpdates();
      apps.push({
        key: app.key,
        name: app.name,
        desc: app.desc,
        package: '',
        page: null,
        icon: app.icon,
        hasService: false,
        systemUpdate: true,
        installed: true,
        version: osVersion(),
        status: info.count > 0 ? `${info.count} 个可用更新` : '已是最新',
        updateCount: info.count,
        updateAvailable: info.count > 0,
        latestVersion: '',
        jobRunning: jobService.isRunning(app.key),
      });
      continue;
    }
    // 3x-ui：基于 GitHub Release 管理，使用独立 systemd 服务 x-ui
    if (app.key === '3x-ui') {
      const marker = readMarker(app.key);
      const status = await getServiceStatus(app.service);
      let updateAvailable = false;
      let latestVersion = '';
      if (marker) {
        try {
          latestVersion = await fetch3xuiLatest();
          updateAvailable = !!latestVersion && compareVersions(latestVersion.replace(/^v/, ''), marker.replace(/^v/, '')) > 0;
        } catch (e) {
          // 忽略网络错误
        }
      }
      const installed = !!marker || fs.existsSync('/usr/local/x-ui/x-ui');
      const xuiPort = readXuiPort();
      const gateway = read3xuiGateway();
      const accessHost = readXuiAccessHost();
      // 有反代网关用网关域名；否则用安装脚本记录的真实 IP:端口（不用面板域名拼接）
      const rawBase = gateway && gateway.basePath ? String(gateway.basePath).replace(/^\/+|\/+$/g, '') : '';
      const basePath = rawBase ? `/${rawBase}` : '';
      const openUrl = gateway && gateway.domain
        ? `${gateway.scheme || 'https'}://${gateway.domain}${basePath}/`
        : (installed && accessHost ? `http://${accessHost}/` : '');
      apps.push({
        key: app.key,
        name: app.name,
        desc: app.desc,
        package: app.package,
        page: app.page,
        icon: app.icon,
        hasService: true,
        installed,
        version: marker || '',
        status,
        updateAvailable,
        latestVersion: updateAvailable ? latestVersion : '',
        jobRunning: jobService.isRunning(app.key),
        port: installed ? xuiPort : undefined,
        openUrl,
      });
      continue;
    }

    // 源码编译安装的软件走独立 systemd 服务（php → php-fpm-8.5，redis → redis-8.0）
    const marker = readMarker(app.key);
    const service = (marker && compiledServiceName(app.key, marker)) || app.service;
    const statusSource = service
      ? getServiceStatus(service)
      : app.binaryCheck
        ? getBinaryStatus(app.binaryCheck)
        : Promise.resolve('inactive');
    const [status, version, pkgInstalled] = await Promise.all([
      statusSource,
      getInstalledVersion(app.key),
      isPackageInstalled([app.package, app.officialPackage]),
    ]);
    // 源码编译 / pip 安装的软件没有 rpm 记录，以版本标记文件为准
    const installed = !!marker || pkgInstalled;
    // 源码编译/pip 安装且配置了更高版本 → 面板内可更新
    const target = marker ? latestTargetVersion(app.key, marker) : '';
    const updateAvailable = !!target && compareVersions(target, marker) > 0;
    apps.push({
      key: app.key,
      name: app.name,
      desc: app.desc,
      package: app.package,
      page: app.page,
      icon: app.icon,
      hasService: !!(service || app.binaryCheck),
      installed,
      version: version || '',
      status,
      updateAvailable,
      latestVersion: updateAvailable ? target : '',
      // 后台任务状态（页面刷新后可据此恢复「安装中」与终端入口）
      jobRunning: jobService.isRunning(app.key),
    });
  }
  return { pkg, apps };
}

// ---- 对外任务接口：安装 / 更新 / 卸载均后台执行，前端轮询 /apps/job/:key 查看终端输出 ----

// 安装
async function startInstall(key, version = '', config = {}) {
  const app = APPS.find((a) => a.key === key);
  if (!app) throw new Error('未知应用');
  if (app.systemUpdate) throw new Error('系统更新无需安装，请直接点击更新');
  if (jobService.isRunning(key)) throw new Error(`${app.name} 正在执行任务中，请等待当前任务完成`);
  // 3x-ui：可选自动反代 + SSL 签发，域名格式提前校验，避免安装完成才发现配置错误
  const domain = key === '3x-ui' ? String(config.domain || '').trim() : '';
  const wantSsl = key === '3x-ui' && config.ssl !== false && config.ssl !== 'false';
  if (domain && !/^[a-zA-Z0-9][\w\-.]*[a-zA-Z0-9]$/.test(domain)) {
    throw new Error('域名格式不正确，请输入如 xui.example.com');
  }
  const port = String(config.port || 2255).trim() || '2255';
  const { script, label } = await buildInstallScript(key, version, config);
  // 源码编译 / pip 安装成功后写入版本标记，供面板识别已安装版本与服务名
  const markerVersion = markerVersionFor(key, version);
  return jobService.start({
    key,
    label,
    script,
    onDone: async (code) => {
      if (code === 0 && markerVersion) writeMarker(key, markerVersion);
      // 3x-ui 安装成功后：按配置自动创建 nginx 反代站点并签发 SSL
      if (code === 0 && key === '3x-ui' && domain) {
        await setupXuiGateway(key, port, domain, wantSsl);
      }
    },
  });
}

// 3x-ui 安装成功后：自动创建 nginx 反代站点（域名 -> 127.0.0.1:面板端口）并可选签发 SSL
async function setupXuiGateway(jobKey, rawPort, domain, wantSsl) {
  const port = String(rawPort || '').trim() || '2255';
  const siteName = 'xui-panel';
  const log = (text) => jobService.appendLogTo(jobKey, `\n[面板] ${text}\n`);
  // 面板已有该域名证书则直接复用，避免重复签发
  let certPath = '';
  let keyPath = '';
  if (wantSsl) {
    try {
      const certs = await sslService.listCertificates();
      const existing = certs.find((c) => c.domain === domain);
      if (existing) {
        certPath = existing.certPath;
        keyPath = existing.keyPath;
      }
    } catch (err) {
      // 枚举已有证书失败不阻塞安装，回退为 certbot 新签流程
    }
  }
  try {
    const result = await nginxService.createSite({
      name: siteName,
      serverName: domain,
      listen: '80',
      root: '',
      proxyPass: `http://127.0.0.1:${port}`,
      runDir: '',
      rewrite: 'none',
      type: 'html',
      ssl: wantSsl,
      email: '',
      createDb: false,
      certPath,
      keyPath,
    });
    // 复用或有新签成功才对外提供 https；签发失败时站点仍是纯 http，避免日志误导
    const sslOk = !!wantSsl && !!(result.ssl && result.ssl.success);
    const scheme = sslOk ? 'https' : 'http';
    const basePath = readXuiBasePath().replace(/^\/+|\/+$/g, '');
    const baseSuffix = basePath ? `/${basePath}/` : '/';
    write3xuiGateway({ domain, port: String(port), scheme, basePath });
    log(`自动反代已配置：${scheme}://${domain} -> http://127.0.0.1:${port}（站点 ${siteName}）`);
    log(`「打开面板」地址：${scheme}://${domain}${baseSuffix}`);
    if (wantSsl) {
      if (result.ssl && result.ssl.success) {
        log(result.ssl.reused
          ? `已直接复用面板现有证书：${domain}（nginx 443 + 80 跳转生效，无需重新签发）`
          : `SSL 证书签发成功：${domain}（certbot 已配置 80->443 强制跳转）`);
      } else if (result.ssl) {
        log('SSL 证书签发失败，请前往「网站 / SSL 证书」手动处理');
      } else {
        log('未找到可用于签发证书的域名，站点暂以 http 提供服务');
      }
    }
  } catch (err) {
    if (err && /站点配置已存在/.test(err.message)) {
      log(`nginx 站点 ${siteName} 已存在，跳过自动反代配置（如需修改请前往「网站」管理）`);
      return;
    }
    // 域名被本站其他站点占用时 nginx 会命中先加载的 server 块，反代会静默失效，
    // 明确提示用户去处理冲突站点，而不是给出一个「已配置」的假成功
    if (err && /域名冲突/.test(err.message)) {
      log(`自动反代未配置：${err.message}`);
      log('3x-ui 面板仍可通过服务器 IP 直接访问（应用中心「打开面板」按钮）');
      return;
    }
    throw err;
  }
}

// 更新（仅源码编译 / pip 安装的软件）
async function startUpdate(key) {
  const app = APPS.find((a) => a.key === key);
  if (!app) throw new Error('未知应用');
  if (jobService.isRunning(key)) throw new Error(`${app.name} 正在执行任务中，请等待当前任务完成`);
  // 系统更新：直接刷新元数据并升级系统所有软件包（非源码编译 / pip 安装）
  if (app.systemUpdate) {
    const pm = detectPkgManager();
    if (pm !== 'dnf' && pm !== 'yum') throw new Error('系统更新仅支持 dnf / yum 系发行版');
    const script = `#!/usr/bin/env bash
set -e
echo "=== 系统更新（${osVersion()}）==="
# 先拿到包管理器真实退出码，再执行 daemon-reload 收尾，最后以真实退出码结束
UPDATE_RC=0
${pm} -y --refresh update || UPDATE_RC=$?
echo "=== 系统更新结束（${pm} 退出码 \${UPDATE_RC}）==="
# 升级 systemd / dbus / rpm 时，事务内 rpm scriptlet 常报
# "Reload daemon failed: Transport endpoint is not connected"（daemon 正被替换，时序性报错）。
# 这里在事务之外补一次 daemon-reload 让其收敛；失败通常是升级后 daemon 短暂不可用，重试一次。
if ! systemctl daemon-reload 2>/dev/null; then
  echo "[面板] daemon-reload 失败，2 秒后重试（systemd/dbus 升级后短暂不可用属正常现象）"
  sleep 2
  systemctl daemon-reload 2>/dev/null && echo "[面板] daemon-reload 重试成功" || echo "[面板] daemon-reload 仍失败，建议重启服务器"
else
  echo "[面板] systemd 配置已重新加载"
fi
LATEST_KERNEL=$(rpm -q kernel --qf '%{VERSION}-%{RELEASE}.%{ARCH}\\n' 2>/dev/null | sort -V | tail -1)
RUNNING_KERNEL=$(uname -r)
if [ -n "$LATEST_KERNEL" ] && [ "$LATEST_KERNEL" != "$RUNNING_KERNEL" ]; then
  echo "[面板] 已安装新内核 $LATEST_KERNEL，当前运行 $RUNNING_KERNEL，需重启服务器后生效"
fi
if [ "$UPDATE_RC" -ne 0 ]; then
  echo "[面板] ${pm} 返回非 0 退出码 $UPDATE_RC，请核对上方输出"
fi
exit "$UPDATE_RC"
`;
    return jobService.start({ key: app.key, label: '系统更新', script });
  }
  // 3x-ui：跟随 GitHub Release 更新，保留当前端口
  if (key === '3x-ui') {
    const installed = readMarker(key);
    if (!installed) throw new Error('3x-ui 尚未安装');
    const target = await fetch3xuiLatest();
    if (!target) throw new Error('无法获取 3x-ui 最新版本');
    if (compareVersions(target.replace(/^v/, ''), installed.replace(/^v/, '')) <= 0) {
      throw new Error(`3x-ui 已是最新版本（${installed}）`);
    }
    const port = readXuiPort();
    return jobService.start({
      key,
      label: `更新 3x-ui 至 ${target}`,
      script: build3xuiInstallScript(target, port),
    });
  }
  const installed = readMarker(key);
  if (!installed) {
    throw new Error(`${app.name} 不是源码编译 / pip 安装的，请通过安装功能或系统仓库更新`);
  }
  const target = latestTargetVersion(key, installed);
  if (!target) throw new Error(`${app.name} ${releaseOf(key, installed)} 尚未配置可更新版本`);
  if (compareVersions(target, installed) <= 0) throw new Error(`${app.name} 已是最新版本（${installed}）`);

  const release = releaseOf(key, installed);
  let script;
  if (key === 'php') script = buildPhpCompileScript(release, target);
  else if (key === 'redis') script = buildRedisCompileScript(target);
  else if (key === 'ffmpeg') script = buildFfmpegCompileScript(target);
  else script = buildSupervisorInstallScript((PIP_INSTALL.supervisor || {})[release] || `supervisor==${target}`);
  script += buildPostUpdateScript(key, installed, target);

  return jobService.start({
    key,
    label: `更新 ${app.name} 至 ${target}`,
    script,
    onDone: async (code) => {
      if (code === 0) writeMarker(key, target);
    },
  });
}

// 卸载（含源码编译 / pip 安装产物的清理）
async function startUninstall(key) {
  const app = APPS.find((a) => a.key === key);
  if (!app) throw new Error('未知应用');
  if (app.systemUpdate) throw new Error('系统更新不支持卸载');
  if (jobService.isRunning(key)) throw new Error(`${app.name} 正在执行任务中，请等待当前任务完成`);
  // 3x-ui：使用官方卸载清理逻辑
  if (key === '3x-ui') {
    return jobService.start({
      key,
      label: `卸载 ${app.name}`,
      script: xuiUninstallLines().join('\n') + '\n',
    });
  }
  const pkg = detectPkgManager();
  // 系统源包名与官方源包名都尝试卸载（如 mysql-server / mysql-community-server）
  const names = [...new Set([app.package, app.officialPackage].filter(Boolean))];
  const lines = ['#!/usr/bin/env bash'];
  // fail2ban 需先停服务并清理 iptables 封禁链：卸载后 f2b-* 链与 DROP 规则会残留
  if (key === 'fail2ban') lines.push(...fail2banUninstallLines());
  if (pkg === 'dnf' || pkg === 'yum') {
    // 先探测包是否由包管理器安装：源码编译 / pip 安装的应用没有对应 RPM，
    // 直接 dnf remove 会打印 "No match for argument" 等噪音，掩盖真正的清理过程
    for (const name of names) {
      lines.push(`if rpm -q ${name} >/dev/null 2>&1; then`);
      lines.push(`  echo "[面板] 从系统包管理器卸载 ${name}"`);
      lines.push(`  ${pkg} remove -y ${name} || true`);
      lines.push('else');
      lines.push(`  echo "[面板] 系统包管理器未安装 ${name}，跳过"`);
      lines.push('fi');
    }
  } else if (pkg === 'apt') {
    for (const name of names) {
      lines.push(`if dpkg -s ${name} >/dev/null 2>&1; then`);
      lines.push(`  echo "[面板] 从系统包管理器卸载 ${name}"`);
      lines.push(`  apt-get remove -y ${name} || true`);
      lines.push('else');
      lines.push(`  echo "[面板] 系统包管理器未安装 ${name}，跳过"`);
      lines.push('fi');
    }
  } else {
    throw new Error('未检测到支持的包管理器');
  }
  lines.push(...runtimeCleanupLines(key));
  lines.push(...compiledCleanupLines(key));
  lines.push(`echo "=== 卸载完成：${app.name} ==="`);
  return jobService.start({ key, label: `卸载 ${app.name}`, script: `${lines.join('\n')}\n` });
}

function getJob(key) {
  return jobService.snapshot(key);
}

function getRunningJobs() {
  return jobService.listRunning();
}

module.exports = {
  listApps,
  listAppVersions,
  startInstall,
  startUpdate,
  startUninstall,
  getJob,
  getRunningJobs,
  sync3xuiPackage,
  sync3xuiLatest,
  fetch3xuiLatest,
  getCached3xuiVersions,
  is3xuiCached,
  INSTALL_MARKERS,
};
