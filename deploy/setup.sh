#!/usr/bin/env bash
# 用法： bash setup.sh <域名> <DASHSCOPE_API_KEY>
# 例：   bash setup.sh api.example.com sk-ws-xxxx
# 适用： 腾讯云轻量应用服务器 Ubuntu 22.04 / 24.04，root 权限执行
set -euo pipefail

DOMAIN="${1:?缺少域名，例：bash setup.sh api.example.com sk-xxx}"
APIKEY="${2:?缺少 DASHSCOPE_API_KEY}"
APP_DIR=/opt/food-calorie
REPO=https://github.com/haoyuan8/food-calorie-server.git

echo "== 1/8 系统包 =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx ca-certificates

echo "== 2/8 Node.js 22 =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== 3/8 拉代码 =="
rm -rf "$APP_DIR"
git clone --depth 1 "$REPO" "$APP_DIR"
cd "$APP_DIR/server"
npm install --omit=dev --registry=https://registry.npmmirror.com

echo "== 4/8 环境变量 =="
cat > /etc/food-calorie.env <<EOF
DASHSCOPE_API_KEY=$APIKEY
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3-vl-plus
PORT=3000
EOF
chmod 600 /etc/food-calorie.env

echo "== 5/8 systemd =="
cp /opt/food-calorie/deploy/food-calorie.service /etc/systemd/system/food-calorie.service
systemctl daemon-reload
systemctl enable --now food-calorie
sleep 3
systemctl --no-pager --full status food-calorie | head -20

echo "== 6/8 Nginx =="
sed "s/__DOMAIN__/$DOMAIN/g" /opt/food-calorie/deploy/nginx-food-calorie.conf > /etc/nginx/conf.d/food-calorie.conf
nginx -t
systemctl reload nginx

echo "== 7/8 HTTPS 证书（需域名已备案并能解析到本机）=="
certbot --nginx -d "$DOMAIN" --agree-tos -m "admin@$DOMAIN" --redirect -n || \
  echo "!! certbot 失败：域名未备案/未解析/80 端口不通时属正常，备案下来后重跑本条"

echo "== 8/8 自检 =="
curl -s --max-time 10 "http://127.0.0.1:3000/health" || true
echo
curl -s --max-time 10 "https://$DOMAIN/health" || curl -s --max-time 10 "http://$DOMAIN/health" || true
echo
echo "完成。健康检查返回 {\"ok\":true,\"model\":\"qwen3-vl-plus\"} 即成功。"
