package com.cogolfers.cg_streamer

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.SurfaceView
import com.pedro.common.ConnectChecker
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

        val rotation = CameraHelper.getCameraOrientation(rotationContext)
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

        // Reconnection is driven from Dart (same policy on Android and iOS).
        s.getStreamClient().setReTries(0)
        s.getStreamClient().setLogs(false)

        bitrateAdapter = BitrateAdapter { adapted -> stream?.setVideoBitrateOnFly(adapted) }.also {
            it.setMaxBitrate(cfg.videoBitrate)
        }
        config = cfg.copy(width = width, height = height)
        prepared = true
        previewView?.let { attachPreview(it) }
        return mapOf("width" to width, "height" to height, "fps" to cfg.fps, "rotation" to rotation)
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
        (stream?.videoSource as? Camera2Source)?.switchCamera()
            ?: throw IllegalStateException("Camera is not open.")
    }

    fun setVideoBitrate(bps: Int) {
        stream?.setVideoBitrateOnFly(bps)
        bitrateAdapter?.setMaxBitrate(bps)
        config = config?.copy(videoBitrate = bps)
    }

    fun release() {
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
