package com.lplsched.app;

import android.app.Activity;
import android.content.res.AssetManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * LOL 赛事 APK 壳：
 * 1) 把 assets/nodejs-project 拷贝到应用私有目录（首次）
 * 2) 在后台线程启动 Node（跑 server.js，监听 127.0.0.1:45231）
 * 3) WebView 加载 http://127.0.0.1:45231/
 *
 * 当前处于「最小化 node 测试」模式：不跑 server.js，只执行内联脚本打印版本，
 * 用于确认 libnode 能否在目标平台上创建 V8 Isolate（排查 SIGSEGV）。
 */
public class MainActivity extends Activity {

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    private static final String NODE_PROJECT = "nodejs-project";
    private static final String SERVER_PORT = "45231";
    private static final String SERVER_URL = "http://127.0.0.1:" + SERVER_PORT + "/";

    // 每个进程只启动一次 Node（node 单实例，不可重启）
    public static boolean _startedNodeAlready = false;

    private WebView webView;
    private Handler mainHandler;

    public native Integer startNodeWithArguments(String[] arguments);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        webView.setWebViewClient(new WebViewClient());
        setContentView(webView);

        // 先显示"启动中"占位，避免白屏
        showStartingNotice();

        if (!_startedNodeAlready) {
            _startedNodeAlready = true;
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        File projectDir = new File(getFilesDir(), NODE_PROJECT);
                        if (!new File(projectDir, "server.js").exists()) {
                            deleteFolderRecursively(projectDir);
                            copyAssetFolder(getAssets(), NODE_PROJECT, projectDir.getAbsolutePath());
                        }
                        // [最小化测试] 只打印版本，不启动 server
                        startNodeWithArguments(new String[]{
                                "node", "-e",
                                "console.log('NODE_TEST_OK v' + process.version);" +
                                "console.log(JSON.stringify(process.versions));"
                        });
                    } catch (Throwable t) {
                        t.printStackTrace();
                    }
                }
            }).start();
        }

        // 轮询健康接口，Node 就绪后再加载页面
        mainHandler = new Handler(Looper.getMainLooper());
        pollServerAndLoad();
    }

    private void showStartingNotice() {
        String html = "<html><head><meta name='viewport' content='width=device-width, initial-scale=1'>" +
                "<style>body{margin:0;background:#0f1419;color:#9aa7b5;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif}</style>" +
                "</head><body><div style='text-align:center'>" +
                "<div style='font-size:40px;margin-bottom:12px'>🏆</div>" +
                "<div>LOL 赛事中心</div><div style='margin-top:8px;font-size:13px'>正在启动本地服务…</div>" +
                "</div></body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void pollServerAndLoad() {
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (isServerReady()) {
                    webView.loadUrl(SERVER_URL);
                } else {
                    mainHandler.postDelayed(this, 400);
                }
            }
        }, 400);
    }

    private boolean isServerReady() {
        try {
            URL u = new URL("http://127.0.0.1:" + SERVER_PORT + "/api/health");
            HttpURLConnection conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(800);
            conn.setReadTimeout(800);
            int code = conn.getResponseCode();
            conn.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    // ---------------- assets 拷贝辅助 ----------------
    private static boolean deleteFolderRecursively(File file) {
        try {
            boolean res = true;
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    if (child.isDirectory()) {
                        res &= deleteFolderRecursively(child);
                    } else {
                        res &= child.delete();
                    }
                }
            }
            res &= file.delete();
            return res;
        } catch (Exception e) {
            return false;
        }
    }

    private static void copyAsset(AssetManager am, String from, String to) throws IOException {
        try (InputStream in = am.open(from); FileOutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[16384];
            int len;
            while ((len = in.read(buf)) > 0) out.write(buf, 0, len);
        }
    }

    private static void copyAssetFolder(AssetManager am, String from, String to) throws IOException {
        String[] files = am.list(from);
        if (files == null || files.length == 0) {
            copyAsset(am, from, to);
            return;
        }
        new File(to).mkdirs();
        for (String f : files) {
            copyAssetFolder(am, from + "/" + f, to + "/" + f);
        }
    }
}
