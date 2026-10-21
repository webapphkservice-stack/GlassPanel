const fs = require('fs');
const { run } = require('./commandRunner');

/**
 * 官方软件源配置（RHEL/dnf 系）。
 * 为 Nginx / MySQL / PHP 提供官方渠道的多版本，Redis / Supervisor 走系统源。
 */

// 各软件官方版本候选（key → 可选 release）
// 注意：redis / supervisor / ffmpeg / fail2ban 的官方版本无可用 el9 二进制包
// （fail2ban 的 EPEL9 包依赖 python(abi)=3.9，alinux4 只有 python3.11），
// 由 appService 走源码编译或 pip 安装
const OFFICIAL_RELEASES = {
  nginx: ['stable', 'mainline'],
  mysql: ['8.0', '8.4'],
  php: ['8.1', '8.2', '8.3', '8.4', '8.5'],
  redis: ['8.0'],
  supervisor: ['4.3'],
  ffmpeg: ['9.0.2'],
  fail2ban: ['1.1.0'],
};

// 返回对应的 Enterprise Linux 大版本（alinux4=el9、alinux3=el8、alinux2=el7，alma/rocky/centos 即自身版本）
function detectElMajor() {
  try {
    const os = fs.readFileSync('/etc/os-release', 'utf8');
    const id = (os.match(/^ID="?(\w+)/m) || [])[1];
    const ver = (os.match(/VERSION_ID="?(\d+)/) || [])[1];
    const v = ver ? parseInt(ver, 10) : 0;
    if (id === 'alinux') return v + 5; // alinux2=7, 3=8, 4=9
    return v;
  } catch (e) {
    return 9;
  }
}

// 配置 Nginx 官方源（stable 或 mainline 二选一需要切换 enabled）
async function configureNginx(release) {
  const repo = release === 'mainline' ? 'nginx-mainline' : 'nginx-stable';
  const el = detectElMajor() || 9; // alinux4/el9 → 9，避免 $releasever=4 导致 404
  const content =
    `[${repo}]\n` +
    'name=nginx repo\n' +
    `baseurl=https://nginx.org/packages/centos/${el}/$basearch/\n` +
    'gpgcheck=1\n' +
    'enabled=0\n' +
    'gpgkey=https://nginx.org/keys/nginx_signing.key\n' +
    // epel-modular 中存在同名 nginx 模块流（nginx:mainline），会按模块过滤隐藏
    // 此处的 nginx 包，导致「无可用 nginx 包」；声明 module_hotfixes 可绕过模块过滤
    'module_hotfixes=true\n';
  fs.writeFileSync('/etc/yum.repos.d/nginx-official.repo', content, 'utf8');
  await run('dnf', ['clean', 'all'], { timeout: 60000 });
  return { repo };
}

// 配置 MySQL 官方源（手写 repo 文件，按所选大版本启用对应子 repo）
async function configureMysql(release) {
  const gpgUrls = 'https://repo.mysql.com/RPM-GPG-KEY-mysql-2022\n  https://repo.mysql.com/RPM-GPG-KEY-mysql-2023';
  const el = detectElMajor() || 9; // alinux4/el9 → 9，避免 $releasever=4 导致 404
  // 所有子 repo 一律 enabled=0，安装时通过 --enablerepo 临时启用。
  // 若常驻启用，系统源安装（如 dnf install mysql-server）会与官方包混装：
  // alinux 的 mysql-server 依赖 mysql，会被解析到 mysql-community-client，二者同带
  // /usr/bin/mysql_migrate_keyring 导致 transaction test 失败
  const repos = ['8.0', '8.4'].map((v) => {
    const id = `mysql${v.replace('.', '')}-community`;
    return (
      `[${id}]\n` +
      `name=MySQL ${v} Community Server\n` +
      `baseurl=https://repo.mysql.com/yum/mysql-${v}-community/el/${el}/$basearch/\n` +
      'enabled=0\n' +
      'gpgcheck=1\n' +
      'gpgkey=' + gpgUrls + '\n'
    );
  });
  fs.writeFileSync('/etc/yum.repos.d/mysql-official.repo', repos.join('\n'), 'utf8');
  await run('dnf', ['clean', 'all'], { timeout: 60000 });
  return { repo: `mysql${release.replace('.', '')}-community` };
}

// remi 的并行安装包名：8.4 → php84-php-fpm。
// 这类包安装到 /opt/remi/php84、二进制 /usr/sbin/php84-fpm、服务 php84-fpm，
// 因此多个 PHP 版本可以真正并存。
function phpParallelPackage(release) {
  return `php${String(release).replace('.', '')}-php-fpm`;
}

// 配置 PHP remi 源（并行安装包模式，不使用模块流）
// 兼容 alinux/anolis：remi release 依赖 epel，需用 rpm --nodeps 安装并校正 baseurl
async function configurePhp(release) {
  const el = detectElMajor() || 9;

  // 1. 若 remi 仓库未注册，下载 remi-release rpm 并用 --nodeps 安装（仅注册 repo 配置）
  if (!fs.existsSync('/etc/yum.repos.d/remi.repo')) {
    const remiRpm = `https://rpms.remirepo.net/enterprise/remi-release-${el}.rpm`;
    const dl = await run('curl', ['-fSL', '-o', '/tmp/remi-release.rpm', remiRpm], { timeout: 180000 });
    if (dl.exitCode !== 0) {
      throw new Error(`下载 remi-release 失败: ${dl.stderr || dl.stdout}`);
    }
    await run('rpm', ['--nodeps', '-Uvh', '/tmp/remi-release.rpm'], { timeout: 120000 });
    fs.unlinkSync('/tmp/remi-release.rpm');
  }

  // 2. 将 remi 仓库 baseurl 固定到对应 el 大版本
  // 所有 remi 子 repo 保持 enabled=0，安装时由 dnfArgs 临时启用。
  // 若常驻 enabled=1，系统源安装（如 dnf install php-fpm）会被 remi 包污染
  for (const f of ['remi.repo', 'remi-modular.repo', 'remi-safe.repo']) {
    const p = `/etc/yum.repos.d/${f}`;
    if (!fs.existsSync(p)) continue;
    let c = fs.readFileSync(p, 'utf8');
    // Alinux 的 $releasever 是 2/3/4，不是 RHEL 大版本，
    // 必须替换成换算后的 el 编号，否则 remi 的 mirrorlist 会指向 /enterprise/3/... 而 404。
    // 同时纠正已被历史版本写成 9.0 / 8.0 的地址（remi 的仓库路径只接受 8 / 9）
    c = c.replace(/\$releasever_major/g, String(el)).replace(/\$releasever/g, String(el));
    c = c.replace(/(enterprise\/)\d+(?:\.\d+)?\//g, `$1${el}/`);
    fs.writeFileSync(p, c.replace(/^enabled=1(?=\s*$)/gm, 'enabled=0'), 'utf8');
  }

  await run('dnf', ['clean', 'all'], { timeout: 60000 });

  // 3. 只启用 remi 基础源与 remi-safe，不启用 remi-modular：
  // 模块流 php:remi-x 是全局唯一的，装第二个版本就会顶掉第一个版本，
  // 只有 php84-php-fpm 这类并行包才能做到多版本共存。
  return {
    repo: 'remi',
    // alinux/anolis 需显式声明 module_platform_id，否则 dnf 会按平台 al8 过滤
    dnfArgs: ['--enablerepo=remi,remi-safe', `--setopt=module_platform_id=platform:el${el}`],
  };
}

// 面板托管的官方源 repo id。系统源安装时需显式 --disablerepo 排除，
// 否则官方包会与系统包混装产生 file 冲突（历史 repo 文件可能仍是 enabled=1）
const OFFICIAL_REPO_IDS = {
  nginx: ['nginx-stable', 'nginx-mainline'],
  mysql: ['mysql80-community', 'mysql84-community'],
};

function officialRepoIds(key) {
  return OFFICIAL_REPO_IDS[key] || [];
}

// remi 的各个子仓库（同样由面板托管，安装系统源包时须一并排除）
const REMI_REPO_IDS = ['remi', 'remi-modular', 'remi-safe'];

// 面板托管的全部官方源 repo id（nginx / mysql / remi），
// 供「从系统源安装」时统一排除；id 在本机不存在时 dnf 仅告警，不影响执行
function allOfficialRepoIds() {
  const merged = new Set(Object.values(OFFICIAL_REPO_IDS).flat());
  REMI_REPO_IDS.forEach((id) => merged.add(id));
  return [...merged];
}

// 确保所选官方源已配置
async function ensure(release) {}

// 对外：获取某软件的官方版本候选列表
function getOfficialVersions(key) {
  return OFFICIAL_RELEASES[key] || [];
}

module.exports = { OFFICIAL_RELEASES, configureNginx, configureMysql, configurePhp, getOfficialVersions, officialRepoIds, allOfficialRepoIds, phpParallelPackage };