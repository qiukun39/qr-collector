package com.qk.packdesk;

import android.content.ContentValues;
import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
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
import java.nio.ByteBuffer;
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
        boolean cache;      // 先落到应用缓存，后面再 remux 进相册
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

        String dest = call.getString("dest", "media");
        Context ctx = getContext();
        Session s = new Session();
        s.mime = mime;

        try {
            if ("cache".equals(dest)) {
                // 录像要先落到缓存，remux 补完时长索引后再进相册
                File dir = new File(ctx.getCacheDir(), "export");
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("无法创建缓存目录");
                    return;
                }
                s.file = new File(dir, name);
                s.out = new BufferedOutputStream(new FileOutputStream(s.file), 1 << 16);
                s.path = s.file.getAbsolutePath();
                s.cache = true;
                s.legacy = true;

                String tk = UUID.randomUUID().toString();
                sessions.put(tk, s);
                JSObject rr = new JSObject();
                rr.put("token", tk);
                rr.put("path", s.path);
                call.resolve(rr);
                return;
            }

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

            if (s.cache) {
                // 缓存文件，不进媒体库
            } else if (!s.legacy) {
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

    /**
     * 把 MediaRecorder 产出的流式 MP4 重新封装成标准 MP4。
     *
     * MediaRecorder 边录边吐，文件头里没有完整的 moov —— 没有时长、没有关键帧索引表。
     * 结果就是相册显示 1 秒、进度条拖不动，但顺着播又是完整的。
     * 这里只搬运已编码的数据，不重新编码，所以很快也不掉画质。
     */
    @PluginMethod
    public void remux(PluginCall call) {
        String src = call.getString("srcPath");
        String name = call.getString("name");
        String kind = call.getString("kind", "video");
        String mime = call.getString("mime", "video/mp4");
        String album = call.getString("album", "打包留证");

        if (src == null || name == null) { call.reject("缺少参数"); return; }
        File in = new File(src);
        if (!in.exists()) { call.reject("源文件不存在"); return; }

        MediaExtractor ex = null;
        MediaMuxer mx = null;
        Uri outUri = null;
        File outFile = null;
        android.os.ParcelFileDescriptor pfd = null;
        String shownPath;
        Context ctx = getContext();

        try {
            ex = new MediaExtractor();
            ex.setDataSource(in.getAbsolutePath());
            int n = ex.getTrackCount();
            if (n <= 0) { call.reject("源文件没有可用轨道"); return; }

            // MP4 容器只认 H.264/H.265 + AAC 这类；VP8/VP9/Opus 塞不进去
            for (int i = 0; i < n; i++) {
                String m = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
                if (m == null) continue;
                boolean ok = m.startsWith("video/avc") || m.startsWith("video/hevc")
                        || m.startsWith("audio/mp4a") || m.startsWith("audio/aac");
                if (!ok) {
                    JSObject r = new JSObject();
                    r.put("remuxed", false);
                    r.put("reason", "编码格式 " + m + " 不能装进 MP4");
                    call.resolve(r);
                    return;
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                String relPath = Environment.DIRECTORY_DCIM + File.separator + album;
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, relPath);
                cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                outUri = ctx.getContentResolver().insert(
                        MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), cv);
                if (outUri == null) { call.reject("系统拒绝创建文件"); return; }
                pfd = ctx.getContentResolver().openFileDescriptor(outUri, "rw");
                if (pfd == null) { call.reject("无法打开输出文件"); return; }
                mx = new MediaMuxer(pfd.getFileDescriptor(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
                shownPath = relPath + File.separator + name;
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DCIM), album);
                if (!dir.exists()) dir.mkdirs();
                outFile = new File(dir, name);
                mx = new MediaMuxer(outFile.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
                shownPath = outFile.getAbsolutePath();
            }

            int[] map = new int[n];
            int maxBuf = 1 << 20;
            for (int i = 0; i < n; i++) {
                MediaFormat f = ex.getTrackFormat(i);
                if (f.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                    int v = f.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE);
                    if (v > maxBuf) maxBuf = v;
                }
                map[i] = mx.addTrack(f);
                ex.selectTrack(i);
            }
            mx.start();

            ByteBuffer buf = ByteBuffer.allocate(maxBuf);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long lastUs = 0;
            while (true) {
                int size = ex.readSampleData(buf, 0);
                if (size < 0) break;
                int track = ex.getSampleTrackIndex();
                long us = ex.getSampleTime();
                if (us > lastUs) lastUs = us;
                info.offset = 0;
                info.size = size;
                info.presentationTimeUs = us;
                info.flags = ex.getSampleFlags();
                mx.writeSampleData(map[track], buf, info);
                ex.advance();
            }

            mx.stop(); mx.release(); mx = null;
            if (pfd != null) { pfd.close(); pfd = null; }

            if (outUri != null) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                ctx.getContentResolver().update(outUri, done, null, null);
            } else if (outFile != null) {
                MediaScannerConnection.scanFile(ctx, new String[]{outFile.getAbsolutePath()},
                        new String[]{mime}, null);
            }

            JSObject r = new JSObject();
            r.put("remuxed", true);
            r.put("path", shownPath);
            r.put("durationMs", lastUs / 1000);
            r.put("uri", outUri != null ? outUri.toString() : Uri.fromFile(outFile).toString());
            call.resolve(r);

        } catch (Exception e) {
            try { if (mx != null) { mx.release(); } } catch (Exception ignored) {}
            try { if (pfd != null) pfd.close(); } catch (Exception ignored) {}
            try { if (outUri != null) ctx.getContentResolver().delete(outUri, null, null); } catch (Exception ignored) {}
            try { if (outFile != null && outFile.exists()) outFile.delete(); } catch (Exception ignored) {}
            JSObject r = new JSObject();
            r.put("remuxed", false);
            r.put("reason", e.getClass().getSimpleName() + " " + e.getMessage());
            call.resolve(r);   // 不当成失败，让前端退回原样保存
        } finally {
            try { if (ex != null) ex.release(); } catch (Exception ignored) {}
        }
    }

    /** 删掉缓存里的临时文件 */
    @PluginMethod
    public void rm(PluginCall call) {
        String path = call.getString("path");
        try {
            if (path != null) {
                File f = new File(path);
                if (f.exists() && f.getAbsolutePath().startsWith(getContext().getCacheDir().getAbsolutePath())) f.delete();
            }
        } catch (Exception ignored) {}
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
