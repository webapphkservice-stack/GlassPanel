#!/usr/bin/env bash
set -e

# 玻璃面板 systemd 服务管理脚本

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_FILE="/etc/systemd/system/glass-panel.service"

case "${1:-}" in
  install)
    if [ "$EUID" -ne 0 ]; then
      echo "请使用 root 权限运行" >&2
      exit 1
    fi
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
# 只杀主进程：面板重启时不连带杀掉后台任务（源码编译、系统更新等）
KillMode=process
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable glass-panel
    echo "服务已安装并启用"
    ;;
  start)
    systemctl start glass-panel
    echo "服务已启动"
    ;;
  stop)
    systemctl stop glass-panel
    echo "服务已停止"
    ;;
  restart)
    systemctl restart glass-panel
    echo "服务已重启"
    ;;
  status)
    systemctl status glass-panel --no-pager
    ;;
  update)
    cd "$REPO_DIR"
    npm run build
    systemctl restart glass-panel
    echo "前端已重新构建并重启服务"
    ;;
  *)
    echo "用法: $0 {install|start|stop|restart|status|update}"
    exit 1
    ;;
esac
