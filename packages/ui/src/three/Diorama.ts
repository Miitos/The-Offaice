import * as THREE from 'three';
import type { OfficeState, Room } from '../api';
import { colorFor } from '../components/Sprite';
import { drawRows, frames, look3d, palette, shade } from './sprites';

/**
 * HD-2D office: an isometric 3D diorama with pixel-art billboard sprites, lit by
 * lamps and moonlight, with depth of field, bloom and color grading done in a
 * small post-processing chain. Driven by OfficeState through `sync()`.
 *
 * three is pinned to 0.150 on purpose: legacy lighting and color handling are
 * still the defaults there, and every intensity below was tuned for them.
 */

type V2 = [number, number];
interface Seat {
  p: V2;
  chain: V2[];
  kind: 'sit' | 'stand' | 'sleep';
  room: Room;
  desk?: number;
  y?: number;
  who: string | null;
}
type FrameKey = 'idle0' | 'idle1' | 'walk0' | 'walk1';
interface Actor {
  name: string;
  deskIndex: number;
  texs: Record<FrameKey, THREE.CanvasTexture>;
  m: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  lm: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  sh: THREE.Mesh;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  tag: HTMLElement;
  bub: HTMLElement;
  pos: THREE.Vector3;
  path: THREE.Vector3[];
  seat: Seat | null;
  room: Room;
  dest: Room;
  anim: number;
  facing: number;
  bubbleUntil: number;
  typer: number;
  lastBubbleAt: number | null;
  activeUntil: number;
  key: string;
}

const lin = (hex: string) => new THREE.Color(hex).convertSRGBToLinear();
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOMS: Record<Room, { label: string; c: V2; hub: V2 }> = {
  desk: { label: 'Bureau', c: [-4.5, -3.5], hub: [-4.5, -3.5] },
  meeting: { label: 'Salle de réunion', c: [4.5, -3.5], hub: [4.5, -2.4] },
  break: { label: 'Salle de pause', c: [-4.5, 3.5], hub: [-3.6, 2.2] },
  rest: { label: 'Salle de repos', c: [4.5, 3.5], hub: [3.2, 2.4] }
};
const DOORS: { a: Room; b: Room; pa: V2; pb: V2 }[] = [
  { a: 'desk', b: 'meeting', pa: [-0.7, -3.5], pb: [0.7, -3.5] },
  { a: 'break', b: 'rest', pa: [-0.7, 3.5], pb: [0.7, 3.5] },
  { a: 'desk', b: 'break', pa: [-4.5, -0.7], pb: [-4.5, 0.7] },
  { a: 'meeting', b: 'rest', pa: [4.5, -0.7], pb: [4.5, 0.7] }
];
const ADJ: Record<Room, Room[]> = { desk: ['meeting', 'break'], meeting: ['desk', 'rest'], break: ['desk', 'rest'], rest: ['meeting', 'break'] };
// 4 × 2 desks: one per agent (7 today) plus a spare. The aisle to each chair runs between two desks.
const DESKS: V2[] = [[-7.8, -5.3], [-5.7, -5.3], [-3.6, -5.3], [-1.5, -5.3], [-7.8, -1.5], [-5.7, -1.5], [-3.6, -1.5], [-1.5, -1.5]];
const ROOMTAG: Record<Room, [number, number, number]> = { desk: [-4.5, 3.75, -7], meeting: [4.5, 3.75, -7], break: [-9, 3.75, 3.5], rest: [6.6, 1.95, 0] };
const COLS = ['BACKLOG', 'TODO', 'TO_DESIGN', 'IN_PROGRESS', 'IN_REVIEW', 'IN_TEST', 'DONE', 'BLOCKED'];
const COLC = ['#8b8fa8', '#6fa8dc', '#b48ad8', '#f0b35a', '#e07f6a', '#5fc3b8', '#7fd38b', '#d65a5a'];
const AZ0 = Math.PI / 4;

function makeSeats(): Record<Room, Seat[]> {
  const S = (room: Room, p: V2, chain: V2[], kind: Seat['kind'], extra: Partial<Seat> = {}): Seat => ({ p, chain, kind, room, who: null, ...extra });
  return {
    desk: DESKS.map((d, i) => {
      const z = d[1] - 0.72, side = d[0] + 1.05;
      return S('desk', [d[0], z], [[side, z], [side, -3.5]], 'sit', { desk: i });
    }),
    meeting: [
      S('meeting', [3.3, -5.85], [[2.0, -5.85], [2.0, -2.6]], 'sit'),
      S('meeting', [4.5, -5.85], [[2.0, -5.85], [2.0, -2.6]], 'sit'),
      S('meeting', [5.7, -5.85], [[7.0, -5.85], [7.0, -2.6]], 'sit'),
      S('meeting', [2.1, -4.6], [[2.1, -2.6]], 'sit'),
      S('meeting', [6.9, -4.6], [[6.9, -2.6]], 'sit'),
      S('meeting', [4.5, -3.35], [], 'stand'),
      S('meeting', [3.4, -2.9], [], 'stand'),
      S('meeting', [5.6, -2.9], [], 'stand')
    ],
    break: [
      S('break', [-7.4, 1.35], [], 'stand'),
      S('break', [-5.6, 3.35], [], 'sit'),
      S('break', [-4.5, 4.3], [], 'sit'),
      S('break', [-8.1, 3.5], [[-7.4, 3.0]], 'sit'),
      S('break', [-8.1, 4.5], [[-7.4, 4.5], [-7.4, 3.0]], 'sit'),
      S('break', [-6.65, 4.3], [[-6.65, 3.0]], 'sit'),
      S('break', [-3.0, 5.6], [], 'stand')
    ],
    rest: [
      S('rest', [6.6, 1.6], [[5.1, 1.6]], 'sleep', { y: 0.48 }),
      S('rest', [6.6, 3.6], [[5.1, 3.6]], 'sleep', { y: 0.48 }),
      S('rest', [6.6, 5.6], [[5.1, 5.6]], 'sleep', { y: 0.48 }),
      S('rest', [1.6, 5.4], [], 'sleep', { y: 0.34 }),
      S('rest', [3.0, 5.95], [], 'sleep', { y: 0.34 }),
      S('rest', [4.3, 5.2], [], 'sleep', { y: 0.34 }),
      S('rest', [4.4, 4.0], [], 'sleep', { y: 0.34 })
    ]
  };
}

/** ?capture in the URL (README recordings): no film grain, so the GIFs stay small. */
const CAPTURE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('capture');

const VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }';

export class Diorama {
  onSelect: ((name: string | null) => void) | null = null;

  private host: HTMLElement;
  private overlay: HTMLElement;
  private reduce: boolean;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(24, 1, 1, 220);
  private R = rng(7);
  private disposed = false;
  private raf = 0;
  private ro: ResizeObserver;
  private cleanups: (() => void)[] = [];

  private actors = new Map<string, Actor>();
  private seats = makeSeats();
  private pickables: THREE.Object3D[] = [];
  private billboards: THREE.Object3D[] = [];
  private screens: { mat: THREE.MeshStandardMaterial; t: THREE.Texture; on: number }[] = [];
  private lights: { l: THREE.PointLight; k: number; flick: number; ph: number }[] = [];
  private beams: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private breakDoors: { m: THREE.Mesh; open: number; shut: number; axis: 'x' | 'z' }[] = [];
  private signs: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[] = [];
  private fx: { s: THREE.Sprite; vel: THREE.Vector3; life: number; max: number; size: number; grow: number }[] = [];
  private roomTags = {} as Record<Room, { el: HTMLElement; p: THREE.Vector3 }>;
  private T: Record<string, THREE.CanvasTexture> = {};
  private board!: { tex: THREE.CanvasTexture; g: CanvasRenderingContext2D };
  private dust!: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private dustBase!: Float32Array;
  private bokeh!: THREE.Points;

  private locked = false;
  private selected: string | null = null;
  private synced = false;
  private lastPostId = 0;
  private lastRetroMsgId = 0;
  private lastCardEventId = 0;
  private boardKey = '';

  private home0 = new THREE.Vector3(0, 0.5, 0.6);
  private view = { az: AZ0 + 0.35, el: 1.05, zoom: 1.7, target: new THREE.Vector3(0, 0.5, 0.6) };
  private goal = { az: AZ0, el: 0.62, zoom: 1, target: new THREE.Vector3(0, 0.5, 0.6) };
  private VW = 1;
  private VH = 1;
  private RT: null | { scene: THREE.WebGLRenderTarget; hA: THREE.WebGLRenderTarget; hB: THREE.WebGLRenderTarget; qA: THREE.WebGLRenderTarget; qB: THREE.WebGLRenderTarget; qC: THREE.WebGLRenderTarget } = null;
  private rtSize = { hw: 1, hh: 1, qw: 1, qh: 1 };
  private canFloat: boolean;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private blurMat: THREE.ShaderMaterial;
  private brightMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private steamT = 0;
  private zT = 0;
  private t0 = performance.now();
  private last = performance.now();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(host: HTMLElement, overlay: HTMLElement, opts: { reducedMotion: boolean }) {
    this.host = host;
    this.overlay = overlay;
    this.reduce = opts.reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'diorama-canvas';
    host.appendChild(this.renderer.domElement);
    this.canFloat = this.renderer.capabilities.isWebGL2 && !!this.renderer.extensions.get('EXT_color_buffer_float');
    if (this.reduce) Object.assign(this.view, { az: this.goal.az, el: this.goal.el, zoom: this.goal.zoom });

    const BG = lin('#0b0f25');
    this.scene.background = BG;
    this.scene.fog = new THREE.Fog(BG, 55, 120);

    this.makeTextures();
    this.buildRoom();
    this.buildFurniture();
    this.buildLights();
    this.buildParticles();
    this.buildRoomTags();

    // post-processing
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } },
      vertexShader: VS,
      depthTest: false,
      depthWrite: false,
      fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 dir; varying vec2 vUv;
      void main(){ vec4 c = texture2D(tDiffuse, vUv) * .2270270270;
        c += texture2D(tDiffuse, vUv + dir * 1.3846153846) * .3162162162; c += texture2D(tDiffuse, vUv - dir * 1.3846153846) * .3162162162;
        c += texture2D(tDiffuse, vUv + dir * 3.2307692308) * .0702702703; c += texture2D(tDiffuse, vUv - dir * 3.2307692308) * .0702702703;
        gl_FragColor = c; }`
    });
    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, threshold: { value: 0.82 } },
      vertexShader: VS,
      depthTest: false,
      depthWrite: false,
      fragmentShader: `uniform sampler2D tDiffuse; uniform float threshold; varying vec2 vUv;
      void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; float l = max(c.r, max(c.g, c.b)); float k = max(l - threshold, 0.) / max(l, 1e-4); gl_FragColor = vec4(c * k, 1.); }`
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tDepth: { value: null }, tHalf: { value: null }, tQuarter: { value: null }, tBloom: { value: null },
        uNear: { value: this.cam.near }, uFar: { value: this.cam.far }, uFocus: { value: 40 }, uRange: { value: 10 }, uTilt: { value: 0.55 },
        uTime: { value: 0 }, uGrain: { value: CAPTURE ? 0 : 0.028 }, uFade: { value: 0 }, uBloom: { value: 1.0 }, uExposure: { value: 1.12 }, uRes: { value: new THREE.Vector2() }
      },
      vertexShader: VS,
      depthTest: false,
      depthWrite: false,
      fragmentShader: `uniform sampler2D tScene, tDepth, tHalf, tQuarter, tBloom;
      uniform float uNear, uFar, uFocus, uRange, uTilt, uTime, uGrain, uFade, uBloom, uExposure; uniform vec2 uRes; varying vec2 vUv;
      float linz(float d){ float z = d * 2. - 1.; return 2. * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
      vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        float z = linz(texture2D(tDepth, vUv).x);
        float coc = clamp(abs(z - uFocus) / uRange, 0., 1.);
        coc = max(coc, smoothstep(.2, .52, abs(vUv.y - .52)) * uTilt);
        vec2 d = vUv - .5; float ab = dot(d, d) * .012;
        vec3 sharp = vec3(texture2D(tScene, vUv + d * ab).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv - d * ab).b);
        vec3 b1 = texture2D(tHalf, vUv).rgb, b2 = texture2D(tQuarter, vUv).rgb;
        vec3 bl = mix(b1, b2, smoothstep(.45, 1., coc));
        vec3 c = mix(sharp, bl, smoothstep(.05, .5, coc));
        c += texture2D(tBloom, vUv).rgb * uBloom;
        c = aces(c * uExposure);
        c = pow(c, vec3(1. / 2.2));
        float l = dot(c, vec3(.299, .587, .114));
        c = mix(c, c * vec3(.84, .97, 1.14), (1. - l) * .4);
        c = mix(c, c * vec3(1.08, 1.0, .88), l * .32);
        c = mix(vec3(l), c, 1.1);
        float vg = smoothstep(.95, .28, length(d * vec2(1., .9)) * 1.2);
        c *= mix(.45, 1., vg);
        c += (hash(vUv * uRes + fract(uTime)) - .5) * uGrain;
        gl_FragColor = vec4(c * uFade, 1.);
      }`
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compMat);
    this.quadScene.add(this.quad);

    this.bindInput();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ───────────── public API

  sync(state: OfficeState) {
    const now = Date.now();
    const names = new Set(state.agents.map((a) => a.name));
    for (const [name, a] of this.actors) if (!names.has(name)) this.removeActor(a);
    state.agents.forEach((ag, i) => {
      let a = this.actors.get(ag.name);
      const first = !a;
      if (!a) a = this.addActor(ag.name, i);
      const label = ag.persona?.firstName ?? ag.name;
      const card = ag.currentCard && ag.room !== 'rest' ? ` <em>#${ag.currentCard.id}</em>` : '';
      const html = `<i></i>${esc(label)} <em>${esc(ag.role)}</em>${card}`;
      if (a.tag.dataset.html !== html) {
        a.tag.innerHTML = html;
        a.tag.dataset.html = html;
        const b = a.bub.querySelector('b');
        if (b) b.textContent = label;
      }
      if (first || !this.synced) this.place(a, ag.room);
      else if (ag.room !== a.dest) this.goTo(a, ag.room);
      // speech bubble on a new action
      if (ag.bubble && ag.bubbleAt && ag.bubbleAt !== a.lastBubbleAt) {
        // Only new actions get a bubble: on first load the old ones would all pile up.
        if (this.synced && now - ag.bubbleAt < 120_000 && ag.room !== 'rest') this.say(a, ag.bubble, 7000, '');
        a.lastBubbleAt = ag.bubbleAt;
      }
      a.activeUntil = ag.bubbleAt ? ag.bubbleAt + 90_000 : 0;
    });

    // break-room conversation and retro discussion
    const posts = [...state.breakRoom.posts].sort((x, y) => x.id - y.id);
    for (const p of posts) {
      if (p.id <= this.lastPostId) continue;
      const a = this.actors.get(p.agent);
      if (a && this.synced) this.say(a, p.body, 9000, 'break');
    }
    this.lastPostId = Math.max(this.lastPostId, ...posts.map((p) => p.id), 0);
    const msgs = state.retro.current?.messages ?? [];
    for (const m of msgs) {
      if (m.id <= this.lastRetroMsgId) continue;
      const a = this.actors.get(m.agent);
      if (a && this.synced) this.say(a, m.body, 9000, 'retro');
    }
    this.lastRetroMsgId = Math.max(this.lastRetroMsgId, ...msgs.map((m) => m.id), 0);

    // a card reaching DONE: sparkles above whoever moved it
    for (const e of state.recentCardEvents) {
      if (e.id <= this.lastCardEventId) continue;
      if (this.synced && e.kind === 'moved' && e.to_col === 'DONE') {
        const a = this.actors.get(e.actor);
        if (a) this.celebrate(a.pos);
      }
    }
    this.lastCardEventId = Math.max(this.lastCardEventId, ...state.recentCardEvents.map((e) => e.id), 0);

    if (state.breakRoom.locked !== this.locked || !this.synced) this.setLocked(state.breakRoom.locked);
    this.drawBoard(state);
    this.synced = true;
    this.roomCounts();
  }

  select(name: string | null) {
    this.selected = name && this.actors.has(name) ? name : null;
    for (const a of this.actors.values()) a.tag.classList.toggle('sel', a.name === this.selected);
    if (this.selected) this.goal.zoom = this.VW < 760 ? 0.62 : 0.5;
    else this.home(false);
  }

  focusRoom(room: Room) {
    this.selected = null;
    for (const a of this.actors.values()) a.tag.classList.remove('sel');
    this.onSelect?.(null);
    const r = ROOMS[room];
    this.goal.target.set(r.c[0], 0.6, r.c[1]);
    this.goal.zoom = this.VW < 760 ? 0.7 : 0.58;
  }

  home(resetAngle = true) {
    this.goal.target.copy(this.home0);
    this.goal.zoom = 1;
    if (resetAngle) {
      this.goal.az = AZ0;
      this.goal.el = 0.62;
    }
  }

  zoomBy(f: number) {
    this.goal.zoom = Math.max(0.35, Math.min(1.4, this.goal.zoom * f));
  }

  rotateBy(d: number) {
    this.goal.az = clampAz(this.goal.az + d);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.cleanups.forEach((f) => f());
    for (const a of this.actors.values()) window.clearInterval(a.typer);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    Object.values(this.T).forEach((t) => t.dispose());
    if (this.RT) Object.values(this.RT).forEach((r) => r.dispose());
    [this.blurMat, this.brightMat, this.compMat].forEach((m) => m.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.replaceChildren();
  }

  // ───────────── construction

  private tex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, { rep = [1, 1] as V2, nearestMin = false } = {}) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    draw(g, w, h);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = nearestMin ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep[0], rep[1]);
    t.anisotropy = 8;
    return t;
  }

  private makeTextures() {
    const R = this.R;
    const pick = <T,>(a: T[]) => a[Math.floor(R() * a.length)]!;
    const px = (g: CanvasRenderingContext2D, x: number, y: number, c: string, w = 1, h = 1) => {
      g.fillStyle = c;
      g.fillRect(x, y, w, h);
    };
    const T = this.T;
    T.wood = this.tex(64, 64, (g) => {
      px(g, 0, 0, '#4c3324', 64, 64);
      for (let y = 0; y < 64; y += 8) {
        const off = ((y / 8) % 2) * 16;
        for (let x = -32; x < 64; x += 32) {
          px(g, x + off, y, pick(['#6b4831', '#74513a', '#61422e', '#7c5940', '#6f4c35']), 31, 7);
          for (let i = 0; i < 5; i++) px(g, x + off + Math.floor(R() * 30), y + 1 + Math.floor(R() * 5), 'rgba(40,24,14,.35)', 3, 1);
          px(g, x + off + 2, y + 3, '#3e2a1d');
        }
        px(g, 0, y + 7, '#36231a', 64, 1);
      }
    }, { rep: [4.5, 3.5] });
    T.carpet = this.tex(16, 16, (g) => {
      px(g, 0, 0, '#2a4855', 16, 16);
      for (let i = 0; i < 8; i++) {
        px(g, 8 + i - 4, 4 + Math.abs(i - 4), '#34606e');
        px(g, 8 + i - 4, 12 - Math.abs(i - 4), '#34606e');
      }
      px(g, 8, 8, '#cfa95f');
      px(g, 0, 0, '#cfa95f');
    }, { rep: [9, 7] });
    T.tiles = this.tex(16, 16, (g) => {
      px(g, 0, 0, '#3c5d53', 16, 16);
      px(g, 0, 0, '#d4cdb0', 7, 7);
      px(g, 8, 8, '#d4cdb0', 7, 7);
      px(g, 8, 0, '#5d9a85', 7, 7);
      px(g, 0, 8, '#5d9a85', 7, 7);
      px(g, 1, 1, '#e4dec4', 2, 1);
      px(g, 9, 9, '#e4dec4', 2, 1);
    }, { rep: [7, 5.5] });
    T.night = this.tex(16, 16, (g) => {
      px(g, 0, 0, '#2f2c55', 16, 16);
      for (let i = 0; i < 6; i++) px(g, Math.floor(R() * 16), Math.floor(R() * 16), '#3a3768', 2, 1);
      px(g, 4, 5, '#9a92e0');
      px(g, 12, 11, '#c9c2ff');
      px(g, 11, 3, '#6f68b8');
    }, { rep: [9, 7] });
    T.plaster = this.tex(32, 32, (g) => {
      px(g, 0, 0, '#b4a28a', 32, 32);
      for (let i = 0; i < 90; i++) px(g, Math.floor(R() * 32), Math.floor(R() * 32), pick(['#a99680', '#bfae96', '#ad9b84']));
      px(g, 0, 31, '#9c8a73', 32, 1);
    }, { rep: [9, 1] });
    T.panel = this.tex(16, 16, (g) => {
      px(g, 0, 0, '#4a3122', 16, 16);
      for (let x = 0; x < 16; x += 4) {
        px(g, x, 0, '#3a2519', 1, 16);
        px(g, x + 1, 0, '#57392a', 1, 16);
      }
      px(g, 0, 0, '#5e4030', 16, 2);
    }, { rep: [12, 1] });
    T.stone = this.tex(32, 32, (g) => {
      px(g, 0, 0, '#241f2f', 32, 32);
      for (let y = 0; y < 32; y += 8) {
        const off = ((y / 8) % 2) * 6;
        for (let x = -12; x < 32; x += 12) px(g, x + off, y, pick(['#3a3347', '#342e41', '#403951', '#2f2a3c']), 11, 7);
      }
      px(g, 0, 0, '#3e5a3a', 32, 2);
      for (let x = 0; x < 32; x += 3) px(g, x, 2, '#35503a', 1, 1 + Math.floor(R() * 3));
    }, { rep: [10, 1] });
    T.desk = this.tex(16, 16, (g) => {
      px(g, 0, 0, '#a5774b', 16, 16);
      for (let i = 0; i < 14; i++) px(g, Math.floor(R() * 14), Math.floor(R() * 16), '#93673f', 3, 1);
      px(g, 0, 15, '#7b5434', 16, 1);
    });
    T.window = this.tex(32, 32, (g) => {
      const gr = g.createLinearGradient(0, 0, 0, 32);
      gr.addColorStop(0, '#17244d');
      gr.addColorStop(1, '#4a6db5');
      g.fillStyle = gr;
      g.fillRect(0, 0, 32, 32);
      for (let i = 0; i < 10; i++) px(g, 3 + Math.floor(R() * 26), 3 + Math.floor(R() * 14), '#e8efff');
      px(g, 21, 6, '#fff6d8', 4, 4);
      px(g, 22, 5, '#fff6d8', 2, 1);
      px(g, 22, 10, '#fff6d8', 2, 1);
      px(g, 20, 7, '#fff6d8', 1, 2);
      px(g, 25, 7, '#fff6d8', 1, 2);
      px(g, 0, 26, '#26304a', 32, 6);
      px(g, 3, 23, '#1e2740', 5, 3);
      px(g, 12, 21, '#1e2740', 4, 5);
      px(g, 22, 24, '#1e2740', 7, 2);
      g.fillStyle = '#3b2a20';
      g.fillRect(0, 0, 32, 2);
      g.fillRect(0, 30, 32, 2);
      g.fillRect(0, 0, 2, 32);
      g.fillRect(30, 0, 2, 32);
      g.fillRect(15, 0, 2, 32);
      g.fillRect(0, 15, 32, 2);
    }, { nearestMin: true });
    T.books = this.tex(32, 32, (g) => {
      px(g, 0, 0, '#3d281c', 32, 32);
      for (let s = 0; s < 3; s++) {
        let x = 2;
        const y = 2 + s * 10;
        while (x < 29) {
          const w = 2 + Math.floor(R() * 2), h = 6 + Math.floor(R() * 3);
          px(g, x, y + 8 - h, pick(['#b9473d', '#3f7fb5', '#d8b45a', '#4f9a6c', '#8a5bb0', '#d77a3e', '#e8e0c8']), w, h);
          x += w + (R() < 0.2 ? 2 : 0);
        }
        px(g, 0, y + 8, '#2a1b13', 32, 2);
      }
    }, { nearestMin: true });
    T.code = this.tex(32, 64, (g) => {
      px(g, 0, 0, '#0a1820', 32, 64);
      for (let y = 1; y < 64; y += 3) {
        let x = 2 + Math.floor(R() * 3) * 2;
        const n = 1 + Math.floor(R() * 3);
        for (let i = 0; i < n && x < 30; i++) {
          const w = 3 + Math.floor(R() * 8);
          px(g, x, y, pick(['#5fd3a0', '#7fb7ff', '#f0c36a', '#e07fb0', '#c9d6e8', '#c9d6e8']), Math.min(w, 30 - x), 1);
          x += w + 2;
        }
      }
    }, { rep: [1, 0.34], nearestMin: true });
    T.vend = this.tex(16, 32, (g) => {
      px(g, 0, 0, '#101820', 16, 32);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) px(g, 2 + c * 4, 2 + r * 5, pick(['#ff6b6b', '#6bd4ff', '#ffd36b', '#8dff9b', '#ff9de0']), 3, 3);
      px(g, 2, 23, '#2a3a48', 12, 6);
      px(g, 11, 24, '#ff5252', 2, 1);
    }, { nearestMin: true });
    T.plaid = this.tex(16, 16, (g) => {
      px(g, 0, 0, '#5d4fa3', 16, 16);
      px(g, 0, 6, '#7a6cc4', 16, 3);
      px(g, 6, 0, '#7a6cc4', 3, 16);
      px(g, 7, 0, '#d6b26b', 1, 16);
      px(g, 0, 7, '#d6b26b', 16, 1);
    }, { rep: [2, 1] });
    T.rug = this.tex(16, 16, (g) => {
      px(g, 0, 0, '#8b4436', 16, 16);
      px(g, 1, 1, '#b86a45', 14, 14);
      px(g, 3, 3, '#8b4436', 10, 10);
      px(g, 5, 5, '#e0b36a', 6, 6);
      px(g, 7, 7, '#8b4436', 2, 2);
    }, { nearestMin: true });
    T.starRug = this.tex(32, 32, (g) => {
      px(g, 0, 0, '#1f2350', 32, 32);
      px(g, 1, 1, '#2b3170', 30, 30);
      for (let i = 0; i < 18; i++) px(g, 2 + Math.floor(R() * 28), 2 + Math.floor(R() * 28), pick(['#f7e4ae', '#c9c2ff', '#8fb4ff']));
      px(g, 14, 12, '#f7e4ae', 4, 4);
      px(g, 13, 12, '#2b3170', 1, 2);
    }, { nearestMin: true });
    const radial = (stops: [number, string][]) => (g: CanvasRenderingContext2D, w: number) => {
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      stops.forEach(([o, c]) => gr.addColorStop(o, c));
      g.fillStyle = gr;
      g.fillRect(0, 0, w, w);
    };
    T.soft = this.tex(64, 64, radial([[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,.45)'], [1, 'rgba(255,255,255,0)']]));
    T.soft.magFilter = THREE.LinearFilter;
    T.soft.encoding = THREE.LinearEncoding;
    T.blob = this.tex(64, 64, radial([[0, 'rgba(0,0,0,.75)'], [0.6, 'rgba(0,0,0,.35)'], [1, 'rgba(0,0,0,0)']]));
    T.blob.magFilter = THREE.LinearFilter;
    T.beam = this.tex(4, 64, (g) => {
      const gr = g.createLinearGradient(0, 0, 0, 64);
      gr.addColorStop(0, 'rgba(255,255,255,.9)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 4, 64);
    });
    T.beam.magFilter = THREE.LinearFilter;
    T.z = this.tex(8, 8, (g) => {
      const c = '#cfe0ff';
      px(g, 1, 1, c, 6, 1);
      px(g, 5, 2, c);
      px(g, 4, 3, c);
      px(g, 3, 4, c);
      px(g, 2, 5, c);
      px(g, 1, 6, c, 6, 1);
    }, { nearestMin: true });
    T.noise = this.tex(16, 16, (g) => {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const v = 215 + Math.floor(R() * 40);
          px(g, x, y, `rgb(${v},${v},${v})`);
        }
    }, { nearestMin: true });
    T.plant = this.tex(16, 24, (g) => {
      const L = ['#3f8a4a', '#57a85a', '#2f6e3c', '#77c06a'];
      for (let i = 0; i < 46; i++) {
        const a = R() * Math.PI * 2, r = R() * 6.5;
        px(g, Math.round(8 + Math.cos(a) * r * 0.9), Math.round(9 + Math.sin(a) * r * 1.1), pick(L), 2, 2);
      }
      px(g, 4, 17, '#b5603e', 8, 6);
      px(g, 3, 16, '#c9744f', 10, 2);
      px(g, 5, 22, '#8a4530', 6, 1);
    }, { nearestMin: true });
    const bc = document.createElement('canvas');
    bc.width = 192;
    bc.height = 96;
    const bt = new THREE.CanvasTexture(bc);
    bt.encoding = THREE.sRGBEncoding;
    bt.magFilter = THREE.NearestFilter;
    bt.minFilter = THREE.LinearFilter;
    T.board = bt;
    this.board = { tex: bt, g: bc.getContext('2d')! };
  }

  private MAT(o: THREE.MeshStandardMaterialParameters = {}) {
    return new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0, ...o });
  }
  private flat(hex: string) {
    return this.MAT({ color: lin(hex), map: this.T.noise });
  }
  private emissive(hex: string, k = 2) {
    return new THREE.MeshStandardMaterial({ color: 0x000000, emissive: lin(hex), emissiveIntensity: k });
  }
  private mesh<G extends THREE.BufferGeometry, M extends THREE.Material>(geo: G, mat: M, x: number, y: number, z: number, { cast = true, receive = true, parent = this.scene as THREE.Object3D } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = receive;
    parent.add(m);
    return m;
  }
  private box<M extends THREE.Material>(w: number, h: number, d: number, mat: M, x: number, y: number, z: number, o?: { cast?: boolean; receive?: boolean; parent?: THREE.Object3D }) {
    return this.mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z, o);
  }
  private blobShadow(x: number, z: number, s: number) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(s * 1.4, s), new THREE.MeshBasicMaterial({ map: this.T.blob, transparent: true, depthWrite: false, opacity: 0.7 }));
    b.rotation.x = -Math.PI / 2;
    b.position.set(x, 0.012, z);
    this.scene.add(b);
    return b;
  }

  private buildRoom() {
    const T = this.T;
    this.box(19.4, 1.6, 15.4, this.MAT({ map: T.stone }), 0, -0.8, 0, { cast: false });
    this.box(19.8, 0.22, 15.8, this.flat('#2b1d17'), 0, -0.1, 0, { cast: false });
    const under = new THREE.Mesh(new THREE.PlaneGeometry(40, 32), new THREE.MeshBasicMaterial({ map: T.soft, color: lin('#3a3fa0'), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    under.rotation.x = -Math.PI / 2;
    under.position.y = -1.7;
    this.scene.add(under);
    const floors: Record<Room, THREE.Texture> = { desk: T.wood!, meeting: T.carpet!, break: T.tiles!, rest: T.night! };
    (Object.keys(ROOMS) as Room[]).forEach((k) => {
      const r = ROOMS[k];
      const f = this.mesh(new THREE.PlaneGeometry(9, 7), this.MAT({ map: floors[k], roughness: k === 'desk' ? 0.6 : 0.92 }), r.c[0], 0.001, r.c[1], { cast: false });
      f.rotation.x = -Math.PI / 2;
    });
    const plaster = this.MAT({ map: T.plaster }), panel = this.MAT({ map: T.panel }), cap = this.flat('#2e1f17'), rail = this.flat('#6b4a33');
    const tallWall = (len: number, along: 'x' | 'z', fixed: number, from: number) => {
      const mid = from + len / 2;
      const [x, z] = along === 'x' ? [mid, fixed] : [fixed, mid];
      const [w, d] = along === 'x' ? [len, 0.3] : [0.3, len];
      this.box(w, 1.1, d, panel, x, 0.55, z);
      this.box(w, 2.1, d, plaster, x, 2.15, z);
      this.box(w + 0.1, 0.14, d + 0.12, cap, x, 3.27, z);
      this.box(w + 0.04, 0.08, d + 0.06, rail, x, 1.12, z);
    };
    tallWall(18.3, 'x', -7.0, -9.15);
    tallWall(14.0, 'z', -9.0, -7.0);
    const lowWall = (x0: number, z0: number, x1: number, z1: number, h = 1.3) => {
      const len = Math.hypot(x1 - x0, z1 - z0), alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
      const w = alongX ? len : 0.26, d = alongX ? 0.26 : len;
      this.box(w, h, d, panel, (x0 + x1) / 2, h / 2, (z0 + z1) / 2);
      this.box(w + 0.06, 0.1, d + 0.06, cap, (x0 + x1) / 2, h + 0.05, (z0 + z1) / 2);
    };
    lowWall(0, -7, 0, -4.4);
    lowWall(0, -2.6, 0, 2.6);
    lowWall(0, 4.4, 0, 7);
    lowWall(-9, 0, -5.4, 0);
    lowWall(-3.6, 0, 3.6, 0);
    lowWall(5.4, 0, 9, 0);
    lowWall(-9.1, 7, 9.1, 7, 0.35);
    lowWall(9, -7, 9, 7, 0.35);
    const frameMat = this.flat('#5a3b28');
    const doorFrame = (x: number, z: number, alongX: boolean) => {
      const o = 0.95;
      if (alongX) {
        this.box(0.16, 1.95, 0.34, frameMat, x - o, 0.975, z);
        this.box(0.16, 1.95, 0.34, frameMat, x + o, 0.975, z);
        this.box(2.06, 0.16, 0.34, frameMat, x, 1.95, z);
      } else {
        this.box(0.34, 1.95, 0.16, frameMat, x, 0.975, z - o);
        this.box(0.34, 1.95, 0.16, frameMat, x, 0.975, z + o);
        this.box(0.34, 0.16, 2.06, frameMat, x, 1.95, z);
      }
    };
    doorFrame(0, -3.5, false);
    doorFrame(0, 3.5, false);
    doorFrame(-4.5, 0, true);
    doorFrame(4.5, 0, true);
    const doorMat = this.MAT({ map: T.panel, color: lin('#d9b88a') });
    this.breakDoors = [
      { m: this.box(1.8, 1.78, 0.1, doorMat, -6.2, 0.9, 0.2), open: -6.2, shut: -4.5, axis: 'x' },
      { m: this.box(0.1, 1.78, 1.8, doorMat, -0.2, 0.9, 5.2), open: 5.2, shut: 3.5, axis: 'z' }
    ];
    this.signs = [this.box(0.3, 0.12, 0.1, this.emissive('#58ff8a', 3), -4.5, 2.1, 0.2, { cast: false }), this.box(0.1, 0.12, 0.3, this.emissive('#58ff8a', 3), -0.2, 2.1, 3.5, { cast: false })];

    const winMat = this.MAT({ map: T.window, emissiveMap: T.window, emissive: lin('#ffffff'), emissiveIntensity: 1.35 });
    const beamMat = new THREE.MeshBasicMaterial({ map: T.beam, color: lin('#9fb6ff'), transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const windowAt = (x: number, z: number, left: boolean) => {
      const g = new THREE.Group();
      g.position.set(x, 2.15, z);
      if (left) g.rotation.y = Math.PI / 2;
      this.scene.add(g);
      this.mesh(new THREE.PlaneGeometry(1.3, 1.25), winMat, 0, 0, 0.16, { cast: false, parent: g });
      this.mesh(new THREE.BoxGeometry(1.5, 0.1, 0.22), frameMat, 0, -0.68, 0.16, { parent: g });
      const b = new THREE.Group();
      b.position.set(0, -0.2, 0.3);
      g.add(b);
      const bm = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 4.6), beamMat.clone());
      bm.position.set(0, -1.6, 1.6);
      bm.rotation.x = -0.9;
      b.add(bm);
      this.beams.push(bm);
    };
    windowAt(-6.6, -7, false);
    windowAt(-2.4, -7, false);
    windowAt(1.6, -7, false);
    windowAt(7.6, -7, false);
    windowAt(-9, -4.2, true);
    windowAt(-9, 4.6, true);
  }

  private buildFurniture() {
    const T = this.T, R = this.R;
    const pick = <X,>(a: X[]) => a[Math.floor(R() * a.length)]!;
    const chairMat = this.flat('#2f5b66'), metal = this.flat('#2b2d38'), deskMat = this.MAT({ map: T.desk }), white = this.flat('#dcd6c8'), leg = this.flat('#7d5636');
    DESKS.forEach(([x, z], i) => {
      this.box(1.5, 0.08, 0.8, deskMat, x, 0.76, z);
      this.box(1.5, 0.62, 0.05, leg, x, 0.44, z + 0.37);
      this.box(0.06, 0.72, 0.76, leg, x - 0.72, 0.37, z);
      this.box(0.06, 0.72, 0.76, leg, x + 0.72, 0.37, z);
      const g = new THREE.Group();
      g.position.set(x + 0.36, 0.8, z + 0.02);
      g.rotation.y = Math.PI / 4 - 0.25;
      this.scene.add(g);
      this.mesh(new THREE.BoxGeometry(0.06, 0.22, 0.06), metal, 0, 0.11, 0, { parent: g });
      this.mesh(new THREE.BoxGeometry(0.66, 0.42, 0.05), metal, 0, 0.42, 0, { parent: g });
      const t = T.code!.clone();
      t.needsUpdate = true;
      t.offset.y = R();
      const sm = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: lin('#ffffff'), emissiveMap: t, emissiveIntensity: 0.2 });
      this.mesh(new THREE.PlaneGeometry(0.6, 0.36), sm, 0, 0.42, 0.03, { cast: false, parent: g });
      this.screens[i] = { mat: sm, t, on: 0.2 };
      this.box(0.16, 0.12, 0.1, white, x - 0.45, 0.86, z + 0.1);
      if (i % 2 === 0) this.box(0.1, 0.1, 0.1, this.flat(pick(['#c8423b', '#3f7fb5', '#d8b45a'])), x - 0.1, 0.85, z + 0.18);
      this.box(0.5, 0.07, 0.5, chairMat, x, 0.46, z - 0.7);
      this.box(0.5, 0.6, 0.06, chairMat, x, 0.8, z - 0.95);
      this.box(0.06, 0.42, 0.06, metal, x, 0.22, z - 0.7);
    });
    // meeting room
    this.box(3.6, 0.1, 1.3, deskMat, 4.5, 0.74, -4.6);
    ([[2.9, -5.1], [6.1, -5.1], [2.9, -4.1], [6.1, -4.1]] as V2[]).forEach((p) => this.box(0.1, 0.7, 0.1, leg, p[0], 0.35, p[1]));
    ([[3.3, -5.85], [4.5, -5.85], [5.7, -5.85]] as V2[]).forEach((p) => {
      this.box(0.5, 0.07, 0.5, chairMat, p[0], 0.46, p[1]);
      this.box(0.5, 0.6, 0.06, chairMat, p[0], 0.8, p[1] - 0.25);
    });
    this.box(0.5, 0.07, 0.5, chairMat, 2.1, 0.46, -4.6);
    this.box(0.06, 0.6, 0.5, chairMat, 1.85, 0.8, -4.6);
    this.box(0.5, 0.07, 0.5, chairMat, 6.9, 0.46, -4.6);
    this.box(0.06, 0.6, 0.5, chairMat, 7.15, 0.8, -4.6);
    this.box(3.5, 1.75, 0.08, this.flat('#c9ccd3'), 4.5, 1.95, -6.8);
    this.mesh(new THREE.PlaneGeometry(3.3, 1.55), this.MAT({ map: this.board.tex, emissiveMap: this.board.tex, emissive: lin('#ffffff'), emissiveIntensity: 0.32 }), 4.5, 1.95, -6.75, { cast: false });
    this.box(1.4, 0.05, 0.1, metal, 4.5, 1.04, -6.72);
    // break room
    this.box(2.4, 0.9, 0.6, this.flat('#6d4a33'), -7.4, 0.45, 0.55);
    this.box(2.46, 0.06, 0.66, deskMat, -7.4, 0.93, 0.55);
    this.box(0.45, 0.55, 0.4, this.flat('#2c2c34'), -7.9, 1.24, 0.55);
    this.box(0.06, 0.06, 0.02, this.emissive('#ff4d4d', 4), -7.78, 1.36, 0.76, { cast: false });
    this.box(0.12, 0.12, 0.12, white, -7.3, 1.02, 0.6);
    const sofa = this.flat('#7a3d55'), sofaD = this.flat('#6a3149'), cushion = this.flat('#8f4d68');
    this.box(0.9, 0.45, 2.2, sofa, -8.35, 0.25, 4.0);
    this.box(0.3, 0.7, 2.2, sofaD, -8.75, 0.7, 4.0);
    this.box(0.9, 0.6, 0.25, sofaD, -8.35, 0.4, 2.85);
    this.box(0.9, 0.6, 0.25, sofaD, -8.35, 0.4, 5.15);
    this.box(0.7, 0.1, 0.9, cushion, -8.25, 0.52, 3.5);
    this.box(0.7, 0.1, 0.9, cushion, -8.25, 0.52, 4.5);
    this.mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.06, 24), deskMat, -5.6, 0.72, 4.3);
    this.mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 8), metal, -5.6, 0.36, 4.3);
    this.mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 16), metal, -5.6, 0.02, 4.3);
    const stool = this.flat('#d6b26b');
    ([[-5.6, 3.35], [-4.5, 4.3], [-6.65, 4.3]] as V2[]).forEach((p) => this.mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.44, 12), stool, p[0], 0.22, p[1]));
    this.box(0.75, 1.95, 0.8, this.flat('#9a2f3b'), -8.5, 0.98, 6.2);
    this.mesh(new THREE.PlaneGeometry(0.62, 1.25), new THREE.MeshStandardMaterial({ color: 0, emissive: lin('#ffffff'), emissiveMap: T.vend, emissiveIntensity: 1.5 }), -8.11, 1.15, 6.2, { cast: false }).rotation.y = Math.PI / 2;
    this.box(1.6, 1.2, 0.45, this.MAT({ map: T.books }), -2.0, 0.6, 0.45);
    const rug = this.mesh(new THREE.PlaneGeometry(2.6, 2.4), this.MAT({ map: T.rug }), -5.6, 0.006, 4.3, { cast: false });
    rug.rotation.x = -Math.PI / 2;
    // rest room
    const bedFrame = this.flat('#4b3427'), sheet = this.flat('#e6e1d6'), blanket = this.MAT({ map: T.plaid });
    [1.6, 3.6, 5.6].forEach((z) => {
      this.box(2.4, 0.35, 1.0, bedFrame, 6.8, 0.18, z);
      this.box(2.3, 0.14, 0.92, sheet, 6.8, 0.42, z);
      this.box(0.45, 0.14, 0.7, white, 7.75, 0.55, z);
      this.box(1.45, 0.12, 0.96, blanket, 6.2, 0.52, z);
    });
    ([[8.45, 2.6], [8.45, 4.6]] as V2[]).forEach((p) => {
      this.box(0.5, 0.5, 0.5, bedFrame, p[0], 0.25, p[1]);
      this.mesh(new THREE.SphereGeometry(0.13, 12, 10), this.emissive('#b9a8ff', 3), p[0], 0.65, p[1], { cast: false });
    });
    ([[1.6, 5.4, '#c96d4a'], [3.0, 5.95, '#4d8a8f'], [4.3, 5.2, '#c2a14e'], [4.4, 4.0, '#8a5fb0']] as [number, number, string][]).forEach((p) => {
      const b = this.mesh(new THREE.SphereGeometry(0.55, 16, 12), this.flat(p[2]), p[0], 0.28, p[1]);
      b.scale.set(1, 0.55, 1);
    });
    const starRug = this.mesh(new THREE.PlaneGeometry(3.4, 2.8), this.MAT({ map: T.starRug }), 2.8, 0.006, 4.6, { cast: false });
    starRug.rotation.x = -Math.PI / 2;
    // lamps and plants
    const lamp = (x: number, z: number, h = 1.9) => {
      this.mesh(new THREE.CylinderGeometry(0.03, 0.03, h, 6), metal, x, h / 2, z);
      this.mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.04, 16), metal, x, 0.02, z);
      this.mesh(new THREE.CylinderGeometry(0.16, 0.3, 0.32, 16, 1, true), this.MAT({ color: lin('#f1dcb0'), emissive: lin('#ffcf8a'), emissiveIntensity: 1.6, side: THREE.DoubleSide }), x, h, z, { cast: false });
    };
    lamp(8.3, -6.2);
    lamp(-8.5, -0.6);
    lamp(-0.7, 0.8);
    lamp(-8.4, -6.4, 1.7);
    const plantMat = this.MAT({ map: T.plant, alphaTest: 0.5, side: THREE.DoubleSide, emissive: lin('#ffffff'), emissiveMap: T.plant, emissiveIntensity: 0.15 });
    const plant = (x: number, z: number, s = 1) => {
      const geo = new THREE.PlaneGeometry(0.9 * s, 1.35 * s);
      geo.translate(0, 0.675 * s, 0);
      this.billboards.push(this.mesh(geo, plantMat, x, 0, z, { cast: false }));
      this.blobShadow(x, z, 0.7 * s);
    };
    plant(-8.4, -3.6);
    plant(0.8, -6.3, 1.1);
    plant(8.3, -2.6);
    plant(-0.9, 6.2, 1.1);
    plant(8.3, 6.5, 0.9);
    plant(-3.2, -6.4, 0.8);
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight(lin('#7c8fd6'), lin('#2a1c2c'), 0.55));
    const moon = new THREE.DirectionalLight(lin('#a9bcff'), 0.85);
    moon.position.set(-5, 16, -8);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    Object.assign(moon.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 40 });
    moon.shadow.bias = -0.0008;
    moon.shadow.normalBias = 0.02;
    this.scene.add(moon);
    const point = (hex: string, k: number, d: number, x: number, y: number, z: number, flick = 0) => {
      const l = new THREE.PointLight(lin(hex), k, d, 2);
      l.position.set(x, y, z);
      this.scene.add(l);
      this.lights.push({ l, k, flick, ph: this.R() * 9 });
    };
    point('#ffb76e', 2.6, 11, -6.2, 2.7, -3.4, 0.04);
    point('#ffc27f', 2.2, 10, -2.2, 2.6, -3.0, 0.04);
    point('#ffd08a', 2.8, 10, 6.6, 2.5, -4.4, 0.03);
    point('#ff9a5c', 2.6, 10, -5.4, 2.6, 3.6, 0.06);
    point('#62c8ff', 1.4, 4, -7.6, 1.4, 6.2, 0.1);
    point('#8a7dff', 2.0, 9, 5.6, 2.2, 3.6, 0.02);
  }

  private buildParticles() {
    const R = this.R;
    const points = (n: number, fill: (a: Float32Array, i: number) => void, mat: THREE.PointsMaterial) => {
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) fill(pos, i * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const p = new THREE.Points(g, mat);
      this.scene.add(p);
      return p;
    };
    this.dust = points(320, (a, i) => {
      a[i] = (R() - 0.5) * 18;
      a[i + 1] = R() * 3.6;
      a[i + 2] = (R() - 0.5) * 14;
    }, new THREE.PointsMaterial({ size: 0.07, map: this.T.soft, color: lin('#ffe2a8'), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.dustBase = ((this.dust.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array).slice();
    this.bokeh = points(70, (a, i) => {
      const ang = R() * Math.PI * 2, r = 15 + R() * 16;
      a[i] = Math.cos(ang) * r;
      a[i + 1] = -6 + R() * 16;
      a[i + 2] = Math.sin(ang) * r;
    }, new THREE.PointsMaterial({ size: 1.3, map: this.T.soft, color: lin('#8fa3ff'), transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  }

  private buildRoomTags() {
    (Object.keys(ROOMS) as Room[]).forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'o room-tag';
      b.innerHTML = `${ROOMS[k].label}<span></span>`;
      b.addEventListener('click', () => this.focusRoom(k));
      this.overlay.appendChild(b);
      this.roomTags[k] = { el: b, p: new THREE.Vector3(...ROOMTAG[k]) };
    });
  }

  // ───────────── actors

  private addActor(name: string, deskIndex: number): Actor {
    const look = look3d(name);
    const fr = frames(look), pal = palette(look);
    const mk = (rows: string[]) => this.tex(16, 24, (g) => drawRows(g, rows, pal), { nearestMin: true });
    const texs: Record<FrameKey, THREE.CanvasTexture> = { idle0: mk(fr.idle0), idle1: mk(fr.idle1), walk0: mk(fr.walk0), walk1: mk(fr.walk1) };
    const lie = this.tex(24, 16, (g) => {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 24;
      drawRows(c.getContext('2d')!, fr.sleep, pal);
      g.save();
      g.translate(24, 0);
      g.rotate(Math.PI / 2);
      g.drawImage(c, 0, -2);
      g.restore();
    }, { nearestMin: true });
    const W = 1.43, H = 2.15;
    const geo = new THREE.PlaneGeometry(W, H);
    geo.translate(0, H / 2 - (H * 2) / 24, 0);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: texs.idle0, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, emissive: lin('#ffffff'), emissiveMap: texs.idle0, emissiveIntensity: 0.32 }));
    m.userData.agent = name;
    this.scene.add(m);
    const lgeo = new THREE.PlaneGeometry(2.15, 1.43);
    lgeo.translate(0, 0.715 - (1.43 * 3) / 16, 0);
    const lm = new THREE.Mesh(lgeo, new THREE.MeshStandardMaterial({ map: lie, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, emissive: lin('#ffffff'), emissiveMap: lie, emissiveIntensity: 0.3 }));
    lm.visible = false;
    lm.userData.agent = name;
    this.scene.add(lm);
    this.pickables.push(m, lm);
    const sh = this.blobShadow(0, 0, 1);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 32), new THREE.MeshBasicMaterial({ color: lin('#f7e4ae'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
    const tag = document.createElement('div');
    tag.className = 'o agent-tag';
    tag.style.setProperty('--c', colorFor(name));
    const bub = document.createElement('div');
    bub.className = 'o win speech';
    bub.innerHTML = '<b></b><span></span>';
    this.overlay.append(tag, bub);
    const a: Actor = {
      name, deskIndex, texs, m, lm, sh, ring, tag, bub,
      pos: new THREE.Vector3(), path: [], seat: null, room: 'desk', dest: 'desk', anim: this.R() * 5, facing: 1,
      bubbleUntil: 0, typer: 0, lastBubbleAt: null, activeUntil: 0, key: 'idle0'
    };
    this.actors.set(name, a);
    return a;
  }

  private removeActor(a: Actor) {
    for (const o of [a.m, a.lm, a.sh, a.ring] as THREE.Mesh[]) {
      this.scene.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    Object.values(a.texs).forEach((t) => t.dispose());
    this.pickables = this.pickables.filter((p) => p !== a.m && p !== a.lm);
    if (a.seat) a.seat.who = null;
    window.clearInterval(a.typer);
    a.tag.remove();
    a.bub.remove();
    this.actors.delete(a.name);
  }

  private freeSeat(a: Actor, room: Room): Seat {
    if (room === 'desk') return this.seats.desk[a.deskIndex % this.seats.desk.length]!;
    const list = this.seats[room];
    return list.find((s) => !s.who || s.who === a.name) ?? list[a.deskIndex % list.length]!;
  }

  private place(a: Actor, room: Room) {
    if (a.seat && a.seat.who === a.name) a.seat.who = null;
    const s = this.freeSeat(a, room);
    s.who = a.name;
    a.seat = s;
    a.room = a.dest = room;
    a.pos.set(s.p[0], 0, s.p[1]);
    a.path = [];
  }

  private route(from: Room, to: Room): Room[] {
    const prev: Partial<Record<Room, Room | null>> = { [from]: null };
    const q: Room[] = [from];
    while (q.length) {
      const r = q.shift()!;
      if (r === to) break;
      for (const n of ADJ[r]) {
        if (n in prev) continue;
        if (this.locked && n === 'break' && to !== 'break') continue;
        prev[n] = r;
        q.push(n);
      }
    }
    if (!(to in prev)) return [from, to];
    const out: Room[] = [];
    for (let r: Room | null | undefined = to; r; r = prev[r]) out.unshift(r);
    return out;
  }

  private door(a: Room, b: Room): [V2, V2] {
    for (const d of DOORS) {
      if (d.a === a && d.b === b) return [d.pa, d.pb];
      if (d.a === b && d.b === a) return [d.pb, d.pa];
    }
    return [ROOMS[a].hub, ROOMS[b].hub];
  }

  private goTo(a: Actor, room: Room) {
    const target = this.freeSeat(a, room);
    const pts: V2[] = [];
    if (a.path.length) {
      // already walking: head back to the hub of the room it was going to
    } else if (a.seat) a.seat.chain.forEach((c) => pts.push(c));
    if (a.seat && a.seat.who === a.name) a.seat.who = null;
    const from = a.dest;
    pts.push(ROOMS[from].hub);
    const rs = this.route(from, room);
    for (let i = 0; i < rs.length - 1; i++) {
      const [p1, p2] = this.door(rs[i]!, rs[i + 1]!);
      pts.push(p1, p2, ROOMS[rs[i + 1]!].hub);
    }
    [...target.chain].reverse().forEach((c) => pts.push(c));
    pts.push(target.p);
    target.who = a.name;
    a.seat = target;
    a.dest = room;
    a.path = pts.map((p) => new THREE.Vector3(p[0], 0, p[1]));
  }

  private say(a: Actor, text: string, ms: number, kind: '' | 'break' | 'retro') {
    const sp = a.bub.querySelector('span')!;
    // At most two bubbles at once: the one closest to ending makes room for the new one.
    const now = performance.now();
    const open = [...this.actors.values()].filter((x) => x !== a && x.bubbleUntil > now).sort((x, y) => x.bubbleUntil - y.bubbleUntil);
    for (const x of open.slice(0, Math.max(0, open.length - 1))) {
      x.bub.classList.remove('on');
      x.bubbleUntil = 0;
    }
    a.bub.className = `o win speech on ${kind}`;
    a.bubbleUntil = now + ms;
    window.clearInterval(a.typer);
    const t = text.length > 200 ? text.slice(0, 198) + '…' : text;
    if (this.reduce) {
      sp.textContent = t;
      return;
    }
    let i = 0;
    sp.textContent = '';
    const step = Math.max(1, Math.ceil(t.length / 60));
    a.typer = window.setInterval(() => {
      i += step;
      sp.textContent = t.slice(0, i);
      if (i >= t.length) window.clearInterval(a.typer);
    }, 22);
  }

  private celebrate(p: THREE.Vector3) {
    const R = this.R;
    const cols = ['#f7e4ae', '#ffd36b', '#ffffff', '#83d58f'];
    for (let i = 0; i < 26; i++) this.spriteFx(this.T.soft!, cols[i % 4]!, new THREE.Vector3(p.x, 1.4, p.z), new THREE.Vector3((R() - 0.5) * 2.4, 1.6 + R() * 1.6, (R() - 0.5) * 2.4), 1.3 + R() * 0.5, 0.22, 0);
  }

  private spriteFx(texture: THREE.Texture, color: string, pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number, grow: number) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: lin(color), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    s.position.copy(pos);
    s.scale.setScalar(size);
    this.scene.add(s);
    this.fx.push({ s, vel, life, max: life, size, grow });
  }

  private setLocked(locked: boolean) {
    this.locked = locked;
    this.signs.forEach((s) => s.material.emissive.copy(lin(locked ? '#ff4a4a' : '#58ff8a')));
  }

  private drawBoard(state: OfficeState) {
    const key = state.board.map((c) => c.column + ':' + c.cards.map((k) => k.id + (k.assignee ?? '')).join(',')).join('|');
    if (key === this.boardKey) return;
    this.boardKey = key;
    const g = this.board.g;
    const px = (x: number, y: number, c: string, w = 1, h = 1) => {
      g.fillStyle = c;
      g.fillRect(x, y, w, h);
    };
    px(0, 0, '#eef1f3', 192, 96);
    COLS.forEach((col, i) => {
      const x = 2 + i * 23.5;
      px(Math.round(x), 4, COLC[i]!, 21, 4);
      if (i < COLS.length - 1) px(Math.round(x + 22.5), 10, '#d5dae0', 1, 82);
      const cards = state.board.find((b) => b.column === col)?.cards ?? [];
      cards.slice(-7).forEach((k, j) => {
        const y = 12 + j * 11;
        const c = k.assignee ? colorFor(k.assignee) : '#cfc9b8';
        px(Math.round(x) + 1, y, c, 19, 9);
        px(Math.round(x) + 1, y, shade(c, 0.75), 19, 2);
        px(Math.round(x) + 3, y + 4, 'rgba(0,0,0,.35)', 11, 1);
        px(Math.round(x) + 3, y + 6, 'rgba(0,0,0,.25)', 7, 1);
      });
      if (cards.length > 7) px(Math.round(x) + 8, 90, '#8b8fa8', 5, 2);
    });
    this.board.tex.needsUpdate = true;
  }

  private roomCounts() {
    (Object.keys(ROOMS) as Room[]).forEach((k) => {
      let n = 0;
      for (const a of this.actors.values()) if (a.dest === k) n++;
      const sp = this.roomTags[k].el.querySelector('span')!;
      sp.textContent = k === 'break' && this.locked ? 'FERMÉE' : n ? `${n} AGENT${n > 1 ? 'S' : ''}` : 'VIDE';
      this.roomTags[k].el.classList.toggle('locked', k === 'break' && this.locked);
    });
  }

  // ───────────── input, resize, render

  private bindInput() {
    const cv = this.renderer.domElement;
    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
    let drag: null | { x: number; y: number; moved: number } = null;
    let hovT = 0;
    const pickAt = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(mouse, this.cam);
      const h = ray.intersectObjects(this.pickables.filter((m) => m.visible), false);
      return h.length ? (h[0]!.object.userData.agent as string) : null;
    };
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
      cv.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        drag.x = e.clientX;
        drag.y = e.clientY;
        if (drag.moved > 4) {
          cv.classList.add('drag');
          this.goal.az = clampAz(this.goal.az - dx * 0.005);
          this.goal.el = Math.max(0.38, Math.min(1.05, this.goal.el + dy * 0.004));
        }
      } else {
        const n = performance.now();
        if (n - hovT < 60) return;
        hovT = n;
        cv.classList.toggle('hot', !!pickAt(e));
      }
    };
    const up = (e: PointerEvent) => {
      cv.classList.remove('drag');
      if (drag && drag.moved <= 4) {
        const id = pickAt(e);
        if (id) {
          this.select(id);
          this.onSelect?.(id);
        }
      }
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.zoomBy(Math.exp(e.deltaY * 0.001));
    };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('wheel', wheel, { passive: false });
    this.cleanups.push(() => {
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('wheel', wheel);
    });
  }

  private makeRT(w: number, h: number, depth = false) {
    const rt = new THREE.WebGLRenderTarget(w, h, { type: this.canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: depth, stencilBuffer: false });
    if (depth) {
      rt.depthTexture = new THREE.DepthTexture(w, h);
      rt.depthTexture.type = THREE.UnsignedIntType;
    }
    return rt;
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    this.VW = Math.max(1, Math.round(r.width));
    this.VH = Math.max(1, Math.round(r.height));
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.VW, this.VH);
    this.cam.aspect = this.VW / this.VH;
    this.cam.updateProjectionMatrix();
    const w = Math.floor(this.VW * pr), h = Math.floor(this.VH * pr);
    if (this.RT) Object.values(this.RT).forEach((x) => x.dispose());
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1), qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.RT = { scene: this.makeRT(w, h, true), hA: this.makeRT(hw, hh), hB: this.makeRT(hw, hh), qA: this.makeRT(qw, qh), qB: this.makeRT(qw, qh), qC: this.makeRT(qw, qh) };
    this.rtSize = { hw, hh, qw, qh };
    (this.compMat.uniforms.uRes!.value as THREE.Vector2).set(w, h);
  }

  private fitDist() {
    const a = this.cam.aspect, reqW = a < 1 ? 15 : 28;
    const vh = Math.max(19.5, reqW / a);
    return vh / (2 * Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2)));
  }

  private pass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  private postRender() {
    const RT = this.RT!, s = this.rtSize, bu = this.blurMat.uniforms, u = this.compMat.uniforms;
    this.renderer.setRenderTarget(RT.scene);
    this.renderer.render(this.scene, this.cam);
    const blur = (src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget, dx: number, dy: number) => {
      bu.tDiffuse!.value = src.texture;
      (bu.dir!.value as THREE.Vector2).set(dx, dy);
      this.pass(this.blurMat, dst);
    };
    blur(RT.scene, RT.hA, 1 / s.hw, 0);
    blur(RT.hA, RT.hB, 0, 1 / s.hh);
    blur(RT.hB, RT.qA, 1.6 / s.qw, 0);
    blur(RT.qA, RT.qB, 0, 1.6 / s.qh);
    this.brightMat.uniforms.tDiffuse!.value = RT.qB.texture;
    this.pass(this.brightMat, RT.qA);
    blur(RT.qA, RT.qC, 2.4 / s.qw, 0);
    blur(RT.qC, RT.qA, 0, 2.4 / s.qh);
    u.tScene!.value = RT.scene.texture;
    u.tDepth!.value = RT.scene.depthTexture;
    u.tHalf!.value = RT.hB.texture;
    u.tQuarter!.value = RT.qB.texture;
    u.tBloom!.value = RT.qA.texture;
    this.pass(this.compMat, null);
  }

  private project(p: THREE.Vector3) {
    this.tmp.copy(p).project(this.cam);
    return { x: (this.tmp.x * 0.5 + 0.5) * this.VW, y: (-this.tmp.y * 0.5 + 0.5) * this.VH, ok: this.tmp.z < 1 && this.tmp.z > -1 };
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.t0) / 1000;
    const wall = Date.now();
    const { view, goal, cam } = this;
    const lerpK = (k: number) => 1 - Math.exp(-dt * k);

    if (this.selected) {
      const a = this.actors.get(this.selected);
      if (a) goal.target.set(a.pos.x, 0.7, a.pos.z);
    }
    const k = lerpK(this.reduce ? 20 : 3.2);
    view.az += (goal.az - view.az) * k;
    view.el += (goal.el - view.el) * k;
    view.zoom += (goal.zoom - view.zoom) * k;
    view.target.lerp(goal.target, k);
    const dist = this.fitDist() * view.zoom;
    cam.position.set(view.target.x + Math.sin(view.az) * Math.cos(view.el) * dist, view.target.y + Math.sin(view.el) * dist, view.target.z + Math.cos(view.az) * Math.cos(view.el) * dist);
    cam.lookAt(view.target);
    cam.updateMatrixWorld();
    this.tmp2.copy(view.target).applyMatrix4(cam.matrixWorldInverse);
    const u = this.compMat.uniforms;
    u.uFocus!.value = -this.tmp2.z;
    u.uRange!.value = 7 + 9 * Math.min(1, view.zoom);
    u.uTilt!.value = view.zoom < 0.8 ? 0.75 : 0.5;
    u.uTime!.value = t;
    u.uFade!.value = Math.min(1, (u.uFade!.value as number) + dt * (this.reduce ? 10 : 0.7));

    const cr = new THREE.Vector3(Math.cos(view.az), 0, -Math.sin(view.az));
    let countsDirty = false;
    for (const a of this.actors.values()) {
      a.anim += dt;
      if (a.path.length) {
        const nx = a.path[0]!;
        this.tmp.subVectors(nx, a.pos);
        const len = this.tmp.length(), step = 2.3 * dt;
        if (len <= step) {
          a.pos.copy(nx);
          a.path.shift();
          if (!a.path.length) {
            a.room = a.dest;
            countsDirty = true;
          }
        } else {
          this.tmp.multiplyScalar(step / len);
          a.pos.add(this.tmp);
          const sx = this.tmp.dot(cr);
          if (Math.abs(sx) > 1e-4) a.facing = sx > 0 ? 1 : -1;
        }
      }
      const walking = a.path.length > 0, kind = a.seat?.kind ?? 'stand';
      const sleeping = !walking && kind === 'sleep', sitting = !walking && kind === 'sit';
      const active = wall < a.activeUntil;
      a.m.visible = !sleeping;
      a.lm.visible = sleeping;
      let key: FrameKey = 'idle0';
      if (walking) key = Math.floor(a.anim * 7) % 2 ? 'walk1' : 'walk0';
      else if (sitting && a.room === 'desk' && active) key = Math.floor(a.anim * 3.2) % 2 ? 'idle1' : 'idle0';
      else key = Math.floor(a.anim * 1.4) % 2 ? 'idle1' : 'idle0';
      if (a.key !== key) {
        a.key = key;
        a.m.material.map = a.texs[key];
        a.m.material.emissiveMap = a.texs[key];
      }
      const bob = walking ? Math.abs(Math.sin(a.anim * 11)) * 0.05 : 0;
      a.m.position.set(a.pos.x, (sitting ? -0.16 : 0) + bob, a.pos.z);
      a.m.rotation.y = view.az;
      a.m.scale.x = a.facing;
      const sy = a.seat?.y ?? 0.45;
      if (sleeping) {
        a.lm.position.set(a.pos.x, sy, a.pos.z);
        a.lm.rotation.y = view.az;
      }
      a.sh.position.set(a.pos.x, 0.013, a.pos.z);
      a.sh.visible = !sleeping;
      const sel = this.selected === a.name;
      a.ring.position.set(a.pos.x, 0.02, a.pos.z);
      a.ring.material.opacity = sel ? 0.55 + Math.sin(t * 4) * 0.25 : 0;
      a.ring.scale.setScalar(sel ? 1 + Math.sin(t * 4) * 0.06 : 1);
      if (a.seat?.desk !== undefined && a.seat.who === a.name) {
        const sc = this.screens[a.seat.desk]!;
        const at = a.room === 'desk' && !walking;
        const target = at ? (active ? 2.4 : 1.1) : 0.18;
        sc.on += (target - sc.on) * lerpK(3);
        sc.mat.emissiveIntensity = sc.on;
        if (at && active) sc.t.offset.y += dt * 0.05;
      }
      this.tmp2.set(a.pos.x, sleeping ? sy + 1.1 : (sitting ? 1.86 : 2.06) + bob, a.pos.z);
      const p = this.project(this.tmp2);
      const tr = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
      a.tag.style.transform = tr;
      a.tag.style.visibility = p.ok ? 'visible' : 'hidden';
      a.bub.style.transform = tr;
      if (a.bubbleUntil && now > a.bubbleUntil) {
        a.bub.classList.remove('on');
        a.bubbleUntil = 0;
      }
      if (sleeping && (this.zT += dt) > 0.5) {
        this.zT = 0;
        this.spriteFx(this.T.z!, '#cfe0ff', new THREE.Vector3(a.pos.x + 0.4, sy + 0.8, a.pos.z), new THREE.Vector3(0.15, 0.45, 0), 2.2, 0.22, 0.5);
      }
    }
    if (countsDirty) this.roomCounts();
    for (const k2 of Object.keys(this.roomTags) as Room[]) {
      const p = this.project(this.roomTags[k2].p);
      this.roomTags[k2].el.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
    }
    for (const b of this.billboards) b.rotation.y = view.az;
    for (const d of this.breakDoors) {
      const target = this.locked ? d.shut : d.open;
      d.m.position[d.axis] += (target - d.m.position[d.axis]) * lerpK(5);
    }
    for (const L of this.lights) L.l.intensity = L.k * (1 + Math.sin(t * 7 + L.ph) * L.flick + Math.sin(t * 13.7 + L.ph * 2) * L.flick * 0.5);
    this.beams.forEach((b, i) => (b.material.opacity = 0.13 + Math.sin(t * 0.6 + i) * 0.03));
    if (!this.reduce) {
      const arr = (this.dust.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array, base = this.dustBase;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] = base[i]! + Math.sin(t * 0.3 + i) * 0.35;
        arr[i + 1] = (base[i + 1]! + t * 0.06 + Math.sin(t * 0.5 + i * 0.7) * 0.1) % 3.6;
        arr[i + 2] = base[i + 2]! + Math.cos(t * 0.25 + i) * 0.35;
      }
      this.dust.geometry.attributes.position!.needsUpdate = true;
      this.bokeh.rotation.y = t * 0.01;
    }
    if ((this.steamT += dt) > 0.28) {
      this.steamT = 0;
      this.spriteFx(this.T.soft!, '#ffffff', new THREE.Vector3(-7.9 + (this.R() - 0.5) * 0.1, 1.55, 0.62), new THREE.Vector3((this.R() - 0.5) * 0.08, 0.35, 0), 2.2, 0.16, 0.35);
    }
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i]!;
      f.life -= dt;
      if (f.life <= 0) {
        this.scene.remove(f.s);
        f.s.material.dispose();
        this.fx.splice(i, 1);
        continue;
      }
      f.s.position.addScaledVector(f.vel, dt);
      if (f.vel.y > 0.6) f.vel.y -= dt * 3;
      const r = f.life / f.max;
      f.s.material.opacity = Math.min(1, r * 1.6) * 0.8;
      f.s.scale.setScalar(f.size * (1 + (1 - r) * f.grow * 4));
    }
    this.postRender();
  };
}

const clampAz = (v: number) => Math.max(AZ0 - 0.6, Math.min(AZ0 + 0.6, v));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
