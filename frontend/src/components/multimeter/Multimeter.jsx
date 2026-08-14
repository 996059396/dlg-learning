import { useMemo } from 'react';
import MultimeterDial, { DEFAULT_DIAL_POSITIONS } from './MultimeterDial';
import MultimeterPorts from './MultimeterPorts';
import MultimeterDisplay from './MultimeterDisplay';
import './multimeter.css';

/**
 * Composite Multimeter component.
 * State can be either controlled (pass dialPosition/redProbeIn/blackProbeIn)
 * or uncontrolled (use onChange callback).
 */
export default function Multimeter({
  dialPosition = 'OFF',
  redProbeIn = 'VOhm',
  blackProbeIn = 'COM',
  displayValue = '0.000',
  displayUnit,
  displayMode,
  onChange,
  disabled = false,
  compact = false,
  warnPort = null,
  availablePositions,
}) {
  // Derive display defaults from dial position if not explicitly given
  const derived = useMemo(() => {
    const pos = DEFAULT_DIAL_POSITIONS.find(p => p.id === dialPosition)
      || { category: 'off', label: '' };

    let unit = '';
    let mode = null;
    switch (pos.category) {
      case 'dcv': unit = pos.id === 'DCV_200M' ? 'mV' : 'V'; mode = 'DC'; break;
      case 'acv': unit = 'V'; mode = 'AC'; break;
      case 'dca':
        if (pos.id === 'A20') unit = 'A';
        else if (pos.id === 'A200M' || pos.id === 'DCA_200M') unit = 'mA';
        else if (pos.id === 'DCA_2M' || pos.id === 'DCA_20M') unit = 'mA';
        else if (pos.id === 'DCA_200U') unit = 'μA';
        else unit = 'A';
        mode = 'DC';
        break;
      case 'aca': unit = 'A'; mode = 'AC'; break;
      case 'ohm':
        if (pos.id.includes('K') || pos.id.includes('k')) unit = 'kΩ';
        else if (pos.id.includes('M')) unit = 'MΩ';
        else unit = 'Ω';
        break;
      case 'cap':
        if (pos.id.includes('N') || pos.id.includes('n')) unit = 'nF';
        else unit = 'μF';
        break;
      case 'freq': unit = 'Hz'; break;
      case 'temp': unit = '℃'; break;
      case 'diode': unit = 'V'; break;
      default: unit = '';
    }
    return { unit, mode };
  }, [dialPosition]);

  const finalUnit = displayUnit ?? derived.unit;
  const finalMode = displayMode ?? derived.mode;

  const handleDialChange = (newPos) => {
    if (onChange) {
      onChange({ dialPosition: newPos, redProbeIn, blackProbeIn });
    }
  };

  const handleProbeChange = (color, port) => {
    if (onChange) {
      onChange({
        dialPosition,
        redProbeIn: color === 'red' ? port : redProbeIn,
        blackProbeIn: color === 'black' ? port : blackProbeIn,
      });
    }
  };

  return (
    <div className={`mm-body ${compact ? 'compact' : ''} ${disabled ? 'disabled' : ''}`}>
      <div className="mm-panel">
        <div className="mm-brand">
          SENIT <small>DT9205Pro</small>
        </div>

        <MultimeterDisplay
          value={displayValue}
          unit={finalUnit}
          mode={finalMode}
          compact={compact}
          auto={true}
        />

        <div className="mm-buttons">
          <button type="button" className="mm-btn" tabIndex={-1}>HOLD</button>
          <button type="button" className="mm-btn" tabIndex={-1}>RANGE</button>
          <button type="button" className="mm-btn" tabIndex={-1}>Hz/DUTY</button>
        </div>

        <MultimeterDial
          dialPosition={dialPosition}
          onPositionChange={handleDialChange}
          availablePositions={availablePositions}
          disabled={disabled}
          compact={compact}
        />
      </div>

      <MultimeterPorts
        redProbeIn={redProbeIn}
        blackProbeIn={blackProbeIn}
        onProbeChange={handleProbeChange}
        disabled={disabled}
        warnPort={warnPort}
      />
    </div>
  );
}
