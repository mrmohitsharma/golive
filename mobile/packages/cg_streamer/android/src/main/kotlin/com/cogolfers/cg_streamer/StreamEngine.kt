package com.cogolfers.cg_streamer

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.os.Handler
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.os.Looper
import android.util.Log
import android.view.SurfaceView
import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.audio.CustomAudioEffect
import com.pedro.encoder.input.sources.audio.MicrophoneSource
import com.pedro.encoder.input.sources.video.Camera2Source
import com.pedro.encoder.input.video.CameraHelper
import com.pedro.library.srt.SrtStream
import com.pedro.library.util.BitrateAdapter

/**
 * Owns the single RootEncoder SrtStream for the app process.
 *
 * Camera2 -> OpenGL -> MediaCodec H.264 + AAC -> MPEG-TS -> SRT (caller) -> MediaMTX.
 *
 * The stream lives here (not in the Activity or PlatformView) so it keeps publishing when
 * the preview surface goes away: screen off, app in background, or Flutter rebuilding the
 * preview widget. The foreground service keeps the process prioritised while live.
 */
object StreamEngine : ConnectChecker {
    private const val TAG = "CgStreamer"

    data class Config(
        val width: Int,
        val height: Int,
        val fps: Int,
        val videoBitrate: Int,
        val audioBitrate: Int,
        val front: Boolean,
        val keyframeInterval: Int,
        val portrait: Boolean = false,
    )

    private val main = Handler(Looper.getMainLooper())
    private var stream: SrtStream? = null
    private var config: Config? = null
    private var prepared = false
    private var previewView: SurfaceView? = null
    private var bitrateAdapter: BitrateAdapter? = null

    /** Receives events for Flutter's EventChannel. Always invoked on the main thread. */
    var listener: ((Map<String, Any?>) -> Unit)? = null

    val isStreaming: Boolean get() = stream?.isStreaming == true

    private fun emit(event: Map<String, Any?>) {
        if (Looper.myLooper() == Looper.getMainLooper()) listener?.invoke(event)
        else main.post { listener?.invoke(event) }
    }

    private fun emitState(state: String, message: String? = null) =
        emit(mapOf("type" to "state", "state" to state, "message" to message))

    /**
     * Opens the camera and prepares encoders. `rotationContext` should be the Activity so the
     * current display rotation is used (the Flutter screen is locked to landscape).
     */
    fun initialize(appContext: Context, rotationContext: Context, cfg: Config): Map<String, Any?> {
        val s = stream ?: SrtStream(appContext, this).also { stream = it }
        if (s.isStreaming) throw IllegalStateException("Stop streaming before changing camera settings.")
        if (s.isOnPreview) s.stopPreview()

        val camera = s.videoSource as? Camera2Source
        if (camera != null) {
            val isFront = camera.getCameraFacing() == CameraHelper.Facing.FRONT
            if (isFront != cfg.front) camera.switchCamera()
        }

        appCtx = appContext
        rotationCtx = rotationContext
        // Landscape: 0 / 180, portrait: 90 / 270 (RootEncoder's camera orientation). The screen
        // turns before this is called; if it hasn't yet, use the upright value for the mode.
        val current = CameraHelper.getCameraOrientation(rotationContext)
        val isPortraitNow = current == 90 || current == 270
        val rotation = if (cfg.portrait) (if (isPortraitNow) current else 90) else (if (isPortraitNow) 0 else current)
        var width = cfg.width
        var height = cfg.height
        var videoOk = try {
            s.prepareVideo(width, height, cfg.videoBitrate, cfg.fps, cfg.keyframeInterval, rotation)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "prepareVideo ${width}x$height rejected: ${e.message}")
            false
        }
        if (!videoOk && (width != 1280 || height != 720)) {
            // Fall back to 720p, which every Camera2 device supports for recording.
            width = 1280
            height = 720
            videoOk = try {
                s.prepareVideo(width, height, cfg.videoBitrate, cfg.fps, cfg.keyframeInterval, rotation)
            } catch (e: IllegalArgumentException) {
                false
            }
        }
        if (!videoOk) throw IllegalStateException("This camera cannot record ${cfg.width}x${cfg.height} at ${cfg.fps} fps.")
        val audioOk = s.prepareAudio(44100, true, cfg.audioBitrate)
        if (!audioOk) throw IllegalStateException("The microphone could not be prepared.")
        (s.audioSource as? MicrophoneSource)?.setAudioEffect(LevelMeter)

        // Reconnection is driven from Dart (same policy on Android and iOS).
        s.getStreamClient().setReTries(0)
        s.getStreamClient().setLogs(false)

        bitrateAdapter = BitrateAdapter { adapted -> stream?.setVideoBitrateOnFly(adapted) }.also {
            it.setMaxBitrate(cfg.videoBitrate)
        }
        config = cfg.copy(width = width, height = height)
        prepared = true
        previewView?.let { attachPreview(it) }
        // A new camera session: settings come back as the operator left them (zoom, brightness…).
        // The camera opens with the preview (a moment later): look for the ultra-wide lens then.
        onUltraWide = false
        uwId = null
        reapplySoon()
        val portrait = rotation == 90 || rotation == 270
        return mapOf(
            "width" to if (portrait) height else width,
            "height" to if (portrait) width else height,
            "fps" to cfg.fps,
            "rotation" to rotation,
            "portrait" to portrait,
        )
    }

    fun attachPreview(view: SurfaceView) {
        previewView = view
        val s = stream ?: return
        if (!prepared) return
        if (s.isOnPreview) s.stopPreview(true)
        // autoHandle = true: RootEncoder starts/stops the preview with the surface lifecycle.
        s.startPreview(view, true)
    }

    fun detachPreview(view: SurfaceView) {
        if (previewView !== view) return
        previewView = null
        val s = stream ?: return
        // Stopping the preview does not stop streaming: the GL pipeline keeps feeding the encoder.
        if (s.isOnPreview) s.stopPreview(true)
    }

    fun start(url: String) {
        val s = stream ?: throw IllegalStateException("Call initialize first.")
        if (!prepared) throw IllegalStateException("Call initialize first.")
        if (s.isStreaming) s.stopStream()
        config?.let { bitrateAdapter?.setMaxBitrate(it.videoBitrate) }
        emitState("connecting")
        s.startStream(url)
    }

    fun stop() {
        val s = stream ?: return
        if (s.isStreaming) s.stopStream()
    }

    fun switchCamera() {
        val cam = cam() ?: throw IllegalStateException("Camera is not open.")
        // Front <-> back always starts from the main lens at 1x; brightness carries over.
        // switchCamera opens the other side by facing, so an ultra-wide lens is left behind too.
        onUltraWide = false
        cam.switchCamera()
        controls.zoom = 1f
        controls.torch = false
        controls.locked = false
        main.postDelayed({ findUltraWide(); reapply() }, 700)
    }

    // ---------------------------------------------------------------- camera controls
    // Brightness (exposure compensation), zoom (with the ultra-wide lens), tap to focus,
    // manual focus, focus + exposure lock and torch. Kept here so they survive a reconnect,
    // a lens change and a new initialize (portrait / landscape).
    private data class Controls(
        var zoom: Float = 1f,
        var ev: Float = 0f,
        var autoFocus: Boolean = true,
        var focusNear: Float = 0f,
        var locked: Boolean = false,
        var torch: Boolean = false,
    )

    private val controls = Controls()
    private var appCtx: Context? = null
    private var rotationCtx: Context? = null
    private var mainId: String? = null
    private var uwId: String? = null
    private var uwRatio = 1f
    private var mainZoomMax = 1f
    private var onUltraWide = false
    private var lensSwitching = false

    private fun cam(): Camera2Source? = stream?.videoSource as? Camera2Source

    private fun manager(): CameraManager? = appCtx?.getSystemService(Context.CAMERA_SERVICE) as? CameraManager

    private fun chars(id: String? = cam()?.getCurrentCameraId()): CameraCharacteristics? {
        if (id == null) return null
        return try {
            manager()?.getCameraCharacteristics(id)
        } catch (e: Exception) {
            null
        }
    }

    /** Horizontal field of view, as sensor width / focal length (bigger = wider). */
    private fun fov(c: CameraCharacteristics): Float? {
        val w = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)?.width ?: return null
        val f = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.minOrNull() ?: return null
        return if (f > 0f) w / f else null
    }

    /**
     * Most phones (Android 11+) reach the ultra-wide lens through the zoom range itself (0.5x…),
     * with no camera change. Older ones list it as a separate camera: then going below 1x
     * reopens the camera, and the picture freezes for about a second.
     */
    private fun findUltraWide() {
        if (onUltraWide) return
        uwId = null
        uwRatio = 1f
        val cam = cam() ?: return
        mainId = cam.getCurrentCameraId()
        mainZoomMax = cam.getZoomRange().upper
        if (cam.getCameraFacing() != CameraHelper.Facing.BACK) return
        if (cam.getZoomRange().lower < 0.99f) return
        val main = chars(mainId) ?: return
        val mainFov = fov(main) ?: return
        val m = manager() ?: return
        var best: Pair<String, Float>? = null
        try {
            for (id in m.cameraIdList) {
                if (id == mainId) continue
                val c = m.getCameraCharacteristics(id)
                if (c.get(CameraCharacteristics.LENS_FACING) != CameraCharacteristics.LENS_FACING_BACK) continue
                val f = fov(c) ?: continue
                if (f > mainFov * 1.25f && (best == null || f > best.second)) best = id to f
            }
        } catch (e: Exception) {
            Log.w(TAG, "camera list failed: ${e.message}")
        }
        best?.let {
            uwId = it.first
            uwRatio = mainFov / it.second
        }
    }

    fun caps(): Map<String, Any?> {
        val cam = cam() ?: return emptyMap()
        val c = chars()
        val ev = c?.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)
        val step = c?.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)?.toFloat() ?: 1f
        val zr = cam.getZoomRange()
        val minFocus = c?.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
        val lens = uwId != null || onUltraWide
        return mapOf(
            "zoomMin" to (if (lens) uwRatio else zr.lower).toDouble(),
            "zoomMax" to (if (onUltraWide) mainZoomMax else zr.upper).toDouble(),
            "evMin" to ((ev?.lower ?: 0) * step).toDouble(),
            "evMax" to ((ev?.upper ?: 0) * step).toDouble(),
            "evStep" to step.toDouble(),
            "torch" to (c?.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true),
            "manualFocus" to (minFocus > 0f),
            "focusPoint" to ((c?.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF) ?: 0) > 0),
            "lensSwitch" to lens,
        )
    }

    /** Zoom in display units (0.5 = ultra-wide). Returns the zoom applied. */
    fun setZoom(display: Float): Float {
        val cam = cam() ?: return display
        controls.zoom = display
        // Changing lens: the latest value is applied when the new lens is open.
        if (lensSwitching) return display
        val uw = uwId
        if (uw != null || onUltraWide) {
            val wantWide = display < 0.999f
            if (wantWide != onUltraWide) {
                switchLens(wantWide)
                return display
            }
            if (onUltraWide) {
                val r = cam.getZoomRange()
                val digital = (display / uwRatio).coerceIn(r.lower, r.upper)
                cam.setZoom(digital)
                return digital * uwRatio
            }
        }
        val r = cam.getZoomRange()
        val z = display.coerceIn(r.lower, r.upper)
        cam.setZoom(z)
        return z
    }

    private fun switchLens(wide: Boolean) {
        val cam = cam() ?: return
        val id = (if (wide) uwId else mainId) ?: return
        emit(mapOf("type" to "lens", "switching" to true))
        lensSwitching = true
        onUltraWide = wide
        cam.openCameraId(id)
        main.postDelayed({
            lensSwitching = false
            // The operator may have dragged back across 1x meanwhile.
            val want = controls.zoom < 0.999f
            if (want != onUltraWide) switchLens(want) else {
                reapply()
                emit(mapOf("type" to "lens", "switching" to false))
            }
        }, 800)
    }

    fun setExposureBias(ev: Float) {
        controls.ev = ev
        val cam = cam() ?: return
        val step = chars()?.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)?.toFloat() ?: 1f
        cam.setExposure(Math.round(ev / step))
    }

    /** Screen point (0..1, as seen) -> a touch on the preview in sensor orientation. */
    private fun touchFor(x: Float, y: Float): Pair<View, MotionEvent>? {
        val view = previewView ?: return null
        val cam = cam() ?: return null
        val c = chars() ?: return null
        val sensor = c.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
        val front = cam.getCameraFacing() == CameraHelper.Facing.FRONT
        val display = when (rotationCtx?.let { CameraHelper.getCameraOrientation(it) } ?: 0) {
            90 -> 0 // ROTATION_0
            0 -> 90 // ROTATION_90
            270 -> 180
            else -> 270
        }
        val px = if (front) 1f - x else x
        val r = if (front) (sensor + display) % 360 else (sensor - display + 360) % 360
        val (sx, sy) = when (r) {
            90 -> y to 1f - px
            180 -> 1f - px to 1f - y
            270 -> 1f - y to px
            else -> px to y
        }
        if (view.width <= 0 || view.height <= 0) return null
        val t = SystemClock.uptimeMillis()
        return view to MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, sx * view.width, sy * view.height, 0)
    }

    fun focusAt(x: Float, y: Float) {
        val cam = cam() ?: return
        if (controls.locked) {
            controls.locked = false
            cam.disableExposureLock()
        }
        val (view, ev) = touchFor(x, y) ?: return
        try {
            cam.tapToFocus(view, ev)
            cam.tapToMeterExposure(view, ev)
        } finally {
            ev.recycle()
        }
        // Back to continuous focus a few seconds later, unless the operator chose manual.
        if (controls.autoFocus) main.postDelayed({ if (controls.autoFocus && !controls.locked) cam()?.enableAutoFocus() }, 5000)
    }

    fun setAutoFocus(on: Boolean) {
        controls.autoFocus = on
        val cam = cam() ?: return
        if (on) cam.enableAutoFocus() else setFocusDistance(controls.focusNear)
    }

    fun setFocusDistance(near: Float) {
        controls.focusNear = near.coerceIn(0f, 1f)
        val cam = cam() ?: return
        val min = chars()?.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: return
        if (min <= 0f) return
        controls.autoFocus = false
        cam.disableAutoFocus()
        cam.setCustomRequest {
            it.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
            it.set(CaptureRequest.LENS_FOCUS_DISTANCE, controls.focusNear * min)
        }
    }

    /** Holds focus and exposure (at x, y if given). */
    fun setAeAfLock(lock: Boolean, x: Float?, y: Float?) {
        val cam = cam() ?: return
        if (lock) {
            if (x != null && y != null) touchFor(x, y)?.let { (view, ev) ->
                try {
                    cam.tapToFocus(view, ev)
                    cam.tapToMeterExposure(view, ev)
                } finally {
                    ev.recycle()
                }
            } else if (controls.autoFocus) {
                cam.setCustomRequest { it.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO) }
            }
            controls.locked = true
            // Let exposure settle on the point first.
            main.postDelayed({ if (controls.locked) cam()?.enableExposureLock() }, 600)
        } else {
            controls.locked = false
            cam.disableExposureLock()
            if (controls.autoFocus) cam.enableAutoFocus() else setFocusDistance(controls.focusNear)
        }
    }

    fun setTorch(on: Boolean) {
        controls.torch = on
        val cam = cam() ?: return
        try {
            if (on) cam.enableLantern() else cam.disableLantern()
        } catch (e: Exception) {
            controls.torch = false
            throw IllegalStateException("This camera has no light.")
        }
    }

    private fun reapplySoon() {
        main.postDelayed({ if (!onUltraWide) findUltraWide(); reapply() }, 700)
        main.postDelayed({ if (!onUltraWide && uwId == null) findUltraWide(); reapply() }, 1800)
    }

    private fun reapply() {
        val cam = cam() ?: return
        try {
            if (onUltraWide) {
                val r = cam.getZoomRange()
                cam.setZoom((controls.zoom / uwRatio).coerceIn(r.lower, r.upper))
            } else if (controls.zoom >= 0.999f || uwId == null) {
                val r = cam.getZoomRange()
                cam.setZoom(controls.zoom.coerceIn(r.lower, r.upper))
            }
            if (controls.ev != 0f) setExposureBias(controls.ev)
            if (!controls.autoFocus) setFocusDistance(controls.focusNear)
            if (controls.torch) cam.enableLantern()
            if (controls.locked) cam.enableExposureLock()
        } catch (e: Exception) {
            Log.w(TAG, "reapply: ${e.message}")
        }
    }

    /** The phone turned round (landscape left <-> right, or portrait upside down): keep the picture upright. */
    fun updateOrientation() {
        val s = stream ?: return
        if (!prepared) return
        val ctx = rotationCtx ?: return
        val r = CameraHelper.getCameraOrientation(ctx)
        val portraitNow = r == 90 || r == 270
        if (portraitNow != (config?.portrait == true)) return // the other mode needs a new initialize
        s.getGlInterface().setCameraOrientation(if (r == 0) 270 else r - 90)
    }

    /** Microphone level for the meter: the loudest sample, falling back slowly, 10 times a second. */
    private object LevelMeter : CustomAudioEffect() {
        private var level = 0f
        private var last = 0L
        override fun process(pcmBuffer: ByteArray): ByteArray {
            var peak = 0
            var i = 0
            while (i + 1 < pcmBuffer.size) {
                val v = (pcmBuffer[i].toInt() and 0xff) or (pcmBuffer[i + 1].toInt() shl 8)
                val a = if (v < 0) -v else v
                if (a > peak) peak = a
                i += 2
            }
            level = maxOf(level * 0.8f, peak / 32768f)
            val now = SystemClock.uptimeMillis()
            if (now - last >= 100) {
                last = now
                val l = level
                main.post { listener?.invoke(mapOf("type" to "audioLevel", "level" to l.toDouble())) }
            }
            return pcmBuffer
        }
    }

    fun setVideoBitrate(bps: Int) {
        stream?.setVideoBitrateOnFly(bps)
        bitrateAdapter?.setMaxBitrate(bps)
        config = config?.copy(videoBitrate = bps)
    }

    fun release() {
        controls.zoom = 1f
        controls.torch = false
        controls.locked = false
        onUltraWide = false
        lensSwitching = false
        try {
            stream?.release()
        } catch (e: Exception) {
            Log.w(TAG, "release failed: ${e.message}")
        }
        stream = null
        prepared = false
        config = null
    }

    // ---------------------------------------------------------------- ConnectChecker
    override fun onConnectionStarted(url: String) = emitState("connecting")

    override fun onConnectionSuccess() = emitState("live")

    override fun onConnectionFailed(reason: String) {
        Log.w(TAG, "SRT connection failed: $reason")
        // Reset the stream so Dart can call start() again for the next attempt.
        try {
            stream?.let { if (it.isStreaming) it.stopStream() }
        } catch (_: Exception) {
        }
        emitState("disconnected", reason)
    }

    override fun onDisconnect() = emitState("stopped")

    override fun onAuthError() = emitState("error", "The ingest server refused this camera's key.")

    override fun onAuthSuccess() {}

    override fun onNewBitrate(bitrate: Long) {
        val s = stream
        if (s != null && s.isStreaming) {
            bitrateAdapter?.adaptBitrate(bitrate, s.getStreamClient().hasCongestion())
        }
        emit(mapOf("type" to "bitrate", "bps" to bitrate))
    }
}
