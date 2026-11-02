import * as THREE from './three.module.js';

// 记忆星云：真实 Three.js 场景。节点和边完全来自 memoryAdmin.graph；
// 这个模块只负责空间布局、交互和渲染，不创建或修改任何记忆。
const SCOPE_COLORS = {global: '#d9a85d', user: '#75a9c6', group: '#79b995'};

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

function cssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function colorFor(scope) {
  return cssColor(scope === 'global' ? '--accent' : scope === 'group' ? '--ok' : '--accent-2', SCOPE_COLORS[scope] || SCOPE_COLORS.user);
}

function makePosition(node, index, count) {
  const scope = node.scope || 'user';
  const radius = scope === 'global' ? 85 : scope === 'group' ? 205 : 145;
  const angle = (index / Math.max(1, count)) * Math.PI * 2 + seeded(node.id + ':angle') * 0.8;
  const vertical = (seeded(node.id + ':height') - 0.5) * (scope === 'global' ? 55 : 145);
  const jitter = 0.78 + seeded(node.id + ':radius') * 0.42;
  return new THREE.Vector3(Math.cos(angle) * radius * jitter, vertical, Math.sin(angle) * radius * jitter);
}

function fallback(canvas, tooltip) {
  const context = canvas.getContext('2d');
  if (!context) return {destroy() {}, focus() {return false;}, search() {return 0;}, setScope() {}, reset() {}, togglePause() {return true;}, isPaused() {return true;}, select() {}};
  const draw = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width));
    const height = Math.max(360, Math.round(rect.height || 480));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = '#0c0d12';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#9da5b5';
    context.font = '13px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('当前浏览器不支持 WebGL，星云暂时无法显示。', width / 2, height / 2 - 8);
    context.fillStyle = '#6f7788';
    context.font = '11px system-ui, sans-serif';
    context.fillText('记忆数据仍可在“记忆库”和“复习曲线”中查看。', width / 2, height / 2 + 18);
    if (tooltip) tooltip.hidden = true;
  };
  draw();
  return {destroy() {}, focus() {return false;}, search() {return 0;}, setScope() {}, reset() {draw();}, togglePause() {return true;}, isPaused() {return true;}, select() {}};
}

export function createStarMap({canvas, tooltip, panel, nodes = [], edges = [], onSelect, onClosePanel}) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('星图缺少 canvas');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: 'low-power'});
  } catch {
    return fallback(canvas, tooltip);
  }

  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 1, 1600);
  camera.position.set(0, 18, 650);
  const root = new THREE.Group();
  const nodeGroup = new THREE.Group();
  const edgeGroup = new THREE.Group();
  root.add(edgeGroup, nodeGroup);
  scene.add(root);

  const listeners = [];
  const state = {paused: reducedMotion, disposed: false, selected: null, hover: null, scope: '', query: '', dragging: false, moved: false, lastX: 0, lastY: 0, yaw: 0.25, pitch: -0.1, targetZoom: 650, currentZoom: 650, raf: 0, materials: new Map(), meshes: new Map()};
  const on = (target, type, handler, options) => {target.addEventListener(type, handler, options);listeners.push(() => target.removeEventListener(type, handler, options));};
  const positionById = new Map();
  const scopeGroups = {global: [], user: [], group: []};
  for (const node of nodes) (scopeGroups[node.scope] || scopeGroups.user).push(node);
  for (const [scope, group] of Object.entries(scopeGroups)) group.forEach((node, index) => positionById.set(node.id, makePosition(node, index, group.length)));

  const sphere = new THREE.SphereGeometry(1, 12, 8);
  for (const node of nodes) {
    const material = new THREE.MeshBasicMaterial({color: new THREE.Color(colorFor(node.scope)), transparent: true, opacity: 0.92});
    const mesh = new THREE.Mesh(sphere, material);
    const importance = Math.max(1, Math.min(5, Number(node.importance) || 3));
    const scale = 2.4 + importance * 1.2;
    mesh.scale.setScalar(scale);
    mesh.position.copy(positionById.get(node.id));
    mesh.userData.node = node;
    mesh.userData.baseScale = scale;
    nodeGroup.add(mesh);
    state.materials.set(node.id, material);
    state.meshes.set(node.id, mesh);
  }

  const edgePositions = [];
  for (const edge of edges) {
    const source = positionById.get(edge.source);
    const target = positionById.get(edge.target);
    if (!source || !target) continue;
    edgePositions.push(source.x, source.y, source.z, target.x, target.y, target.z);
  }
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
  const edgeMaterial = new THREE.LineBasicMaterial({color: new THREE.Color('#9aa5bd'), transparent: true, opacity: 0.24});
  edgeGroup.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

  const starPositions = [];
  for (let index = 0; index < 480; index++) {
    const radius = 340 + seeded('nebula-radius-' + index) * 430;
    const theta = seeded('nebula-theta-' + index) * Math.PI * 2;
    const y = (seeded('nebula-y-' + index) - 0.5) * 300;
    starPositions.push(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
  const starMaterial = new THREE.PointsMaterial({color: new THREE.Color('#b7c2dc'), size: 1.8, transparent: true, opacity: 0.24, depthWrite: false, blending: THREE.AdditiveBlending});
  const stars = new THREE.Points(starGeometry, starMaterial);
  scene.add(stars);

  function visible(node) {
    if (state.scope && node.scope !== state.scope) return false;
    if (!state.query) return true;
    const query = state.query.toLowerCase();
    return String(node.label || '').toLowerCase().includes(query) || (node.tags || []).some(tag => String(tag).toLowerCase().includes(query));
  }

  function refreshVisibility() {
    for (const node of nodes) {
      const mesh = state.meshes.get(node.id);
      const material = state.materials.get(node.id);
      if (!mesh || !material) continue;
      const shown = visible(node);
      const connected = !state.selected || state.selected === node.id || edges.some(edge => (edge.source === state.selected && edge.target === node.id) || (edge.target === state.selected && edge.source === node.id));
      mesh.visible = shown;
      material.opacity = shown ? (connected ? 0.92 : 0.2) : 0;
      mesh.scale.setScalar(mesh.userData.baseScale * (state.selected === node.id ? 1.75 : 1));
    }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, rect.width || 640);
    const height = Math.max(360, rect.height || 540);
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function render() {
    if (state.disposed) return;
    if (!state.paused && !state.dragging) {
      state.yaw += 0.00024;
      stars.rotation.y += 0.00008;
    }
    state.currentZoom += (state.targetZoom - state.currentZoom) * 0.08;
    root.rotation.y = state.yaw;
    root.rotation.x = state.pitch;
    camera.position.z = state.currentZoom;
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    const node = state.hover ? nodes.find(item => item.id === state.hover) : null;
    if (tooltip) {
      tooltip.hidden = !node;
      if (node) tooltip.textContent = `${node.label || '记忆'} · ${node.scope} · 重要度 ${node.importance}`;
    }
    state.raf = requestAnimationFrame(render);
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function nodeAt(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...state.meshes.values()].filter(mesh => mesh.visible), false);
    return hits[0]?.object?.userData?.node || null;
  }

  function selectNode(node, focus = false) {
    state.selected = node?.id || null;
    refreshVisibility();
    if (node) {
      if (focus) state.targetZoom = 360;
      onSelect?.(node);
    } else {
      if (panel) panel.hidden = true;
      onClosePanel?.();
    }
  }

  function focusOn(id) {
    const node = nodes.find(item => item.id === id);
    if (!node) return false;
    state.scope = '';
    state.targetZoom = 360;
    const point = positionById.get(id);
    if (point) state.yaw = -Math.atan2(point.x, point.z || 1) + 0.2;
    selectNode(node, true);
    return true;
  }

  function pointerDown(event) {
    if (event.button !== 0) return;
    state.dragging = true;
    state.moved = false;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event) {
    if (state.dragging) {
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) state.moved = true;
      state.yaw += dx * 0.006;
      state.pitch = Math.max(-0.95, Math.min(0.95, state.pitch + dy * 0.004));
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      return;
    }
    const node = nodeAt(event);
    state.hover = node?.id || null;
    canvas.style.cursor = node ? 'pointer' : 'grab';
  }

  function pointerUp(event) {
    if (!state.dragging) return;
    state.dragging = false;
    canvas.releasePointerCapture?.(event.pointerId);
    if (!state.moved) selectNode(nodeAt(event));
  }

  function wheel(event) {
    event.preventDefault();
    state.targetZoom = Math.max(280, Math.min(900, state.targetZoom + (event.deltaY < 0 ? -45 : 45)));
  }

  function keydown(event) {
    if (event.key === 'Escape') selectNode(null);
    if (event.key === ' ') { event.preventDefault(); state.paused = !state.paused; }
  }

  function togglePause() {
    state.paused = !state.paused;
    return state.paused;
  }

  function search(query) {
    state.query = String(query || '').trim().slice(0, 80);
    refreshVisibility();
    const matches = nodes.filter(visible);
    if (matches[0]) focusOn(matches[0].id);
    return matches.length;
  }

  function setScope(scope) {
    state.scope = ['global', 'user', 'group'].includes(scope) ? scope : '';
    state.selected = null;
    state.query = '';
    state.targetZoom = 650;
    refreshVisibility();
    if (panel) panel.hidden = true;
  }

  function reset() {
    state.yaw = 0.25;
    state.pitch = -0.1;
    state.targetZoom = 650;
    state.selected = null;
    state.query = '';
    state.scope = '';
    refreshVisibility();
    if (panel) panel.hidden = true;
  }

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  on(window, 'resize', resize);
  on(canvas, 'pointerdown', pointerDown);
  on(canvas, 'pointermove', pointerMove);
  on(canvas, 'pointerup', pointerUp);
  on(canvas, 'pointerleave', () => { state.hover = null; state.dragging = false; });
  on(canvas, 'dblclick', event => {
    const node = nodeAt(event);
    if (node) selectNode(node, true);
  });
  on(canvas, 'wheel', wheel, {passive: false});
  on(canvas, 'keydown', keydown);
  canvas.tabIndex = 0;
  canvas.style.touchAction = 'none';
  refreshVisibility();
  resize();
  state.raf = requestAnimationFrame(render);

  return {
    destroy() {
      state.disposed = true;
      cancelAnimationFrame(state.raf);
      observer?.disconnect();
      for (const remove of listeners) remove();
      sphere.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      starGeometry.dispose();
      starMaterial.dispose();
      for (const material of state.materials.values()) material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      state.meshes.clear();
      state.materials.clear();
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
