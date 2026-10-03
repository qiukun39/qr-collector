package com.qk.packingproof;

import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 把文件写进系统公共目录。
 *
 * 安卓 11 起，Android/data/<包名> 对第三方文件管理器关闭，存在那里的文件用户根本看不到。
 * 正确做法是走 MediaStore：免权限，写完立刻出现在相册 / 文件管理器里。
 *   video / image -> DCIM/<相册名>
 *   doc           -> Download/<相册名>
 */
@CapacitorPlugin(name = "MediaSave")
public class MediaSavePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String name = call.getString("name");
        String mime = call.getString("mime", "application/octet-stream");
        String kind = call.getString("kind", "doc");
        String data = call.getString("data");
        String album = call.getString("album", "打包留证");

        if (name == null || name.isEmpty() || data == null) {
            call.reject("缺少文件名或数据");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("数据解码失败：" + e.getMessage());
            return;
        }

        boolean isMedia = "video".equals(kind) || "image".equals(kind);
        Context ctx = getContext();

        try {
            Uri uri;
            String shown;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                String relPath = (isMedia ? Environment.DIRECTORY_DCIM : Environment.DIRECTORY_DOWNLOADS)
                        + File.separator + album;

                Uri collection;
                if ("video".equals(kind)) {
                    collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                } else if ("image".equals(kind)) {
                    collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                } else {
                    collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                }

                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, relPath);
                cv.put(MediaStore.MediaColumns.IS_PENDING, 1);

                uri = ctx.getContentResolver().insert(collection, cv);
                if (uri == null) {
                    call.reject("系统拒绝创建文件");
                    return;
                }

                OutputStream os = ctx.getContentResolver().openOutputStream(uri);
                if (os == null) {
                    call.reject("无法写入文件");
                    return;
                }
                os.write(bytes);
                os.flush();
                os.close();

                // 清掉 pending，文件才会对相册和文件管理器可见
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                ctx.getContentResolver().update(uri, done, null, null);

                shown = relPath + File.separator + name;

            } else {
                // 安卓 10 以下走传统路径，写完手动通知媒体库扫描
                File base = Environment.getExternalStoragePublicDirectory(
                        isMedia ? Environment.DIRECTORY_DCIM : Environment.DIRECTORY_DOWNLOADS);
                File dir = new File(base, album);
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("无法创建目录：" + dir.getAbsolutePath());
                    return;
                }
                File f = new File(dir, name);
                FileOutputStream fos = new FileOutputStream(f);
                fos.write(bytes);
                fos.flush();
                fos.close();

                uri = Uri.fromFile(f);
                shown = f.getAbsolutePath();
                MediaScannerConnection.scanFile(ctx, new String[]{f.getAbsolutePath()},
                        new String[]{mime}, null);
            }

            JSObject r = new JSObject();
            r.put("uri", uri.toString());
            r.put("path", shown);
            r.put("kind", kind);
            call.resolve(r);

        } catch (Exception e) {
            call.reject("保存失败：" + e.getMessage());
        }
    }
}
