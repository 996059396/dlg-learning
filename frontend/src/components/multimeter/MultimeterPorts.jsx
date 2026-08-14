import './multimeter.css';

/**
 * Multimeter front-panel ports (input jacks).
 * Real DT9205Pro layout (left → right):
 *   1. 20A    — large unfused current input (red)
 *   2. mA     — small fused current input (red)
 *   3. COM    — common, always black
 *   4. VΩHz℃  — non-current measurements (red)
 */
export const PORTS = [
  { id: '20A',  topLabel: '20A MAX\n10s UNFUSED', botLabel: '20A',     color: 'red' },
  { id: 'mA',   topLabel: '200mA MAX\nFUSED',     botLabel: 'mA',      color: 'red' },
  { id: 'COM',  topLabel: 'COM',                  botLabel: 'COM',     color: 'black' },
  { id: 'VOhm', topLabel: 'V Ω Hz ℃',             botLabel: 'VΩ',      color: 'red' },
];

export default function MultimeterPorts({
  redProbeIn = 'VOhm',
  blackProbeIn = 'COM',
  onProbeChange,
  disabled = false,
  warnPort = null, // optional id to highlight as warning
}) {
  const handleClick = (port) => {
    if (disabled) return;
    if (port.color === 'red' && onProbeChange) {
      onProbeChange('red', port.id);
    }
    // Black probe is fixed at COM — no swap
  };

  return (
    <div className="mm-ports">
      {PORTS.map(port => {
        const hasRed = redProbeIn === port.id;
        const hasBlack = blackProbeIn === port.id;
        const isWarn = warnPort === port.id;
        return (
          <div
            key={port.id}
            className="mm-port"
            onClick={() => handleClick(port)}
          >
            <div className="mm-port-label-top" style={{ whiteSpace: 'pre-line' }}>
              {port.topLabel}
            </div>
            <div className={`mm-port-socket ${port.color} ${isWarn ? 'danger-warn' : ''}`}>
              {hasRed && <span className="mm-port-probe red" />}
              {hasBlack && <span className="mm-port-probe black" />}
              {isWarn && <span className="mm-port-warn">⚠️</span>}
            </div>
            <div className="mm-port-label-bot">{port.botLabel}</div>
          </div>
        );
      })}
    </div>
  );
}
