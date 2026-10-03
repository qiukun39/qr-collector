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

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 把文件写进系统公共目录。
 *
 * 安卓 11 起 Android/data/<包名> 对第三方文件管理器关闭，存那里的文件用户看不到，
 * 必须走 MediaStore：
 *   video / image -> DCIM/<相册名>
 *   doc           -> Download/<相册名>
 *
 * 一次性把整个文件 base64 丢过桥，几十 MB 的视频会撑爆（表现为「数据解码失败」，
 * 小文件也慢），所以提供 begin / append / end 分片写入。
 */
@CapacitorPlugin(name = "MediaSave")
public class MediaSavePlugin extends Plugin {

    private static class Session {
        Uri uri;            // API 29+ 用
        File file;          // API 28- 用
        OutputStream out;
        String path;
        String mime;
        boolean legacy;
        long written;
    }

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

    private boolean isMedia(String kind) {
        return "video".equals(kind) || "image".equals(kind);
    }

    @PluginMethod
    public void begin(PluginCall call) {
        String name = call.getString("name");
        String mime = call.getString("mime", "application/octet-stream");
        String kind = call.getString("kind", "doc");
        String album = call.getString("album", "打包留证");

        if (name == null || name.isEmpty()) {
            call.reject("缺少文件名");
            return;
        }

        Context ctx = getContext();
        Session s = new Session();
        s.mime = mime;

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                String relPath = (isMedia(kind) ? Environment.DIRECTORY_DCIM
                        : Environment.DIRECTORY_DOWNLOADS) + File.separator + album;

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

                s.uri = ctx.getContentResolver().insert(collection, cv);
                if (s.uri == null) {
                    call.reject("系统拒绝创建文件（可能同名文件被占用）");
                    return;
                }
                OutputStream raw = ctx.getContentResolver().openOutputStream(s.uri);
                if (raw == null) {
                    call.reject("无法打开写入流");
                    return;
                }
                s.out = new BufferedOutputStream(raw, 1 << 16);
                s.path = relPath + File.separator + name;
                s.legacy = false;
            } else {
                File base = Environment.getExternalStoragePublicDirectory(
                        isMedia(kind) ? Environment.DIRECTORY_DCIM : Environment.DIRECTORY_DOWNLOADS);
                File dir = new File(base, album);
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("无法创建目录：" + dir.getAbsolutePath());
                    return;
                }
                s.file = new File(dir, name);
                s.out = new BufferedOutputStream(new FileOutputStream(s.file), 1 << 16);
                s.path = s.file.getAbsolutePath();
                s.legacy = true;
            }

            String token = UUID.randomUUID().toString();
            sessions.put(token, s);

            JSObject r = new JSObject();
            r.put("token", token);
            r.put("path", s.path);
            call.resolve(r);

        } catch (Exception e) {
            cleanup(s, true);
            call.reject("创建文件失败：" + e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    @PluginMethod
    public void append(PluginCall call) {
        String token = call.getString("token");
        String data = call.getString("data");
        Session s = token == null ? null : sessions.get(token);
        if (s == null) {
            call.reject("写入会话已失效，请重试");
            return;
        }
        if (data == null) {
            call.reject("缺少数据");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            s.out.write(bytes);
            s.written += bytes.length;
            JSObject r = new JSObject();
            r.put("written", s.written);
            call.resolve(r);
        } catch (OutOfMemoryError oom) {
            call.reject("内存不足，请把分片调小");
        } catch (Exception e) {
            call.reject("写入失败：" + e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    @PluginMethod
    public void end(PluginCall call) {
        String token = call.getString("token");
        Session s = token == null ? null : sessions.remove(token);
        if (s == null) {
            call.reject("写入会话已失效");
            return;
        }
        try {
            s.out.flush();
            s.out.close();
            s.out = null;

            if (!s.legacy) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContext().getContentResolver().update(s.uri, done, null, null);
            } else {
                // 老系统要手动通知媒体库，否则相册和文件管理器看不到
                MediaScannerConnection.scanFile(getContext(),
                        new String[]{s.file.getAbsolutePath()}, new String[]{s.mime}, null);
            }

            JSObject r = new JSObject();
            r.put("path", s.path);
            r.put("uri", s.legacy ? Uri.fromFile(s.file).toString() : s.uri.toString());
            r.put("size", s.written);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("收尾失败：" + e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    /** 中途失败时把半截文件清掉，别留垃圾 */
    @PluginMethod
    public void abort(PluginCall call) {
        String token = call.getString("token");
        Session s = token == null ? null : sessions.remove(token);
        cleanup(s, true);
        call.resolve();
    }

    private void cleanup(Session s, boolean deleteFile) {
        if (s == null) return;
        try { if (s.out != null) s.out.close(); } catch (Exception ignored) {}
        if (!deleteFile) return;
        try {
            if (s.uri != null) getContext().getContentResolver().delete(s.uri, null, null);
            else if (s.file != null && s.file.exists()) s.file.delete();
        } catch (Exception ignored) {}
    }
}
