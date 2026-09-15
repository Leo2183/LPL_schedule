package com.lplsched.app;

import android.app.Activity;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * LOL 赛事 APK 壳：
 * 1) 把 assets/nodejs-project 拷贝到应用私有目录（首次）
 * 2) 在后台线程启动 Node（跑 server.js，监听 127.0.0.1:45231）
 * 3) WebView 加载 http://127.0.0.1:45231/
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

    // WebView 主文档加载重试：Node 未就绪时 loadUrl 会失败（连接拒绝），
    // 按递增退避重试；曾加载成功后不再自动重试（Node 单实例不会中途退出）
    private static final int LOAD_MAX_RETRIES = 6;
    private static final long LOAD_RETRY_STEP_MS = 2000L;
    private static final long LOAD_RETRY_MAX_DELAY_MS = 15000L;
    private boolean pageLoaded = false;
    private boolean showingFailPage = false;
    private int loadRetries = 0;

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
        // 禁用用户缩放/缩放控件，避免缩放或边缘把页面整体平移出屏
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        // 页面加载完成时把状态栏高度注入给前端（CSS 变量 --statusbar-h），
        // 前端 sticky 顶栏据此在沉浸式布局下避让状态栏（背景铺满、内容不前空）。
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(android.webkit.WebView view, String url, android.graphics.Bitmap favicon) {
                // 从失败占位页点"重试"进入新一轮加载时，重置退避计数
                if (url != null && url.startsWith(SERVER_URL) && showingFailPage) {
                    showingFailPage = false;
                    loadRetries = 0;
                }
            }

            @Override
            public void onPageFinished(android.webkit.WebView view, String url) {
                if (url != null && url.startsWith(SERVER_URL)) pageLoaded = true;
                // 状态栏高度（物理像素）转为 CSS px(=dp)，避免高 DPI 下留白过大
                int h = getStatusBarHeight();
                float density = getResources().getDisplayMetrics().density;
                int hDp = Math.round(h / density);
                String js = "document.documentElement.style.setProperty('--statusbar-h', '" + hDp + "px')";
                view.evaluateJavascript(js, null);
            }

            // API 23+：主文档加载失败（Node 未就绪/启动失败）→ 退避重试；子资源失败忽略
            @Override
            public void onReceivedError(android.webkit.WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) scheduleLoadRetry();
            }

            // API 21-22 只回调旧签名（主资源失败）
            @Override
            public void onReceivedError(android.webkit.WebView view, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) scheduleLoadRetry();
            }
        });
        webView.setBackgroundColor(0xFF0D1017);
        setContentView(webView);

        // ===== 系统栏适配（沉浸式）=====
        // WebView 全屏延伸到状态栏后，状态栏透明，前端顶栏背景自然盖住顶部，
        // 内容通过注入的 --statusbar-h 精确避让，滚动时也不遮挡。
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
        getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);

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
                        // [正式模式] 启动 Node 跑 server.js（监听 127.0.0.1:45231）
                        String serverJs = new File(projectDir, "server.js").getAbsolutePath();
                        startNodeWithArguments(new String[]{"node", serverJs});
                    } catch (Throwable t) {
                        t.printStackTrace();
                    }
                }
            }).start();
        }

        // 首次加载不探测健康接口：Java 层 HttpURLConnection 在本机（Android 16）访问
        // 127.0.0.1 监听端口会被系统拦截超时；故延时后直接 loadUrl，靠 onReceivedError
        // 退避重试兜底（WebView 的 Chromium 网络栈与 Java 网络栈不同，不受该拦截影响）。
        // 首次尝试 3 秒（二次启动 Node 通常 1~2 秒就绪）；冷启动较慢由重试覆盖。
        mainHandler = new Handler(Looper.getMainLooper());
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                webView.loadUrl(SERVER_URL);
            }
        }, 3000);
    }

    // 主文档加载失败：先用"启动中"占位盖住 WebView 的错误页，再按 2s/4s/6s…（上限 15s）重试；
    // 连续 LOAD_MAX_RETRIES 次仍失败则展示带手动重试链接的失败页
    private void scheduleLoadRetry() {
        if (pageLoaded || isFinishing()) return;
        if (loadRetries >= LOAD_MAX_RETRIES) {
            showLoadFailedNotice();
            return;
        }
        loadRetries++;
        showStartingNotice();
        long delay = Math.min(LOAD_RETRY_MAX_DELAY_MS, LOAD_RETRY_STEP_MS * loadRetries);
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!pageLoaded && !isFinishing()) webView.loadUrl(SERVER_URL);
            }
        }, delay);
    }

    private void showLoadFailedNotice() {
        showingFailPage = true;
        String html = "<html><head><meta name='viewport' content='width=device-width, initial-scale=1'>" +
                "<style>body{margin:0;background:#0f1419;color:#9aa7b5;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif}" +
                "a{color:#6ab0f3;text-decoration:none;font-size:15px}</style>" +
                "</head><body><div style='text-align:center'>" +
                "<div style='font-size:40px;margin-bottom:12px'>⚠️</div>" +
                "<div style='color:#d7e0ea;font-size:16px'>本地服务启动失败</div>" +
                "<div style='margin-top:8px;font-size:13px'>多次自动重试未成功，请点击重试；<br>若仍失败请完全退出应用后重新打开</div>" +
                "<div style='margin-top:16px'><a href='" + SERVER_URL + "'>↻ 重试</a></div>" +
                "</div></body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
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

    /**
     * 获取系统状态栏高度（像素）。
     * 优先用系统 status_bar_height 资源（可靠、固定值），再以 WindowInsets 校正。
     */
    private int getStatusBarHeight() {
        int h = 0;
        // 优先：系统资源（不依赖 insets 时序，确定能取到）
        int resId = getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (resId > 0) h = getResources().getDimensionPixelSize(resId);
        // 校正：API 30+ 以 WindowInsets 的实际值优先
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.view.WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
            if (insets != null) {
                android.graphics.Insets bars = insets.getInsetsIgnoringVisibility(
                        android.view.WindowInsets.Type.systemBars());
                if (bars != null && bars.top > 0) h = bars.top;
            }
        }
        if (h == 0) {
            // 极端兜底：按常规密度估算（160dpi 基准 24dp）
            h = Math.round(24 * getResources().getDisplayMetrics().density);
        }
        return h;
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
