# DingTalk bridge agent notes

## 私聊编号控制

- 发送 `历史会话` 或 `会话列表`，桥接在本地列出最多 10 个历史会话。
- 回复 `1`、`2` 等自然编号，桥接在本地切换对应历史会话。
- 发送 `模型列表` 或 `模型`，桥接在本地列出最多 10 个可用模型。
- 回复模型编号后，桥接继续列出该模型支持的推理强度，再回复编号完成模型和推理强度切换。
- 列表命令和编号选择不会转发给 Codex。选择完成后，下一条普通消息才进入 Codex。
- 编号菜单绑定当前私聊，10 分钟后失效。无有效菜单时，数字消息按普通消息处理。
- `/new`、`/relay` 和控制台中的会话、模型管理继续有效。

## 新用户本机 JSON 初始化

- `scripts/setup.ps1` 使用 UTF-8 无 BOM 在 `%LOCALAPPDATA%\DingTalkCodexBridge` 自动创建以下个人文件，不得提交到仓库或复制给其他用户。
- `bridge-config.json` 保存 `clientId`、`clientSecret`、`pairCode`、`codexExe`、`cwd` 和 `writableRoots`。其中 `clientSecret` 和 `pairCode` 只由当前用户在本机配置。
- `bridge-state.json` 初始格式为 `{"owner":null,"threads":{},"seen":[],"groups":{}}`，配对、会话和群登记后由桥接更新。
- `external-assistants.json` 初始格式为 `{"assistants":[]}`。需要外部助手联动时，再由部署者补充助手名称、群 ID 和已核实的钉钉身份。
- `robot-mentions-groups.json` 初始格式为 `[]`。只有部署者明确加入已核实的群会话 ID 后，桥接才归档该群 @机器人的消息或处理 MR 信号。
- 初始化脚本遇到已有 `bridge-config.json` 会停止，不覆盖已有配置。补充文件时必须保留现有内容并使用最小修改。

## 暂缓功能

- `browser-relay.cjs` 和 `browser-relay.test.cjs` 属于桌面浏览器代查 CODING MR 评论功能，当前暂不纳入发布提交。
