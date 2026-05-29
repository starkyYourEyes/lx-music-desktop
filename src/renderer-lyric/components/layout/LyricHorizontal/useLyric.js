import { ref, onMounted, onBeforeUnmount, watch, nextTick } from '@common/utils/vueTools'
import { lyric } from '@lyric/store/lyric'
import { setting } from '@lyric/store/state'
import { setWindowBounds, setWindowResizeable } from '@lyric/utils/ipc'
import { isWin } from '@common/utils'

const MIN_WINDOW_HEIGHT = 38
const MAX_EXTENDED_LINES = 1

export default () => {
  const dom_lyric = ref(null)
  const dom_lyric_text = ref(null)
  const isMsDown = ref(false)

  const winEvent = {
    isMsDown: false,
    msDownX: 0,
    msDownY: 0,
    windowW: 0,
    windowH: 0,
  }

  let heightRaf = null
  let currentLine = -1

  const setLineExtendedVisible = (lineEl) => {
    if (!lineEl) return
    const extendedEls = lineEl.querySelectorAll('.extended')
    extendedEls.forEach((el, index) => {
      el.style.display = index < MAX_EXTENDED_LINES ? '' : 'none'
    })
  }

  const syncWindowHeight = () => {
    if (!dom_lyric_text.value) return
    if (heightRaf) window.cancelAnimationFrame(heightRaf)
    heightRaf = window.requestAnimationFrame(() => {
      heightRaf = null
      const contentHeight = dom_lyric_text.value.scrollHeight
      const paddingTop = Math.max(0, setting['desktopLyric.style.paddingTop'])
      const paddingBottom = Math.max(0, setting['desktopLyric.style.paddingBottom'])
      const targetHeight = Math.max(MIN_WINDOW_HEIGHT, Math.ceil(contentHeight + paddingTop + paddingBottom))
      if (Math.abs(window.innerHeight - targetHeight) < 2) return
      setWindowBounds({
        x: 0,
        y: 0,
        w: window.innerWidth,
        h: targetHeight,
      })
    })
  }

  const renderCurrentLine = () => {
    if (!dom_lyric_text.value) return
    const line = lyric.lines[lyric.line]
    currentLine = lyric.line
    dom_lyric_text.value.textContent = ''
    if (line?.dom_line) {
      setLineExtendedVisible(line.dom_line)
      dom_lyric_text.value.appendChild(line.dom_line)
    }
    nextTick(syncWindowHeight)
  }

  const handleLyricDown = (x, y) => {
    winEvent.isMsDown = true
    winEvent.msDownX = x
    winEvent.msDownY = y
    winEvent.windowW = window.innerWidth
    winEvent.windowH = window.innerHeight
    if (isWin) setWindowResizeable(false)
  }
  const handleLyricMouseDown = event => {
    handleLyricDown(event.clientX, event.clientY)
  }
  const handleLyricTouchStart = event => {
    if (event.changedTouches.length) {
      const touch = event.changedTouches[0]
      handleLyricDown(touch.clientX, touch.clientY)
    }
  }
  const handleMouseMsUp = () => {
    isMsDown.value = false
    winEvent.isMsDown = false
    if (isWin) setWindowResizeable(true)
  }

  const handleMove = (x, y) => {
    if (!winEvent.isMsDown) return
    if (isWin) {
      setWindowBounds({
        x: x - winEvent.msDownX,
        y: y - winEvent.msDownY,
        w: winEvent.windowW,
        h: winEvent.windowH,
      })
    } else {
      setWindowBounds({
        x: x - winEvent.msDownX,
        y: y - winEvent.msDownY,
        w: window.innerWidth,
        h: window.innerHeight,
      })
    }
  }
  const handleMouseMsMove = event => {
    handleMove(event.clientX, event.clientY)
  }
  const handleTouchMove = (e) => {
    if (e.changedTouches.length) {
      const touch = e.changedTouches[0]
      handleMove(touch.clientX, touch.clientY)
    }
  }

  const handleWheel = () => {}

  watch(() => lyric.lines, renderCurrentLine)
  watch(() => lyric.line, renderCurrentLine)
  watch(() => [
    setting['desktopLyric.style.font'],
    setting['desktopLyric.style.fontSize'],
    setting['desktopLyric.style.lineGap'],
    setting['desktopLyric.style.extendedLineGap'],
    setting['desktopLyric.style.lineHeight'],
    setting['desktopLyric.style.paddingTop'],
    setting['desktopLyric.style.paddingBottom'],
    setting['desktopLyric.style.isZoomActiveLrc'],
    setting['desktopLyric.style.isFontWeightFont'],
    setting['desktopLyric.style.isFontWeightLine'],
    setting['desktopLyric.style.isFontWeightExtended'],
    setting['player.isShowLyricTranslation'],
  ], () => {
    if (currentLine !== lyric.line) renderCurrentLine()
    else nextTick(syncWindowHeight)
  })

  onMounted(() => {
    document.addEventListener('mousemove', handleMouseMsMove)
    document.addEventListener('mouseup', handleMouseMsUp)
    document.addEventListener('touchmove', handleTouchMove)
    document.addEventListener('touchend', handleMouseMsUp)
    window.addEventListener('resize', syncWindowHeight)

    renderCurrentLine()
  })

  onBeforeUnmount(() => {
    if (heightRaf) window.cancelAnimationFrame(heightRaf)
    document.removeEventListener('mousemove', handleMouseMsMove)
    document.removeEventListener('mouseup', handleMouseMsUp)
    document.removeEventListener('touchmove', handleTouchMove)
    document.removeEventListener('touchend', handleMouseMsUp)
    window.removeEventListener('resize', syncWindowHeight)
  })

  return {
    dom_lyric,
    dom_lyric_text,
    isMsDown,
    handleLyricMouseDown,
    handleLyricTouchStart,
    handleWheel,
  }
}
