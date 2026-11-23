import type { CSSProperties } from 'react';

export interface Look {
  shirt: string;
  hair: string;
  skin: string;
}

const LOOKS: Record<string, Look> = {
  lead: { shirt: '#f2b45a', hair: '#3b2a1e', skin: '#f1c27d' },
  archi: { shirt: '#c9a8ff', hair: '#1f1a2b', skin: '#e0ac69' },
  dev1: { shirt: '#5cc8b8', hair: '#6b3d1f', skin: '#ffdbac' },
  dev2: { shirt: '#8fc3ff', hair: '#2a2a33', skin: '#c68642' },
  reviewer: { shirt: '#8fd9a8', hair: '#c08a3e', skin: '#f1c27d' },
  tester: { shirt: '#ff9ecf', hair: '#7a2e2e', skin: '#8d5524' },
  designer: { shirt: '#ffb38a', hair: '#5a2d6e', skin: '#e8b98a' }
};
const FALLBACK = ['#f2c46b', '#ff9d9d', '#9ad0ff', '#b8e986'];

export function lookFor(name: string): Look {
  if (LOOKS[name]) return LOOKS[name]!;
  const h = [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  return { shirt: FALLBACK[h % FALLBACK.length]!, hair: '#2a2a33', skin: '#f1c27d' };
}

export function colorFor(name: string) {
  return lookFor(name).shirt;
}

export type SpriteState = 'idle' | 'walking' | 'typing' | 'talking' | 'sleeping';

/** 12×16 pixel character. `state` drives the CSS animations (legs, arms, mouth, eyes). */
export function Sprite({ name, state = 'idle', scale = 3, style }: { name: string; state?: SpriteState; scale?: number; style?: CSSProperties }) {
  const { shirt, hair, skin } = lookFor(name);
  const pants = '#2f3442';
  const shoe = '#15171d';
  const dark = '#141418';
  return (
    <svg
      className={`sprite ${state}`}
      width={12 * scale}
      height={16 * scale}
      viewBox="0 0 12 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      style={{ overflow: 'visible', ...style }}
    >
      {/* hair */}
      <rect x="2" y="0" width="8" height="2" fill={hair} />
      <rect x="1" y="1" width="1" height="3" fill={hair} />
      <rect x="10" y="1" width="1" height="3" fill={hair} />
      {/* face */}
      <rect x="2" y="2" width="8" height="5" fill={skin} />
      <rect x="2" y="2" width="8" height="1" fill={hair} opacity="0.55" />
      <g className="eyes-open">
        <rect x="4" y="4" width="1" height="1" fill={dark} />
        <rect x="7" y="4" width="1" height="1" fill={dark} />
      </g>
      <g className="eyes-closed">
        <rect x="3.5" y="4.5" width="2" height="0.6" fill={dark} />
        <rect x="6.5" y="4.5" width="2" height="0.6" fill={dark} />
      </g>
      <rect className="mouth" x="5" y="5.8" width="2" height="0.6" fill="#8a4b3a" style={{ transformOrigin: '6px 6px', transformBox: 'fill-box' }} />
      {/* body */}
      <rect x="2" y="7" width="8" height="5" fill={shirt} />
      <rect x="5" y="7" width="2" height="1" fill="#ffffff" opacity="0.35" />
      <rect x="2" y="11" width="8" height="1" fill="#000000" opacity="0.18" />
      {/* arms */}
      <g className="arm-l">
        <rect x="0.5" y="7.5" width="1.5" height="3.5" fill={shirt} />
        <rect x="0.5" y="11" width="1.5" height="1" fill={skin} />
      </g>
      <g className="arm-r">
        <rect x="10" y="7.5" width="1.5" height="3.5" fill={shirt} />
        <rect x="10" y="11" width="1.5" height="1" fill={skin} />
      </g>
      {/* legs, two walking frames */}
      <g className="legs-a">
        <rect x="3" y="12" width="2" height="3" fill={pants} />
        <rect x="7" y="12" width="2" height="3" fill={pants} />
        <rect x="3" y="15" width="2.5" height="1" fill={shoe} />
        <rect x="7" y="15" width="2.5" height="1" fill={shoe} />
      </g>
      <g className="legs-b">
        <rect x="3" y="12" width="2" height="2" fill={pants} />
        <rect x="7" y="12" width="2" height="3" fill={pants} />
        <rect x="2.5" y="14" width="2.5" height="1" fill={shoe} />
        <rect x="7.5" y="15" width="2.5" height="1" fill={shoe} />
      </g>
    </svg>
  );
}
