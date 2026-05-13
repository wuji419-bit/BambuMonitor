# BambuMonitor

BambuMonitor 是一款面向 Bambu Lab / 拓竹打印机的 Windows 桌面悬浮监控工具。它会登录拓竹账号读取已绑定设备，在局域网内发现可连接的打印机，并通过本地 MQTT 显示实时打印进度、剩余时间、温度、AMS 和异常状态。

它不是切片软件，也不会替代 Bambu Studio；它更像一个常驻桌面的轻量监控面板，适合多台机器同时打印时快速查看状态。

## 截图

![登录页面](./docs/screenshots/login.png)

![监控面板](./docs/screenshots/dashboard.png)

## 下载安装

Windows 安装包在 GitHub Release 中提供：

[前往 Releases 下载](https://github.com/wuji419-bit/BambuMonitor/releases)

源码仓库不会提交 `release/`、`dist/`、`node_modules/` 或本地调试文件。

## 功能

- 多台 Bambu Lab / 拓竹打印机同时监控
- 完整模式、紧凑模式和超迷你模式
- 窗口置顶、鼠标穿透锁定和透明度调节
- 账号密码登录和验证码登录
- 自动局域网扫描，扫不到时可手动设置 IP
- 实时显示进度、剩余时间、层数、温度、风扇、速度和 AMS 信息
- Windows 托盘菜单：显示/隐藏、锁定、布局切换、透明度调节和退出
- OpenClaw、Hermes 或其他 Webhook 自动化通知

## 快捷键

- `Ctrl + Shift + L`：锁定/解锁鼠标穿透
- `Ctrl + Shift + H`：切换横向/纵向布局

## 技术栈

- Electron 40
- React 19
- Vite 7
- MQTT over TLS
- Bambu Cloud API + 局域网 SSDP 扫描

## 开发

```bash
npm install
npm run electron:dev
```

## 打包

```bash
npm run build
npm run electron:build
```

打包后的 Windows 安装包会输出到 `release/`。

## 版本规则

后续每次功能或打包更新都递增一个小版号，按 npm/electron-builder 兼容的语义化版本执行：`1.0.1` -> `1.0.2` -> `1.0.3`。

## English

BambuMonitor is a desktop floating monitor for Bambu Lab printers. It signs in with a Bambu account, reads the bound printer list, discovers reachable printers on the LAN, and displays real-time print progress through local MQTT.

## License

MIT
