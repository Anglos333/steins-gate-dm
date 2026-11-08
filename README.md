# Steins;Gate 因果律导演 (steins-gate-dm)

SillyTavern / TauriTavern 专用《命运石之门 (Steins;Gate)》原著因果律审查与动态设定检索（RAG）前端扩展。

## 安装方式（SillyTavern / TauriTavern）

在酒馆顶栏打开 **扩展 (Extensions)** -> **安装扩展 (Install extension)**，填入仓库地址：

```text
https://github.com/Anglos333/steins-gate-dm
```

## 核心特性

1. **面包屑结构化设定切片 (`knowledge_base.json`)**：按章节与设定维度切分，自带 `【所属词条 | 维度 | 适用世界线 | 适用阶段 | 认知隔离】` 面包屑前缀。
2. **简 / 繁（台版官方设定集）/ 日 / 黑话外号四合一别名检索 (`aliases.json`)**：精准映射「助手 / 克里斯蒂娜 / 栗悟饭和龟派气功」「金属乌帕 / 合金乌帕 / 轉蛋機」「闪光指压师 / M4」等别名，命中必召回。
3. **Generate Interceptor + `setExtensionPrompt` 用完即焚**：通过 `steinsGateDmInterceptor` 在发送瞬间动态注入当轮原著设定与 7/28 广播会馆六步因果锁，只对当轮生成生效，零聊天记录存档污染。
4. **MVU 状态变量 + `<state>` / `<trace>` 标签双保险同步**：自动追踪当前世界线变动率、吸引子场（β / α / SG / Ω）、时间与地点。
