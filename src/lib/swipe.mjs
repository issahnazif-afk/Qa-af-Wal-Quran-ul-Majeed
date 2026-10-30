// Page swiping with a finger, a pen or a mouse: the page follows the pointer, and once it has moved
// far enough it turns. Swipe right (pointer moving left → right) = next page, as in a printed mushaf.
export function attachSwipe(area, { target, onSwipe, threshold = 60 }) {
  area.style.touchAction = 'pan-y';
  let start = null, dx = 0, horiz = null, moved = false;
  const el = () => (typeof target === 'function' ? target() : target);
  const reset = (animate) => {
    const t = el();
    if (!t) return;
    t.classList.remove('dragging');
    if (animate) { t.classList.add('settle'); setTimeout(() => t.classList.remove('settle'), 260); }
    t.style.transform = ''; t.style.opacity = '';
  };
  area.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId }; dx = 0; horiz = null; moved = false;
  });
  area.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (horiz === null && Math.abs(dx) + Math.abs(dy) > 10) {
      horiz = Math.abs(dx) > Math.abs(dy) * 1.2;
      if (horiz) { try { area.setPointerCapture(e.pointerId); } catch {} }
    }
    if (!horiz) return;
    moved = true;
    const t = el();
    if (t) {
      t.classList.add('dragging');
      t.style.transform = `translateX(${dx}px)`;
      t.style.opacity = String(1 - Math.min(0.45, Math.abs(dx) / 700));
    }
    e.preventDefault();
  });
  const end = (e) => {
    if (!start || (e.pointerId !== undefined && e.pointerId !== start.id)) return;
    const turn = horiz && Math.abs(dx) > threshold;
    start = null;
    if (turn) { reset(false); onSwipe(dx > 0 ? 1 : -1); }
    else reset(true);
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
  // a drag should not also count as a tap on a word
  area.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
}
