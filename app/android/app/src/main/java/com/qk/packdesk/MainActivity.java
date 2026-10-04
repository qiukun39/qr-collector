package com.qk.packdesk;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final int REQ_PERMS = 9001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自写插件必须在 super.onCreate 之前注册
        registerPlugin(MediaSavePlugin.class);
        super.onCreate(savedInstanceState);

        // 打包台上手机长时间亮屏，避免录像中途熄屏
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // WebView 里的 <video autoplay> 和 getUserMedia 不能要求用户手势
        WebSettings ws = this.getBridge().getWebView().getSettings();
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);

        requestNeededPermissions();
    }

    private void requestNeededPermissions() {
        String[] perms = new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO};
        boolean missing = false;
        for (String p : perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                missing = true;
                break;
            }
        }
        if (missing) {
            ActivityCompat.requestPermissions(this, perms, REQ_PERMS);
        }
    }
}
