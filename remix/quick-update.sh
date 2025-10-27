#!/bin/bash

# Quick update script - run these commands on server 34.130.69.135
# Copy and paste into SSH session

SERVER="34.130.69.135"

echo "更新服务器 $SERVER ..."

ssh root@$SERVER << 'EOF'
cd /root
echo "当前目录: $(pwd)"
echo "正在拉取最新镜像..."
docker-compose pull
echo "正在重启容器..."
docker-compose down
docker-compose up -d
echo "清理旧镜像..."
docker image prune -f
echo "查看运行状态..."
docker-compose ps
echo "更新完成！"
EOF

