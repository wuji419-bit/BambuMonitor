# README 与双语宣传视频实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写项目介绍、更新六张脱敏截图，并制作带中英文男声配音和字幕的两条 30 秒 B 站宣传视频。

**Architecture:** 使用应用现有预览数据生成状态类画面，使用真实应用摄像头画面生成摄像头类素材并脱敏。视频通过可重复执行的素材清单、旁白音轨、字幕和 FFmpeg 时间线生成，README 只引用适合 GitHub 加载的压缩图片，视频成品保存在发布素材目录。

**Tech Stack:** Electron、React、Vite、内置浏览器控制、Windows 桌面控制、OpenAI Speech、FFmpeg、Markdown。

---

### Task 1: 建立宣传素材目录与检查规则

**Files:**
- Create: `docs/media/README.md`
- Create: `docs/media/video/storyboard-zh.md`
- Create: `docs/media/video/storyboard-en.md`

- [ ] **Step 1:** 创建目录说明，记录截图名称、公开隐私规则、视频分辨率和输出文件名。
- [ ] **Step 2:** 写中文 30 秒分镜、旁白和逐句时间码。
- [ ] **Step 3:** 写语义一致且自然的英文分镜、旁白和逐句时间码。
- [ ] **Step 4:** 检查两版旁白在沉稳语速下均不超过 30 秒。
- [ ] **Step 5:** 提交 `docs: add bilingual promo storyboards`。

### Task 2: 生成六张当前界面截图

**Files:**
- Replace: `docs/screenshots/dashboard.png`
- Replace: `docs/screenshots/mini.png`
- Replace: `docs/screenshots/login.png`
- Create: `docs/screenshots/compact.png`
- Create: `docs/screenshots/camera-wall.png`
- Create: `docs/screenshots/camera-zoom.png`
- Create: `docs/screenshots/settings.png`

- [ ] **Step 1:** 启动当前工作区开发服务器并打开 `?preview=dashboard`。
- [ ] **Step 2:** 在完整、紧凑和迷你尺寸分别截取状态界面。
- [ ] **Step 3:** 在已安装桌面版中截取摄像头墙、放大画面和设置面板。
- [ ] **Step 4:** 裁掉桌面背景并遮盖 IP、账号和其他私人信息。
- [ ] **Step 5:** 检查每张图无重叠、裁切、空白画面或旧版 UI。
- [ ] **Step 6:** 提交 `docs: refresh product screenshots`。

### Task 3: 重写 README 产品介绍

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** 重写首屏标题、一句话价值和核心能力概览。
- [ ] **Step 2:** 插入主图和功能画廊，使用相对路径引用新截图。
- [ ] **Step 3:** 保留并精简安装、云端状态、局域网/VPN 摄像头、非官方声明和 AGPLv3 内容。
- [ ] **Step 4:** 添加简短英文摘要，避免重复整篇中文内容。
- [ ] **Step 5:** 检查所有 Markdown 图片路径存在。
- [ ] **Step 6:** 提交 `docs: redesign project introduction`。

### Task 4: 生成中英文配音与字幕

**Files:**
- Create: `docs/media/video/bambu-monitor-zh.wav`
- Create: `docs/media/video/bambu-monitor-en.wav`
- Create: `docs/media/video/bambu-monitor-zh.srt`
- Create: `docs/media/video/bambu-monitor-en.srt`

- [ ] **Step 1:** 使用沉稳科技感男声生成中文旁白。
- [ ] **Step 2:** 使用同类音色生成英文旁白。
- [ ] **Step 3:** 根据最终音频时长校准两份 SRT 字幕。
- [ ] **Step 4:** 检查语音清晰、无截字，字幕不超出安全区。

### Task 5: 剪辑两条 30 秒宣传视频

**Files:**
- Create: `docs/media/video/render-promo.ps1`
- Create: `docs/media/video/bambu-monitor-bilibili-zh.mp4`
- Create: `docs/media/video/bambu-monitor-bilibili-en.mp4`
- Create: `docs/media/video/bambu-monitor-cover.png`

- [ ] **Step 1:** 使用截图与短录屏建立 `1920x1080`、30fps 时间线。
- [ ] **Step 2:** 添加简洁转场、双语烧录字幕和项目结尾卡。
- [ ] **Step 3:** 生成无版权风险的轻科技背景节奏音轨，并在旁白期间降低音量。
- [ ] **Step 4:** 输出 H.264/AAC MP4，确认时长约 30 秒且音画同步。
- [ ] **Step 5:** 从主视觉生成无私人信息的 B 站封面图。
- [ ] **Step 6:** 提交 `media: add bilingual Bilibili promo videos`。

### Task 6: 最终验证与发布

**Files:**
- Verify: `README.md`
- Verify: `docs/screenshots/*`
- Verify: `docs/media/video/*`

- [ ] **Step 1:** 运行 `npm.cmd test`，预期全部测试通过。
- [ ] **Step 2:** 运行 `npm.cmd run lint`，预期零错误。
- [ ] **Step 3:** 运行 `npm.cmd run build`，预期生产构建成功。
- [ ] **Step 4:** 运行 `git diff --check` 并验证所有 README 图片路径。
- [ ] **Step 5:** 抽帧检查两条视频开头、中段、结尾，确认无隐私信息和字幕裁切。
- [ ] **Step 6:** 推送 `codex/resizable-workspace-ui` 并核对远端提交。
