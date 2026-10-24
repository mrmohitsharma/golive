package com.cogolfers.cg_streamer

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory
import java.util.UUID

class CgStreamerPlugin :
    FlutterPlugin,
    MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler,
    ActivityAware,
    PluginRegistry.RequestPermissionsResultListener {

    companion object {
        private const val PERMISSION_REQUEST = 4712
    }

    private lateinit var methods: MethodChannel
    private lateinit var events: EventChannel
    private lateinit var appContext: Context
    private var activity: Activity? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var eventSink: EventChannel.EventSink? = null
    private var pendingPermission: MethodChannel.Result? = null

    // The service is started once when the operator goes live (app in foreground) and kept
    // through automatic reconnects: Android 12+ forbids starting a camera foreground service
    // from the background, so it must not be stopped and restarted on a network blip.
    private var serviceRunning = false

    private fun ensureService() {
        if (serviceRunning) return
        CgStreamService.start(appContext, "CoGolfer camera is live")
        serviceRunning = true
    }

    private fun stopService() {
        if (!serviceRunning) return
        CgStreamService.stop(appContext)
        serviceRunning = false
    }

    // ---------------------------------------------------------------- FlutterPlugin
    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, "cg_streamer")
        methods.setMethodCallHandler(this)
        events = EventChannel(binding.binaryMessenger, "cg_streamer/events")
        events.setStreamHandler(this)
        binding.platformViewRegistry.registerViewFactory("cg_streamer/preview", PreviewFactory())
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods.setMethodCallHandler(null)
        events.setStreamHandler(null)
        StreamEngine.listener = null
    }

    // ---------------------------------------------------------------- EventChannel
    override fun onListen(arguments: Any?, sink: EventChannel.EventSink) {
        eventSink = sink
        StreamEngine.listener = { event -> eventSink?.success(event) }
    }

    override fun onCancel(arguments: Any?) {
        eventSink = null
        StreamEngine.listener = null
    }

    // ---------------------------------------------------------------- ActivityAware
    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
        activityBinding = binding
        binding.addRequestPermissionsResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)

    override fun onDetachedFromActivity() {
        activityBinding?.removeRequestPermissionsResultListener(this)
        activityBinding = null
        activity = null
    }

    // ---------------------------------------------------------------- methods
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "requestPermissions" -> requestPermissions(result)
                "initialize" -> {
                    if (!hasPermission(Manifest.permission.CAMERA) || !hasPermission(Manifest.permission.RECORD_AUDIO)) {
                        return result.error("permission_denied", "Camera and microphone permission are required.", null)
                    }
                    val cfg = StreamEngine.Config(
                        width = call.argument<Int>("width") ?: 1280,
                        height = call.argument<Int>("height") ?: 720,
                        fps = call.argument<Int>("fps") ?: 30,
                        videoBitrate = call.argument<Int>("videoBitrate") ?: 2_500_000,
                        audioBitrate = call.argument<Int>("audioBitrate") ?: 128_000,
                        front = call.argument<String>("facing") == "front",
                        keyframeInterval = call.argument<Int>("keyframeInterval") ?: 2,
                    )
                    result.success(StreamEngine.initialize(appContext, activity ?: appContext, cfg))
                }
                "start" -> {
                    val url = call.argument<String>("url") ?: return result.error("bad_args", "url is required", null)
                    ensureService()
                    StreamEngine.start(url)
                    result.success(null)
                }
                "stop" -> {
                    StreamEngine.stop()
                    stopService()
                    result.success(null)
                }
                "switchCamera" -> {
                    StreamEngine.switchCamera()
                    result.success(null)
                }
                "setVideoBitrate" -> {
                    StreamEngine.setVideoBitrate(call.argument<Int>("bitrate") ?: 2_500_000)
                    result.success(null)
                }
                "dispose" -> {
                    StreamEngine.release()
                    stopService()
                    result.success(null)
                }
                "keepScreenOn" -> {
                    val on = call.argument<Boolean>("on") ?: false
                    activity?.window?.let {
                        if (on) it.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        else it.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                    result.success(null)
                }
                "deviceStatus" -> result.success(deviceStatus())
                "deviceId" -> result.success(deviceId())
                else -> result.notImplemented()
            }
        } catch (e: Exception) {
            result.error("native_error", e.message ?: e.javaClass.simpleName, null)
        }
    }

    private fun hasPermission(p: String) = ContextCompat.checkSelfPermission(appContext, p) == PackageManager.PERMISSION_GRANTED

    private fun requestPermissions(result: MethodChannel.Result) {
        val needed = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) needed.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = needed.filter { !hasPermission(it) }
        if (missing.isEmpty()) return result.success(true)
        val act = activity ?: return result.error("no_activity", "No foreground activity to ask for permission.", null)
        if (pendingPermission != null) return result.error("busy", "A permission request is already showing.", null)
        pendingPermission = result
        ActivityCompat.requestPermissions(act, missing.toTypedArray(), PERMISSION_REQUEST)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray): Boolean {
        if (requestCode != PERMISSION_REQUEST) return false
        // Notifications are optional; camera and microphone are required.
        pendingPermission?.success(hasPermission(Manifest.permission.CAMERA) && hasPermission(Manifest.permission.RECORD_AUDIO))
        pendingPermission = null
        return true
    }

    private fun deviceStatus(): Map<String, Any?> {
        val bm = appContext.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val sticky = appContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        var thermal = "unknown"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val pm = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            thermal = when (pm.currentThermalStatus) {
                PowerManager.THERMAL_STATUS_NONE, PowerManager.THERMAL_STATUS_LIGHT -> "nominal"
                PowerManager.THERMAL_STATUS_MODERATE -> "fair"
                PowerManager.THERMAL_STATUS_SEVERE -> "serious"
                else -> "critical"
            }
        }
        return mapOf(
            "platform" to "android",
            "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
            "battery" to if (level in 0..100) level else null,
            "charging" to charging,
            "thermal" to thermal,
        )
    }

    private fun deviceId(): String {
        val prefs = appContext.getSharedPreferences("cg_streamer", Context.MODE_PRIVATE)
        prefs.getString("device_id", null)?.let { return it }
        val id = "android-" + UUID.randomUUID().toString()
        prefs.edit().putString("device_id", id).apply()
        return id
    }

    // ---------------------------------------------------------------- preview view
    private class PreviewFactory : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
        override fun create(context: Context, viewId: Int, args: Any?): PlatformView = PreviewView(context)
    }

    private class PreviewView(context: Context) : PlatformView {
        private val surface = SurfaceView(context)

        init {
            StreamEngine.attachPreview(surface)
        }

        override fun getView(): View = surface

        override fun dispose() = StreamEngine.detachPreview(surface)
    }
}
