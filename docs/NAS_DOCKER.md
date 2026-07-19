# BambuMonitor NAS Docker 版部署指南

本指南适用于支持 Docker Compose 的 **Linux NAS**。首版正式支持 `host network`（主机网络）运行方式，镜像同时提供 `amd64` 与 `arm64` 架构。macOS Docker Desktop 可以用于临时验证，但它的主机网络与 Linux NAS 不同，不作为正式 NAS 生产部署路径。

容器镜像固定为：`ghcr.io/wuji419-bit/bambu-monitor:latest`。

## 准备条件

- NAS 已安装 Docker Engine 与 Docker Compose 插件，并可执行 `docker compose version`。
- NAS 能访问互联网，以便拉取镜像和连接拓竹云端服务。
- 如需摄像头或本地状态，NAS 必须能直接访问打印机所在 LAN（局域网）。
- 当前用户可以管理 Docker，并能为 NAS 共享目录设置用户编号 `1000` 的读写权限。

## 首次部署

### 1. 创建目录和数据权限

登录 NAS 的终端后执行：

```bash
mkdir -p bambu-monitor
cd bambu-monitor
mkdir -p data
chown -R 1000:1000 data
```

容器以用户编号 `1000` 运行。若 NAS 不允许执行 `chown`，请在共享目录权限界面进行等效设置，确保编号 `1000` 对 `data` 目录有读取、写入和进入权限。

### 2. 保存编排文件

在当前目录把以下内容保存为 `compose.yaml`：

```yaml
services:
  bambu-monitor:
    image: ghcr.io/wuji419-bit/bambu-monitor:latest
    container_name: bambu-monitor
    network_mode: host
    restart: unless-stopped
    environment:
      PORT: 3080
      DATA_DIR: /app/data
      TZ: Asia/Shanghai
      TRUST_PROXY: "0"
    volumes:
      - ./data:/app/data
```

### 3. 启动并访问

```bash
docker compose up -d
```

浏览器打开 `http://NAS-IP:3080`，把 `NAS-IP` 换成 NAS 的局域网地址。进入页面后可直接使用拓竹账号登录。

## 日常运维

### 查看日志

```bash
docker compose logs -f
```

按 `Ctrl+C` 只会退出日志跟踪，不会停止容器。

### 升级

```bash
docker compose pull
docker compose up -d
```

升级不会删除挂载在 `./data` 的配置和登录会话。

### 停止

```bash
docker compose down
```

也可以用 `docker compose stop` 暂停服务，再用 `docker compose start` 恢复。

### 备份

建议先停止服务，再备份整个 `./data` 目录：

```bash
docker compose down
tar -czf bambu-monitor-data-backup.tar.gz ./data
docker compose up -d
```

恢复时应整体恢复该目录并重新确认 `1000:1000` 权限，不要只挑选其中某个文件。

### 完整重置

完整重置会删除账号会话、配置、设备缓存和加密密钥。先执行 `docker compose down` 停止容器，再删除并重建 `data`，不要在容器运行时删除数据：

```bash
docker compose down
rm -rf ./data
mkdir -p data
chown -R 1000:1000 data
docker compose up -d
```

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3080` | NAS Web 服务监听端口；主机网络模式下也是浏览器访问端口。 |
| `DATA_DIR` | `/app/data` | 容器内持久化数据目录，应保持与卷挂载目标一致。 |
| `TZ` | `Asia/Shanghai` | 日志和运行时使用的时区，可改为 NAS 所在时区。 |
| `TRUST_PROXY` | `0` | 是否信任反向代理转发的协议头。 |

只有在服务位于**受信任的反向代理**之后，并且该代理会正确覆盖 `X-Forwarded-Proto` 时，才把 `TRUST_PROXY=1`。直接访问 NAS、代理来源不受控或代理只是透传客户端头时必须保持 `0`。

修改 `compose.yaml` 后执行 `docker compose up -d` 使配置生效。

## 健康检查

- `http://NAS-IP:3080/healthz`：进程存活检查，正常返回 `200`。
- `http://NAS-IP:3080/readyz`：服务就绪检查，存储初始化完成后返回 `200`。
- 当 `data` 不可写时，`readyz` 返回 `503`；请查看 `docker compose logs`，常见存储权限错误码（storage permission code）为 `EACCES` 或 `EPERM`。

可在 NAS 上检查：

```bash
curl -i http://127.0.0.1:3080/healthz
curl -i http://127.0.0.1:3080/readyz
```

## 账号、云端状态与局域网画面

- 在 NAS 页面中使用拓竹账号直接登录；密码和验证码只用于当前登录请求。
- 云端状态通过拓竹云服务同步，不要求为打印机填写本地 IP。
- 摄像头和本地状态需要 NAS 能访问打印机 LAN；浏览器本身不需要访问打印机私网地址。
- 外部浏览器只连接 NAS。绝不向公网暴露打印机 MQTT 和摄像头端口，也不支持让公网浏览器直接读取打印机画面。
- HTTPS、域名和反向代理由用户自行管理。对外提供 NAS 页面时应使用 HTTPS，并限制管理入口的访问范围。

## 数据与密钥

`./data` 包含服务配置、会话和加密材料。`secret.key` 丢失或损坏会使 `session.enc` 无法解密，此时需要重新登录。必须备份整个 `data` 目录，使密钥与其加密的数据保持同一版本。

不要把 `data` 目录提交到 Git、同步到公开网盘或发送给他人。备份文件也包含敏感信息，应加密保存并限制读取权限。

## 安全建议

- 及时升级镜像与 NAS 系统，不使用来源不明的镜像标签。
- 只开放 BambuMonitor 的 NAS Web 入口，不开放打印机 MQTT、RTSPS 或摄像头端口。
- 主机网络模式下容器直接使用 NAS 网络；请用 NAS 防火墙限制 `PORT` 的来源范围。
- 使用反向代理时启用 HTTPS，并仅在满足前述条件时设置 `TRUST_PROXY=1`。
- 定期备份整个 `data`，并验证备份可以恢复权限与文件。

## 排错

### 页面无法打开

1. 执行 `docker compose ps`，确认容器处于运行状态。
2. 执行 `docker compose logs -f` 查看启动错误。
3. 在 NAS 本机请求 `/healthz`，再检查 NAS 防火墙是否允许 `3080`。
4. 确认没有其他程序占用 `PORT`。

### 就绪检查返回 503

检查 `data` 的所有者和写权限：

```bash
ls -ld ./data
chown -R 1000:1000 data
docker compose up -d
```

日志中的 `EACCES` 或 `EPERM` 表示存储权限错误。若 NAS 使用共享目录权限界面，请在那里授予等效权限。

### 有云端状态但没有摄像头

云端在线不代表局域网摄像头可达。确认 NAS 与打印机之间的路由、防火墙、访客网络隔离和 VLAN 规则允许通信；不要通过公网端口映射解决。

### 登录会话失效

确认 `./data` 被正确挂载且没有被临时目录替代。若 `secret.key` 与 `session.enc` 不匹配、丢失或损坏，只能清理失效会话并重新登录，再从完整且匹配的 `data` 备份恢复其他数据。

## 卸载

先停止并移除容器：

```bash
docker compose down
```

确认不再需要配置和会话后，再删除部署目录。若仍可能恢复使用，请先备份整个 `./data`。镜像可按需删除：

```bash
docker image rm ghcr.io/wuji419-bit/bambu-monitor:latest
```

## 社区与源码

- GitHub：<https://github.com/wuji419-bit/BambuMonitor>
- QQ 交流群：`526457346`

本项目使用 AGPLv3。修改后通过网络部署或提供服务时，必须向该网络服务的用户提供正在运行的对应版本完整源码，并保留许可证与版权声明；仅发布容器镜像不能替代这项网络部署义务。
