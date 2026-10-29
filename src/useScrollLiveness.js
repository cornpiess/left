import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Scrolling booleans gate media scheduling (`interactive`) and card
 * activation on the native side. Every event path that arms the flag must
 * also release it — but programmatic scrolls (scrollToIndex/scrollToOffset)
 * never fire momentum callbacks, and interrupted gestures can skip the
 * end event. A stuck `true` freezes the whole pipeline: every view stays
 * priority-background while `interactive` blocks scheduling, which reads
 * as "photos stopped loading / background gone / burst frames black".
 *
 * Every arm therefore carries a failsafe release. A long continuous drag
 * releases mid-gesture after the timeout — the cost is only that background
 * prefetch resumes during very long drags.
 */
export default function useScrollLiveness(timeoutMs = 1600) {
  const [active, setActive] = useState(false);
  const timer = useRef(null);
  const mark = useCallback(value => {
    clearTimeout(timer.current);
    if (value) {
      setActive(true);
      timer.current = setTimeout(() => setActive(false), timeoutMs);
    } else {
      setActive(false);
    }
  }, [timeoutMs]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [active, mark];
}
