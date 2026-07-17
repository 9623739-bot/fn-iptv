# 飞牛 IPTV 管家（fn-iptv）

适用于飞牛 NAS（FnOS）的第三方 IPTV 管理应用。它可以把用户自己的咪咕账号转换成本地直播源，提供后台频道浏览、内置播放器、TVBox 配置、EPG 节目单、电视端分组过滤等功能。

> 免责声明：本项目仅用于个人学习与技术研究。频道数据与播放能力来自第三方接口，可能受账号、网络、地域、版权策略影响。请遵守所在地法律法规和内容平台服务条款。

## 下载安装包

当前版本：`v1.2.12`

推荐下载（点击后会直接下载）：

- [fn-iptv_x86.fpk](https://github.com/9623739-bot/fn-iptv/raw/main/fn-iptv_x86.fpk)
- [fn-iptv.fpk](https://github.com/9623739-bot/fn-iptv/raw/main/fn-iptv.fpk)

两个安装包内容一致，飞牛 x86 设备优先使用 `fn-iptv_x86.fpk`。如果浏览器没有自动下载，请右键链接选择“另存为”。

## 安装方法

1. 下载上面的 `.fpk` 安装包。
2. 打开飞牛 NAS 的“应用中心”。
3. 点击左下角手动安装。
4. 上传 `.fpk` 文件并安装。
5. 安装完成后打开“飞牛 IPTV 管家”。

默认访问地址：

```text
http://<NAS_IP>:8510/
```

## 主要功能

- 生成咪咕直播源：`m3u`、`txt`、TVBox 配置 JSON。
- 后台频道浏览：后台显示全部频道，支持分类、搜索、内置播放。
- 电视端隐藏分组：只影响 TVBox/m3u/txt 输出，不影响后台显示。
- 清晰度设置：标清、高清、蓝光、原画、4K。
- H.264 减少只有声音没有画面的情况。
- 同源代理播放：解决浏览器和播放器 CORS 问题。
- 远程更新提示：GitHub 有新版本时，后台自动提示下载。
- TVBox 教程：后台内置填写教程和复制地址。
- Token 教程：后台内置咪咕 userId/token 获取教程。
- 账号不写死：不内置私人账号、token 或私有播放源。

## 使用前准备

你需要准备自己的咪咕账号凭据：

- `userId`
- `token`

后台提供“获取 Token 教程”。基本流程是：

1. 打开咪咕视频官网并登录。
2. 按 `F12` 打开浏览器开发者工具。
3. 进入 `Application / 应用`。
4. 在 `Cookies` 中找到 `userinfo`。
5. `userinfo` 前半部分是 userId，后半部分是 token。

不要把 token 分享给别人。

## 画质说明

| 配置状态 | 可用画质 |
| --- | --- |
| 不填写 userId/token | 通常只能标清 |
| 填写 userId/token | 可用高清 |
| 咪咕 VIP 账号 | 可尝试蓝光、原画、4K |

后台清晰度选项：

| 值 | 清晰度 |
| --- | --- |
| `2` | 标清 |
| `3` | 高清 |
| `4` | 蓝光 |
| `7` | 原画 |
| `9` | 4K |

蓝光及以上画质需要咪咕 VIP，并且仍可能受频道权益限制。

## TVBox 使用

后台点击“TVBox 教程”可以直接复制地址。

常用地址如下：

```text
数据源地址:     http://<NAS_IP>:8510/tvbox.json
直播源地址:     http://<NAS_IP>:8510/migu/txt
直播 EPG 地址:  http://<NAS_IP>:8510/migu/playback.xml
```

如果 TVBox 只允许填写一个地址，只填：

```text
http://<NAS_IP>:8510/tvbox.json
```

TVBox 下载地址：

- [vipshihua/tvbox](https://github.com/vipshihua/tvbox)

建议下载开源版、官方原版。

## 电视端隐藏分组

后台“设置”里可以勾选电视端隐藏分组，例如：

- 体育（包含体育-今天、体育-明天等子分组）
- 其他

这个功能只影响电视端订阅源：

- `/migu/txt`
- `/migu/m3u`
- `/tvbox.json`

后台频道列表仍然显示全部频道，方便管理和测试。

## 常用接口

```text
后台页面:       http://<NAS_IP>:8510/
TVBox 配置:    http://<NAS_IP>:8510/tvbox.json
直播源 TXT:    http://<NAS_IP>:8510/migu/txt
直播源 M3U:    http://<NAS_IP>:8510/migu/m3u
EPG 节目单:    http://<NAS_IP>:8510/migu/playback.xml
```

订阅地址不会直接暴露 userId/token。

## 更新机制

- 频道列表、分组、EPG：默认约每 6 小时更新一次。
- 单频道播放链接：点击播放时实时获取，并缓存约 3 小时。
- 咪咕临时调整链接后，缓存过期会重新获取。

## 项目结构

```text
fn-iptv/
├─ manifest
├─ fn-iptv.fpk
├─ fn-iptv_x86.fpk
├─ app/
│  ├─ docker/docker-compose.yaml
│  ├─ migu/
│  │  ├─ app.js
│  │  └─ utils/appUtils.js
│  └─ ui/
│     ├─ config
│     ├─ nginx.conf
│     ├─ images/
│     └─ html/
│        ├─ index.html
│        ├─ favicon.ico
│        ├─ css/style.css
│        └─ js/app.js
├─ cmd/
├─ config/
├─ ICON.PNG
├─ ICON_256.PNG
├─ generate_icons.py
├─ README.md
└─ LICENSE
```

## 技术架构

本应用是 FnOS `docker-project` 类型 FPK。

| 服务 | 镜像 | 容器端口 | 主机端口 | 作用 |
| --- | --- | --- | --- | --- |
| `fn-iptv-ui` | `nginx:alpine` | 8510 | 8510 | 管理后台与同源反代 |
| `fn-iptv-migu` | `develop767/migu_video:latest` | 1234 | 3566 | 咪咕直播源服务 |

前端通过 nginx 反代访问 `/migu/`，避免浏览器 CORS 问题。

## 隐私说明

- 仓库不内置任何私人咪咕账号或 token。
- 用户凭据只保存在 NAS 本机运行配置中。
- 项目不收集、不上传用户凭据。
- 订阅地址不直接暴露 userId/token。

## 本地构建

需要飞牛官方打包工具 `fnpack`：

```bash
fnpack build
cp fn-iptv.fpk fn-iptv_x86.fpk
```

## 开源协议

本项目采用 MIT License。
