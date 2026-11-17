// プレイブック (how replies are written + what the AI has learned), 設定 (the account), and the setup wizard.
// Owners edit; staff read. Copy is kept short on purpose.
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.js';
import { Select, Star } from '/ui.js';

const L = {
  ja: {
    playbook: 'プレイブック', settings: '設定', readOnly: '閲覧のみ（変更はオーナー）', save: '保存', add: '追加', remove: '削除', saved: '保存しました',
    questions: '質問', questionsSub: '下書きの【要確認】について', answer: '回答', saveFact: '事実として保存', factKey: '項目名',
    website: 'ウェブサイト', websiteSub: '料金・営業時間・URL などを読み取り、事実の候補にします', read: '読み込む', reading: '読み込み中…',
    readDone: (p, n) => `${p} ページから ${n} 件見つかりました`, readFailed: '読み込めませんでした', candidates: '候補', accept: '採用', reject: '却下', source: '出典',
    rules: 'ルール', addRule: 'ルールを追加', cancel: 'キャンセル', edit: '編集', talk: 'AI と相談', refine: '直してもらう', refining: '考えています…', refinePh: '例：見積書は PDF で送ると書き足して', wasRule: '前の文：', undoEdit: '元に戻す', acceptEdited: '直して採用', phase: '段階', phaseAlways: 'いつでも', phases: { first: '初回の返信', sample: 'サンプル送付', deal: '見積・契約', active: '進行中のお客様', after: '納品後・フォロー' }, rulesSub: '日本語の文章で。下書きはこれに従います', anyLabel: 'すべてのメール', proposed: 'AI の提案', propose: 'メールから提案を作る', proposing: '考えています…', noNewRules: '新しい提案はありませんでした', needExamples: '送った返信がもう少し集まると提案できます',
    rulePh: '例：予約の問い合わせには、空き状況を確認してから返信すると伝える。',
    facts: '事実', factsSub: '下書きの金額・日時・URL はここにあるものだけ。ないものは【要確認】になります', key: '項目', value: '内容',
    learned: '学習', learnedSub: (c, e) => `仕分けの修正 ${c} 件 · 返信の例 ${e} 件`, forget: '忘れる', history: '過去の送信メールから学ぶ', importing: '読み込み中…', imported: (n) => `${n} 件の返信を学びました`,
    voices: '文体と署名', sharedVoice: '全メールボックスで同じ文体', perMailbox: 'メールボックスごと', fullName: '名前', style: '文体', signature: '署名',
    general: '基本', company: '会社名', undo: '送信の取り消し猶予（秒）', plain: 'テキスト形式で送る', cap: 'AI 利用料の上限（1日・ドル）', capHint: (d) => `空欄で既定（$${d}）`,
    notify: '通知', notifyButton: 'この端末で通知を受け取る', notifyOn: '通知を有効にしました', notifyDenied: '通知が許可されませんでした', notifyUnsupported: 'この端末は通知に対応していません',
    mailboxes: 'メールボックス', addMailbox: 'メールボックスを追加', modes: { live: '送信可能', shadow: '試運転', paused: '停止' },
    labels: '仕分けラベル', hide: '隠す', autoDraft: '自動で下書き', newLabel: '新しいラベル',
    intake: '取り込みの除外', team: 'チーム', invite: '招待', owner: 'オーナー', staff: 'スタッフ', partner: 'パートナー', never: '未ログイン',
    partnerSee: '見る・下書き', partnerSend: '送信', partnerNone: 'まだどのメールボックスも見られません',
    partnerWhat: 'パートナーは、ここでチェックしたメールボックスだけを見て下書きできます。送信は「送信」にチェックしたものだけ。設定・プレイブック・チーム・請求は見られません。',
    kinds: { exclude_sender: '送信者', exclude_domain: 'ドメイン', exclude_gmail_label: 'Gmail ラベル', include_only_gmail_label: 'このラベルだけ取り込む' },
    setup: 'はじめの設定', next: '次へ', back: '戻る', skip: 'あとで', finish: '使いはじめる',
    steps: ['会社', 'メール', 'ウェブサイト', '下書き'],
    s1: '会社名を教えてください', s2: 'メールボックスをつなぎましょう', s2sub: 'Gmail / Google Workspace。最初は試運転（送信なし）で始まります',
    s3: 'ウェブサイトを読み込みます', s3sub: '料金や営業時間を事実の候補にします。あとでプレイブックから確認できます',
    s4: 'どのメールに下書きを作りますか？', connected: 'つながっています',
  },
  en: {
    playbook: 'Playbook', settings: 'Settings', readOnly: 'Read only (owners can change this)', save: 'Save', add: 'Add', remove: 'Remove', saved: 'Saved',
    questions: 'Questions', questionsSub: 'About 【要確認】 blanks in drafts', answer: 'Answer', saveFact: 'Save as a fact', factKey: 'Fact name',
    website: 'Website', websiteSub: 'Reads prices, hours and URLs into fact candidates', read: 'Read', reading: 'Reading…',
    readDone: (p, n) => `${n} found on ${p} pages`, readFailed: 'Could not read', candidates: 'Candidates', accept: 'Accept', reject: 'Reject', source: 'Source',
    rules: 'Rules', addRule: 'Add a rule', cancel: 'Cancel', edit: 'Edit', talk: 'Ask AI', refine: 'Rewrite', refining: 'Thinking…', refinePh: 'e.g. add that quotes are sent as PDF', wasRule: 'Before: ', undoEdit: 'Undo', acceptEdited: 'Accept edited', phase: 'Stage', phaseAlways: 'Always', phases: { first: 'First reply', sample: 'Sample', deal: 'Quote & contract', active: 'Ongoing client', after: 'After delivery' }, rulesSub: 'Plain sentences; drafts follow them', anyLabel: 'All mail', proposed: 'Suggested', propose: 'Suggest from mail', proposing: 'Thinking…', noNewRules: 'Nothing new to suggest', needExamples: 'A few more sent replies are needed first',
    rulePh: 'e.g. For booking questions, say we will check availability and reply.',
    facts: 'Facts', factsSub: 'Drafts only use prices, dates and URLs from here', key: 'Item', value: 'Value',
    learned: 'Learned', learnedSub: (c, e) => `${c} label fixes · ${e} reply examples`, forget: 'Forget', history: 'Learn from past sent mail', importing: 'Reading…', imported: (n) => `Learned ${n} replies`,
    voices: 'Voice and signature', sharedVoice: 'One voice for all mailboxes', perMailbox: 'Per mailbox', fullName: 'Name', style: 'Style', signature: 'Signature',
    general: 'General', company: 'Company name', undo: 'Undo window (seconds)', plain: 'Send as plain text', cap: 'Daily AI cap (USD)', capHint: (d) => `Empty = default ($${d})`,
    notify: 'Notifications', notifyButton: 'Notify me on this device', notifyOn: 'Notifications on', notifyDenied: 'Not allowed', notifyUnsupported: 'Not supported on this device',
    mailboxes: 'Mailboxes', addMailbox: 'Add a mailbox', modes: { live: 'Sending', shadow: 'Trial', paused: 'Paused' },
    labels: 'Labels', hide: 'Hide', autoDraft: 'Auto-draft', newLabel: 'New label',
    intake: 'Exclusions', team: 'Team', invite: 'Invite', owner: 'Owner', staff: 'Staff', partner: 'Partner', never: 'Never',
    partnerSee: 'See and draft', partnerSend: 'Send', partnerNone: 'No mailbox granted yet',
    partnerWhat: 'A partner sees and drafts only in the mailboxes ticked here, and sends only where Send is ticked. No settings, playbook, team or billing.',
    kinds: { exclude_sender: 'Sender', exclude_domain: 'Domain', exclude_gmail_label: 'Gmail label', include_only_gmail_label: 'Only this label' },
    setup: 'Get set up', next: 'Next', back: 'Back', skip: 'Later', finish: 'Start',
    steps: ['Company', 'Mail', 'Website', 'Drafts'],
    s1: 'What is your company called?', s2: 'Connect a mailbox', s2sub: 'Gmail / Google Workspace. Starts in trial mode (no sending)',
    s3: 'Read your website', s3sub: 'Prices and hours become fact candidates you can check later',
    s4: 'Which mail should get drafts?', connected: 'Connected',
  },
};

function useData(api, toast) {
  const [s, setS] = useState(null); const [l, setL] = useState(null);
  const load = async () => {
    try { const [a, b] = await Promise.all([api('/api/settings'), api('/api/learn')]); setS(a); setL(b); } catch (e) { toast(e.message); }
  };
  useEffect(() => { load(); }, []);
  const act = async (path, method, body, msg) => {
    try { const r = await api(path, { method, body }); if (msg) toast(msg); await load(); return r; } catch (e) { toast(e.message); return null; }
  };
  return { s, l, load, act };
}

// A suggested rule you can tweak before accepting: edit the words, pick the stage, or ask the AI to change it.
function Proposal({ r, t, ro, api, act, toast, labelName }) {
  const [text, setText] = useState(r.text); const [phase, setPhase] = useState(r.phase ?? '');
  const [talk, setTalk] = useState(false); const [busy, setBusy] = useState(false); const [before, setBefore] = useState(null);
  const ask = async (e) => {
    e.preventDefault(); const q = e.target.elements.q.value.trim(); if (!q) return;
    setBusy(true);
    try { const res = await api(`/api/settings/playbook/${r.id}/refine`, { method: 'POST', body: { instruction: q, text } }); setBefore(text); setText(res.text); e.target.reset(); }
    catch (err) { toast(err.message); }
    setBusy(false);
  };
  return html`<li class=${`proposal ${talk ? 'talking' : ''}`}>
    <div class="rule-tags"><span class="tag ai"><${Star} />${t.proposed}</span><span class="tag">${r.label ? labelName(r.label) : t.anyLabel}</span>
      <${Select} className="phase-sel" disabled=${ro} value=${phase} label=${t.phase} onChange=${setPhase}
        options=${[{ value: '', label: t.phaseAlways }, ...Object.entries(t.phases).map(([k, v]) => ({ value: k, label: v }))]} /></div>
    <textarea class="prop-text" rows="3" disabled=${ro || busy} value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
    ${before !== null && before !== text ? html`<div class="prop-was"><span>${t.wasRule}</span>${before}<button class="link" onClick=${() => { setText(before); setBefore(null); }}>${t.undoEdit}</button></div>` : ''}
    ${talk ? html`<form class="prop-talk" onSubmit=${ask}><${Star} live=${busy} /><input name="q" autofocus placeholder=${t.refinePh} disabled=${busy} /><button class="btn small" disabled=${busy}>${busy ? t.refining : t.refine}</button></form>` : ''}
    ${!ro ? html`<div class="acts">
      <button class="btn small primary" disabled=${busy || !text.trim()} onClick=${() => act(`/api/settings/playbook/${r.id}`, 'PUT', { status: 'active', text: text.trim(), phase: phase || null }, t.saved)}>${text !== r.text ? t.acceptEdited : t.accept}</button>
      <button class=${`btn small ${talk ? 'on' : ''}`} onClick=${() => setTalk(!talk)}><${Star} />${t.talk}</button>
      <span class="sp"></span>
      <button class="btn small ghost" onClick=${() => act(`/api/settings/playbook/${r.id}`, 'DELETE')}>${t.reject}</button></div>` : ''}
  </li>`;
}

// Folding remembered per section / group (this browser only).
const foldStore = { get() { try { return JSON.parse(localStorage.getItem('tbi.fold') || '{}'); } catch { return {}; } }, set(v) { try { localStorage.setItem('tbi.fold', JSON.stringify(v)); } catch { /* private mode */ } } };
function useFold(key, openByDefault) {
  const [open, setOpen] = useState(() => { const v = foldStore.get()[key]; return v === undefined ? openByDefault : v; });
  const toggle = () => setOpen((o) => { const all = foldStore.get(); all[key] = !o; foldStore.set(all); return !o; });
  return [open, toggle];
}
const Chev = html`<svg class="fold-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`;

const Sec = ({ title, sub, right, children, id, fold, open: openDefault = true, count }) => {
  const [open, toggle] = fold ? useFold(`sec:${fold}`, openDefault) : [true, null];
  return html`<section class=${`sec ${fold ? 'foldable' : ''} ${open ? 'open' : 'closed'}`} id=${id}>
    <header>${fold ? html`<button class="sec-toggle" aria-expanded=${open} onClick=${toggle}>${Chev}<div><h3>${title}${count != null ? html`<span class="sec-n">${count}</span>` : ''}</h3>${sub ? html`<p>${sub}</p>` : ''}</div></button>`
      : html`<div><h3>${title}</h3>${sub ? html`<p>${sub}</p>` : ''}</div>`}${open ? right ?? '' : ''}</header>${open ? children : ''}</section>`;
};

// One stage of rules as a drop-down: closed it shows the count and the first rule, open it lists them.
// A rule reads as one quiet line; click it to edit, change its stage or delete it.
function RuleRow({ r, t, ro, act, labelName }) {
  const [edit, setEdit] = useState(false); const [text, setText] = useState(r.text);
  if (!edit) return html`<li class="rrow" role="button" tabindex="0" onClick=${() => !ro && setEdit(true)} onKeyDown=${(e) => e.key === 'Enter' && !ro && setEdit(true)}>
    <span class="tag">${r.label ? labelName(r.label) : t.anyLabel}</span><span class="rtext">${r.text}</span>${!ro ? html`<span class="redit">${t.edit}</span>` : ''}</li>`;
  return html`<li class="rrow editing">
    <div class="rule-tags"><span class="tag">${r.label ? labelName(r.label) : t.anyLabel}</span>
      <${Select} className="phase-sel" value=${r.phase ?? ''} label=${t.phase} onChange=${(v) => act(`/api/settings/playbook/${r.id}`, 'PUT', { phase: v || null }, t.saved)}
        options=${[{ value: '', label: t.phaseAlways }, ...Object.entries(t.phases).map(([k, v]) => ({ value: k, label: v }))]} /></div>
    <textarea rows="3" value=${text} onInput=${(e) => setText(e.target.value)} autofocus></textarea>
    <div class="acts"><button class="btn small primary" disabled=${!text.trim()} onClick=${async () => { await act(`/api/settings/playbook/${r.id}`, 'PUT', { text: text.trim() }, t.saved); setEdit(false); }}>${t.save}</button>
      <button class="btn small" onClick=${() => { setText(r.text); setEdit(false); }}>${t.cancel}</button><span class="sp"></span>
      <button class="btn small danger" onClick=${() => act(`/api/settings/playbook/${r.id}`, 'DELETE')}>${t.remove}</button></div>
  </li>`;
}

function AddRule({ t, children }) {
  const [open, setOpen] = useState(false);
  return open ? children : html`<button class="btn add-rule-btn" onClick=${() => setOpen(true)}>＋ ${t.addRule}</button>`;
}

function RuleGroup({ name, rules, children }) {
  const [open, toggle] = useFold(`rules:${name}`, false);
  return html`<div class=${`rgroup ${open ? 'open' : ''}`}>
    <button class="rg-h" aria-expanded=${open} onClick=${toggle}>${Chev}<b>${name}</b><span class="rg-n">${rules.length}</span>
      ${!open ? html`<span class="rg-peek">${rules[0]?.text}</span>` : ''}</button>
    ${open ? children : ''}</div>`;
}

function Website({ t, l, act, load, ro }) {
  const running = l.website.last?.status === 'running';
  useEffect(() => { if (!running) return undefined; const h = setInterval(load, 2500); return () => clearInterval(h); }, [running]);
  const last = l.website.last;
  return html`<${Sec} title=${t.website} sub=${t.websiteSub} id="website" fold="website" open=${l.proposals.length > 0}>
    <form class="row-form" onSubmit=${(e) => { e.preventDefault(); act('/api/website/read', 'POST', { url: e.target.elements.url.value.trim() }); }}>
      <input name="url" type="url" required placeholder="https://" value=${l.website.url ?? ''} disabled=${ro} />
      <button class="btn primary" disabled=${ro || running}><${Star} live=${running} />${running ? t.reading : t.read}</button>
    </form>
    ${last ? html`<p class=${`status ${last.status}`}>${last.status === 'running' ? html`<span class="tb-text-shimmer ai-shimmer">${t.reading}</span>`
      : last.status === 'done' ? t.readDone(last.pages, last.found) : `${t.readFailed}：${last.error ?? ''}`}</p>` : ''}
    ${l.proposals.length ? html`<div class="list-head"><${Star} />${t.candidates} ${l.proposals.length}</div>
      <ul class="items">${l.proposals.map((p) => html`<li key=${p.id} class="cand">
        <input class="k" value=${p.key} aria-label=${t.key} id=${`k-${p.id}`} disabled=${ro} />
        <input class="v" value=${p.value} aria-label=${t.value} id=${`v-${p.id}`} disabled=${ro} />
        ${p.sourceUrl ? html`<a class="src" href=${p.sourceUrl} target="_blank" rel="noopener">${t.source}</a>` : ''}
        ${!ro ? html`<button class="btn small primary" onClick=${() => act(`/api/facts/proposals/${p.id}`, 'POST', { key: document.getElementById(`k-${p.id}`).value, value: document.getElementById(`v-${p.id}`).value })}>${t.accept}</button>
          <button class="btn small" onClick=${() => act(`/api/facts/proposals/${p.id}`, 'POST', { action: 'reject' })}>${t.reject}</button>` : ''}
      </li>`)}</ul>` : ''}
  </${Sec}>`;
}

export function Playbook({ api, lang, toast }) {
  const t = L[lang]; const { s, l, load, act } = useData(api, toast);
  const [busy, setBusy] = useState('');
  if (!s || !l) return html`<div class="page"><i class="spin"></i></div>`;
  const ro = !s.canEdit;
  const labelName = (k) => { const x = s.labels.find((y) => y.key === k); return x ? (lang === 'ja' ? x.ja : x.en) : k; };
  const proposed = s.playbook.filter((r) => r.status === 'proposed'); const active = s.playbook.filter((r) => r.status === 'active');
  const run = async (key, path, msg) => { setBusy(key); const r = await act(path, 'POST', {}); setBusy(''); if (r) toast(msg(r)); };

  return html`<div class="page">
    <h2>${t.playbook}</h2>
    ${ro ? html`<p class="note">${t.readOnly}</p>` : ''}

    ${l.questions.length ? html`<${Sec} title=${`${t.questions} ${l.questions.length}`} sub=${t.questionsSub} id="questions">
      <ul class="items">${l.questions.map((q) => html`<li key=${q.id} class="question" id=${`q-${q.id}`}>
        <div class="q-head"><b>${q.blank}</b><span>${q.subject ?? ''}</span></div>
        <form class="row-form" onSubmit=${(e) => { e.preventDefault(); const f = e.target.elements; act(`/api/questions/${q.id}/answer`, 'POST', { answer: f.a.value, saveFact: f.sf.checked, factKey: f.k.value }, t.saved); }}>
          <input name="a" required placeholder=${t.answer} />
          <label class="chk"><input type="checkbox" name="sf" checked /> ${t.saveFact}</label>
          <input name="k" class="k" value=${q.blank} aria-label=${t.factKey} />
          <button class="btn primary">${t.answer}</button>
        </form></li>`)}</ul>
    </${Sec}>` : ''}

    <${Website} t=${t} l=${l} act=${act} load=${load} ro=${ro} />

    <${Sec} title=${t.rules} sub=${t.rulesSub} id="rules" fold="rules" count=${active.length}
      right=${!ro ? html`<button class="btn" disabled=${busy === 'propose'} onClick=${() => run('propose', '/api/learn/propose', (r) => (r.reason === 'not_enough_examples' ? t.needExamples : r.proposed ? `${t.proposed} ${r.proposed}` : t.noNewRules))}>
        <${Star} live=${busy === 'propose'} />${busy === 'propose' ? html`<span class="tb-text-shimmer ai-shimmer">${t.proposing}</span>` : t.propose}</button>` : ''}>
      ${proposed.length ? html`<ul class="items">${proposed.map((r) => html`<${Proposal} key=${r.id} r=${r} t=${t} ro=${ro} api=${api} act=${act} toast=${toast} labelName=${labelName} />`)}</ul>` : ''}
      ${[['', t.phaseAlways], ...Object.entries(t.phases)].map(([ph, name]) => { const rs = active.filter((r) => (r.phase ?? '') === ph); return rs.length ? html`
        <${RuleGroup} key=${ph || 'always'} name=${name} rules=${rs}><ul class="rlist">${rs.map((r) => html`<${RuleRow} key=${r.id} r=${r} t=${t} ro=${ro} act=${act} labelName=${labelName} />`)}</ul></${RuleGroup}>` : ''; })}
      ${!ro ? html`<${AddRule} t=${t}>${html`<form class="row-form add-rule" onSubmit=${(e) => { e.preventDefault(); const f = new FormData(e.target); act('/api/settings/playbook', 'POST', { text: f.get('text'), label: f.get('label') || null, phase: f.get('phase') || null }, t.saved); e.target.reset(); }}>
        <${Select} name="phase" options=${[{ value: '', label: t.phaseAlways }, ...Object.entries(t.phases).map(([k, v]) => ({ value: k, label: v }))]} />
        <${Select} name="label" options=${[{ value: '', label: t.anyLabel }, ...s.labels.filter((x) => !x.hidden).map((x) => ({ value: x.key, label: labelName(x.key) }))]} />
        <input name="text" required placeholder=${t.rulePh} class="grow" /><button class="btn">${t.add}</button></form>`}</${AddRule}>` : ''}
    </${Sec}>

    <${Sec} title=${t.facts} sub=${t.factsSub} id="facts" fold="facts" open=${false} count=${s.facts?.length}>
      <ul class="items">${s.facts.map((f) => html`<li key=${f.key} class="fact"><b>${f.key}</b>
        <textarea rows="1" disabled=${ro} onChange=${(e) => act('/api/settings/facts', 'PUT', { key: f.key, value: e.target.value }, t.saved)}>${f.value}</textarea>
        ${f.source === 'website' ? html`<span class="tag">web</span>` : ''}
        ${!ro ? html`<button class="btn small ghost" onClick=${() => act(`/api/settings/facts?key=${encodeURIComponent(f.key)}`, 'DELETE')}>${t.remove}</button>` : ''}</li>`)}</ul>
      ${!ro ? html`<form class="row-form" onSubmit=${(e) => { e.preventDefault(); const f = new FormData(e.target); act('/api/settings/facts', 'PUT', { key: f.get('key'), value: f.get('value') }, t.saved); e.target.reset(); }}>
        <input name="key" required placeholder=${t.key} /><input name="value" required placeholder=${t.value} class="grow" /><button class="btn">${t.add}</button></form>` : ''}
    </${Sec}>

    <${Sec} title=${t.learned} sub=${t.learnedSub(s.learnedCount, l.examples.total)} id="learned" fold="learned" open=${false}
      right=${!ro ? html`<button class="btn" disabled=${busy === 'history'} onClick=${() => run('history', '/api/learn/history', (r) => t.imported(r.saved))}><${Star} live=${busy === 'history'} />${busy === 'history' ? t.importing : t.history}</button>` : ''}>
      <ul class="items">${s.learnings.map((c) => html`<li key=${c.id} class="learn">
        <span class="tag">${c.fromLabel ? labelName(c.fromLabel) : '—'}</span><span class="arrow">→</span><span class="tag ok">${labelName(c.toLabel)}</span>
        <span class="lsub">${c.subject ?? ''}</span><span class="ldom">${c.domain ?? ''}</span>
        ${!ro ? html`<button class="btn small ghost" onClick=${() => act(`/api/settings/learnings/${c.id}`, 'DELETE')}>${t.forget}</button>` : ''}</li>`)}</ul>
    </${Sec}>

    <${Sec} title=${t.voices} id="voices" fold="voices" open=${false}>
      <div class="field">${t.sharedVoice}<${Select} disabled=${ro} value=${s.business.sharedVoiceId ?? ''} onChange=${(v) => act('/api/settings/business', 'PUT', { sharedVoiceId: v || null }, t.saved)}
        options=${[{ value: '', label: t.perMailbox }, ...s.voices.map((v) => ({ value: v.id, label: `${v.mailbox} — ${v.fullName}` }))]} /></div>
      ${s.voices.map((v) => html`<details key=${v.id}><summary><b>${v.mailbox}</b> ${v.fullName}</summary>
        <form class="grid" onSubmit=${(e) => { e.preventDefault(); const f = new FormData(e.target); act(`/api/settings/voices/${v.id}`, 'PUT', { fullName: f.get('fullName'), style: f.get('style'), signature: f.get('signature') }, t.saved); }}>
          <label class="field">${t.fullName}<input name="fullName" value=${v.fullName} disabled=${ro} /></label>
          <label class="field">${t.style}<textarea name="style" rows="4" disabled=${ro}>${v.style ?? ''}</textarea></label>
          <label class="field">${t.signature}<textarea name="signature" rows="5" disabled=${ro}>${v.signature ?? ''}</textarea></label>
          ${!ro ? html`<button class="btn primary">${t.save}</button>` : ''}</form></details>`)}
    </${Sec}>
  </div>`;
}

export function Settings({ api, lang, toast }) {
  const t = L[lang]; const { s, act } = useData(api, toast);
  if (!s) return html`<div class="page"><i class="spin"></i></div>`;
  const ro = !s.canEdit;
  const labelName = (k) => { const x = s.labels.find((y) => y.key === k); return x ? (lang === 'ja' ? x.ja : x.en) : k; };
  const push = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error(t.notifyUnsupported);
      if (await Notification.requestPermission() !== 'granted') throw new Error(t.notifyDenied);
      const { key } = await api('/api/push/key');
      const reg = await navigator.serviceWorker.ready;
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
      await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      toast(t.notifyOn);
    } catch (e) { toast(e.message); }
  };
  return html`<div class="page">
    <h2>${t.settings}</h2>
    ${ro ? html`<p class="note">${t.readOnly}</p>` : ''}
    <${Sec} title=${t.general}>
      <form class="grid two" onSubmit=${(e) => { e.preventDefault(); const f = new FormData(e.target);
        act('/api/settings/business', 'PUT', { name: f.get('name'), undoSeconds: Number(f.get('undo')), plainText: f.get('plain') === 'on', dailyCapUsd: f.get('cap') === '' ? null : Number(f.get('cap')) }, t.saved); }}>
        <label class="field">${t.company}<input name="name" value=${s.business.name} disabled=${ro} /></label>
        <label class="field">${t.undo}<input name="undo" type="number" min="5" max="30" value=${s.business.undoSeconds} disabled=${ro} /></label>
        <label class="field">${t.cap}<input name="cap" type="number" min="0" step="0.5" value=${s.business.dailyCapUsd ?? ''} placeholder=${t.capHint(s.business.defaultDailyCapUsd)} disabled=${ro} /></label>
        <label class="chk"><input name="plain" type="checkbox" checked=${s.business.plainText} disabled=${ro} /> ${t.plain}</label>
        ${!ro ? html`<button class="btn primary">${t.save}</button>` : ''}
      </form>
    </${Sec}>
    <${Sec} title=${t.notify} right=${html`<button class="btn" onClick=${push}>${t.notifyButton}</button>`} />
    <${Sec} title=${t.mailboxes} right=${!ro ? html`<a class="btn" href="/connect/google/me">${t.addMailbox}</a>` : ''}>
      <ul class="items">${s.mailboxes.map((m) => html`<li key=${m.id} class="mbx"><b>${m.address}</b>
        <${Select} disabled=${ro} value=${m.mode} onChange=${(v) => act(`/api/settings/mailboxes/${m.id}`, 'PUT', { mode: v }, t.saved)}
          options=${Object.entries(t.modes).map(([k, v]) => ({ value: k, label: v }))} />
        ${m.lastError ? html`<span class="tag warn">${m.lastError}</span>` : ''}</li>`)}</ul>
    </${Sec}>
    <${Sec} title=${t.labels}>
      <table class="tbl"><tr><th></th><th>${t.autoDraft}</th><th>${t.hide}</th></tr>
      ${s.labels.map((x) => html`<tr key=${x.key}>
        <td><input value=${x.ja} aria-label="ja" disabled=${ro} onChange=${(e) => act(`/api/settings/labels/${x.key}`, 'PUT', { ja: e.target.value }, t.saved)} /></td>
        <td><input type="checkbox" checked=${x.autoDraft} disabled=${ro} onChange=${(e) => act(`/api/settings/labels/${x.key}`, 'PUT', { autoDraft: e.target.checked })} /></td>
        <td><input type="checkbox" checked=${x.hidden} disabled=${ro || x.key === 'unconfirmed'} onChange=${(e) => act(`/api/settings/labels/${x.key}`, 'PUT', { hidden: e.target.checked })} /></td></tr>`)}
      </table>
      ${!ro ? html`<form class="row-form" onSubmit=${(e) => { e.preventDefault(); const f = new FormData(e.target); act(`/api/settings/labels/${String(f.get('key')).trim()}`, 'PUT', { ja: f.get('ja'), en: f.get('ja') }, t.saved); e.target.reset(); }}>
        <input name="ja" required placeholder=${t.newLabel} /><input name="key" required pattern="[a-z0-9_]+" placeholder="key (vip)" /><button class="btn">${t.add}</button></form>` : ''}
    </${Sec}>
    <${Sec} title=${t.intake}>
      <ul class="items">${s.intake.map((r) => html`<li key=${r.id}><span class="tag">${t.kinds[r.kind]}</span><b>${r.value}</b>${r.mailbox ? html`<span class="lsub">${r.mailbox}</span>` : ''}
        ${!ro ? html`<button class="btn small ghost" onClick=${() => act(`/api/settings/intake/${r.id}`, 'DELETE')}>${t.remove}</button>` : ''}</li>`)}</ul>
      ${!ro ? html`<form class="row-form" onSubmit=${(e) => { e.preventDefault(); const f = new FormData(e.target); act('/api/settings/intake', 'POST', { kind: f.get('kind'), value: f.get('value'), mailboxId: f.get('mailbox') || null }, t.saved); e.target.reset(); }}>
        <${Select} name="kind" defaultValue=${Object.keys(t.kinds)[0]} options=${Object.entries(t.kinds).map(([k, v]) => ({ value: k, label: v }))} />
        <input name="value" required placeholder="news@example.com" class="grow" />
        <${Select} name="mailbox" options=${[{ value: '', label: '—' }, ...s.mailboxes.map((m) => ({ value: m.id, label: m.address }))]} />
        <button class="btn">${t.add}</button></form>` : ''}
    </${Sec}>
    <${Sec} title=${t.team}>
      <ul class="items">${s.team.map((u) => html`<li key=${u.id}><b>${u.email}</b><span class="tag">${u.role === 'owner' ? t.owner : u.role === 'partner' ? t.partner : t.staff}</span>
        <span class="lsub">${u.lastLogin ? new Date(u.lastLogin).toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-GB') : t.never}</span>
        ${!ro ? html`<button class="btn small ghost" onClick=${() => act(`/api/team/${u.id}`, 'DELETE')}>${t.remove}</button>` : ''}
        ${u.role === 'partner' ? html`<${PartnerAccess} t=${t} u=${u} mailboxes=${s.mailboxes} ro=${ro} act=${act} />` : ''}</li>`)}</ul>
      <p class="lsub">${t.partnerWhat}</p>
      ${!ro ? html`<form class="row-form" onSubmit=${(e) => { e.preventDefault(); const f = new FormData(e.target); act('/api/team', 'POST', { email: f.get('email'), role: f.get('role') }, t.saved); e.target.reset(); }}>
        <input name="email" type="email" required placeholder="name@company.jp" class="grow" />
        <${Select} name="role" defaultValue="staff" options=${[{ value: 'staff', label: t.staff }, { value: 'partner', label: t.partner }, { value: 'owner', label: t.owner }]} /><button class="btn">${t.invite}</button></form>` : ''}
    </${Sec}>
  </div>`;
}

// D8 partner: the owner ticks which mailboxes this partner sees, and from which they may send.
function PartnerAccess({ t, u, mailboxes, ro, act }) {
  const has = (id) => u.access?.find((a) => a.mailboxId === id);
  const save = (id, field, on) => {
    const next = mailboxes.map((m) => {
      const a = has(m.id); const see = field === 'see' && m.id === id ? on : Boolean(a);
      const send = m.id === id ? (field === 'send' ? on : field === 'see' && !on ? false : Boolean(a?.canSend)) : Boolean(a?.canSend);
      return see || send ? { mailboxId: m.id, canSend: send } : null;
    }).filter(Boolean);
    act(`/api/team/${u.id}/access`, 'PUT', { access: next }, t.saved);
  };
  return html`<div class="partner-access">${!u.access?.length ? html`<span class="lsub warn">${t.partnerNone}</span>` : ''}
    ${mailboxes.map((m) => html`<div class="pa-row" key=${m.id}><b>${m.address}</b>
      <label><input type="checkbox" disabled=${ro} checked=${Boolean(has(m.id))} onChange=${(e) => save(m.id, 'see', e.target.checked)} /> ${t.partnerSee}</label>
      <label><input type="checkbox" disabled=${ro} checked=${Boolean(has(m.id)?.canSend)} onChange=${(e) => save(m.id, 'send', e.target.checked)} /> ${t.partnerSend}</label></div>`)}</div>`;
}

// First-run wizard (D20): company → mailbox → website → which mail gets drafts.
export function Setup({ api, lang, toast, onDone }) {
  const t = L[lang]; const { s, l, load, act } = useData(api, toast);
  const [step, setStep] = useState(() => Number(sessionStorage.getItem('tbi.setup') || 0));
  useEffect(() => { try { sessionStorage.setItem('tbi.setup', String(step)); } catch { /* ignore */ } }, [step]);
  const nameRef = useRef(null);
  if (!s || !l) return html`<div class="setup"><i class="spin"></i></div>`;
  const go = (n) => setStep(Math.max(0, Math.min(3, n)));
  const finish = () => { try { sessionStorage.removeItem('tbi.setup'); } catch { /* ignore */ } onDone(); };
  const body = [
    html`<h3>${t.s1}</h3><input ref=${nameRef} class="big-input" value=${s.business.name} />
      <div class="wiz-actions"><span></span><button class="btn primary" onClick=${async () => { await act('/api/settings/business', 'PUT', { name: nameRef.current.value }); go(1); }}>${t.next}</button></div>`,
    html`<h3>${t.s2}</h3><p>${t.s2sub}</p>
      <ul class="items">${s.mailboxes.map((m) => html`<li key=${m.id}><span class="tag ok">${t.connected}</span><b>${m.address}</b></li>`)}</ul>
      <a class="btn" href="/connect/google/me?back=setup">${t.addMailbox}</a>
      <div class="wiz-actions"><button class="btn ghost" onClick=${() => go(0)}>${t.back}</button><button class="btn primary" disabled=${!s.mailboxes.length} onClick=${() => go(2)}>${t.next}</button></div>`,
    html`<h3>${t.s3}</h3><p>${t.s3sub}</p><${Website} t=${t} l=${l} act=${act} load=${load} ro=${false} />
      <div class="wiz-actions"><button class="btn ghost" onClick=${() => go(1)}>${t.back}</button><button class="btn primary" onClick=${() => go(3)}>${l.website.url ? t.next : t.skip}</button></div>`,
    html`<h3>${t.s4}</h3>
      <div class="choices">${s.labels.filter((x) => !x.hidden && x.key !== 'unconfirmed').map((x) => html`<label key=${x.key} class=${`choice toggle ${x.autoDraft ? 'guess' : ''}`}>
        <input type="checkbox" checked=${x.autoDraft} onChange=${(e) => act(`/api/settings/labels/${x.key}`, 'PUT', { autoDraft: e.target.checked })} />${lang === 'ja' ? x.ja : x.en}</label>`)}</div>
      <div class="wiz-actions"><button class="btn ghost" onClick=${() => go(2)}>${t.back}</button><button class="btn primary" onClick=${finish}>${t.finish}</button></div>`,
  ];
  return html`<div class="setup"><div class="wiz">
    <div class="wiz-top"><span class="logo">扉</span><b>${t.setup}</b></div>
    <ol class="wiz-steps">${t.steps.map((x, i) => html`<li class=${i === step ? 'on' : i < step ? 'done' : ''}>${x}</li>`)}</ol>
    <div class="wiz-body" key=${step}>${body[step]}</div>
  </div></div>`;
}
