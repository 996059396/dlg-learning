import { useMemo } from 'react';
import './multimeter.css';

/**
 * Full list of dial positions on the SENIT DT9205Pro / 9205P.
 * Angles measured clockwise from 12 o'clock (top = 0°).
 * Categories drive the color tinting.
 */
export const DEFAULT_DIAL_POSITIONS = [
  { id: 'OFF',       label: 'OFF',     angle: 0,   category: 'off' },
  { id: 'hFE',       label: 'hFE',     angle: 15,  category: 'special' },
  { id: 'NCV',       label: 'NCV',     angle: 25,  category: 'special' },

  { id: 'OHM_200',   label: '200',     angle: 38,  category: 'ohm' },
  { id: 'OHM_2K',    label: '2k',      angle: 48,  category: 'ohm' },
  { id: 'OHM_20K',   label: '20k',     angle: 58,  category: 'ohm' },
  { id: 'OHM_200K',  label: '200k',    angle: 68,  category: 'ohm' },
  { id: 'OHM_2M',    label: '2M',      angle: 78,  category: 'ohm' },
  { id: 'OHM_20M',   label: '20M',     angle: 88,  category: 'ohm' },

  { id: 'DIODE',     label: '➤|⊣🔊',  angle: 100, category: 'diode' },

  { id: 'TEMP',      label: '℃',       angle: 120, category: 'temp' },

  { id: 'CAP_200N',  label: '200n',    angle: 140, category: 'cap' },
  { id: 'CAP_2U',    label: '2μ',      angle: 150, category: 'cap' },
  { id: 'CAP_20U',   label: '20μ',     angle: 160, category: 'cap' },
  { id: 'CAP_200U',  label: '200μ',    angle: 170, category: 'cap' },

  { id: 'FREQ',      label: 'Hz',      angle: 180, category: 'freq' },

  { id: 'A20',       label: '20A',     angle: 195, category: 'dca' },
  { id: 'A200M',     label: '200mA',   angle: 205, category: 'dca' },

  { id: 'DCA_200U',  label: '200μ',    angle: 215, category: 'dca' },
  { id: 'DCA_2M',    label: '2m',      angle: 222, category: 'dca' },
  { id: 'DCA_20M',   label: '20m',     angle: 229, category: 'dca' },
  { id: 'DCA_200M',  label: '200m',    angle: 236, category: 'dca' },

  { id: 'ACA',       label: 'A~',      angle: 248, category: 'aca' },

  { id: 'DCV_200M',  label: '200m',    angle: 262, category: 'dcv' },
  { id: 'DCV_2',     label: '2',       angle: 272, category: 'dcv' },
  { id: 'DCV_20',    label: '20',      angle: 282, category: 'dcv' },
  { id: 'DCV_200',   label: '200',     angle: 292, category: 'dcv' },
  { id: 'DCV_1000',  label: '1000',    angle: 302, category: 'dcv' },

  { id: 'ACV_2',     label: '2~',      angle: 318, category: 'acv' },
  { id: 'ACV_20',    label: '20~',     angle: 328, category: 'acv' },
  { id: 'ACV_200',   label: '200~',    angle: 338, category: 'acv' },
  { id: 'ACV_750',   label: '750~',    angle: 348, category: 'acv' },
];

export default function MultimeterDial({
  dialPosition = 'OFF',
  onPositionChange,
  availablePositions,
  disabled = false,
  compact = false,
}) {
  const positions = availablePositions && availablePositions.length > 0
    ? availablePositions
    : DEFAULT_DIAL_POSITIONS;

  const current = useMemo(
    () => positions.find(p => p.id === dialPosition) || positions[0],
    [positions, dialPosition]
  );

  // Radius for the label ring (% of dial wrap)
  const labelR = 44;
  const center = 50;

  const handleSelect = (pos) => {
    if (disabled) return;
    if (onPositionChange) onPositionChange(pos.id);
  };

  return (
    <div className="mm-dial-wrap">
      <div className="mm-dial-ring" />

      {/* Knob — rotated to current angle */}
      <div
        className="mm-dial-knob"
        style={{ transform: `translate(-50%, -50%) rotate(${current.angle}deg)` }}
      >
        <div className="mm-dial-pointer" />
        <div className="mm-dial-cap" />
      </div>

      {/* Labels around the dial */}
      {positions.map(pos => {
        const rad = (pos.angle - 90) * (Math.PI / 180);
        const x = center + Math.cos(rad) * labelR;
        const y = center + Math.sin(rad) * labelR;
        const isActive = pos.id === current.id;
        return (
          <button
            key={pos.id}
            type="button"
            className={`mm-dial-label cat-${pos.category} ${isActive ? 'active' : ''}`}
            style={{ left: `${x}%`, top: `${y}%` }}
            onClick={() => handleSelect(pos)}
            disabled={disabled}
            title={pos.id}
          >
            {pos.label}
          </button>
        );
      })}
    </div>
  );
}
