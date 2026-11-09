<script>
import { startEvents, stopMedia } from './events.js'

export default {
  onLaunch() {
    startEvents()
  },
  onHide() {
    stopMedia(true)
  },
}
</script>
