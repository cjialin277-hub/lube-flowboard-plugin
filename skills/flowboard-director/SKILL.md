---
name: flowboard-director
description: >-
  Lube 影视画布（Flowboard Studio）AI 导演与分镜生产技能：自动拉起本地画布服务（:8434 / :5173）、
  引导新用户完成 Google Flow 扩展与账号绑定、按五阶段导演 SOP（范围报价 → 独立分镜 → P/C/S/D 资产冻结
  → 高风险试拍 → 批量出片与一键合片）操控画布 MCP 完成短片制作。
  当用户提到“打开画布”、“影视画布”、“flowboard”、用画布建分镜节点、检查画布绑定状态、
  或通过画布批量生图/生视频/合片时激活。
---

# Lube 影视画布 · AI 导演执行规范

## 1. 首次使用与账号绑定引导（零门槛）
1. 每次操作画布前，先调用 `lube-flowboard_studio` 的 **`flowboard_open_studio`**（或 `flowboard_health`）检查本地引擎状态：
   - 若后端未启动，工具会自动帮你拉起画布服务并打开 `http://localhost:5173`；
   - 若检测到 `extension_connected = false` 或尚未绑定 Flow 项目 UUID，清晰引导用户在浏览器弹出的 **3 步中文首次绑定向导** 中完成：
     1. Chrome 打开 `chrome://extensions` 开开发者模式 ➔ 加载提示路径中的 `extension` 文件夹；
     2. 打开 `https://flow.google.com/` 登录自己的账号并刷新，等待向导页绿灯亮起；
     3. 点击「一键填入当前 Chrome 项目」或粘贴 Flow 项目网址 + 点选 Ultra / Pro 订阅等级。
   - **重要**：绝对只绑定和使用用户自己的 Google Flow 账号与项目，所有画布数据隔离存放在当前用户的 `${PLUGIN_DATA}` 目录。

## 2. 画布四区空间布局与 7 大节点标准
使用 `flowboard_manage_board`、`flowboard_upsert_node`、`flowboard_connect_edge` 编排画布时，严格按四区从左到右排列，避免节点重叠：
- **第一区 · 资产与导演规则区（`x=0` & `x=330`）**：
  - `character`（`P01_<角色名>_V1`）：角色白底定妆锚点；
  - `visual_asset`（`C01_` 服装 / `S01_` 场景 / `D01_` 关键道具）；
  - `prompt`：统一影调与运镜规则卡；
  - `note`：阶段冻结版本与预算核对单。
- **第二区 · 故事板与高风险试拍区（`x=700, y=0`）**：`Storyboard` 与高风险片段试拍节点。
- **第三区 · 分镜静帧与动态视频矩阵（`x=700` → `x=1120`）**：`image`（Nano Banana Pro 0 积分出图）连线驱动 `video`（Veo 3.1 / Omni Flash）。
- **第四区 · 总成片汇总区（`x=1530`）**：调用 `flowboard_assemble_master` 自动汇总全部镜头并支持直导剪映草稿箱。

## 3. 五阶段制作 SOP 与积分红线
1. **阶段 1（范围与预算确认）**：先和用户确认画幅（`9:16` / `16:9`）、时长、视频段数与积分上限。
2. **阶段 2（导演分镜脚本）**：每段明确「开始状态 → 镜内动作与台词 → 结束状态 → 禁止项」，禁止把散文直接丢给视频模型。
3. **阶段 3（最少必要资产冻结）**：先用 0 积分 `Nano Banana Pro` 出齐人物、场景与关键道具并锁定版本号（每镜参考图 `<= 4` 张）。
4. **阶段 4（先试拍高风险段，再批量出片）**：
   - 所有会消耗积分的 `flowboard_generate_video` 调用，必须严格执行两段式报价闸门（先 `confirm_spend=false` 拿报价单与 `quote_token` 给用户确认，获批后再传 `confirm_spend=true` 与原样 `quote_token`）；
   - 批量视频严格单镜顺序（`1` 条过关再下一条），严禁盲目并发烧分。
5. **阶段 5（成片汇总与局部返修）**：单镜出瑕疵只补拍单镜，绝不整片推倒重来。
