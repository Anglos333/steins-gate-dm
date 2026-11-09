/**
 * Steins;Gate 因果律导演前端插件 (steins-gate-dm)
 *
 * 核心能力：
 * 1. 【锦囊 1 · 面包屑切片知识库】：加载按章节/维度切分且自带前缀标签的 `knowledge_base.json`。
 * 2. 【锦囊 2 · 简/繁(台版)/日/黑话外号四合一别名检索】：通过 `aliases.json` 精准识别如「助手/克里斯蒂娜/栗悟饭和龟派气功」「金属乌帕/合金乌帕/轉蛋機」「打工战士/提托」等专有名词，命中必召回。
 * 3. 【锦囊 3 · Generate Interceptor + setExtensionPrompt 用完即焚】：注册 `steinsGateDmInterceptor`，在点击发送瞬间读取状态并检索设定，可选调用副模型做 JSON 导演审查，最后通过 `setExtensionPrompt('steins_gate_dm', ...)` 注入当轮上下文，零存档污染。
 * 4. 【锦囊 4 · MVU 状态变量 + <state>/<trace> 标签双保险同步】：优先读取角色卡 MVU `stat_data`（时间/地点/世界线变动率/所属场/叙事阶段），同时支持解析消息末尾 `<state>...</state>` 或 `<trace>...</trace>` 标签。
 */

const EXTENSION_KEY = 'steins_gate_dm';
const PROMPT_KEY = 'steins_gate_dm';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  mode: 'direct', // 'direct' (直通导演模式·零延迟) | 'submodel' (副模型审查导演模式)
  maxChunks: 5,
  promptPosition: 1, // 1 = IN_CHAT (按深度注入聊天上下文)
  promptDepth: 1,    // 距离最新消息深度 1
  submodelSource: 'quiet', // 'quiet' (复用酒馆当前连接 generateQuietPrompt) | 'custom' (独立 OpenAI 兼容小模型接口)
  submodelUrl: 'https://api.openai.com/v1/chat/completions',
  submodelKey: '',
  submodelName: 'gpt-4o-mini',
  lastInjectedPrompt: '',
  lastMatchedAliases: [],
  lastStateSnapshot: {
    time: '2010/07/28 11:58 (周三)',
    location: '秋叶原·广播会馆八楼会场',
    stage: '广播会馆开篇',
    divergence: '1.130426',
    attractorField: 'β',
    keyEvents: '冈部与真由理抵达广播会馆八楼中钵博士发布会现场，刚听见头顶天台传来沉闷震动，冈部正独自上楼查看'
  }
});

let aliasData = { entries: [] };
let kbData = { chunks: [] };
let kbLoaded = false;

/**
 * 获取 SillyTavern 上下文与设置对象
 */
function getStContext() {
  if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
    return SillyTavern.getContext();
  }
  return globalThis;
}

function getSettings() {
  const ctx = getStContext();
  const extSettings = ctx.extensionSettings || globalThis.extension_settings || {};
  if (!extSettings[EXTENSION_KEY]) {
    extSettings[EXTENSION_KEY] = structuredClone(DEFAULT_SETTINGS);
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (extSettings[EXTENSION_KEY][k] === undefined) {
      extSettings[EXTENSION_KEY][k] = structuredClone(v);
    }
  }
  return extSettings[EXTENSION_KEY];
}

function saveSettingsDebounced() {
  const ctx = getStContext();
  if (typeof ctx.saveSettingsDebounced === 'function') {
    ctx.saveSettingsDebounced();
  } else if (typeof globalThis.saveSettingsDebounced === 'function') {
    globalThis.saveSettingsDebounced();
  }
}

/**
 * 加载插件目录下的 aliases.json 与 knowledge_base.json
 */
async function ensureKnowledgeBaseLoaded() {
  if (kbLoaded && kbData.chunks.length > 0) return;
  try {
    const aliasUrl = new URL('./aliases.json', import.meta.url);
    const kbUrl = new URL('./knowledge_base.json', import.meta.url);
    const [aliasResp, kbResp] = await Promise.all([fetch(aliasUrl), fetch(kbUrl)]);
    if (aliasResp.ok) aliasData = await aliasResp.json();
    if (kbResp.ok) kbData = await kbResp.json();
    kbLoaded = true;
    console.log(
      `[Steins;Gate DM] 知识库加载完成：别名词条 ${aliasData.entries?.length || 0} 组，面包屑切片 ${kbData.chunks?.length || 0} 条`
    );
  } catch (err) {
    console.warn('[Steins;Gate DM] 加载知识库 JSON 失败:', err);
  }
}

/**
 * 【锦囊 4】从 MVU 变量 (stat_data) 或消息末尾 <state>/<trace> 标签提取当前时空与世界线状态
 */
export function extractCurrentWorldState(chat = []) {
  const settings = getSettings();
  const state = structuredClone(settings.lastStateSnapshot || DEFAULT_SETTINGS.lastStateSnapshot);

  // 1. 尝试从 TavernHelper / MVU chat_metadata 或消息楼层读取 stat_data
  try {
    const ctx = getStContext();
    let statData = null;

    if (typeof globalThis.getVariables === 'function') {
      const vars = globalThis.getVariables({ type: 'chat' });
      if (vars?.stat_data) statData = vars.stat_data;
    }

    if (!statData && Array.isArray(chat)) {
      for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        const candidate =
          msg?.variables?.[msg?.swipe_id ?? 0]?.stat_data ||
          msg?.variables?.stat_data ||
          msg?.extra?.stat_data ||
          msg?.stat_data;
        if (candidate && typeof candidate === 'object') {
          statData = candidate;
          break;
        }
      }
    }

    if (!statData && ctx?.chatMetadata?.stat_data) {
      statData = ctx.chatMetadata.stat_data;
    }

    if (statData) {
      if (statData.世界?.时间) state.time = String(statData.世界.时间);
      if (statData.世界?.地点) state.location = String(statData.世界.地点);
      if (statData.世界?.叙事阶段) state.stage = String(statData.世界.叙事阶段);
      if (statData.世界线?.变动率 !== undefined) state.divergence = String(statData.世界线.变动率);
      if (statData.世界线?.所属场) state.attractorField = String(statData.世界线.所属场);
      if (statData.剧情进度?.关键事件) state.keyEvents = String(statData.剧情进度.关键事件);
    }
  } catch (err) {
    console.debug('[Steins;Gate DM] 读取 MVU stat_data 跳过:', err);
  }

  // 2. 尝试从最近一轮 AI 回复的 <state>...</state> 标签或 <trace>...</trace> 中提取增量更新
  if (Array.isArray(chat)) {
    for (let i = chat.length - 1; i >= 0; i--) {
      const msg = chat[i];
      if (!msg || msg.is_user) continue;
      const mesText = String(msg.mes || '');

      // 匹配 <state>2010-08-02 下午 | 地点:秋叶原街道 | 世界线:0.571024%</state>
      const stateTagMatch = mesText.match(/<state>([\s\S]*?)<\/state>/i);
      if (stateTagMatch) {
        const parts = stateTagMatch[1].split('|').map(s => s.trim());
        for (const p of parts) {
          if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(p) || p.startsWith('时间:')) {
            state.time = p.replace(/^时间:\s*/, '').trim();
          } else if (p.startsWith('地点:')) {
            state.location = p.replace(/^地点:\s*/, '').trim();
          } else if (p.startsWith('世界线:')) {
            const div = p.replace(/^世界线:\s*/, '').replace(/%/g, '').trim();
            state.divergence = div;
          } else if (p.startsWith('阶段:')) {
            state.stage = p.replace(/^阶段:\s*/, '').trim();
          }
        }
        break;
      }

      // 匹配角色卡内置 <trace> 中的 Time / Location
      const traceMatch = mesText.match(/<trace>([\s\S]*?)<\/trace>/i);
      if (traceMatch) {
        const traceBody = traceMatch[1];
        const timeLine = traceBody.match(/-\s*Time:\s*(.+)/i);
        const locLine = traceBody.match(/-\s*Location:\s*(.+)/i);
        if (timeLine && !state.time) state.time = timeLine[1].trim();
        if (locLine && !state.location) state.location = locLine[1].trim();
        break;
      }
    }
  }

  // 根据世界线变动率数值自动校准所属吸引子场
  const numDiv = parseFloat(state.divergence);
  if (!Number.isNaN(numDiv)) {
    if (Math.abs(numDiv - 1.048596) < 0.0001) {
      state.attractorField = 'SG';
    } else if (numDiv < 0) {
      state.attractorField = 'Ω';
    } else if (numDiv >= 0 && numDiv < 1) {
      state.attractorField = 'α';
    } else if (numDiv >= 1) {
      state.attractorField = 'β';
    }
  }

  settings.lastStateSnapshot = state;
  return state;
}

/**
 * 【锦囊 2】扫描查询文本中的简/繁/日/外号别名，返回命中的标准词条与别名列表
 */
export function scanAliasesInText(queryText, aliasEntries = aliasData.entries) {
  const matchedCanonicals = new Set();
  const matchedAliasWords = new Set();
  const matchedEntityIds = new Set();

  const text = String(queryText || '');
  if (!text) return { canonicals: [], aliasWords: [], entityIds: [] };

  for (const entry of aliasEntries || []) {
    for (const alias of entry.aliases || []) {
      if (alias && alias.length >= 2 && text.includes(alias)) {
        matchedCanonicals.add(entry.canonical);
        matchedAliasWords.add(alias);
        matchedEntityIds.add(entry.id);
      }
    }
  }

  return {
    canonicals: Array.from(matchedCanonicals),
    aliasWords: Array.from(matchedAliasWords),
    entityIds: Array.from(matchedEntityIds)
  };
}

/**
 * 提取中文/日文二元字符组 (Character Bi-grams) 用于轻量语义相似度打分
 */
function buildBigrams(text) {
  const clean = String(text || '').replace(/[\s\p{P}]/gu, '');
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) {
    set.add(clean.slice(i, i + 2));
  }
  return set;
}

/**
 * 【锦囊 1 + 锦囊 2】混合检索：世界线硬过滤 + 别名必召回 + 阶段因果铁律 + 语义打分
 */
export function retrieveCanonChunks(queryText, worldState, maxChunks = 5, chunks = kbData.chunks, aliasEntries = aliasData.entries) {
  const combinedQuery = [
    queryText,
    worldState?.time || '',
    worldState?.location || '',
    worldState?.stage || '',
    worldState?.keyEvents || ''
  ].join(' ');

  const aliasHits = scanAliasesInText(combinedQuery, aliasEntries);
  const queryBigrams = buildBigrams(queryText + ' ' + (worldState?.location || ''));
  const isOpening728 =
    /07[-/]28|7月28日/.test(worldState?.time || '') ||
    /广播会馆|RADIO/i.test(worldState?.location || '') ||
    /开篇|序章/.test(worldState?.stage || '');

  const currentField = worldState?.attractorField || 'β';

  const scored = [];
  for (const chunk of chunks || []) {
    // 1. 世界线硬过滤：如果当前在 α 线，排除纯 SG0 专属且不含 α/通用的词条；如果在 7/28 开篇，排除 SG0 剧透
    const chunkWls = chunk.worldlines || ['通用'];
    const fieldCompatible =
      chunkWls.includes('通用') ||
      chunkWls.includes(currentField) ||
      (currentField === 'β' && chunkWls.includes('0') && !isOpening728);

    if (!fieldCompatible) continue;

    let score = 0;

    // 2. 7/28 广播会馆开篇黄金六步铁律强制置顶召回
    if (isOpening728 && chunk.entryName.includes('2010年7月28日广播会馆开篇六步因果链')) {
      score += 200;
    }
    if (isOpening728 && (chunk.entryName === '广播会馆' || chunk.entryName === '中钵博士')) {
      score += 65;
    }

    // 3. 别名实体命中加权（锦囊 2：命中黑话/外号必召回）
    for (const eid of aliasHits.entityIds) {
      if (chunk.entityIds?.includes(eid)) {
        score += 28;
      }
    }
    for (const canonical of aliasHits.canonicals) {
      if (chunk.entryName.includes(canonical)) {
        score += 45;
      } else if (chunk.keywords?.includes(canonical)) {
        score += 18;
      }
    }

    // 4. 用户输入直接命中词条名或维度名
    if (queryText && chunk.entryName && queryText.includes(chunk.entryName)) {
      score += 50;
    }

    // 5. Bi-gram 字符重叠度打分（补充语义相关条目）
    if (queryBigrams.size > 0) {
      const chunkTextSample = `${chunk.entryName} ${chunk.dimension} ${chunk.content.slice(0, 400)}`;
      let overlap = 0;
      for (const bg of queryBigrams) {
        if (chunkTextSample.includes(bg)) overlap++;
      }
      score += (overlap / Math.sqrt(queryBigrams.size)) * 12;
    }

    // 6. 官方设定集与世界书核心设定优先于长剧本散段
    if (chunk.sourceType === 'guidebook_pdf') score += 15;
    else if (chunk.sourceType === 'worldbook') score += 8;

    if (score > 5) {
      scored.push({ chunk, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // 去重并限制同一词条最多占 2 个名额，保证召回维度丰富
  const selected = [];
  const entryCount = new Map();
  for (const item of scored) {
    const count = entryCount.get(item.chunk.entryName) || 0;
    if (count >= 2 && selected.length < maxChunks) continue;
    selected.push(item.chunk);
    entryCount.set(item.chunk.entryName, count + 1);
    if (selected.length >= maxChunks) break;
  }

  return {
    selectedChunks: selected,
    aliasHits
  };
}

/**
 * 组装注入给主模型的 <steins_gate_dm_guidance> 导演指令文本
 */
export function buildDirectorPrompt(worldState, recalledChunks, aliasHits, submodelReviewText = '') {
  const isOpening728 =
    /07[-/]28|7月28日/.test(worldState?.time || '') ||
    /广播会馆|RADIO/i.test(worldState?.location || '') ||
    /开篇|序章/.test(worldState?.stage || '');

  const lines = [
    '<steins_gate_dm_guidance>',
    '【Steins;Gate 因果律导演系统 · 当轮动态设定与分镜约束（仅本轮生效）】',
    `- 当前世界线变动率：${worldState.divergence}（所属吸引子场：${worldState.attractorField}场）`,
    `- 当前时间：${worldState.time} | 当前地点：${worldState.location} | 叙事阶段：${worldState.stage}`,
    `- 当前关键剧情进度：${worldState.keyEvents || '按原著因果推进'}`
  ];

  if (aliasHits?.canonicals?.length > 0) {
    lines.push(`- 本轮识别到的原著专有词条/外号映射：${aliasHits.canonicals.join('、')}`);
  }

  if (isOpening728 && worldState.attractorField === 'β') {
    lines.push(
      '',
      '【7/28 广播会馆开篇绝对因果律防呆锁（严禁跳步或串改）】',
      '1. 顺序锁：①8楼会场开讲前头顶天台震动 → ②冈部独自走楼梯上天台见坏门锁（被手枪打坏）与C204卫星，只听到阴影处传来【年轻女性工作人员的声音】喝止驱赶（【认知隔离铁律】：冈部绝对没看到铃羽的脸，严禁显示铃羽立绘或写出阿万音铃羽真名！说话人只能写 `[女性工作人员][][]` 或 `[？？？][][]`） → ③回到8楼发现真由理不在，下到7楼楼梯间直接看到蹲在扭蛋机前的真由理（此处未发短信），必须由【冈部伦太郎亲手投100日元】抽出稀有【金属乌帕（合金乌帕）】送给真由理写名字 → ④回8楼听中钵抄袭约翰·提托理论，冈部起身反驳后被牧濑红莉栖拉出场外质问「15分钟前你是不是想对我说什么」（冈部初见红莉栖，红莉栖二见冈部） → ⑤冈部逃到楼梯拐角掏手机想找再次走散的真由理时，收到7秒雪花噪音视频邮件，随后回8楼会场外遇真由理告知价值1万日元的金属乌帕丢了 → ⑥两人寻找乌帕时听见通道深处传来男子的凄厉惨叫（未来冈部误杀红莉栖的哀嚎），冈部独自前往8楼深处杂物走廊发现血泊中的红莉栖 → ⑦逃出会馆在中央通发送第一封D-Mail跳入α世界线（0.571024）。',
      '2. 节奏锁：严禁在一轮回复中把上述多步一次性快进跑完！每轮只推进当前所在的 1 个自然场景节点，留出玩家（冈部）的互动反应空间。'
    );
  }

  lines.push(
    '',
    '【输出格式与 MVU 变量防崩铁律（最高优先级，覆盖任何第三方预设格式）】',
    '1. 严禁在最外层包裹 `<game>...</game>`，严禁在末尾输出 `<summary>`、`<comment>`、`<details>` 等额外标签。',
    '2. 若有前置思考过程（如 `<think>`、`<额外剧情思考>`），思考块内部【绝对禁止】写出带尖括号的 `<UpdateVariable>`、`<JSONPatch>`、`<content>` 字样（如需提及只能写纯字母 UpdateVariable），防止变量解析器提前捕获破损标签报错！',
    '3. 回复正文必须且只能按顺序输出 `<content>...</content>`、`<trace>...</trace>`、`<bgm>...</bgm>` 三个标签，并在整条回复的最末尾输出完整的 `<UpdateVariable>...</UpdateVariable>` 块。',
    '4. 在 `<JSONPatch>` 中更新数组字段（如 `/剧情进度/已触发锚点`、`/剧情进度/已揭露信息`）时，禁止使用 `/-` 追加语法，请对数组路径使用 `replace` 或数字下标 `/0`。'
  );

  if (submodelReviewText) {
    lines.push('', '【副模型导演本轮分镜审查指令】', submodelReviewText.trim());
  }

  if (recalledChunks && recalledChunks.length > 0) {
    lines.push('', '【本轮召回的原著权威设定切片（带面包屑上下文）】');
    for (const c of recalledChunks) {
      lines.push(c.content);
      lines.push('---');
    }
  }

  lines.push('</steins_gate_dm_guidance>');
  return lines.join('\n');
}

/**
 * 可选：调用副模型（小模型）生成本轮导演审查意见
 */
async function runSubmodelDirectorReview(userText, worldState, recalledChunks, settings) {
  const chunkSummary = recalledChunks
    .slice(0, 3)
    .map(c => c.content.slice(0, 350))
    .join('\n\n');

  const reviewPrompt = [
    '你是《命运石之门》原著因果律审查导演（DM）。请根据以下当前时空状态、玩家（冈部伦太郎）最新输入以及召回的原著设定切片，用不超过180字的精炼条目输出本轮主模型写作指令：',
    '1. 【因果合规检查】：玩家行为是否触碰当前世界线收束锁或7/28六步顺序锁？',
    '2. 【本轮推进边界】：本轮应当停留在哪个具体分镜节点，严禁超前剧透什么？',
    '3. 【原著细节锚点】：点名本轮必须还原的1~2个原著物理/道具/人物反应细节。',
    '',
    `当前状态：时间=${worldState.time} | 地点=${worldState.location} | 世界线=${worldState.divergence}(${worldState.attractorField}) | 阶段=${worldState.stage}`,
    `玩家最新输入：${userText || '（继续推进剧情）'}`,
    `相关原著设定：\n${chunkSummary}`
  ].join('\n');

  try {
    if (settings.submodelSource === 'custom' && settings.submodelUrl && settings.submodelKey) {
      const resp = await fetch(settings.submodelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.submodelKey}`
        },
        body: JSON.stringify({
          model: settings.submodelName || 'gpt-4o-mini',
          messages: [{ role: 'user', content: reviewPrompt }],
          max_tokens: 300,
          temperature: 0.2
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
      }
    } else {
      const ctx = getStContext();
      const quietFn = ctx.generateQuietPrompt || globalThis.generateQuietPrompt;
      if (typeof quietFn === 'function') {
        const result = await quietFn({ quietPrompt: reviewPrompt });
        return String(result || '');
      }
    }
  } catch (err) {
    console.warn('[Steins;Gate DM] 副模型审查调用失败，已自动降级为直通导演模式:', err);
  }
  return '';
}

/**
 * 【锦囊 3】调用酒馆自带 setExtensionPrompt 注入当轮提示词（用完即焚、零存档污染）
 */
function injectEphemeralExtensionPrompt(promptText, settings) {
  const ctx = getStContext();
  const setPromptFn = ctx.setExtensionPrompt || globalThis.setExtensionPrompt;
  if (typeof setPromptFn === 'function') {
    setPromptFn(
      PROMPT_KEY,
      promptText,
      Number(settings.promptPosition ?? 1),
      Number(settings.promptDepth ?? 1)
    );
  }
}

/**
 * 【锦囊 3】SillyTavern Generate Interceptor 主入口
 * 在 manifest.json 中声明为 "generate_interceptor": "steinsGateDmInterceptor"
 */
export async function steinsGateDmInterceptor(chat, contextSize, abort, type) {
  const settings = getSettings();
  if (!settings.enabled) {
    injectEphemeralExtensionPrompt('', settings);
    return;
  }

  // 避免在 quiet 后台生成时递归拦截
  if (type === 'quiet') return;

  await ensureKnowledgeBaseLoaded();

  // 1. 提取当前 MVU / 标签状态
  const worldState = extractCurrentWorldState(chat);

  // 2. 获取玩家最新输入与最近一轮上下文
  let latestUserText = '';
  let recentContextText = '';
  if (Array.isArray(chat) && chat.length > 0) {
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i]?.is_user && !latestUserText) {
        latestUserText = String(chat[i].mes || '');
      } else if (!chat[i]?.is_user && !recentContextText) {
        recentContextText = String(chat[i].mes || '').slice(-500);
      }
      if (latestUserText && recentContextText) break;
    }
  }

  // 3. 执行混合检索（世界线过滤 + 简繁日外号别名匹配 + 面包屑切片召回）
  const queryInput = `${latestUserText}\n${recentContextText}`;
  const { selectedChunks, aliasHits } = retrieveCanonChunks(
    queryInput,
    worldState,
    Number(settings.maxChunks || 5)
  );

  // 4. 如开启副模型审查模式，先挂起等待小模型输出导演审查指令
  let submodelReviewText = '';
  if (settings.mode === 'submodel') {
    submodelReviewText = await runSubmodelDirectorReview(
      latestUserText,
      worldState,
      selectedChunks,
      settings
    );
  }

  // 5. 组装并调用 setExtensionPrompt 注入当轮生成
  const finalPrompt = buildDirectorPrompt(worldState, selectedChunks, aliasHits, submodelReviewText);
  injectEphemeralExtensionPrompt(finalPrompt, settings);

  settings.lastInjectedPrompt = finalPrompt;
  settings.lastMatchedAliases = aliasHits.canonicals;
  saveSettingsDebounced();
  updateSettingsPanelPreview();
}

// 挂载到全局作用域供 SillyTavern generate_interceptor 调用
globalThis.steinsGateDmInterceptor = steinsGateDmInterceptor;

/**
 * 渲染 SillyTavern 扩展设置面板
 */
function updateSettingsPanelPreview() {
  if (typeof document === 'undefined') return;
  const previewEl = document.getElementById('sg_dm_last_prompt_preview');
  const stateEl = document.getElementById('sg_dm_state_summary');
  const settings = getSettings();

  if (stateEl && settings.lastStateSnapshot) {
    const s = settings.lastStateSnapshot;
    stateEl.textContent = `${s.divergence} (${s.attractorField}场) | ${s.time} | ${s.location}`;
  }
  if (previewEl) {
    previewEl.value = settings.lastInjectedPrompt || '（尚未触发拦截生成，点击下方「测试检索预览」或发送一条消息即可查看）';
  }
}

function mountSettingsPanel() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('steins_gate_dm_settings')) return;

  const container =
    document.getElementById('extensions_settings2') ||
    document.getElementById('extensions_settings');
  if (!container) return;

  const settings = getSettings();
  const wrapper = document.createElement('div');
  wrapper.id = 'steins_gate_dm_settings';
  wrapper.className = 'sg-dm-panel inline-drawer';

  wrapper.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Steins;Gate 因果律导演 (DM Interceptor)</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content sg-dm-body">
      <div class="sg-dm-row">
        <label class="checkbox_label">
          <input id="sg_dm_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
          <span>启用因果律拦截器与动态设定注入 (setExtensionPrompt)</span>
        </label>
      </div>

      <div class="sg-dm-status-box">
        <div class="sg-dm-status-label">当前观测状态 (MVU / State)：</div>
        <div id="sg_dm_state_summary" class="sg-dm-meter">1.130426 (β场) | 2010/07/28 11:58 | 广播会馆八楼</div>
      </div>

      <div class="sg-dm-grid">
        <label>
          <span>工作模式</span>
          <select id="sg_dm_mode" class="text_pole">
            <option value="direct" ${settings.mode === 'direct' ? 'selected' : ''}>直通导演模式（零延迟·推荐）</option>
            <option value="submodel" ${settings.mode === 'submodel' ? 'selected' : ''}>副模型审查模式（小模型导演指令）</option>
          </select>
        </label>
        <label>
          <span>每轮召回切片数 (Top-K)</span>
          <input id="sg_dm_max_chunks" type="number" min="1" max="12" class="text_pole" value="${settings.maxChunks}" />
        </label>
        <label>
          <span>注入深度 (Depth)</span>
          <input id="sg_dm_depth" type="number" min="0" max="10" class="text_pole" value="${settings.promptDepth}" />
        </label>
      </div>

      <div id="sg_dm_submodel_config" class="sg-dm-submodel-box" style="display: ${settings.mode === 'submodel' ? 'block' : 'none'};">
        <div class="sg-dm-row">
          <label>
            <span>副模型通道</span>
            <select id="sg_dm_submodel_source" class="text_pole">
              <option value="quiet" ${settings.submodelSource === 'quiet' ? 'selected' : ''}>复用酒馆当前连接 (generateQuietPrompt)</option>
              <option value="custom" ${settings.submodelSource === 'custom' ? 'selected' : ''}>独立 OpenAI 兼容小模型 API</option>
            </select>
          </label>
        </div>
        <div class="sg-dm-grid">
          <label>
            <span>API Endpoint</span>
            <input id="sg_dm_submodel_url" type="text" class="text_pole" value="${settings.submodelUrl}" />
          </label>
          <label>
            <span>Model 名称</span>
            <input id="sg_dm_submodel_name" type="text" class="text_pole" value="${settings.submodelName}" />
          </label>
          <label>
            <span>API Key</span>
            <input id="sg_dm_submodel_key" type="password" class="text_pole" value="${settings.submodelKey}" placeholder="sk-..." />
          </label>
        </div>
      </div>

      <div class="sg-dm-test-bar">
        <input id="sg_dm_test_input" type="text" class="text_pole" placeholder="输入测试词（如：助手、金属乌帕、中钵博士、閃光的指壓師）..." />
        <button id="sg_dm_test_btn" class="menu_button" type="button">测试检索预览</button>
      </div>

      <div class="sg-dm-row">
        <label>最近一次注入的导演提示词预览（用完即焚，不写进存档）：</label>
        <textarea id="sg_dm_last_prompt_preview" class="text_pole sg-dm-preview" rows="8" readonly></textarea>
      </div>
    </div>
  `;

  container.appendChild(wrapper);
  updateSettingsPanelPreview();

  // 事件绑定
  wrapper.querySelector('#sg_dm_enabled')?.addEventListener('change', e => {
    settings.enabled = Boolean(e.target.checked);
    saveSettingsDebounced();
  });

  wrapper.querySelector('#sg_dm_mode')?.addEventListener('change', e => {
    settings.mode = e.target.value;
    const subBox = wrapper.querySelector('#sg_dm_submodel_config');
    if (subBox) subBox.style.display = settings.mode === 'submodel' ? 'block' : 'none';
    saveSettingsDebounced();
  });

  wrapper.querySelector('#sg_dm_max_chunks')?.addEventListener('change', e => {
    settings.maxChunks = Math.max(1, Math.min(12, parseInt(e.target.value || '5', 10)));
    saveSettingsDebounced();
  });

  wrapper.querySelector('#sg_dm_depth')?.addEventListener('change', e => {
    settings.promptDepth = Math.max(0, Math.min(10, parseInt(e.target.value || '1', 10)));
    saveSettingsDebounced();
  });

  wrapper.querySelector('#sg_dm_submodel_source')?.addEventListener('change', e => {
    settings.submodelSource = e.target.value;
    saveSettingsDebounced();
  });

  wrapper.querySelector('#sg_dm_submodel_url')?.addEventListener('change', e => {
    settings.submodelUrl = e.target.value.trim();
    saveSettingsDebounced();
  });

  wrapper.querySelector('#sg_dm_submodel_name')?.addEventListener('change', e => {
    settings.submodelName = e.target.value.trim();
    saveSettingsDebounced();
  });

  wrapper.querySelector('#sg_dm_submodel_key')?.addEventListener('change', e => {
    settings.submodelKey = e.target.value.trim();
    saveSettingsDebounced();
  });

  wrapper.querySelector('#sg_dm_test_btn')?.addEventListener('click', async () => {
    await ensureKnowledgeBaseLoaded();
    const testQuery = wrapper.querySelector('#sg_dm_test_input')?.value || '助手 金属乌帕 广播会馆';
    const ctx = getStContext();
    const worldState = extractCurrentWorldState(ctx.chat || []);
    const { selectedChunks, aliasHits } = retrieveCanonChunks(testQuery, worldState, settings.maxChunks);
    const previewPrompt = buildDirectorPrompt(worldState, selectedChunks, aliasHits);
    settings.lastInjectedPrompt = previewPrompt;
    updateSettingsPanelPreview();
  });
}

// 初始化加载
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  ensureKnowledgeBaseLoaded();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountSettingsPanel);
  } else {
    setTimeout(mountSettingsPanel, 500);
  }
}
