package com.photogood.booth;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.photogood.booth.usbcamera.UsbCameraPlugin;
import com.photogood.booth.usbcamera.UsbCameraService;
import com.photogood.booth.usbcamera.UsbWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UsbCameraPlugin.class);
        super.onCreate(savedInstanceState);
        // Serve the USB capture device's frames to the page, same-origin.
        bridge.setWebViewClient(new UsbWebViewClient(bridge, UsbCameraService.get(this)));
    }
}
