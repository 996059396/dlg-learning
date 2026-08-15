// Server-side grading: mirrors the frontend's per-node-type answer checks so the
// server (not the client) decides correctness — fixes "客户端自报判分可刷分".
// Half-width normalization first: full-width digits/letters/punct (U+FF01–U+FF5E)
// and full-width space (U+3000) are converted to their ASCII equivalents so a
// user typing "５" or "，wrong" on a Chinese IME grades the same as "5" / ",wrong".
// This fixes the 490/919 fill_blank false-negatives caused by full-width input.
const _halfWidth = (s) => String(s)
  .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/　/g, ' ');

// The frontend serializes sequences with ',' and '=' without spaces; the backend
// historically used ' → ' and ' = '. These helpers make BOTH sides canonical so
// answers from the real client (and legacy stored mistakes) grade correctly.
const _seqParts = (s) => _normalize(s).split(/[,→]/).map(x => x.trim()).filter(Boolean);
const _matchCanon = (s) => _normalize(s).replace(/\s*([=,])\s*/g, '$1');

// NOTE: _normalize strips ALL whitespace, not just collapsing runs. A user who
// types "1 库仑" or "1库仑", "５　Ｖ" or "5V", "选　择Ａ" or "选择A" (full-width
// space from a Chinese IME) grades identically. Both sides of every comparison
// go through the same transform, so stripping is strictly leniency — it can only
// accept, never reject, a correct answer the audit's 490/919 misgrade wrongly
// failed.
// Ω (ohm, U+03A9) and ω (angular frequency, U+03C9) are DIFFERENT units that
// toLowerCase() fuses into one — an answer "2Ω" would otherwise accept "2ω".
// Shield Ω with a private-use sentinel before lowercasing, then restore it, so
// the two stay distinct through normalization.
const _normalize = (s) => {
  // `?? ''` not `|| ''` (P29 / #72 falsy asymmetry): a legit answer "0" arriving
  // as the NUMBER 0 (or false for a boolean-typed answer) used to collapse to ''
  // and falsely fail. Only null/undefined mean "no answer".
  const half = _halfWidth(String(s ?? '').trim());
  // Crosscheck4 C08: toLowerCase() fuses the SI prefixes m (milli) and M (mega),
  // so '0.5MΩ' was accepting '0.5mΩ' and '500mA' accepting '500MA'. Shield an
  // uppercase M that starts an SI prefix (immediately followed by a unit letter
  // or Ω/ω) the same way Ω is shielded below — prefix case survives lowercasing.
  // Selection answers unaffected (both sides transform identically); typed
  // fill_blank '0.5MΩ' vs '0.5mΩ' now grade distinctly.
  const mShielded = half.replace(/M(?=[A-Za-zΩω])/g, '');
  const shielded = mShielded.replace(/Ω/g, '');
  return shielded.toLowerCase().replace(//g, 'M').replace(//g, 'Ω').replace(/\s+/g, '');
};function extractAnswer(node) {
  if (!node) return '';
  switch (node.type) {
    case 'multiple_choice':
      return node.options?.find(o => o.is_correct)?.text || '';
    case 'multi_select':
      // Show every correct option — the learner needs to see the full answer set.
      return (node.options || []).filter(o => o.is_correct).map(o => o.text).join('、') || '';
    case 'true_false':
      if (node.correct_answer === true) return '正确';
      if (node.correct_answer === false) return '错误';
      return String(node.correct_answer ?? '');
    case 'fill_blank':
      return node.answer || node.acceptable_answers?.[0] || '';
    case 'simulation_dial':
      return node.dial_options?.find(o => o.is_correct)?.label || '';
    case 'simulation_probe': {
      if (node.correct_probes) {
        const r = node.correct_probes.red || '?';
        const b = node.correct_probes.black || '?';
        const rh = node.hotspots?.[r]?.label || r;
        const bh = node.hotspots?.[b]?.label || b;
        return `红表笔→${rh}, 黑表笔→${bh}`;
      }
      return '';
    }
    case 'simulation_danger':
      return '安全操作（先换表笔再测量）';
    case 'multimeter_challenge': {
      const c = node.correct_setup || {};
      const ts = node.target?.hotspots || {};
      const rt = ts[c.red_touch]?.label || c.red_touch || '?';
      const bt = ts[c.black_touch]?.label || c.black_touch || '?';
      return `档位:${c.dial}, 红表笔:${c.red_port}→${rt}, 黑表笔:${c.black_port || 'COM'}→${bt}`;
    }
    case 'sort':
      if (node.correct_order && node.items) {
        return node.correct_order
          .map(id => node.items.find(i => i.id === id)?.text)
          .filter(Boolean)
          .join(' → ');
      }
      return '';
    case 'drag_drop':
      return node.target_zone?.label || '';
    case 'match':
      if (node.pairs) return node.pairs.map(p => `${p.left} = ${p.right}`).join(', ');
      return '';
    default:
      return '';
  }
}

// Grade a user answer against a node. Returns { gradeable, correct }.
// gradeable=false means the type can't be structurally re-graded server-side
// (complex interactive sims) and the caller should fall back to the client claim.
function gradeNode(node, userAnswer) {
  if (!node || !node.type) return { gradeable: true, correct: false };
  const u = _normalize(userAnswer);

  switch (node.type) {
    case 'multiple_choice': {
      const opt = (node.options || []).find(o => _normalize(o.text) === u);
      return { gradeable: true, correct: !!opt?.is_correct };
    }
    case 'multi_select': {
      // Real 考证 多选题: every correct option must be selected, no extras.
      // userAnswer = JSON array of selected option ids, e.g. '["A","B"]' — NOT
      // comma-joined texts, because option text itself may contain full-width
      // commas (，) which collide with a comma delimiter (the same bug class as
      // the multimeter label regression). Ids are short and collision-free.
      const opts = node.options || [];
      const correctIds = opts.filter(o => o.is_correct).map(o => String(o.id || o.text));
      if (!correctIds.length) return { gradeable: false, correct: false };
      let selected = null;
      try { selected = JSON.parse(String(userAnswer || '')); } catch (e) { selected = null; }
      if (!Array.isArray(selected)) return { gradeable: true, correct: false };
      const selectedIds = selected.map(s => String(s));
      const sameSet = selectedIds.length === correctIds.length &&
        correctIds.every(id => selectedIds.includes(id));
      return { gradeable: true, correct: sameSet };
    }
    case 'true_false': {
      if (node.correct_answer === true)
        return { gradeable: true, correct: u === '正确' || u === 'true' || u === '1' };
      if (node.correct_answer === false)
        return { gradeable: true, correct: u === '错误' || u === 'false' || u === '0' };
      return { gradeable: true, correct: u === _normalize(String(node.correct_answer)) };
    }
    case 'fill_blank': {
      const accepted = [node.answer, ...(node.acceptable_answers || [])].filter(Boolean);
      return { gradeable: true, correct: accepted.some(a => _normalize(a) === u) };
    }
    case 'simulation_dial': {
      const opt = (node.dial_options || []).find(o => _normalize(o.label) === u);
      return { gradeable: true, correct: !!opt?.is_correct };
    }
    case 'simulation_danger': {
      // Not unconditional: the safe action has a canonical answer the frontend
      // sends only after completing the correct (先换表笔再测量) sequence. The old
      // substring test /安全操作/ wrongly accepted "不安全操作" (it CONTAINS the
      // characters 安全操作). Accept only the exact safe-action forms after
      // normalization: the frontend's '安全操作' and extractAnswer's display
      // canonical '安全操作（先换表笔再测量）'.
      const displayCanonical = _normalize('安全操作（先换表笔再测量）');
      return { gradeable: true, correct: u === '安全操作' || u === displayCanonical };
    }
    case 'sort': {
      if (!node.correct_order || !node.items) return { gradeable: false, correct: false };
      const correctText = node.correct_order
        .map(id => node.items.find(i => i.id === id)?.text).filter(Boolean).join(' → ');
      // Compare as ordered token sequences; delimiter style (',' vs ' → ') is ignored.
      return { gradeable: true, correct: _seqParts(u).join('|') === _seqParts(correctText).join('|') };
    }
    case 'drag_drop':
      return { gradeable: true, correct: u === _normalize(node.target_zone?.label) };
    case 'match': {
      if (!node.pairs) return { gradeable: false, correct: false };
      const correctText = node.pairs.map(p => `${p.left} = ${p.right}`).join(', ');
      // Strip whitespace around '=' and ',' on both sides (client sends "L=R, R=X").
      return { gradeable: true, correct: _matchCanon(u) === _matchCanon(correctText) };
    }
    case 'simulation_probe': {
      // Frontend serializes the placement as "红:<hotspotKey>,黑:<hotspotKey>".
      // The probe keys themselves are the answer — no client boolean needed.
      if (!node.correct_probes?.red || !node.correct_probes?.black) return { gradeable: false, correct: false };
      const m = u.match(/红:\s*([^,]+),\s*黑:\s*(.+)/);
      if (!m) return { gradeable: true, correct: false };
      const red = _normalize(m[1]);
      const black = _normalize(m[2]);
      const cr = _normalize(node.correct_probes.red);
      const cb = _normalize(node.correct_probes.black);
      const direct = red === cr && black === cb;
      const swapped = !!node.allow_swap && red === cb && black === cr;
      return { gradeable: true, correct: direct || swapped };
    }
    case 'multimeter_challenge': {
      // Frontend serializes the full setup: "档位:<dial>, 红:<port>→<touchLabel>, 黑:<port>→<touchLabel>".
      // Dial + ports are graded verbatim; touch points are resolved label→key via
      // node.target.hotspots (labels are display text, keys are the identifiers).
      //
      // Parse the RAW answer, NOT the pre-normalized `u`: _normalize converts
      // full-width punctuation (U+FF0C ，→ ',') which is ALSO this serialization's
      // field delimiter, so pre-normalizing truncated labels like "正极 (+)，凸起一端"
      // at the first comma. Each captured field is normalized individually instead,
      // so full-width comma is preserved inside a label until the real field
      // boundary (", 黑:").
      const c = node.correct_setup;
      if (!c?.dial || !c?.red_port || !c?.black_port) return { gradeable: false, correct: false };
      const raw = String(userAnswer || '');
      const mDial = raw.match(/档位[:：]\s*([^,，]+)/);
      const mRed = raw.match(/红[:：]\s*([^→]+)→\s*(.*?)(?:[,，]\s*黑[:：]|$)/);
      const mBlack = raw.match(/黑[:：]\s*([^→]+)→\s*(.+)$/);
      if (!mDial || !mRed || !mBlack) return { gradeable: true, correct: false };
      if (_normalize(mDial[1]) !== _normalize(c.dial)) return { gradeable: true, correct: false };
      if (_normalize(mRed[1]) !== _normalize(c.red_port)) return { gradeable: true, correct: false };
      if (_normalize(mBlack[1]) !== _normalize(c.black_port)) return { gradeable: true, correct: false };
      const keyForLabel = (label) => {
        const hs = node.target?.hotspots;
        if (!hs) return null;
        const n = _normalize(label);
        if (Array.isArray(hs)) return hs.find(h => h && h.id && _normalize(h.label) === n)?.id || null;
        for (const [k, h] of Object.entries(hs)) {
          if (h && _normalize(h.label) === n) return k;
        }
        return null;
      };
      const redKey = keyForLabel(mRed[2]);
      const blackKey = keyForLabel(mBlack[2]);
      if (!redKey || !blackKey) return { gradeable: true, correct: false };
      const direct = redKey === c.red_touch && blackKey === c.black_touch;
      const swapped = !!node.allow_swap && redKey === c.black_touch && blackKey === c.red_touch;
      return { gradeable: true, correct: direct || swapped };
    }
    default:
      // Unknown/malformed node: fail closed — the client's claim is never trusted.
      return { gradeable: false, correct: false };
  }
}

module.exports = { gradeNode, extractAnswer };
