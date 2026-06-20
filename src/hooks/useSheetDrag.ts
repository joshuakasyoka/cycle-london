import { useRef, type RefObject } from 'react'

const DEFAULT_THRESHOLD = 36

interface Options {
  enabled: boolean
  expanded: boolean
  onExpand: () => void
  onCollapse: () => void
  scrollRef?: RefObject<HTMLDivElement | null>
  threshold?: number
}

/** Swipe up to expand, swipe down (from handle or scroll top) to collapse. */
export function useSheetDrag({
  enabled,
  expanded,
  onExpand,
  onCollapse,
  scrollRef,
  threshold = DEFAULT_THRESHOLD,
}: Options) {
  const touchYRef = useRef(0)
  const touchInScrollRef = useRef(false)
  const scrollAtStartRef = useRef(0)

  function onTouchStart(e: React.TouchEvent) {
    if (!enabled) return
    touchYRef.current = e.touches[0]?.clientY ?? 0
    const scrollEl = scrollRef?.current
    touchInScrollRef.current = scrollEl?.contains(e.target as Node) ?? false
    scrollAtStartRef.current = scrollEl?.scrollTop ?? 0
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (!enabled) return
    const endY = e.changedTouches[0]?.clientY ?? touchYRef.current
    const dy = touchYRef.current - endY // positive = finger moved up

    if (!expanded && dy > threshold) {
      onExpand()
      return
    }

    if (expanded && dy < -threshold) {
      const scrollTop = scrollRef?.current?.scrollTop ?? 0
      const fromHandle = !touchInScrollRef.current
      const fromScrollTop = touchInScrollRef.current
        && scrollAtStartRef.current <= 0
        && scrollTop <= 0
      if (fromHandle || fromScrollTop) onCollapse()
    }
  }

  return { onTouchStart, onTouchEnd }
}
