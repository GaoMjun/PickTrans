// ==UserScript==
// @name         PickTrans
// @namespace    picktrans.selection-translate
// @version      1.1.0
// @description  选中文本后连按两下触发键,调用 OpenAI completions 接口翻译,弹出只显示翻译结果的浮窗。Tampermonkey 菜单提供设置入口。
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

  async function translate(text) {
    if (!config.apiKey) {
      throw new Error('未配置 API Key,请在设置面板中填写');
    }
    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: `You are a translation assistant. Translate the user's text into ${config.targetLang}. Output only the translation, nothing else, no explanations, no quotes.` },
        { role: 'user', content: text },
      ],
      temperature: 0.3,
    };

    const doFetch = typeof GM_xmlhttpRequest === 'function';
    if (doFetch) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: config.apiUrl,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
          data: JSON.stringify(body),
          onload: (res) => {
            if (res.status < 200 || res.status >= 300) {
              reject(new Error('HTTP ' + res.status + ': ' + res.responseText.slice(0, 200)));
              return;
            }
            try {
              const json = JSON.parse(res.responseText);
              resolve(json.choices[0].message.content.trim());
            } catch (e) { reject(e); }
          },
          onerror: () => reject(new Error('Network error')),
        });
      });
    }
    const resp = await fetch(config.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
    const json = await resp.json();
    return json.choices[0].message.content.trim();
  }

  function handleSelection() {
    if (loading) return;
    const info = getSelectionInfo();
    if (!info) return;

    if (!box) createBox();
    box.textContent = '翻译中…';
    showBox(info.range);
    loading = true;

    translate(info.text)
      .then((t) => { box.textContent = t; })
      .catch((err) => { box.textContent = '翻译失败: ' + err.message; })
      .finally(() => { loading = false; });
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
