// packages/engine/src/blanks.js
// 【要確認：…】 blanks (D23). A draft with any blank left cannot be sent.

// Candidate-slot shapes match the external CRM backend (unfilled-slots).
// Half-filled dates/times also block; ordinary ○○様 and 二〇二六年 do not.
const BLANK_RE = /【要確認[：:]\s*([^】]*)】|[〇○]{1,2}月[〇○0-9０-９]{1,2}日|[〇○0-9０-９]{1,2}月[〇○]{1,2}日|[〇○]{1,2}[:：][〇○0-9０-９]{2}|[〇○0-9０-９]{1,2}[:：][〇○]{2}/g;

/** @returns {Array<{index:number, text:string, raw:string}>} */
export function findBlanks(body) {
  const out = [];
  for (const m of String(body ?? '').matchAll(BLANK_RE)) {
    out.push({ index: m.index, text: (m[1] ?? m[0]).trim(), raw: m[0] });
  }
  return out;
}

export function hasBlanks(body) {
  return findBlanks(body).length > 0;
}

/** Replace the first blank whose text matches `question` with `answer`. */
export function fillBlank(body, question, answer) {
  const target = findBlanks(body).find((b) => b.text === question);
  if (!target) return body;
  return body.slice(0, target.index) + answer + body.slice(target.index + target.raw.length);
}

export function makeBlank(question) {
  return `【要確認：${String(question).replace(/】/g, '')}】`;
}
