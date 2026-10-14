package com.photogood.booth.usbcamera;

import android.Manifest;
import android.content.pm.ApplicationInfo;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;

/**
 * The booth page's handle on {@link UsbCameraService}: start it, read its state,
 * and hear about devices being plugged in or pulled ("change" events). Frames
 * themselves go over the service's local HTTP endpoints, not through the bridge.
 *
 * Android only lets an app use a USB camera once the CAMERA permission is
 * granted, so `start` asks for it first.
 */
@CapacitorPlugin(
    name = "UsbCamera",
    permissions = { @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }) }
)
public class UsbCameraPlugin extends Plugin {

    private UsbCameraService service;

    @Override
    public void load() {
        service = UsbCameraService.get(getContext());
        service.setListener(() -> notifyListeners("change", state()));
    }

    private JSObject state() {
        try {
            return JSObject.fromJSONObject(service.toJson());
        } catch (JSONException e) {
            return new JSObject();
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        service.start();
        call.resolve(state());
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Camera permission is required to use a USB capture device");
            return;
        }
        service.start();
        call.resolve(state());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        service.stop();
        call.resolve(state());
    }

    /** Debug builds only: feed a moving test pattern instead of a device. */
    @PluginMethod
    public void startTestPattern(PluginCall call) {
        boolean debuggable = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable) {
            call.reject("Not available in release builds");
            return;
        }
        service.startTestPattern();
        call.resolve(state());
    }

    @Override
    protected void handleOnDestroy() {
        service.stop();
    }
}
