# 飞牛 IPTV 管家（fn-iptv）

飞牛 NAS（FnOS）第三方应用，提供 MiguTV 直播源管理、频道分类浏览、搜索、内置播放器、EPG 节目单和 TVBox 配置教程。

> 免责声明：本应用仅用于个人学习与技术研究。频道数据与播放能力来自第三方接口，可能受账号、网络、地域、版权策略影响。使用本应用产生的任何后果由使用者自行承担。

## 功能特性

- MiguTV 直播源：生成 m3u/txt 订阅与同源播放链接。
- 凭据本地配置：不内置任何私人 userId/token。
- 短订阅地址：订阅链接不暴露 userId/token。
- 清晰度可选：标清、高清、蓝光、原画、4K。
- H.264 优先：默认关闭 H.265，减少只有声音没有画面的情况。
- 频道浏览：后台显示全部频道，支持分类和搜索。
- 电视端隐藏分组：可隐藏体育、其他等分组，仅影响 TVBox/m3u/txt 输出。
- TVBox 支持：内置 `/tvbox.json`、`/migu/txt`、`/migu/playback.xml`。
- 获取 Token 教程：后台提供咪咕 userId/token 获取步骤。

## 安装

1. 在 Releases 下载 `fn-iptv_x86.fpk` 或 `fn-iptv.fpk`。
2. 飞牛 NAS -> 应用中心 -> 右上角设置 -> 离线安装。
3. 选择 `.fpk` 安装包并安装。
4. 打开“飞牛 IPTV 管家”，默认端口为 `8510`。
5. 进入右上角“设置”，填写自己的咪咕 userId 和 token。

当前飞牛第三方应用主要面向 x86_64。

## 常用地址

```text
后台页面:       http://<NAS>:8510/
TVBox 配置:    http://<NAS>:8510/tvbox.json
直播源 TXT:    http://<NAS>:8510/migu/txt
直播源 M3U:    http://<NAS>:8510/migu/m3u
EPG 节目单:    http://<NAS>:8510/migu/playback.xml
```

TVBox 如果只有一个“数据源地址”，填 `/tvbox.json`；如果有三行，按“数据源地址、直播源地址、直播 EPG 地址”分别填写。

## 画质说明

- 不填写 userId/token：通常只能观看标清。
- 填写 userId/token：可观看高清。
- 蓝光、原画、4K：需要咪咕 VIP 账号，并受频道权益限制。

清晰度选项：

| 值 | 清晰度 |
| --- | --- |
| `2` | 标清 |
| `3` | 高清 |
| `4` | 蓝光 |
| `7` | 原画 |
| `9` | 4K |

默认关闭 H.265，优先 H.264 以保证浏览器和电视端兼容性。

## 获取 userId/token

后台提供“获取 Token 教程”。基本流程：

1. 打开咪咕视频官网并登录。
2. 按 F12 打开开发者工具。
3. 进入 Application / 应用。
4. 在 Cookies 中找到 `userinfo`。
5. `userinfo` 的前半部分为 userId，后半部分为 token。

不要把 token 分享给别人。

## 架构

本应用是 docker-project 类型的 FPK。安装时由 FnOS AppCenter 根据 `app/docker/docker-compose.yaml` 拉起容器。

| 服务 | 镜像 | 容器端口 | 主机端口 | 作用 |
| --- | --- | --- | --- | --- |
| `fn-iptv-ui` | `nginx:alpine` | 8510 | 8510 | 管理面板与同源反代 |
| `fn-iptv-migu` | `develop767/migu_video:latest` | 1234 | 3566 | 咪咕视频源 |

前端通过 nginx 同源反代访问 `/migu/`，避免浏览器 CORS。

## 数据与隐私

- 本仓库不包含私人咪咕账号、token 或私有播放源。
- userId/token 由用户自行填写，保存在 NAS 本机运行配置中。
- 订阅地址不直接暴露 userId/token。
- 项目不收集、不上传用户凭据。

## 本地构建

需要飞牛官方打包工具 `fnpack`：

```bash
cd fn-iptv
fnpack build
cp fn-iptv.fpk fn-iptv_x86.fpk
```

## 开源说明

代码采用 MIT 协议。请遵守所在地区法律法规和内容平台服务条款。
