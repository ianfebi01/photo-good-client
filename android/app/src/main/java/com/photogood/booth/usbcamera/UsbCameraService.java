package com.photogood.booth.usbcamera;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.usb.UsbDevice;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;

import com.herohan.uvcapp.CameraException;
import com.herohan.uvcapp.CameraHelper;
import com.herohan.uvcapp.ICameraHelper;
import com.serenegiant.usb.IFrameCallback;
import com.serenegiant.usb.Size;
import com.serenegiant.usb.UVCCamera;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The booth's camera service, running inside the app.
 *
 * A booth films through an HDMI→USB capture device. Many Android phones do not
 * hand USB video devices to apps as cameras, so the WebView cannot see one; this
 * reads it directly over USB instead (UVCAndroid: libusb + libuvc), the way
 * "USB Camera"-type apps do. Each frame is turned into a JPEG and served to the
 * page, same-origin, by {@link UsbWebViewClient} — with the same /status,
 * /preview (MJPEG) and /snapshot endpoints as the Python camera service.
 *
 * All CameraHelper calls are made on a dedicated control thread, never the
 * main thread: some of them block until the device answers, and a capture
 * device that stalls must not freeze the booth's UI.
 */
public final class UsbCameraService {

    private static final String TAG = "UsbCameraService";

    /** Largest frame width requested — the booth composes from 1080p at most. */
    private static final int MAX_WIDTH = 1920;
    private static final int JPEG_QUALITY = 85;
    /** How long a video mode may stay silent before the next one is tried. */
    private static final long FIRST_FRAME_TIMEOUT_MS = 5_000;
    /** Video modes tried, best first, before giving up. */
    private static final int MAX_ATTEMPTS = 6;
    private static final int LOG_LINES = 40;

    public interface Listener {
        void onChange();
    }

    private static UsbCameraService instance;

    public static synchronized UsbCameraService get(Context context) {
        if (instance == null) instance = new UsbCameraService(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** Where every CameraHelper call is made (see class comment). */
    private final Handler control;
    private final ExecutorService encoder = Executors.newSingleThreadExecutor();
    private final AtomicBoolean encoding = new AtomicBoolean(false);

    private CameraHelper helper;
    private Listener listener;
    private Thread testPattern;

    // What /status and the plugin report.
    // idle | waiting | opening | starting | streaming | error
    private volatile String state = "idle";
    private volatile String error;
    private volatile String deviceName;
    private volatile int width;
    private volatile int height;
    private volatile int fps;

    // Newest frame, shared with the page (UsbWebViewClient).
    private final Object frameLock = new Object();
    private byte[] latestJpeg;
    private long frameSeq;
    private byte[] nv21;

    // Opening: the video modes still to try, and frames seen in the current one.
    // Read from the frame callback's thread too (adoptSizeFor), hence copy-on-write.
    private final List<Size> candidates = new java.util.concurrent.CopyOnWriteArrayList<>();
    private int attempt;
    private volatile long framesReceived;
    private volatile boolean frameSizeWarned;
    private final Runnable firstFrameWatchdog = this::onNoFrames;

    // What happened, newest last — shown in the booth's "USB details".
    private final ArrayDeque<String> log = new ArrayDeque<>();
    private final SimpleDateFormat clock = new SimpleDateFormat("HH:mm:ss", Locale.US);

    private UsbCameraService(Context context) {
        this.context = context;
        HandlerThread thread = new HandlerThread("usb-camera-control");
        thread.start();
        control = new Handler(thread.getLooper());
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    private void changed() {
        Listener l = listener;
        if (l != null) main.post(l::onChange);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────

    /** Start the server and look for a capture device (idempotent). */
    public void start() {
        control.post(() -> {
            if (helper != null) {
                // Already running; retry a device that is attached but idle.
                if (!"streaming".equals(state) && !"opening".equals(state)) selectFirstDevice();
                return;
            }
            helper = new CameraHelper();
            helper.setStateCallback(stateCallback);
            selectFirstDevice();
        });
    }

    public void stop() {
        control.post(() -> {
            stopTestPattern();
            if (helper != null) {
                helper.release();
                helper = null;
            }
            clearFrames();
            setState("idle", null);
        });
    }

    private void selectFirstDevice() {
        if (helper == null) return;
        List<UsbDevice> devices = helper.getDeviceList();
        if (devices == null || devices.isEmpty()) {
            log("No USB video device found");
            setState("waiting", null);
            return;
        }
        UsbDevice device = devices.get(0);
        log("Found " + describe(device) + " — requesting USB access");
        // Asks the user for USB permission the first time (Android dialog).
        setState("opening", null);
        helper.selectDevice(device);
    }

    private static String describe(UsbDevice device) {
        String name = device.getProductName() != null ? device.getProductName() : device.getDeviceName();
        return String.format(Locale.US, "%s (%04x:%04x)", name, device.getVendorId(), device.getProductId());
    }

    /**
     * CameraHelper delivers these on the main thread; each is handed straight to
     * the control thread, where it may call back into the helper.
     */
    private final ICameraHelper.StateCallback stateCallback = new ICameraHelper.StateCallback() {
        @Override
        public void onAttach(UsbDevice device) {
            control.post(() -> handleOnAttach(device));
        }

        @Override
        public void onDeviceOpen(UsbDevice device, boolean isFirstOpen) {
            control.post(() -> handleOnDeviceOpen(device, isFirstOpen));
        }

        @Override
        public void onCameraOpen(UsbDevice device) {
            control.post(() -> handleOnCameraOpen(device));
        }

        @Override
        public void onCameraClose(UsbDevice device) {
            control.post(() -> handleOnCameraClose(device));
        }

        @Override
        public void onDeviceClose(UsbDevice device) {
            control.post(() -> handleOnDeviceClose(device));
        }

        @Override
        public void onDetach(UsbDevice device) {
            control.post(() -> handleOnDetach(device));
        }

        @Override
        public void onCancel(UsbDevice device) {
            control.post(() -> handleOnCancel(device));
        }

        @Override
        public void onError(UsbDevice device, CameraException e) {
            control.post(() -> handleOnError(device, e));
        }
    };

    private void handleOnAttach(UsbDevice device) {
        log("Attached " + describe(device));
        if (helper != null && !"streaming".equals(state) && !"starting".equals(state)) {
            setState("opening", null);
            helper.selectDevice(device);
        }
    }

    private void handleOnDeviceOpen(UsbDevice device, boolean isFirstOpen) {
        deviceName = device.getProductName() != null ? device.getProductName() : device.getDeviceName();
        log("USB access granted; opening camera");
        if (helper != null) helper.openCamera();
    }

    private void handleOnCameraOpen(UsbDevice device) {
        if (helper == null) return;
        if (deviceName == null) deviceName = device.getProductName() != null ? device.getProductName() : device.getDeviceName();
        List<Size> sizes = null;
        try {
            sizes = helper.getSupportedSizeList();
        } catch (Exception e) {
            log("Could not read video modes: " + e.getMessage());
        }
        log("Camera open; modes: " + summarize(sizes));
        candidates.clear();
        candidates.addAll(rankSizes(sizes));
        attempt = 0;
        tryNextMode();
    }

    private void handleOnCameraClose(UsbDevice device) {
        log("Camera closed");
        control.removeCallbacks(firstFrameWatchdog);
        clearFrames();
        if ("streaming".equals(state) || "starting".equals(state)) setState("waiting", null);
    }

    private void handleOnDeviceClose(UsbDevice device) {
        log("USB device closed");
    }

    private void handleOnDetach(UsbDevice device) {
        log("Detached " + describe(device));
        control.removeCallbacks(firstFrameWatchdog);
        clearFrames();
        deviceName = null;
        setState("waiting", null);
    }

    private void handleOnCancel(UsbDevice device) {
        log("USB access denied");
        setState("error", "USB permission was not granted for the capture device");
    }

    private void handleOnError(UsbDevice device, CameraException e) {
        Log.e(TAG, "Camera error", e);
        log("Error: " + e.getMessage());
        setState("error", e.getMessage() != null ? e.getMessage() : "Capture device error");
    }

    /**
     * Start the preview in the next candidate mode and wait for its first frame.
     *
     * The frame callback must be attached *before* startPreview: attaching it to
     * a running preview stops the library's capture loop, and no frame arrives.
     */
    private void tryNextMode() {
        if (helper == null) return;
        control.removeCallbacks(firstFrameWatchdog);
        if (attempt >= candidates.size() || attempt >= MAX_ATTEMPTS) {
            log("No video mode produced a picture");
            setState("error", "The capture device opened but sent no picture in any video mode");
            return;
        }
        Size size = candidates.get(attempt);
        try {
            try {
                helper.stopPreview();
            } catch (Exception ignored) {
                // Not previewing yet.
            }
            helper.setFrameCallback(null, UVCCamera.PIXEL_FORMAT_NV21);
            helper.setPreviewSize(size);
            // The helper applies these asynchronously, in order, so reading the
            // size back here would still return the previous one. The frames
            // will be the size just requested.
            Size actual = size;
            width = actual.width;
            height = actual.height;
            fps = actual.fps;
            nv21 = null;
            frameSizeWarned = false;
            framesReceived = 0;
            helper.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21);
            helper.startPreview();
            log("Trying " + modeName(actual));
            setState("starting", null);
            control.postDelayed(firstFrameWatchdog, FIRST_FRAME_TIMEOUT_MS);
        } catch (Exception e) {
            Log.e(TAG, "Preview failed", e);
            log("Mode " + modeName(size) + " failed: " + e.getMessage());
            attempt++;
            control.post(this::tryNextMode);
        }
    }

    private void onNoFrames() {
        if (!"starting".equals(state) || framesReceived > 0) return;
        log("No frames in " + modeName(candidates.get(attempt)) + "; trying the next mode");
        attempt++;
        tryNextMode();
    }

    private static String modeName(Size s) {
        String type = s.type == UVCCamera.UVC_VS_FRAME_MJPEG ? "MJPEG" : s.type == UVCCamera.UVC_VS_FRAME_UNCOMPRESSED ? "YUYV" : ("type " + s.type);
        return s.width + "x" + s.height + " " + type + " @" + s.fps;
    }

    private static String summarize(List<Size> sizes) {
        if (sizes == null || sizes.isEmpty()) return "none reported";
        StringBuilder out = new StringBuilder();
        for (Size s : sizes) {
            if (out.length() > 0) out.append(", ");
            out.append(modeName(s));
        }
        return out.toString();
    }

    /**
     * Video modes to try, best first: MJPEG — what capture devices deliver at
     * full rate over USB 2 — from the largest up to 1080p, then uncompressed
     * YUYV up to 720p (it saturates the bus above that). Later entries are the
     * fallbacks for a device that will not stream in its best mode.
     */
    static List<Size> rankSizes(List<Size> sizes) {
        List<Size> mjpeg = new ArrayList<>();
        List<Size> yuyv = new ArrayList<>();
        if (sizes != null) {
            for (Size s : sizes) {
                if (s.type == UVCCamera.UVC_VS_FRAME_MJPEG && s.width <= MAX_WIDTH) mjpeg.add(s);
                else if (s.type == UVCCamera.UVC_VS_FRAME_UNCOMPRESSED && s.width <= 1280) yuyv.add(s);
            }
        }
        java.util.Comparator<Size> byArea = (a, b) -> {
            long d = (long) b.width * b.height - (long) a.width * a.height;
            return d != 0 ? Long.signum(d) : b.fps - a.fps;
        };
        mjpeg.sort(byArea);
        yuyv.sort(byArea);
        List<Size> ranked = new ArrayList<>(dedupe(mjpeg));
        ranked.addAll(dedupe(yuyv));
        return ranked;
    }

    /** One entry per resolution — a second frame rate of it is no new fallback. */
    private static List<Size> dedupe(List<Size> sizes) {
        List<Size> out = new ArrayList<>();
        for (Size s : sizes) {
            boolean seen = false;
            for (Size o : out) {
                if (o.width == s.width && o.height == s.height) {
                    seen = true;
                    break;
                }
            }
            if (!seen) out.add(s);
        }
        return out;
    }

    // ── Frames ───────────────────────────────────────────────────────

    private final IFrameCallback frameCallback = new IFrameCallback() {
        @Override
        public void onFrame(ByteBuffer frame) {
            // Drop a frame rather than queue it when the encoder is still busy:
            // the preview only ever needs the newest one.
            if (!encoding.compareAndSet(false, true)) return;

            // Trust the frame, not the mode requested: a device can ignore the
            // size it was asked for, and decoding NV21 at the wrong size gives
            // nothing usable. An NV21 frame is width × height × 1.5 bytes.
            int length = frame.remaining();
            if (length != width * height * 3 / 2 && !adoptSizeFor(length)) {
                if (!frameSizeWarned) {
                    frameSizeWarned = true;
                    control.post(() -> log("Frame is " + length + " bytes, matching no known video mode"));
                }
                encoding.set(false);
                return;
            }
            final int w = width;
            final int h = height;
            if (nv21 == null || nv21.length != length) nv21 = new byte[length];
            final byte[] buf = nv21;
            frame.get(buf, 0, length);
            encoder.execute(() -> {
                try {
                    YuvImage image = new YuvImage(buf, ImageFormat.NV21, w, h, null);
                    ByteArrayOutputStream out = new ByteArrayOutputStream(w * h / 4);
                    if (!image.compressToJpeg(new Rect(0, 0, w, h), JPEG_QUALITY, out)) {
                        throw new IllegalStateException("compressToJpeg returned false");
                    }
                    publish(out.toByteArray());
                    if (++framesReceived == 1) {
                        control.post(() -> {
                            control.removeCallbacks(firstFrameWatchdog);
                            log("Streaming " + w + "x" + h);
                            setState("streaming", null);
                        });
                    }
                } catch (Exception e) {
                    if (!frameSizeWarned) {
                        frameSizeWarned = true;
                        control.post(() -> log("Frame encode failed: " + e.getMessage()));
                    }
                } finally {
                    encoding.set(false);
                }
            });
        }
    };

    /** Switch to the video mode whose NV21 frame is {@code length} bytes. */
    private boolean adoptSizeFor(int length) {
        for (Size s : candidates) {
            if (s.width * s.height * 3 / 2 == length) {
                final int w = s.width;
                final int h = s.height;
                width = w;
                height = h;
                control.post(() -> log("Device sends " + w + "x" + h + " frames"));
                return true;
            }
        }
        return false;
    }

    private void publish(byte[] jpeg) {
        synchronized (frameLock) {
            latestJpeg = jpeg;
            frameSeq++;
            frameLock.notifyAll();
        }
    }

    private void clearFrames() {
        synchronized (frameLock) {
            latestJpeg = null;
            frameLock.notifyAll();
        }
    }

    /** Newest JPEG, or null when nothing is streaming. */
    byte[] latestFrame() {
        synchronized (frameLock) {
            return latestJpeg;
        }
    }

    /**
     * Wait for a frame newer than {@code afterSeq}. Returns the frame and its
     * sequence number, or null on timeout.
     */
    Object[] awaitFrame(long afterSeq, long timeoutMs) throws InterruptedException {
        long end = System.currentTimeMillis() + timeoutMs;
        synchronized (frameLock) {
            while (frameSeq <= afterSeq || latestJpeg == null) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) return null;
                frameLock.wait(left);
            }
            return new Object[]{latestJpeg, frameSeq};
        }
    }

    // ── Status ───────────────────────────────────────────────────────

    private void setState(String next, String message) {
        state = next;
        error = message;
        changed();
    }

    private void log(String line) {
        Log.i(TAG, line);
        synchronized (log) {
            log.addLast(clock.format(new Date()) + "  " + line);
            while (log.size() > LOG_LINES) log.removeFirst();
        }
        changed();
    }

    public JSONObject toJson() {
        JSONObject json = new JSONObject();
        try {
            boolean streaming = "streaming".equals(state);
            json.put("connected", streaming);
            json.put("state", state);
            json.put("model", deviceName != null ? deviceName : JSONObject.NULL);
            json.put("mode", "uvc");
            json.put("device", deviceName != null ? deviceName : JSONObject.NULL);
            json.put("error", error != null ? error : JSONObject.NULL);
            json.put("testPattern", testPattern != null);
            json.put("frames", framesReceived);
            JSONArray lines = new JSONArray();
            synchronized (log) {
                for (String line : log) lines.put(line);
            }
            json.put("log", lines);
            JSONObject preview = new JSONObject();
            preview.put("width", width);
            preview.put("height", height);
            preview.put("fps", fps);
            json.put("preview", preview);
        } catch (JSONException ignored) {
        }
        return json;
    }

    // ── Test pattern (debug builds only) ─────────────────────────────

    /**
     * A moving 1280×720 pattern in place of a capture device, so the whole
     * USB-camera path of the booth can be exercised on an emulator, which has
     * no USB. Never reachable from a release build (see the plugin).
     */
    public void startTestPattern() {
        control.post(() -> {
            if (testPattern != null) return;
            width = 1280;
            height = 720;
            fps = 25;
            deviceName = "Test pattern";
            testPattern = new Thread(() -> {
                Bitmap bitmap = Bitmap.createBitmap(1280, 720, Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(bitmap);
                Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
                long tick = 0;
                while (!Thread.currentThread().isInterrupted()) {
                    canvas.drawColor(Color.rgb(40, 40, 60));
                    paint.setColor(Color.rgb(235, 76, 76));
                    canvas.drawCircle(640 + (float) (400 * Math.sin(tick / 12.0)), 360, 120, paint);
                    paint.setColor(Color.WHITE);
                    paint.setTextSize(64);
                    canvas.drawText("USB TEST " + tick, 60, 100, paint);
                    paint.setColor(Color.rgb(0, 160, 255));
                    canvas.drawRect(0, 620, 200, 720, paint); // left marker, to check mirroring
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
                    publish(out.toByteArray());
                    tick++;
                    try {
                        Thread.sleep(40);
                    } catch (InterruptedException e) {
                        break;
                    }
                }
            }, "usb-test-pattern");
            testPattern.start();
            setState("streaming", null);
        });
    }

    private void stopTestPattern() {
        if (testPattern != null) {
            testPattern.interrupt();
            testPattern = null;
        }
    }
}
