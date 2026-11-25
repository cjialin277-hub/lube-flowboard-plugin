# Lube 影视画布（Antigravity 插件版 · `lube-flowboard`）

把 **AI 影视分镜画布工作台（Flowboard Studio v2.0）** 直接装进你的 **Google Antigravity**！  
安装并启用后，自动解锁：
- **本地影视画布引擎 + 3 步中文首次绑定向导**（`http://localhost:5173`，自动检测你自己的 Chrome 扩展与 Google Flow 账号）
- **11 个画布 MCP 操控工具**（开画布、建分镜节点、连线、0 积分出图、两段式报价拍视频、抽尾帧接力、一键合片直导剪映）
- **五阶段 AI 导演分镜技能（`/flowboard-director`）与防烧分护栏规则**

---

## 一、 安装方式（macOS）

### 方式 1：从 GitHub 仓库一键安装（推荐分享给朋友）
```bash
agy plugin install https://github.com/cjialin277-hub/lube-flowboard-plugin
```

### 方式 2：从本地文件夹安装（直接发压缩包给朋友）
1. 解压压缩包得到 `lube-flowboard-plugin` 文件夹；
2. 在终端运行：
```bash
agy plugin install /path/to/lube-flowboard-plugin
```

---

## 二、 首次启用与绑定你自己的信息（3 分钟）

1. 在 Antigravity 左侧 **Customizations > Installed** 找到 **Lube 影视画布 (Flowboard Studio)** 并开启开关（或 CLI 运行 `agy plugin enable lube-flowboard`）。
2. Antigravity 会弹出配置框，引导你填写 2 项基础信息：
   - **Google Flow 项目网址或 UUID**：去 [flow.google.com](https://flow.google.com/) 登录你自己的账号，新建一个空白项目，复制地址栏网址粘贴进去；
   - **订阅等级**：Ultra 填 `PAYGATE_TIER_TWO`，Pro 填 `PAYGATE_TIER_ONE`。
3. 随便在对话里说一句：**「启动 Lube 影视画布并检查我的账号绑定状态」**：
   - 插件会自动初始化独立环境（首次约 1～2 分钟，需本机已装 Node.js 18+）并打开 `http://localhost:5173`；
   - 按页面上的 **3 步中文引导向导** 加载 `extension` 文件夹到 Chrome 扩展页，看到绿灯亮起即可开拍！

---

## 三、 隐私与数据隔离说明

- 本插件**不含任何他人的账号、密钥或素材**；
- 你在画布里创作的所有项目、数据库和媒体文件均保存在你本机独立的 `${PLUGIN_DATA}` 目录中，升级插件也不会丢失数据。
