import './multimeter.css';

export default function MultimeterDisplay({
  value = '0.000',
  unit = '',
  mode = null,       // 'AC' | 'DC' | null
  lowBattery = false,
  hold = false,
  auto = true,
  compact = false,
}) {
  return (
    <div className={`mm-display ${compact ? 'compact' : ''}`}>
      <div className="mm-display-top">
        <span className={`mm-display-tag ${auto ? 'on' : ''}`}>AUTO</span>
        <span className={`mm-display-tag ${mode === 'DC' ? 'on' : ''}`}>DC</span>
        <span className={`mm-display-tag ${mode === 'AC' ? 'on' : ''}`}>AC</span>
        <span className={`mm-display-tag ${hold ? 'on' : ''}`}>HOLD</span>
        <span className={`mm-display-tag ${lowBattery ? 'on' : ''}`}>🔋</span>
      </div>
      <div className="mm-display-main">
        <div className="mm-display-value">{String(value)}</div>
        <div className="mm-display-unit">{unit}</div>
      </div>
    </div>
  );
}
