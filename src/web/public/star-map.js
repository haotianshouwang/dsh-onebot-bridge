// 长期记忆星图：Canvas 2D 伪 3D 渲染。
//
// 这里不引入 Three.js/WebGL 依赖：当前节点规模（后台最多 120 个）用 2D Canvas
// 做透视投影、景深、粒子、动态连线已经足够，且更容易在低性能设备和严格 CSP 下稳定运行。
// 每个视觉属性都有数据含义：大小=重要度，颜色=范围，亮度=最近更新，连线=共享标签/向量相似度。
const PALETTE = {
  global: '#e8b878',
  user: '#8fb8c9',
  group: '#94c9a6',
  text: '#f2ede3',
  muted: '#a49d90',
  line: 'rgba(242,237,227,0.16)',
  warm: 'rgba(232,184,120,0.12)'
};

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(value) {
  return (hashText(value) % 10000) / 10000;
}

export function createStarMap({canvas, tooltip, panel, nodes = [], edges = [], onSelect, onClosePanel}) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('星图缺少 canvas');
  const ctx = canvas.getContext('2d');
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = {
    yaw: 0.35, pitch: 0.18, zoom: 1, targetZoom: 1,
    paused: reducedMotion, dragging: false, moved: false, lastX: 0, lastY: 0,
    selected: null, hover: null, scope: '', query: '',
    width: 0, height: 0, dpr: 1, raf: 0, start: performance.now(), lastPaint: 0,
    disposed: false, stars: [], layout: new Map()
  };
  const listeners = [];
  const pristine = nodes.map(node => ({...node}));

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  }

  function buildLayout() {
    state.layout.clear();
    const byScope = {global: [], user: [], group: []};
    for (const node of nodes) (byScope[node.scope] || byScope.user).push(node);
    const rings = {global: 0.38, user: 0.66, group: 0.92};
    for (const [scope, group] of Object.entries(byScope)) {
      group.forEach((node, index) => {
        const seedA = seeded(node.id + ':a');
        const seedB = seeded(node.id + ':b');
        const seedC = seeded(node.id + ':c');
        const angle = (index / Math.max(1, group.length)) * Math.PI * 2 + seedA * 0.7;
        const radius = rings[scope] * (0.72 + seedB * 0.34);
        state.layout.set(node.id, {
          x: Math.cos(angle) * radius * 420,
          y: (seedC - 0.5) * 360 + Math.sin(angle) * 50,
          z: Math.sin(angle) * radius * 420,
          phase: seedA * Math.PI * 2
        });
      });
    }
    state.stars = Array.from({length: 260}, (_, index) => ({
      x: seeded('star-x-' + index) * 2 - 1,
      y: seeded('star-y-' + index) * 2 - 1,
      z: seeded('star-z-' + index),
      size: 0.4 + seeded('star-s-' + index) * 1.5,
      phase: seeded('star-p-' + index) * Math.PI * 2
    }));
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    state.width = Math.max(320, Math.round(rect.width));
    state.height = Math.max(360, Math.round(rect.height || 480));
    canvas.width = Math.round(state.width * state.dpr);
    canvas.height = Math.round(state.height * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }

  function project(point, time) {
    const cosY = Math.cos(state.yaw), sinY = Math.sin(state.yaw);
    const cosP = Math.cos(state.pitch), sinP = Math.sin(state.pitch);
    const floatY = state.paused ? 0 : Math.sin(time / 4200 + point.phase) * 7;
    const x1 = point.x * cosY - point.z * sinY;
    const z1 = point.x * sinY + point.z * cosY;
    const y1 = point.y * cosP - z1 * sinP + floatY;
    const z2 = point.y * sinP + z1 * cosP;
    const distance = 1100;
    const scale = (state.zoom * distance) / Math.max(220, distance + z2);
    return {x: state.width / 2 + x1 * scale, y: state.height / 2 + y1 * scale, depth: z2, scale};
  }

  function visible(node) {
    if (state.scope && node.scope !== state.scope) return false;
    if (!state.query) return true;
    const text = state.query.toLowerCase();
    return String(node.label || '').toLowerCase().includes(text) || (node.tags || []).some(tag => String(tag).toLowerCase().includes(text));
  }

  function drawBackground(time) {
    const gradient = ctx.createRadialGradient(state.width * 0.5, state.height * 0.38, 20, state.width * 0.5, state.height * 0.48, Math.max(state.width, state.height) * 0.72);
    gradient.addColorStop(0, '#141419');
    gradient.addColorStop(0.55, '#0b0b0f');
    gradient.addColorStop(1, '#050507');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, state.width, state.height);
    for (const star of state.stars) {
      const twinkle = state.paused ? 0.55 : 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(time / 1700 + star.phase));
      const x = (star.x * 0.5 + 0.5) * state.width;
      const y = (star.y * 0.5 + 0.5) * state.height;
      ctx.globalAlpha = (0.18 + star.z * 0.5) * twinkle;
      ctx.fillStyle = star.z > 0.7 ? '#e8b878' : '#f2ede3';
      ctx.beginPath();
      ctx.arc(x, y, star.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawEdges(time) {
    const linked = new Set();
    if (state.selected) for (const edge of edges) {
      if (edge.source === state.selected || edge.target === state.selected) linked.add(edge.source === state.selected ? edge.target : edge.source);
    }
    for (const edge of edges) {
      const a = nodes.find(node => node.id === edge.source);
      const b = nodes.find(node => node.id === edge.target);
      if (!a || !b || !visible(a) || !visible(b)) continue;
      const pa = state.layout.get(a.id), pb = state.layout.get(b.id);
      if (!pa || !pb) continue;
      const p1 = project(pa, time), p2 = project(pb, time);
      const related = !state.selected || edge.source === state.selected || edge.target === state.selected;
      const alpha = (related ? 0.7 : 0.12) * Math.max(0.15, 1 - (p1.depth + p2.depth + 900) / 2400);
      ctx.strokeStyle = edge.kind === 'similarity' ? `rgba(143,184,201,${alpha})` : `rgba(232,184,120,${alpha})`;
      ctx.lineWidth = 0.6 + Math.min(1.8, (edge.weight || 0.5) * 1.6);
      ctx.setLineDash(edge.kind === 'similarity' ? [3, 5] : []);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      if (!state.paused && related && edge.weight > 0.7) {
        const t = ((time / 5200) + seeded(edge.source + edge.target)) % 1;
        const x = p1.x + (p2.x - p1.x) * t;
        const y = p1.y + (p2.y - p1.y) * t;
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(232,184,120,0.8)';
        ctx.beginPath();
        ctx.arc(x, y, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.setLineDash([]);
  }

  function drawNodes(time) {
    const now = Date.now();
    const related = new Set(state.selected ? [state.selected] : []);
    if (state.selected) for (const edge of edges) {
      if (edge.source === state.selected) related.add(edge.target);
      if (edge.target === state.selected) related.add(edge.source);
    }
    const ordered = nodes.filter(visible).slice().sort((a, b) => (state.layout.get(a.id)?.z || 0) - (state.layout.get(b.id)?.z || 0));
    for (const node of ordered) {
      const point = state.layout.get(node.id);
      if (!point) continue;
      const p = project(point, time);
      if (p.x < -80 || p.x > state.width + 80 || p.y < -80 || p.y > state.height + 80) continue;
      const importance = Math.max(1, Math.min(5, Number(node.importance) || 3));
      const radius = (3.2 + importance * 1.7) * Math.max(0.55, Math.min(1.8, p.scale));
      const isSelected = state.selected === node.id;
      const isHover = state.hover === node.id;
      const linked = !state.selected || related.has(node.id);
      const freshness = node.updatedAt ? Math.max(0.35, Math.min(1, 1 - (now - new Date(node.updatedAt).getTime()) / (90 * 86400000))) : 0.6;
      const color = PALETTE[node.scope] || PALETTE.user;
      ctx.globalAlpha = linked ? 0.55 + freshness * 0.45 : 0.16;
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * (isSelected ? 6 : 3.2));
      glow.addColorStop(0, color + (isSelected ? '88' : '44'));
      glow.addColorStop(1, color + '00');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * (isSelected ? 6 : 3.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = isSelected || isHover ? '#f8f3ea' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();
      if (state.query && !isSelected) {
        ctx.strokeStyle = 'rgba(232,184,120,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (isSelected) {
        const pulse = state.paused ? 1 : 0.7 + 0.3 * Math.sin(time / 300);
        ctx.strokeStyle = `rgba(232,184,120,${0.4 * pulse})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 10 + 4 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (p.depth < 330 || isSelected || isHover) {
        ctx.globalAlpha = linked ? 0.9 : 0.3;
        ctx.fillStyle = PALETTE.text;
        ctx.font = '10px "Microsoft YaHei", system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const label = String(node.label || '').slice(0, 18);
        ctx.fillText(label, p.x + radius + 5, p.y);
      }
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    if (state.disposed) return;
    const now = performance.now();
    const time = now - state.start;
    // 暂停时只以约 5fps 重绘静态场景，避免“暂停”仍持续满帧占用 CPU。
    if (state.paused && !state.dragging && now - state.lastPaint < 200) {
      state.raf = requestAnimationFrame(draw);
      return;
    }
    state.lastPaint = now;
    if (!state.paused && !state.dragging) {
      state.yaw += 0.00022;
      state.zoom += (state.targetZoom - state.zoom) * 0.08;
    } else {
      state.zoom += (state.targetZoom - state.zoom) * 0.12;
    }
    drawBackground(time);
    drawEdges(time);
    drawNodes(time);
    if (state.hover && tooltip) {
      const node = nodes.find(item => item.id === state.hover);
      if (node) {
        tooltip.hidden = false;
        tooltip.textContent = `${node.label || '记忆'} · ${node.scope} · 重要度 ${node.importance}`;
      }
    } else if (tooltip) tooltip.hidden = true;
    state.raf = requestAnimationFrame(draw);
  }

  function nodeAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    for (const node of nodes) {
      if (!visible(node)) continue;
      const point = state.layout.get(node.id);
      if (!point) continue;
      const p = project(point, performance.now() - state.start);
      const radius = 9 + Number(node.importance || 3) * 1.8;
      const distance = Math.hypot(p.x - x, p.y - y);
      if (distance <= radius && (!best || p.depth < best.depth)) best = {node, depth: p.depth};
    }
    return best?.node || null;
  }

  function selectNode(node, focus = false) {
    state.selected = node?.id || null;
    if (node) {
      if (focus) state.targetZoom = Math.max(1.5, state.targetZoom);
      if (typeof onSelect === 'function') onSelect(node);
    } else {
      if (panel) panel.hidden = true;
      if (typeof onClosePanel === 'function') onClosePanel();
    }
  }

  function focusOn(id) {
    const node = nodes.find(item => item.id === id);
    if (!node) return false;
    state.scope = '';
    state.targetZoom = 1.85;
    const point = state.layout.get(id);
    if (point) state.yaw = -Math.atan2(point.x, point.z || 1) + 0.2;
    selectNode(node, true);
    return true;
  }

  function search(query) {
    state.query = String(query || '').trim().slice(0, 80);
    if (!state.query) return 0;
    const matches = nodes.filter(visible);
    if (matches[0]) focusOn(matches[0].id);
    return matches.length;
  }

  function setScope(scope) {
    state.scope = ['global', 'user', 'group'].includes(scope) ? scope : '';
    state.selected = null;
    state.query = '';
    state.targetZoom = 1;
    if (panel) panel.hidden = true;
  }

  function reset() {
    state.yaw = 0.35; state.pitch = 0.18; state.zoom = 1; state.targetZoom = 1;
    state.selected = null; state.query = ''; state.scope = '';
    if (panel) panel.hidden = true;
  }

  function pointerDown(event) {
    if (event.button !== 0) return;
    state.dragging = true; state.moved = false;
    state.lastX = event.clientX; state.lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event) {
    if (state.dragging) {
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) state.moved = true;
      state.yaw += dx * 0.006;
      state.pitch = Math.max(-0.9, Math.min(0.9, state.pitch + dy * 0.004));
      state.lastX = event.clientX; state.lastY = event.clientY;
      return;
    }
    state.hover = nodeAt(event.clientX, event.clientY)?.id || null;
    canvas.style.cursor = state.hover ? 'pointer' : 'grab';
  }

  function pointerUp(event) {
    if (!state.dragging) return;
    state.dragging = false;
    canvas.releasePointerCapture?.(event.pointerId);
    if (!state.moved) {
      const node = nodeAt(event.clientX, event.clientY);
      selectNode(node);
    }
  }

  function wheel(event) {
    event.preventDefault();
    state.targetZoom = Math.max(0.55, Math.min(3.2, state.targetZoom + (event.deltaY < 0 ? 0.16 : -0.16)));
  }

  function doubleClick(event) {
    const node = nodeAt(event.clientX, event.clientY);
    if (node) focusOn(node.id);
  }

  function keydown(event) {
    if (event.key === 'Escape') { reset(); if (panel) panel.hidden = true; }
    if (event.key === ' ') { event.preventDefault(); togglePause(); }
  }

  function togglePause() {
    state.paused = !state.paused;
    return state.paused;
  }

  buildLayout();
  resize();
  on(window, 'resize', resize);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  on(canvas, 'pointerdown', pointerDown);
  on(canvas, 'pointermove', pointerMove);
  on(canvas, 'pointerup', pointerUp);
  on(canvas, 'pointerleave', () => { state.hover = null; state.dragging = false; });
  on(canvas, 'wheel', wheel, {passive: false});
  on(canvas, 'dblclick', doubleClick);
  on(canvas, 'keydown', keydown);
  canvas.tabIndex = 0;
  state.raf = requestAnimationFrame(draw);

  return {
    destroy() {
      state.disposed = true;
      cancelAnimationFrame(state.raf);
      observer?.disconnect();
      for (const remove of listeners) remove();
      state.layout.clear();
    },
    focus: focusOn,
    search,
    setScope,
    reset,
    togglePause,
    isPaused: () => state.paused,
    select: selectNode
  };
}
