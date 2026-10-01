/**
 * The farming order on the manager page. The bot runs accounts by number, top
 * first; these helpers work out a new order, which the API saves as a list of
 * emails.
 */

/** A copy of `list` with the item at `from` moved to `to`, kept within the list. */
export function moveTo(list, from, to) {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/**
 * Where a dragged row lands. It passes another row once its leading edge
 * crosses that row's middle: its top edge going up, its bottom edge going
 * down. `boxes` are the rows' { top, bottom } before the drag, `from` the
 * dragged row, `dy` how far it has moved.
 */
export function dropIndex(boxes, from, dy) {
  const top = boxes[from].top + dy;
  const bottom = boxes[from].bottom + dy;
  const middle = (box) => (box.top + box.bottom) / 2;
  const above = boxes.slice(0, from).filter((box) => top < middle(box)).length;
  const below = boxes.slice(from + 1).filter((box) => bottom > middle(box)).length;
  return from - above + below;
}
