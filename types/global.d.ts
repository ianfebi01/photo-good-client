/* eslint-disable no-var */

/**
 * Runtime override for the camera service URL — set this in the browser console
 * to point the photobooth at a local Python camera service without rebuilding.
 *
 * Example:
 *   __CAMERA_SERVICE_URL = "http://192.168.1.100:8088"
 */
declare var __CAMERA_SERVICE_URL: string | undefined;
