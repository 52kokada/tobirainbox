(() => {
  const T = window.THREADS.map(t => ({ ...t, status: 'open' }));
  const S = { sel: T[0].id, tab: 'all', view: 'queue', q: '', mailbox: '', showOld: {} };
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const draftHtml = txt => esc(txt).replace(/\[\[(.+?)\]\]/g, (_, l) => `<mark class="blank">【要確認：${l}】</mark>`);
  const STAGES = ['連絡', '返信あり', 'サンプル', '見積', '契約'];
  let sentCount = window.SENT_TODAY;

  const byId = id => T.find(t => t.id === id);
  const inQueue = t => t.status === 'open' || t.status === 'sending';
  const matches = t => {
    if (S.mailbox && t.mailbox !== S.mailbox) return false;
    if (!S.q) return true;
    const hay = [t.name, t.subject, t.email, ...t.msgs.map(m => m.body)].join(' ').toLowerCase();
    return hay.includes(S.q.toLowerCase());
  };
  function visible() {
    let list = T.filter(matches);
    if (S.view === 'sent' || S.tab === 'done') return list.filter(t => t.status === 'sent' || t.status === 'done');
    list = list.filter(inQueue);
    if (S.tab === 'decide') list = list.filter(t => t.group === 'decide');
    if (S.tab === 'approve') list = list.filter(t => t.group === 'approve');
    return list;
  }

  // ---------- list ----------
  function renderList() {
    const q = T.filter(matches).filter(inQueue);
    const done = T.filter(matches).filter(t => t.status === 'sent' || t.status === 'done');
    $('#railCount').textContent = T.filter(inQueue).length;
    $('#railCount').style.display = T.filter(inQueue).length ? '' : 'none';
    $('#listTitle').textContent = S.view === 'sent' ? '送信済み・完了' : '対応待ち';
    const tabs = S.view === 'sent' ? [] : [
      ['all', 'すべて', q.length], ['decide', '要判断', q.filter(t => t.group === 'decide').length],
      ['approve', '承認待ち', q.filter(t => t.group === 'approve').length], ['done', '完了', done.length]
    ];
    $('#seg').innerHTML = tabs.map(([k, l, n]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}<b>${n}</b></button>`).join('');
    $('#seg').style.display = tabs.length ? '' : 'none';

    const list = visible();
    let html = '';
    const groups = (S.view === 'sent' || S.tab === 'done')
      ? [['', '', list]]
      : [['要判断', 'var(--red)', list.filter(t => t.group === 'decide')], ['承認待ち', 'var(--acc)', list.filter(t => t.group === 'approve')]];
    for (const [title, color, items] of groups) {
      if (!items.length) continue;
      if (title) html += `<div class="grp"><span class="dot" style="background:${color}"></span>${title}</div>`;
      html += items.map(rowHtml).join('');
    }
    if (!list.length) {
      html = S.q || S.mailbox
        ? `<div class="empty"><b>見つかりませんでした</b></div>`
        : `<div class="empty"><b>すべて片付きました</b></div>`;
    }
    $('#rows').innerHTML = html;
    $('#today').innerHTML = `<svg viewBox="0 0 24 24" style="width:15px;height:15px;color:var(--grn)"><path d="M5 12l4 4 10-10"/></svg>今日 <b>${sentCount}</b> 件送信`;
  }
  function rowHtml(t) {
    const last = t.msgs[t.msgs.length - 1];
    let tag = `<span class="tag ${t.tag[0]}">${t.tag[1]}</span>`;
    if (t.status === 'sending') tag = `<span class="tag ai">送信待ち</span>`;
    if (t.status === 'sent') tag = `<span class="tag ok">送信済み</span>`;
    if (t.status === 'done') tag = `<span class="tag">完了</span>`;
    return `<div class="row ${t.id === S.sel ? 'on' : ''} ${t.unread ? 'unread' : ''} ${t.status === 'sending' ? 'leaving' : ''}" data-id="${t.id}">
      <span class="av" style="background:${t.av[0]};color:${t.av[1]}">${t.init}</span>
      <div class="rb"><div class="rt"><b>${esc(t.name)}</b><time>${t.time}</time></div>
      <div class="subj">${esc(t.subject)}</div><div class="snip">${esc(last.body.replace(/\n/g, ' '))}</div>
      <div class="tags">${tag}<span class="tag">${t.mailbox}</span></div></div></div>`;
  }

  // ---------- conversation ----------
  function renderConv() {
    const t = byId(S.sel);
    const conv = $('#conv');
    if (!t || !visible().includes(t)) {
      conv.innerHTML = `<div class="scroll"><div class="sentview"><div class="big"><svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"/></svg></div><h3>メールを選んでください</h3></div></div>`;
      $('#side').innerHTML = '';
      return;
    }
    t.unread = false;
    const old = t.msgs.slice(0, -1), last = t.msgs[t.msgs.length - 1];
    const open = S.showOld[t.id];
    const msgHtml = (m, collapsed) => `<article class="msg ${m.us ? 'out' : ''} ${collapsed ? 'collapsed' : ''}" ${collapsed ? 'data-expand="1"' : ''}>
      <div class="mh"><span class="av" style="${m.us ? 'background:#18181b;color:#fff' : `background:${t.av[0]};color:${t.av[1]}`}">${m.us ? m.who[0] : t.init}</span><b>${esc(m.who)}</b><time>${m.time}</time></div>
      <p>${esc(m.body)}</p></article>`;
    let thread = '';
    if (old.length && !open) thread += `<button class="fold" data-old="1">+${old.length}</button>`;
    if (open) thread += old.map(m => msgHtml(m, false)).join('');
    thread += msgHtml(last, false);
    if (t.why && t.status === 'open') thread += `<div class="why"><span class="ic">!</span>${t.why}</div>`;

    let bottom = '';
    if (t.status === 'sent' || t.status === 'done') {
      bottom = `<div class="sentview"><div class="big"><svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"/></svg></div><h3>${t.status === 'sent' ? '送信済み' : '完了'}</h3><div style="margin-top:12px"><button class="ib" data-act="reopen">戻す</button></div></div>`;
    } else if (t.needsLabel) {
      const opts = ['質問', '予約', '新規問い合わせ', '返信不要'];
      bottom = `<section class="classify"><h3>どれですか？</h3>
        <div class="choices">${opts.map(k => `<button class="choice ${k === t.guess ? 'guess' : ''}" data-label="${k}">${k}${k === t.guess ? '<span>AI の推測</span>' : ''}</button>`).join('')}</div></section>`;
    } else {
      const chips = [['price', '料金を入れる'], ['short', '短く'], ['polite', '丁寧に'], [t.side.lang === 'English' ? 'ja' : 'en', t.side.lang === 'English' ? '日本語' : '英語']]
        .filter(([k]) => k !== 'price' || (t.variants && t.variants.price));
      bottom = `<section class="comp" id="comp">
        <div class="cbar"><span class="ai"><svg viewBox="0 0 24 24"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>下書き</span>
          <span class="sp"></span>${chips.map(([k, l]) => `<button class="chip" data-rw="${k}">${l}</button>`).join('')}</div>
        <div class="editor" id="editor" contenteditable="true" spellcheck="false">${t.html || draftHtml(t.draft)}</div>
        <div class="cfoot">
          <button class="tool" title="添付（デモ）" data-act="soon"><svg viewBox="0 0 24 24"><path d="M20 11l-8 8a5 5 0 01-7-7l9-9a3 3 0 014 4l-9 9a1 1 0 01-2-2l8-8"/></svg></button>
          <button class="tool" title="下書きを最初に戻す" data-act="reset"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 103-6.7L3 8"/><path d="M3 3v5h5"/></svg></button>
          <span class="hint" id="hint"></span>
          <div class="send"><button id="sendBtn" data-act="send">承認して送信</button><button class="more" title="あとで送る（デモ）" data-act="soon">▾</button></div>
        </div></section>`;
    }

    const labels = ['質問', '予約', '新規問い合わせ', '様子見', '返信不要', '要確認'];
    conv.innerHTML = `<div class="ch">
        <button class="ib back" data-act="back">← 一覧</button>
        <span class="av" style="background:${t.av[0]};color:${t.av[1]}">${t.init}</span>
        <div style="min-width:0"><h2>${esc(t.subject)}</h2><div class="who">${esc(t.name)} · ${t.mailbox}</div></div>
        <span class="sp"></span>
        <select class="ib hide-sm" id="labelSel" title="仕分けを直す">${labels.map(l => `<option ${l === t.label ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${inQueue(t) ? `<button class="ib" data-act="done" title="D"><svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"/></svg>完了</button>` : ''}
      </div>
      <div class="scroll" id="scroll"><div class="thread">${thread}</div>${bottom}</div>`;
    const sc = $('#scroll'); sc.scrollTop = sc.scrollHeight;
    updateHint();
    renderSide(t);
  }

  function blanksLeft() { const e = $('#editor'); return e ? (e.innerText.match(/【要確認/g) || []).length : 0; }
  function updateHint() {
    const h = $('#hint'), b = $('#sendBtn'); if (!h) return;
    const n = blanksLeft();
    const t = byId(S.sel);
    if (t.status === 'sending') { h.className = 'hint ok'; h.textContent = ''; b.disabled = true; return; }
    h.className = 'hint ' + (n ? 'warn' : 'ok');
    h.textContent = n ? `要確認 ${n}` : '';
    b.disabled = n > 0;
  }

  function renderSide(t) {
    const s = t.side;
    $('#side').innerHTML = `
      <div style="display:flex;gap:10px;align-items:center"><span class="av" style="width:42px;height:42px;flex-basis:42px;font-size:15px;background:${t.av[0]};color:${t.av[1]}">${t.init}</span>
        <div><b style="font-size:15px">${esc(t.name)}</b><div style="font-size:12.5px">${esc(s.place)}</div></div></div>
      <div><h4>進み具合</h4><div class="steps">${STAGES.map((_, i) => `<i class="${i <= s.stage ? 'on' : ''}"></i>`).join('')}</div>
        <div class="stepl">${STAGES.map((l, i) => `<span class="${i === s.stage ? 'cur' : ''}">${l}</span>`).join('')}</div></div>
      <div class="kv"><span>担当</span><span>${s.owner}</span><span>ID</span><span>${s.tid}</span></div>
      <div><h4>メモ</h4><textarea class="note">${esc(t.note || '')}</textarea></div>`;
    $('#side .note').oninput = e => { t.note = e.target.value; };
  }

  function render() { renderList(); renderConv(); }

  // ---------- actions ----------
  function select(id) { S.sel = id; document.getElementById('app').classList.add('reading'); render(); }
  function nextId(fromId) {
    const list = visible(); const i = list.findIndex(t => t.id === fromId);
    const rest = list.filter(t => t.id !== fromId && inQueue(t));
    return (list.slice(i + 1).find(t => t.id !== fromId && t.status === 'open') || rest[0] || {}).id;
  }
  function toast(text, undo, secs) {
    const el = document.createElement('div'); el.className = 'toast'; el.style.position = 'relative';
    el.innerHTML = `<span class="tx">${text}</span>${undo ? '<button>取り消す</button>' : ''}${secs ? '<span class="bar"></span>' : ''}`;
    $('#toasts').appendChild(el);
    let left = secs || 3, timer;
    const close = () => { clearInterval(timer); el.remove(); };
    if (secs) {
      const bar = el.querySelector('.bar'); bar.style.width = '100%';
      const tx = el.querySelector('.tx'), base = text;
      tx.textContent = `${base} · ${left}`;
      timer = setInterval(() => { left--; bar.style.width = (left / secs * 100) + '%'; tx.textContent = `${base} · ${left}`; if (left <= 0) { close(); undo && undo.expire(); } }, 1000);
    } else setTimeout(close, 2600);
    if (undo) el.querySelector('button').onclick = () => { close(); undo.cancel(); };
    return close;
  }

  function send() {
    const t = byId(S.sel); if (!t || t.status !== 'open' || t.needsLabel) return;
    if (blanksLeft()) { toast('要確認を埋めてください'); flashBlank(); return; }
    t.html = $('#editor').innerHTML; t.status = 'sending';
    const nxt = nextId(t.id);
    toast('送信します', {
      cancel() { t.status = 'open'; S.sel = t.id; render(); toast('取り消しました'); },
      expire() { t.status = 'sent'; sentCount++; render(); }
    }, 30);
    S.sel = nxt || t.id; render();
  }
  function markDone() {
    const t = byId(S.sel); if (!t || !inQueue(t)) return;
    t.status = 'done'; const nxt = nextId(t.id);
    toast('完了', { cancel() { t.status = 'open'; S.sel = t.id; render(); }, expire() {} }, 8);
    S.sel = nxt || t.id; render();
  }
  function flashBlank() {
    const m = document.querySelector('#editor mark.blank'); if (!m) return;
    m.scrollIntoView({ block: 'center' }); selectNode(m);
  }
  function selectNode(m) {
    const r = document.createRange(); r.selectNodeContents(m);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); $('#editor').focus();
  }
  function rewrite(kind) {
    const t = byId(S.sel); const comp = $('#comp');
    const sh = document.createElement('div'); sh.className = 'shimmer'; sh.innerHTML = '<span><i class="spin"></i></span>';
    comp.appendChild(sh);
    setTimeout(() => {
      let txt = t.variants && t.variants[kind];
      if (!txt) {
        const cur = $('#editor').innerText;
        if (kind === 'short') { const p = cur.split(/\n\n+/); txt = [p[0], p[p.length - 2], p[p.length - 1]].filter(Boolean).join('\n\n'); }
        else if (kind === 'polite') txt = cur.replace('ありがとうございます。', '誠にありがとうございます。').replace('よろしくお願いいたします。', '何卒よろしくお願い申し上げます。');
        else txt = cur;
        txt = txt.replace(/【要確認：(.+?)】/g, '[[$1]]');
      }
      t.html = draftHtml(txt); renderConv();
    }, 900);
  }
  function chooseLabel(label) {
    const t = byId(S.sel);
    if (label === '返信不要') { t.label = '返信不要'; t.status = 'done'; toast('返信不要'); S.sel = nextId(t.id) || t.id; render(); return; }
    $('.classify').innerHTML = '<i class="spin"></i>';
    setTimeout(() => {
      t.needsLabel = false; t.label = label; t.draft = t.afterLabel.draft; t.why = null;
      t.group = 'approve'; t.tag = ['warn', '要確認 1'];
      t.side.used = [['仕分け', `あなたが「${label}」に修正 → 学習済み`], ['プレイブック', '撮影の相談 → 候補日を出す']];
      t.side.cost = ['$0.0004', '$0.010'];
      render();
    }, 1100);
  }

  // ---------- events ----------
  document.addEventListener('click', e => {
    const row = e.target.closest('.row'); if (row) return select(row.dataset.id);
    const tab = e.target.closest('[data-tab]'); if (tab) { S.tab = tab.dataset.tab; const v = visible(); if (!v.find(t => t.id === S.sel) && v[0]) S.sel = v[0].id; return render(); }
    const ri = e.target.closest('.ri'); if (ri) {
      if (ri.dataset.view === 'soon') return toast('準備中');
      document.querySelectorAll('.ri').forEach(x => x.classList.toggle('on', x === ri));
      S.view = ri.dataset.view; S.tab = 'all'; const v = visible(); S.sel = v[0] ? v[0].id : null; return render();
    }
    if (e.target.closest('[data-old]')) { S.showOld[S.sel] = true; return renderConv(); }
    const m = e.target.closest('mark.blank'); if (m) return selectNode(m);
    const rw = e.target.closest('[data-rw]'); if (rw) return rewrite(rw.dataset.rw);
    const lb = e.target.closest('[data-label]'); if (lb) return chooseLabel(lb.dataset.label);
    const act = e.target.closest('[data-act]'); if (!act) return;
    const a = act.dataset.act, t = byId(S.sel);
    if (a === 'send') send();
    if (a === 'done') markDone();
    if (a === 'soon') toast('準備中');
    if (a === 'reset') { t.html = null; renderConv(); }
    if (a === 'reopen') { t.status = 'open'; S.tab = 'all'; S.view = 'queue'; document.querySelectorAll('.ri').forEach((x, i) => x.classList.toggle('on', i === 0)); render(); }
    if (a === 'back') document.getElementById('app').classList.remove('reading');
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'editor') { byId(S.sel).html = e.target.innerHTML; updateHint(); }
    if (e.target.id === 'q') { S.q = e.target.value; renderList(); }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'mailbox') { S.mailbox = e.target.value; const v = visible(); if (!v.find(t => t.id === S.sel)) S.sel = v[0] ? v[0].id : null; render(); }
    if (e.target.id === 'labelSel') { const t = byId(S.sel); t.label = e.target.value; }
  });
  document.addEventListener('keydown', e => {
    const typing = e.target.closest && e.target.closest('input,textarea,select,[contenteditable]');
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); return send(); }
    if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
    const list = visible(); const i = list.findIndex(t => t.id === S.sel);
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); if (list[i + 1]) select(list[i + 1].id); }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) select(list[i - 1].id); }
    if (e.key === 'e') { e.preventDefault(); const m = document.querySelector('#editor mark.blank'); m ? selectNode(m) : $('#editor') && $('#editor').focus(); }
    if (e.key === 'd') markDone();
    if (e.key === '?') $('#kbdHelp').classList.toggle('show');
  });

  render();
})();
