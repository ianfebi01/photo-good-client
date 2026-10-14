package com.photogood.booth.usbcamera;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves {@link UsbCameraService}'s frames to the booth page from the page's
 * own origin, under {@code /__usb-camera/}, with the Python camera service's
 * endpoints:
 *
 *   /__usb-camera/status    JSON state of the capture device
 *   /__usb-camera/preview   MJPEG stream (each part carries a Content-Length)
 *   /__usb-camera/snapshot  the newest frame as one image/jpeg
 *
 * Answering inside the WebView, instead of from a server on 127.0.0.1, keeps the
 * frames same-origin: no CORS, no mixed content, and none of the newer WebView
 * restrictions on pages reaching local-network/loopback addresses — which is
 * what left the preview blank on real phones.
 *
 * Everything else goes to Capacitor's own handling.
 */
public class UsbWebViewClient extends BridgeWebViewClient {

    static final String PREFIX = "/__usb-camera/";
    private static final String BOUNDARY = "photoboothframe";

    private final UsbCameraService camera;

    public UsbWebViewClient(Bridge bridge, UsbCameraService camera) {
        super(bridge);
        this.camera = camera;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String path = request.getUrl().getPath();
        if (path == null || !path.startsWith(PREFIX)) return super.shouldInterceptRequest(view, request);

        switch (path.substring(PREFIX.length())) {
            case "status":
                return respond(200, "OK", "application/json",
                        camera.toJson().toString().getBytes(StandardCharsets.UTF_8));
            case "snapshot": {
                byte[] frame = camera.latestFrame();
                if (frame == null) {
                    return respond(503, "Service Unavailable", "application/json",
                            "{\"error\":\"No frame from the capture device\"}".getBytes(StandardCharsets.UTF_8));
                }
                return respond(200, "OK", "image/jpeg", frame);
            }
            case "preview":
                return new WebResourceResponse(
                        "multipart/x-mixed-replace", null, 200, "OK",
                        headers("multipart/x-mixed-replace; boundary=" + BOUNDARY),
                        new MjpegStream(camera));
            default:
                return respond(404, "Not Found", "application/json",
                        "{\"error\":\"not found\"}".getBytes(StandardCharsets.UTF_8));
        }
    }

    private static Map<String, String> headers(String contentType) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", contentType);
        headers.put("Cache-Control", "no-store, no-cache, must-revalidate");
        return headers;
    }

    private static WebResourceResponse respond(int status, String reason, String mime, byte[] body) {
        return new WebResourceResponse(mime, null, status, reason, headers(mime), new ByteArrayInputStream(body));
    }

    /**
     * An endless MJPEG body: each newest frame as one multipart part. The
     * WebView reads it on a background thread and hands the page bytes as they
     * come; closing it (the page stops reading) ends the loop.
     */
    static final class MjpegStream extends InputStream {
        private final UsbCameraService camera;
        private byte[] chunk = new byte[0];
        private int pos;
        private long seq;
        private volatile boolean closed;

        MjpegStream(UsbCameraService camera) {
            this.camera = camera;
        }

        /** Load the next part into {@code chunk}; false once closed. */
        private boolean fill() throws IOException {
            while (!closed) {
                Object[] next;
                try {
                    next = camera.awaitFrame(seq, 2_000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("interrupted");
                }
                if (next == null) continue;
                byte[] jpeg = (byte[]) next[0];
                seq = (long) next[1];
                byte[] head = ("--" + BOUNDARY + "\r\nContent-Type: image/jpeg\r\nContent-Length: "
                        + jpeg.length + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1);
                chunk = new byte[head.length + jpeg.length + 2];
                System.arraycopy(head, 0, chunk, 0, head.length);
                System.arraycopy(jpeg, 0, chunk, head.length, jpeg.length);
                chunk[chunk.length - 2] = '\r';
                chunk[chunk.length - 1] = '\n';
                pos = 0;
                return true;
            }
            return false;
        }

        @Override
        public int read() throws IOException {
            if (pos >= chunk.length && !fill()) return -1;
            return chunk[pos++] & 0xff;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            if (pos >= chunk.length && !fill()) return -1;
            int n = Math.min(len, chunk.length - pos);
            System.arraycopy(chunk, pos, b, off, n);
            pos += n;
            return n;
        }

        @Override
        public int available() {
            return chunk.length - pos;
        }

        @Override
        public void close() {
            closed = true;
        }
    }
}
