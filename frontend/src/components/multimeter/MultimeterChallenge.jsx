import { useState, useMemo } from 'react';
import Multimeter from './Multimeter';
import { DEFAULT_DIAL_POSITIONS } from './MultimeterDial';
import './multimeter.css';

/**
 * MultimeterChallenge — multi-step practice question.
 *
 * node shape:
 * {
 *   type: 'multimeter_challenge',
 *   question: string,
 *   instruction: string,
 *   target: {
 *     type: 'battery_15v' | 'socket_220v' | 'resistor_1k' | 'wire_continuity' | ...,
 *     label?: string,
 *     hotspots: {
 *       [key: string]: { label: string, x: number, y: number }
 *     }
 *   },
 *   correct_setup: {
 *     dial: string,           // e.g. 'DCV_20'
 *     red_port: string,       // '20A' | 'mA' | 'VOhm'
 *     black_port: string,     // 'COM'
 *     red_touch: string,      // hotspot id
 *     black_touch: string     // hotspot id
 *   },
 *   correct_display?: string, // e.g. '1.500'
 *   success_msg: string,
 *   fail_msg: string,
 *   allow_swap?: boolean      // if true, swapping red/black hotspots still scores correct
 * }
 */
export default function MultimeterChallenge({ node, onAnswer }) {
  const correct = node.correct_setup || {};
  const target = node.target || {};

  // Normalize hotspots: support both array [{id,label,x,y}] and object {id:{label,x,y}}
  const hotspots = useMemo(() => {
    const raw = target.hotspots;
    if (!raw) return {};
    if (Array.isArray(raw)) {
      // Convert array to keyed object
      const obj = {};
      raw.forEach(h => {
        if (h && h.id) obj[h.id] = { label: h.label, x: h.x, y: h.y };
      });
      return obj;
    }
    return raw;
  }, [target.hotspots]);

  // Authoring space for hotspot x/y. Percent positioning keeps the buttons
  // anchored to the target when the area reflows narrower on small screens
  // (audit #13 E2) — same treatment as SimulationProbe's 400×300 reference.
  const REF_W = 300, REF_H = 180;
  const pct = (v, ref) => `${(v / ref) * 100}%`;

  // Candidate dial positions: the correct dial + ~4 well-spread distractors.
  // Rendering all 33 ranges on a compact dial squeezes every label into an
  // un-tappable sliver (audit #13 E3). Same-category siblings sit only 10°
  // apart on a real dial face, so keeping all of them still crowds the dial;
  // instead pick distractors that are both plausible AND ≥28° apart (≈49px of
  // arc at the label radius — comfortably above the 44px tap-target floor).
  const dialCandidates = useMemo(() => {
    const correctId = correct.dial;
    if (!correctId) return undefined;
    const byId = Object.fromEntries(DEFAULT_DIAL_POSITIONS.map(p => [p.id, p]));
    const correctPos = byId[correctId];
    if (!correctPos) return undefined;
    const picked = [correctId];
    const pickedSet = new Set(picked);
    const minAngle = 28;
    const farEnough = (pos) =>
      picked.every(id => {
        const a = Math.abs(byId[id].angle - pos.angle);
        return Math.min(a, 360 - a) >= minAngle;
      });
    // 1) same-category siblings (dial order) that stay far enough apart
    const siblings = DEFAULT_DIAL_POSITIONS.filter(p => p.category === correctPos.category && p.id !== correctId);
    for (const p of siblings) {
      if (picked.length >= 5) break;
      if (farEnough(p)) { picked.push(p.id); pickedSet.add(p.id); }
    }
    // 2) top up with the nearest other-category positions to reach 5 total
    const rest = DEFAULT_DIAL_POSITIONS
      .filter(p => !pickedSet.has(p.id))
      .sort((a, b) => Math.abs(a.angle - correctPos.angle) - Math.abs(b.angle - correctPos.angle));
    for (const p of rest) {
      if (picked.length >= 5) break;
      if (farEnough(p)) { picked.push(p.id); pickedSet.add(p.id); }
    }
    return DEFAULT_DIAL_POSITIONS
      .filter(p => pickedSet.has(p.id) || p.id === 'OFF')
      .sort((a, b) => a.angle - b.angle);
  }, [correct.dial]);

  const [dialPos, setDialPos] = useState('OFF');
  const [redPort, setRedPort] = useState('VOhm');
  const [blackPort] = useState('COM');
  const [redTouch, setRedTouch] = useState(null);
  const [blackTouch, setBlackTouch] = useState(null);
  const [activeProbe, setActiveProbe] = useState('red'); // which probe user is placing
  const [submitted, setSubmitted] = useState(false);
  const [resultCorrect, setResultCorrect] = useState(null);
  const [hint, setHint] = useState('');

  // === Step status ===
  const dialOk = dialPos === correct.dial;
  const portOk = redPort === correct.red_port;
  const redTouchOk = node.allow_swap
    ? redTouch === correct.red_touch || redTouch === correct.black_touch
    : redTouch === correct.red_touch;
  const blackTouchOk = node.allow_swap
    ? blackTouch === correct.black_touch || blackTouch === correct.red_touch
    : blackTouch === correct.black_touch;
  const allTouchOk = node.allow_swap
    ? (redTouch === correct.red_touch && blackTouch === correct.black_touch) ||
      (redTouch === correct.black_touch && blackTouch === correct.red_touch)
    : redTouchOk && blackTouchOk;

  // === Warning port (e.g. red in 20A while testing voltage) ===
  const warnPort = useMemo(() => {
    if (submitted) return null;
    // dangerous: red probe is in a current jack but dial is on voltage
    const dial = dialPos || '';
    if ((redPort === '20A' || redPort === 'mA') &&
        (dial.startsWith('DCV') || dial.startsWith('ACV'))) {
      return redPort;
    }
    return null;
  }, [redPort, dialPos, submitted]);

  // === Display value ===
  // Reading is authoritative only when the node carries correct_display; missing
  // data renders an explicit "---" failure instead of a hardcoded fake reading.
  const displayValue = useMemo(() => {
    if (!submitted) return '0.000';
    if (resultCorrect) return node.correct_display || '---';
    // probes placed but touching the wrong points with an otherwise-correct setup
    if (dialOk && portOk && (redTouch && blackTouch)) return '0.0';
    // Wrong setup — simulate the real reading so same-category ranges that can
    // actually measure the value don't falsely show "OL" (e.g. measuring 1kΩ on
    // OHM_200K reads ~1.0kΩ, only a smaller range like OHM_200 overloads).
    // Only a wrong measuring function or a value beyond the range cap shows "OL".
    const sim = simulateReading(dialPos, correct.dial, target.type, node.correct_display);
    return sim !== null ? sim : 'OL';
  }, [submitted, resultCorrect, dialOk, portOk, redTouch, blackTouch, dialPos, correct.dial, target.type, node]);

  // === Handlers ===
  const handleMultimeterChange = ({ dialPosition, redProbeIn }) => {
    if (submitted) return;
    setDialPos(dialPosition);
    setRedPort(redProbeIn);
    setHint('');
  };

  const handleHotspotClick = (key) => {
    if (submitted) return;
    if (activeProbe === 'red') {
      setRedTouch(key);
      setActiveProbe('black');
    } else {
      if (key === redTouch) return; // same spot not allowed
      setBlackTouch(key);
    }
  };

  const handleClearProbes = () => {
    if (submitted) return;
    setRedTouch(null);
    setBlackTouch(null);
    setActiveProbe('red');
  };

  const handleConfirm = () => {
    if (submitted) return;
    // C10: correct_setup is no longer shipped to the client (it IS the answer),
    // so a review card can't self-check locally. Fall back to submitting the raw
    // setup string and letting the server re-grade it — MistakeReview calls
    // /mistakes/review, whose verdict drives the result phase. `correct` is
    // passed as null (unknown here) and is overridden by the server response.
    if (!node.correct_setup) {
      if (redTouch == null || blackTouch == null) {
        setHint('请先把红、黑表笔都放到测试点上');
        return;
      }
      setSubmitted(true);
      setResultCorrect(null); // unknown locally; server verdict drives the UI
      const setupStr = `档位:${dialPos}, 红:${redPort}→${hotspots[redTouch]?.label}, 黑:${blackPort}→${hotspots[blackTouch]?.label}`;
      setTimeout(() => onAnswer && onAnswer(null, setupStr), 800);
      return;
    }
    // Build hint for first wrong step
    if (!dialOk) {
      setHint(`档位不对哦，提示：${dialHint(correct.dial, node.target?.type)}`);
      return;
    }
    if (!portOk) {
      setHint(`红表笔插孔不对，应插在「${portName(correct.red_port)}」`);
      return;
    }
    if (redTouch == null || blackTouch == null) {
      setHint('请先把红、黑表笔都放到测试点上');
      return;
    }
    if (!allTouchOk) {
      const rLabel = hotspots[correct.red_touch]?.label || correct.red_touch;
      const bLabel = hotspots[correct.black_touch]?.label || correct.black_touch;
      setHint(`表笔位置不对，红表笔应接「${rLabel}」，黑表笔应接「${bLabel}」`);
      return;
    }

    // All correct
    setSubmitted(true);
    setResultCorrect(true);
    setHint('');
    const setupStr = `档位:${dialPos}, 红:${redPort}→${hotspots[redTouch]?.label}, 黑:${blackPort}→${hotspots[blackTouch]?.label}`;
    setTimeout(() => onAnswer && onAnswer(true, setupStr), 800);
  };

  const handleGiveUp = () => {
    if (submitted) return;
    setSubmitted(true);
    setResultCorrect(false);
    setTimeout(() => onAnswer && onAnswer(false, '未完成正确设置'), 600);
  };

  // === Render ===
  const stepStatus = (ok, current) => {
    if (submitted) return ok ? 'done' : 'wrong';
    if (current) return 'done';
    return '';
  };

  return (
    <div className="question-node">
      <div className="question-text">{node.question}</div>
      {node.instruction && (
        <div className="question-instruction">{node.instruction}</div>
      )}

      <div className="mm-challenge">
        {/* === Step checklist === */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className={`mm-step-row ${stepStatus(dialOk, dialOk)}`}>
            <span className="mm-step-num">1</span>
            <span>拨档位：{dialPos === 'OFF' ? '未选' : dialPos}</span>
            {dialOk && <span style={{ marginLeft: 'auto' }}>✓</span>}
          </div>
          <div className={`mm-step-row ${stepStatus(portOk, portOk)}`}>
            <span className="mm-step-num">2</span>
            <span>红表笔插孔：{portName(redPort)}</span>
            {portOk && <span style={{ marginLeft: 'auto' }}>✓</span>}
          </div>
          <div className={`mm-step-row ${stepStatus(allTouchOk, redTouch && blackTouch)}`}>
            <span className="mm-step-num">3</span>
            <span>
              测试点：红→{redTouch ? hotspots[redTouch]?.label : '未放'}，
              黑→{blackTouch ? hotspots[blackTouch]?.label : '未放'}
            </span>
            {allTouchOk && <span style={{ marginLeft: 'auto' }}>✓</span>}
          </div>
        </div>

        {/* === Target visual area === */}
        <div className="mm-target-area">
          <div className="mm-target-title">
            {target.label || targetLabel(target.type)}
          </div>
          <div className="mm-target-visual">{targetEmoji(target.type)}</div>

          {Object.entries(hotspots).map(([key, hs], hsIdx, arr) => {
            const hasRed = redTouch === key;
            const hasBlack = blackTouch === key;
            // Auto-position if x/y missing: spread horizontally across the design space
            const total = arr.length;
            const autoX = total > 1 ? 30 + (260 / (total - 1)) * hsIdx : 150;
            const autoY = 80;
            const hx = typeof hs.x === 'number' ? hs.x : autoX;
            const hy = typeof hs.y === 'number' ? hs.y : autoY;
            return (
              <button
                key={key}
                type="button"
                className={`mm-hotspot ${hasRed ? 'has-red' : ''} ${hasBlack ? 'has-black' : ''}`}
                style={{
                  left: pct(hx, REF_W),
                  top: pct(hy, REF_H),
                  // Center the button on its anchor point. Separate `translate`
                  // property composes with the :hover transform: scale, so the
                  // hover grow still works.
                  translate: '-50% -50%',
                }}
                onClick={() => handleHotspotClick(key)}
                disabled={submitted}
              >
                {hs.label}
                {hasRed && <span style={{ marginLeft: 4 }}>🔴</span>}
                {hasBlack && <span style={{ marginLeft: 4 }}>⚫</span>}
              </button>
            );
          })}
        </div>

        {/* === Probe picker === */}
        {!submitted && (
          <div className="mm-toolbar">
            <span style={{ fontSize: 12, color: '#666', marginRight: 4 }}>当前放置：</span>
            <button
              type="button"
              className={`mm-pick-probe-btn red ${activeProbe === 'red' ? 'active' : ''}`}
              onClick={() => setActiveProbe('red')}
            >
              🔴 红表笔
            </button>
            <button
              type="button"
              className={`mm-pick-probe-btn black ${activeProbe === 'black' ? 'active' : ''}`}
              onClick={() => setActiveProbe('black')}
            >
              ⚫ 黑表笔
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleClearProbes}
              style={{ marginLeft: 4 }}
            >
              ↺ 重放
            </button>
          </div>
        )}

        {/* === Multimeter itself === */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Multimeter
            dialPosition={dialPos}
            redProbeIn={redPort}
            blackProbeIn={blackPort}
            displayValue={displayValue}
            onChange={handleMultimeterChange}
            disabled={submitted}
            warnPort={warnPort}
            compact
            availablePositions={dialCandidates}
          />
        </div>

        {/* === Hint / feedback === */}
        {hint && !submitted && (
          <div className="mm-feedback warn">💡 {hint}</div>
        )}
        {warnPort && !submitted && (
          <div className="mm-feedback warn">
            ⚠️ 危险！红表笔在电流孔，旋钮却在电压档 — 这样会短路烧表！
          </div>
        )}

        {submitted && (
          <div className={`mm-feedback ${resultCorrect ? 'success' : 'warn'}`}>
            {resultCorrect
              ? `✅ ${node.success_msg || '测量正确！'}`
              : `❌ ${node.fail_msg || '设置不正确，再练一遍吧。'}`}
          </div>
        )}

        {/* === Actions === */}
        {!submitted && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-primary btn-block"
              onClick={handleConfirm}
            >
              ✅ 确认测量
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleGiveUp}
              style={{ flexShrink: 0 }}
            >
              跳过
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// === Reading simulation model (for wrong-setup feedback) ===
// Full-scale capacity of each dial, in base units (Ω / V / A / F).
const DIAL_CAPACITY = {
  // ohm (Ω)
  OHM_200: 200, OHM_2K: 2000, OHM_20K: 20000, OHM_200K: 200000, OHM_2M: 2e6, OHM_20M: 2e7,
  // dcv (V)
  DCV_200M: 0.2, DCV_2: 2, DCV_20: 20, DCV_200: 200, DCV_1000: 1000,
  // acv (V)
  ACV_2: 2, ACV_20: 20, ACV_200: 200, ACV_750: 750,
  // dca (A)
  DCA_200U: 2e-4, DCA_2M: 2e-3, DCA_20M: 0.02, DCA_200M: 0.2, A200M: 0.2, A20: 20,
  // cap (F)
  CAP_200N: 2e-7, CAP_2U: 2e-6, CAP_20U: 2e-5, CAP_200U: 2e-4,
};

const DIAL_CATEGORY = {
  OHM_200: 'ohm', OHM_2K: 'ohm', OHM_20K: 'ohm', OHM_200K: 'ohm', OHM_2M: 'ohm', OHM_20M: 'ohm',
  DCV_200M: 'dcv', DCV_2: 'dcv', DCV_20: 'dcv', DCV_200: 'dcv', DCV_1000: 'dcv',
  ACV_2: 'acv', ACV_20: 'acv', ACV_200: 'acv', ACV_750: 'acv',
  DCA_200U: 'dca', DCA_2M: 'dca', DCA_20M: 'dca', DCA_200M: 'dca', A200M: 'dca', A20: 'dca',
  CAP_200N: 'cap', CAP_2U: 'cap', CAP_20U: 'cap', CAP_200U: 'cap',
  DIODE: 'diode',
};

// Nominal value of each challenge target, in base units.
const TARGET_VALUE = {
  socket_220v: 220, wall_outlet_220v: 220, breaker_output: 220,
  battery_9v: 9,
  battery_aa_1v5: 1.5, old_battery_1v5: 1.5,
  car_battery_12v: 12,
  unknown_dc_terminal: 24,
  led_circuit: 0.0198, buzzer_circuit: 0.078, dc_motor_circuit: 1.05,
  resistor_1k: 1000,
  unknown_resistor: 853000,
  capacitor_100uf: 1e-4,
  power_cord_test: 0,
  extension_cord_wire: Infinity, // broken — overloads (reads OL) on every range
};

// Returns a simulated display string for a wrong setup, or null when the
// reading should be "OL" (wrong measuring function, or value beyond range cap).
function simulateReading(selectedDial, correctDial, targetType, correctDisplay) {
  if (!selectedDial) return null;
  const value = TARGET_VALUE[targetType];
  if (value === undefined) return null;
  const catSel = DIAL_CATEGORY[selectedDial];
  const catOk = DIAL_CATEGORY[correctDial];
  if (!catSel || !catOk || catSel !== catOk) return null; // wrong function
  const cap = DIAL_CAPACITY[selectedDial];
  if (cap === undefined) return null;
  if (value > cap) return null; // real overload → OL
  // Same function and the range can display the value: valid (coarser) reading.
  return correctDisplay || '---';
}

// === Helpers ===
function portName(id) {
  switch (id) {
    case '20A': return '20A 孔';
    case 'mA': return 'mA 孔';
    case 'COM': return 'COM 孔';
    case 'VOhm': return 'V/Ω 孔';
    default: return id || '未插';
  }
}

function dialHint(dialId, targetType) {
  if (!dialId) return '';
  if (dialId.startsWith('DCV')) return '测电池或直流要选 DCV (V---) 档';
  if (dialId.startsWith('ACV')) return '测交流电（如插座）要选 ACV (V~) 档';
  if (dialId.startsWith('OHM')) return '测电阻要选 Ω 档，且电路必须断电';
  if (dialId === 'DIODE') return '测通断要选蜂鸣档（带 🔊 符号）';
  if (dialId.startsWith('DCA') || dialId === 'A20' || dialId === 'A200M')
    return '测直流电流要选 A--- 档';
  if (dialId === 'ACA') return '测交流电流要选 A~ 档';
  return '请仔细看旋钮上的档位';
}

function targetLabel(type) {
  switch (type) {
    case 'battery_15v': return '🔋 1.5V 干电池';
    case 'battery_9v': return '🔋 9V 方块电池';
    case 'battery_12v': return '🔋 12V 汽车电瓶';
    case 'socket_220v': return '🔌 220V 家用插座';
    case 'resistor_1k': return '📏 1kΩ 电阻';
    case 'wire_continuity': return '〰️ 待测导线（通断）';
    case 'diode': return '➤| 二极管';
    default: return '待测元件';
  }
}

function targetEmoji(type) {
  switch (type) {
    case 'battery_15v':
    case 'battery_9v':
    case 'battery_12v': return '🔋';
    case 'socket_220v': return '🔌';
    case 'resistor_1k': return '🟫';
    case 'wire_continuity': return '〰️';
    case 'diode': return '➤|';
    default: return '🧰';
  }
}
