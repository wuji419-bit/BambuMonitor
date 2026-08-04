# BambuMonitor Windows 使用说明

这是一款给 Bambu Lab / 拓竹打印机用的桌面监控工具。登录后可以自动读取你账号下的打印机，并在一个可自由缩放的悬浮工作区里查看实时打印进度、温度、AMS 耗材和摄像头画面。支持完整、紧凑、迷你和摄像头四种窗口模式。

## 安装（推荐）

直接从 GitHub Releases 下载 Windows 安装包（`.exe`）：

**[前往 Releases 下载](https://github.com/wuji419-bit/BambuMonitor/releases)**

安装后从开始菜单启动即可，无需安装 Node.js。

## 登录说明

- 支持账号密码登录
- 如果云端要求安全验证，会自动切到验证码模式
- 登录成功后会读取账号下的打印机列表，登录会话会安全保存，正常重启不需要重新登录

## 扫描与连接

- 只查看云端状态不需要填写打印机本地 IP
- 程序会自动扫描局域网中的拓竹打印机，扫描大约需要 6 秒
- 摄像头和低延迟本地数据需要电脑与打印机在同一局域网（或经 VPN 可达）
- 如果某台非云端设备没扫到 IP，可以在界面里点击“设置打印机 IP”手动输入

## 常用快捷键

- `Ctrl + Shift + L`：锁定/解锁鼠标穿透
- `Ctrl + Shift + H`：切换横向/纵向布局

## 常见问题

### 1. 登录失败

- 检查账号密码是否正确
- 检查网络是否能访问拓竹云端
- 如果提示会话过期，重新登录即可

### 2. 扫描不到打印机

- 确认电脑和打印机在同一个局域网
- 确认打印机已经绑定到当前账号
- 可以尝试手动设置打印机 IP（仅影响本地摄像头和低延迟数据，云端状态不受影响）

### 3. 打包后没有图标

当前项目已经包含 Windows 图标资源；如果你替换品牌图标，请同步更新 `build/icon.ico`。

## 开发者：从源码运行

需要先安装 [Node.js LTS](https://nodejs.org/zh-cn)，然后在项目目录执行：

```bash
npm install
npm run electron:dev
```

生成可分发的 Windows 安装包：

```bash
npm run electron:build
```

完成后可在 `release/` 目录看到打包结果。

## 更多

- NAS / Docker 网页版部署：[docs/NAS_DOCKER.md](./docs/NAS_DOCKER.md)
- 通知与 Webhook 集成：[docs/notification-integrations.md](./docs/notification-integrations.md)
- 开源协议：AGPL-3.0-or-later，详见 [LICENSE](./LICENSE)
