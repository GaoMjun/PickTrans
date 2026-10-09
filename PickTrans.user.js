// ==UserScript==
// @name         PickTrans
// @namespace    picktrans.selection-translate
// @version      1.2.0
// @description  选中文本后连按两下触发键,调用 OpenAI 接口翻译并弹出浮窗显示结果。支持自定义 API 地址、模型与目标语言,可在 Tampermonkey 菜单中设置。
// @match        *://*/*
// @license      MIT
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 默认配置(可被设置面板覆盖) ====================
  const DEFAULTS = {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o-mini',
    targetLang: '中文',
    triggerKey: 'meta', // meta | alt | ctrl | shift
    minLength: 1,
  };
  const KEY_PREFIX = 'picktrans.';

  function loadConfig() {
    const cfg = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      const v = typeof GM_getValue === 'function' ? GM_getValue(KEY_PREFIX + k, undefined) : undefined;
      if (v !== undefined && v !== '') cfg[k] = v;
    }
    return cfg;
  }
  function saveConfig(cfg) {
    if (typeof GM_setValue !== 'function') return;
    for (const k of Object.keys(DEFAULTS)) GM_setValue(KEY_PREFIX + k, cfg[k]);
  }

  let config = loadConfig();

  // ====================================================================
  //  翻译结果弹框
  // ====================================================================
  let box = null;
  let loading = false;

  function createBox() {
    box = document.createElement('div');
    box.id = 'pt-translate-box';
    box.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'max-width:420px',
      'padding:12px 16px', 'border:1px solid #d0d7de', 'border-radius:8px',
      'background:#ffffff', 'color:#1f2328',
      'font:13px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.15)',
      'word-break:break-word', 'white-space:pre-wrap', 'display:none',
    ].join(';');
    document.body.appendChild(box);
  }

  function getSelectionInfo() {
    const sel = window.getSelection();
    if (!sel || !sel.toString || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text || text.length < (config.minLength || 1)) return null;
    return { text, range: sel.getRangeAt(0) };
  }

  function positionBox(range) {
    const rect = range.getBoundingClientRect();
    const top = rect.bottom + 8;
    box.style.left = Math.min(rect.left, window.innerWidth - box.offsetWidth - 12) + 'px';
    box.style.top = top + 'px';
    box.style.maxHeight = (window.innerHeight - top - 20) + 'px';
    box.style.overflowY = 'auto';
  }

  function showBox(range) {
    box.style.display = 'block';
    positionBox(range);
  }

  function hideBox() {
    if (!box) return;
    box.style.display = 'none';
    box.textContent = '';
  }

  // 流式翻译:通过 GM_xmlhttpRequest 的 onprogress 增量读取 SSE,边收边回调
  function translate(text, onDelta) {
    if (!config.apiKey) {
      return Promise.reject(new Error('未配置 API Key,请在设置面板中填写'));
    }
    const body = {
      model: config.model,
      stream: true,
      messages: [
        { role: 'system', content: `You are a translation assistant. Translate the user's text into ${config.targetLang}. Output only the translation, nothing else, no explanations, no quotes.` },
        { role: 'user', content: text },
      ],
      temperature: 0.3,
    };

    return new Promise((resolve, reject) => {
      let consumed = 0;      // 已解析到 responseText 的字符位置
      let buffer = '';       // 未成行的残留
      let failed = false;    // 已 reject,忽略后续回调
      let gotText = false;   // 是否已输出过正式译文(content)
      let hadReasoning = false; // 是否见过 reasoning_content(思维链,仅用于诊断,永不当作译文显示)

      // 从一段 JSON 里取出正式译文(content / text)。
      // 注意:reasoning_content 是模型的思维链,绝不作为译文返回。
      function extract(json) {
        const c = json && json.choices && json.choices[0];
        if (!c) return null;
        const d = c.delta || c.message || {};
        let content = '';
        if (typeof d.content === 'string') content += d.content;
        if (typeof c.text === 'string') content += c.text;
        return { content };
      }

      // 处理一行:支持 `data: {json}` (SSE) 和裸 `{json}` (一次性响应)
      function parseLine(line) {
        let s = line.trim();
        if (!s) return;
        if (s.startsWith('data:')) {
          s = s.slice(5).trim();
          if (s === '[DONE]') return;
        }
        if (s[0] !== '{') return;
        try {
          const json = JSON.parse(s);
          // 只要见过思维链就标记一下(诊断用)
          const c = json && json.choices && json.choices[0];
          const dd = c && (c.delta || c.message);
          if (dd && typeof dd.reasoning_content === 'string') hadReasoning = true;
          const r = extract(json);
          if (!r) return;
          if (r.content) { gotText = true; onDelta(r.content); }
        } catch (e) { /* 半行/非 JSON 片段,跳过 */ }
      }

      // 解析新增片段;flush=true 时把残留 buffer 也当作完整行处理
      function consume(responseText, flush) {
        buffer += responseText.slice(consumed);
        consumed = responseText.length;
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 末行可能不完整,留到下次
        for (const line of lines) parseLine(line);
        if (flush && buffer) { parseLine(buffer); buffer = ''; }
        // 防御:异常大且不含换行的响应,避免 buffer 无限增长
        if (buffer.length > 2000000) buffer = '';
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url: config.apiUrl,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
        data: JSON.stringify(body),
        onprogress: (res) => {
          if (failed) return;
          // 出错状态码:直接失败,不做非流式回退
          if (res.status && (res.status < 200 || res.status >= 300)) {
            failed = true;
            reject(new Error('HTTP ' + res.status));
            return;
          }
          consume(res.responseText || '', false);
        },
        onload: (res) => {
          if (failed) return;
          if (res.status < 200 || res.status >= 300) {
            failed = true;
            reject(new Error('HTTP ' + res.status + ': ' + (res.responseText || '').slice(0, 200)));
            return;
          }
          const full = res.responseText || '';
          consume(full, true);
          if (!gotText) {
            // 兜底:响应可能是多行缩进的整段 JSON,逐行解析不到,整体再试一次
            try {
              const json = JSON.parse(full);
              const c = json && json.choices && json.choices[0];
              const dd = c && (c.delta || c.message);
              if (dd && typeof dd.reasoning_content === 'string') hadReasoning = true;
              const r = extract(json);
              if (r && r.content) { gotText = true; onDelta(r.content); }
            } catch (e) { /* 忽略 */ }
          }
          if (!gotText) {
            // 没有正式译文:如果模型只吐了思维链,说明该模型不适合直出译文
            if (hadReasoning) {
              reject(new Error('模型只返回了思维链(reasoning),没有正文译文。请在设置中换用非推理模型(如 gpt-4o-mini / deepseek-chat)'));
              return;
            }
            reject(new Error('空响应:接口未返回任何译文内容'));
            return;
          }
          resolve();
        },
        onerror: () => {
          if (failed) return;
          failed = true;
          reject(new Error('Network error'));
        },
      });
    });
  }

  function handleSelection() {
    if (loading) return;
    const info = getSelectionInfo();
    if (!info) return;

    if (!box) createBox();
    box.textContent = '翻译中…';
    showBox(info.range);
    loading = true;

    let acc = '';      // 已收到的译文
    let shown = 0;     // 已显示的字符数
    let rafId = null;  // 打字机动画帧
    let done = false;  // 流是否已结束
    let errored = false;

    // 按码点安全截断,避免把 emoji/代理对切一半
    function safeSlice(s, n) {
      if (n >= s.length) return s;
      const c = s.charCodeAt(n - 1);
      if (c >= 0xD800 && c <= 0xDBFF) n += 1; // 高代理,补上低位
      return s.slice(0, n);
    }

    // 打字机:每帧吐一点,长文本自动加速追平,保证逐字观感
    function tick() {
      rafId = null;
      if (shown >= acc.length) {
        if (done && !errored) loading = false;
        return;
      }
      const gap = acc.length - shown;
      const step = Math.max(2, Math.floor(gap / 20)); // 落后越多吐越快
      shown = Math.min(acc.length, shown + step);
      box.textContent = safeSlice(acc, shown);
      positionBox(info.range);
      rafId = requestAnimationFrame(tick);
    }

    translate(info.text, (piece) => {
      acc += piece;
      if (rafId === null) rafId = requestAnimationFrame(tick);
    })
      .then(() => {
        done = true;
        if (!acc) { box.textContent = '翻译失败: 空响应'; loading = false; return; }
        if (rafId === null) rafId = requestAnimationFrame(tick);
      })
      .catch((err) => {
        errored = true;
        done = true;
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        box.textContent = '翻译失败: ' + err.message;
        loading = false;
      });
  }

  // 触发键对应的 KeyboardEvent.key 值(用于监听按下)
  function triggerName() {
    switch (config.triggerKey) {
      case 'meta': return 'Meta';
      case 'alt': return 'Alt';
      case 'ctrl': return 'Control';
      case 'shift': return 'Shift';
      default: return 'Meta';
    }
  }

  // 触发:先鼠标选中文本,再连按两下触发键(双击) -> 翻译当前选区
  let lastTrigger = { key: '', time: 0 };
  const DOUBLE_CLICK_MS = 500;
  document.addEventListener('keydown', (e) => {
    if (e.key !== triggerName()) return;
    const now = Date.now();
    if (!e.repeat && lastTrigger.key === e.key && now - lastTrigger.time < DOUBLE_CLICK_MS) {
      e.preventDefault();
      setTimeout(handleSelection, 0);
    }
    lastTrigger = { key: e.key, time: now };
  });

  // 点击空白处或 Esc 关闭翻译弹框
  document.addEventListener('mousedown', (e) => {
    if (box && box.style.display === 'block' && !box.contains(e.target) && !(settings && settings.contains(e.target))) hideBox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideBox(); closeSettings(); }
  });

  // ====================================================================
  //  设置面板
  // ====================================================================
  let settings = null;

  function createSettings() {
    const overlay = document.createElement('div');
    overlay.id = 'pt-settings';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483646',
      'background:rgba(0,0,0,.35)', 'display:none',
      'justify-content:center', 'align-items:center',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'width:360px', 'max-width:90vw', 'background:#fff', 'border-radius:10px',
      'padding:20px 22px', 'box-shadow:0 8px 30px rgba(0,0,0,.25)',
      'font:13px/1.7 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif',
      'color:#1f2328', 'text-align:left',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'PickTrans 设置';
    title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:14px;';

    const fields = [
      { key: 'apiUrl', label: '接口地址 (API URL)', type: 'text' },
      { key: 'apiKey', label: 'API Key', type: 'password' },
      { key: 'model', label: '模型 (Model)', type: 'text' },
      { key: 'targetLang', label: '目标语言', type: 'text' },
    ];

    const inputs = {};
    const rows = fields.map((f) => {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:10px;';
      const label = document.createElement('div');
      label.textContent = f.label;
      label.style.cssText = 'margin-bottom:3px;color:#57606a;font-size:12px;';
      const input = document.createElement('input');
      input.type = f.type;
      input.value = config[f.key] || '';
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #d0d7de;border-radius:6px;font:13px inherit;';
      inputs[f.key] = input;
      row.appendChild(label);
      row.appendChild(input);
      return row;
    });

    // 触发键选择
    const trigRow = document.createElement('div');
    trigRow.style.cssText = 'margin-bottom:10px;';
    const trigLabel = document.createElement('div');
    trigLabel.textContent = '触发键 (选中文本后连按两下翻译)';
    trigLabel.style.cssText = 'margin-bottom:3px;color:#57606a;font-size:12px;';
    const trigSel = document.createElement('select');
    const opts = [
      ['meta', 'Cmd (Mac) / Win'],
      ['alt', 'Alt'],
      ['ctrl', 'Ctrl'],
      ['shift', 'Shift'],
    ];
    for (const [val, lab] of opts) {
      const o = document.createElement('option');
      o.value = val; o.textContent = lab;
      if (val === config.triggerKey) o.selected = true;
      trigSel.appendChild(o);
    }
    trigSel.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #d0d7de;border-radius:6px;font:13px inherit;background:#fff;';
    trigRow.appendChild(trigLabel);
    trigRow.appendChild(trigSel);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存';
    saveBtn.style.cssText = baseBtn('linear-gradient(#2ea043,#238636)');
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = baseBtn('#f6f8fa');

    function baseBtn(bg) {
      return [
        'padding:6px 16px;border:1px solid rgba(0,0,0,.15);border-radius:6px;cursor:pointer;',
        'font:13px inherit;color:' + (bg.startsWith('linear') ? '#fff' : '#1f2328') + ';',
      ].join('') + 'background:' + bg + ';';
    }

    for (const r of rows) panel.appendChild(r);
    panel.appendChild(trigRow);
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    panel.appendChild(btnRow);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    saveBtn.addEventListener('click', () => {
      const next = { ...config };
      for (const f of fields) next[f.key] = inputs[f.key].value.trim();
      next.triggerKey = trigSel.value;
      next.minLength = parseInt(inputs.minLength?.value, 10) || 1;
      config = next;
      saveConfig(config);
      closeSettings();
      alert('已保存设置');
    });
    cancelBtn.addEventListener('click', closeSettings);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeSettings(); });

    return overlay;
  }

  function openSettings() {
    if (!settings) settings = createSettings();
    // 用最新配置填充
    const inputs = settings.querySelectorAll('input');
    const sel = settings.querySelector('select');
    if (inputs[0]) inputs[0].value = config.apiUrl || '';
    if (inputs[1]) inputs[1].value = config.apiKey || '';
    if (inputs[2]) inputs[2].value = config.model || '';
    if (inputs[3]) inputs[3].value = config.targetLang || '';
    if (sel) sel.value = config.triggerKey || 'meta';
    settings.style.display = 'flex';
  }
  function closeSettings() {
    if (settings) settings.style.display = 'none';
  }

  // 注册到 Tampermonkey 菜单(不进页面),点击弹出设置面板
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('⚙ PickTrans 设置', openSettings);
  }
})();
