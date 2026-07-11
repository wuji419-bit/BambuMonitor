# BambuMonitor 动态宣传片重制实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 Image 2、HyperFrames 和 Remotion 制作高分辨率、完整中英文本地化、约 50-65 秒的双语 BambuMonitor 产品宣传片。

**Architecture:** Image 2 只生成无文字的高清打印机与深墨绿打印板素材。HyperFrames 产出品牌开场与开源收尾动态片段；Remotion 使用可本地化的矢量 UI 组件组合设备状态、窗口形态、摄像头和设置场景，并完成双语时间线、字幕、配音与最终渲染。

**Tech Stack:** ChatGPT Image 2、HyperFrames HTML/GSAP、Remotion、React/TypeScript、edge-tts、FFmpeg。

---

### Task 1: 建立视觉制作工程

**Files:**
- Create: `promo/DESIGN.md`
- Create: `promo/assets/README.md`
- Create: `promo/scripts/zh.txt`
- Create: `promo/scripts/en.txt`

- [ ] **Step 1:** 写入设计规范中的准确色板、字体、动效和禁止项。
- [ ] **Step 2:** 写约 50-65 秒中文旁白，按品牌、多设备、窗口、摄像头、设置和开源六段组织。
- [ ] **Step 3:** 写语义一致的英文旁白，避免逐字直译。
- [ ] **Step 4:** 提交 `docs: scaffold cinematic promo production`。

### Task 2: 使用 Image 2 重绘高清设备素材

**Files:**
- Create: `promo/assets/printer-hero-ink-green.png`
- Create: `promo/assets/printer-detail-ink-green.png`
- Create: `promo/assets/image-production-ledger.md`

- [ ] **Step 1:** 将 `docs/screenshots/camera-zoom.png` 与 `docs/screenshots/camera-wall.png` 作为构图参考上传到 web ChatGPT Image 2。
- [ ] **Step 2:** 生成无 UI 文字的打印机舱内广角镜头，保留机械结构，打印板替换为 `#163A32` 哑光深墨绿，输出至少 1536px 宽 PNG。
- [ ] **Step 3:** 生成喷头、导轨与深墨绿打印板的高细节近景，避免随机文字、水印、额外设备和紫色残留。
- [ ] **Step 4:** 打开两张 PNG 检查透视、结构、清晰度和颜色；若失败，只针对问题区域迭代一次。
- [ ] **Step 5:** 在 ledger 记录输入、最终提示、输出尺寸和导出方式。
- [ ] **Step 6:** 提交 `media: add high-resolution printer visuals`。

### Task 3: 制作 HyperFrames 品牌动态片段

**Files:**
- Create: `promo/hyperframes/index.html`
- Create: `promo/hyperframes/DESIGN.md`
- Create: `promo/hyperframes/package.json`
- Create: `promo/hyperframes/renders/brand-plates.mp4`

- [ ] **Step 1:** 运行 `npx hyperframes init promo/hyperframes --example product-promo --non-interactive`。
- [ ] **Step 2:** 按 `promo/DESIGN.md` 制作 12 秒品牌片段：0-6 秒为产品开场，6-12 秒为 GitHub / AGPLv3 收尾。
- [ ] **Step 3:** 每个文字、数字和装饰元素均添加 GSAP 入场；两个场景之间使用遮罩或推拉转场。
- [ ] **Step 4:** 运行 `npx hyperframes lint promo/hyperframes`、`npx hyperframes validate promo/hyperframes` 和 `npx hyperframes inspect promo/hyperframes --samples 15`，修复所有错误与非故意溢出。
- [ ] **Step 5:** 运行 `npx hyperframes render promo/hyperframes --output renders/brand-plates.mp4 --fps 30 --quality high`。
- [ ] **Step 6:** 提交 `media: add HyperFrames brand animation`。

### Task 4: 搭建 Remotion 双语矢量界面

**Files:**
- Create: `promo/remotion/package.json`
- Create: `promo/remotion/src/index.ts`
- Create: `promo/remotion/src/Root.tsx`
- Create: `promo/remotion/src/Promo.tsx`
- Create: `promo/remotion/src/copy.ts`
- Create: `promo/remotion/src/theme.ts`
- Create: `promo/remotion/src/components/AppFrame.tsx`
- Create: `promo/remotion/src/components/DeviceCard.tsx`
- Create: `promo/remotion/src/components/Captions.tsx`
- Create: `promo/remotion/src/scenes/BrandScene.tsx`
- Create: `promo/remotion/src/scenes/DashboardScene.tsx`
- Create: `promo/remotion/src/scenes/ModesScene.tsx`
- Create: `promo/remotion/src/scenes/CameraScene.tsx`
- Create: `promo/remotion/src/scenes/SettingsScene.tsx`
- Create: `promo/remotion/src/scenes/OpenSourceScene.tsx`

- [ ] **Step 1:** 在 `promo` 中运行 `npx create-video@latest --yes --blank --no-tailwind remotion`，并安装 `@remotion/transitions`、`@remotion/media` 和 `@remotion/captions`。
- [ ] **Step 2:** 在 `copy.ts` 定义 `zh` 与 `en` 字典，覆盖导航、统计、状态、设置、摄像头和开源文案；设备型号与数值保持一致。
- [ ] **Step 3:** 创建同一套矢量 UI 组件，所有可见标签从字典读取，不在图片中烘焙 UI 文字。
- [ ] **Step 4:** 创建六个场景并使用 `useCurrentFrame()`、`interpolate()` 与弹簧完成入场、进度、窗口形变和镜头推拉。
- [ ] **Step 5:** 使用 `TransitionSeries` 连接场景，转场 15-24 帧，最终总时长按旁白较长版本计算为约 50-65 秒。
- [ ] **Step 6:** 注册 `BambuPromoZH` 与 `BambuPromoEN` 两个 `1920x1080`、30fps composition。
- [ ] **Step 7:** 运行 TypeScript 检查并分别渲染第 150、600、1050、1500 帧，检查无重叠、黑边和中文残留。
- [ ] **Step 8:** 提交 `media: build localized Remotion promo`。

### Task 5: 生成双语配音、字幕和声音设计

**Files:**
- Create: `promo/remotion/public/audio/narration-zh.mp3`
- Create: `promo/remotion/public/audio/narration-en.mp3`
- Create: `promo/remotion/src/captions.zh.ts`
- Create: `promo/remotion/src/captions.en.ts`
- Create: `promo/remotion/public/audio/ambient-tech.wav`

- [ ] **Step 1:** 使用免费 `edge-tts` 的 `zh-CN-YunxiNeural` 与 `en-US-GuyNeural` 生成沉稳男声，语速保持自然。
- [ ] **Step 2:** 用 `ffprobe` 读取两段旁白时长，以较长音频加 2 秒作为 composition 最小长度。
- [ ] **Step 3:** 将字幕转换为 Remotion `Caption[]`，每条最多两行并按语义断句。
- [ ] **Step 4:** 生成原创轻科技背景音与短促转场提示音；旁白播放时音乐自动降低。
- [ ] **Step 5:** 运行音量检查，旁白峰值不超过 -3 dB，最终混音不削波。
- [ ] **Step 6:** 提交 `media: add bilingual narration and sound design`。

### Task 6: 最终渲染与验收

**Files:**
- Create: `docs/media/video/bambu-monitor-cinematic-zh.mp4`
- Create: `docs/media/video/bambu-monitor-cinematic-en.mp4`
- Replace: `docs/media/video/bambu-monitor-cover.png`
- Create: `docs/media/video/bambu-monitor-cover-en.png`
- Modify: `README.md`

- [ ] **Step 1:** 使用 Remotion 高质量参数渲染中英文 MP4，并开启 faststart。
- [ ] **Step 2:** 渲染中英文封面，中文封面用于 B 站主发布。
- [ ] **Step 3:** 抽取开场、多设备、窗口、摄像头、设置和结尾六组关键帧；检查英文版无中文界面文案。
- [ ] **Step 4:** 用 `ffprobe` 验证两条视频为 H.264/AAC、`1920x1080`、30fps，时长落在内容所需范围。
- [ ] **Step 5:** 运行项目 `npm.cmd test`、`npm.cmd run lint`、`npm.cmd run build` 与 `git diff --check`。
- [ ] **Step 6:** 更新 README 视频说明并提交 `media: publish cinematic bilingual promos`。
