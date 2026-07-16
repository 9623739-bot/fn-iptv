# 飞牛 IPTV 管家 —— UI 自包含镜像（可选路径）
# 默认方案用 nginx:alpine + 挂载网页，无需此镜像。
# 仅当你想“不挂载、直接用一个镜像部署”时，本地或用仓库 Actions 构建并推送：
#   docker build -t 你的DockerHub用户名/fn-iptv-ui:1.0.0 ./fn-iptv
#   docker push 你的DockerHub用户名/fn-iptv-ui:1.0.0
# 然后把 app/docker/docker-compose.yaml 里 fn-iptv-ui 的 image 改为上面同名镜像。
FROM nginx:alpine
COPY app/ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY app/ui/html/index.html /usr/share/nginx/html/index.html
COPY app/ui/html/css /usr/share/nginx/html/css
COPY app/ui/html/js /usr/share/nginx/html/js
EXPOSE 8510
