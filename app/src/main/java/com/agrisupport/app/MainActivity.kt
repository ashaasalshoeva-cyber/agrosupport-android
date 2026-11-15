package com.agrisupport.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLConnection

/**
 * Native shell for the AgriSupport (AAIAP) web application.
 *
 * The web app lives in app/src/main/assets and is served to the WebView through the virtual
 * origin https://appassets.androidplatform.net/ so that ES modules, localStorage and relative
 * URLs behave exactly as on a normal website, without enabling file:// access.
 *
 * Requests the website used to send to its Python server (/api/..., /uploads/...) are answered
 * by [ApiBridge]: with built-in read-only data, or forwarded to BuildConfig.API_BASE if set.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var loading: View
    private lateinit var errorScreen: View
    private lateinit var offlineBanner: View

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pageLoadedOffline = false
    private var mainFrameFailed = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)

        // Android 15 draws edge-to-edge by default: keep content between the system bars.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        webView = findViewById(R.id.webView)
        loading = findViewById(R.id.loading)
        errorScreen = findViewById(R.id.errorScreen)
        offlineBanner = findViewById(R.id.offlineBanner)
        findViewById<View>(R.id.errorRetry).setOnClickListener { reloadPage() }
        findViewById<View>(R.id.bannerRetry).setOnClickListener { reloadPage() }

        configureWebView()

        // Restore the page after the system killed the process; if nothing could be restored, open the start page.
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            loadHome()
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = handleBack()
        })
        registerNetworkCallback()
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.setBackgroundColor(getColor(R.color.forest_dark))
        webView.settings.apply {
            javaScriptEnabled = true          // the web app is a JavaScript application
            domStorageEnabled = true          // localStorage: language, theme, saved calculations
            allowFileAccess = false           // no file:// access
            allowContentAccess = true         // content:// is needed for the file picker result
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
            builtInZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        // No addJavascriptInterface: the page cannot call into Android.
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                serveLocal(request)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == LOCAL_HOST) return false
                // Any other link (sources, agencies) opens in the user's browser, never inside the app.
                if (uri.scheme == "https" || uri.scheme == "http") {
                    try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: Exception) { }
                }
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                mainFrameFailed = false
                pageLoadedOffline = !isOnline()
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (!mainFrameFailed) {
                    errorScreen.visibility = View.GONE
                    loading.visibility = View.GONE
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    mainFrameFailed = true
                    loading.visibility = View.GONE
                    errorScreen.visibility = View.VISIBLE
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(buildPickerIntent(params.acceptTypes), FILE_PICKER_REQUEST)
                    true
                } catch (_: Exception) {
                    fileCallback = null
                    false
                }
            }
        }
    }

    private fun buildPickerIntent(acceptTypes: Array<String>?): Intent {
        val mimes = linkedSetOf<String>()
        acceptTypes.orEmpty().flatMap { it.split(",") }.map { it.trim() }.filter { it.isNotEmpty() }.forEach {
            when {
                it == ".json" || it == ".geojson" -> mimes += "application/json"
                it == ".jpg" || it == ".jpeg" -> mimes += "image/jpeg"
                it == ".png" -> mimes += "image/png"
                it == ".webp" -> mimes += "image/webp"
                !it.startsWith(".") -> mimes += it
            }
        }
        if ("application/json" in mimes) { mimes += "application/geo+json"; mimes += "text/plain" }
        return Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            if (mimes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_PICKER_REQUEST) {
            val uri = if (resultCode == RESULT_OK) data?.data else null
            fileCallback?.onReceiveValue(uri?.let { arrayOf(it) })
            fileCallback = null
        }
    }

    private fun loadHome() {
        loading.visibility = View.VISIBLE
        errorScreen.visibility = View.GONE
        webView.loadUrl("https://$LOCAL_HOST/index.html")
    }

    private fun reloadPage() {
        loading.visibility = View.VISIBLE
        errorScreen.visibility = View.GONE
        if (webView.url.isNullOrEmpty()) loadHome() else webView.reload()
    }

    // ---------------------------------------------------------------- Local assets and API

    private fun serveLocal(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (uri.scheme != "https" || uri.host != LOCAL_HOST) return null
        var path = uri.path ?: return ApiBridge.json(404, """{"error":"Not found"}""")
        if (path.contains("..")) return ApiBridge.json(404, """{"error":"Not found"}""")
        if (path == "/") path = "/index.html"
        if (path.startsWith("/__ext/")) {
            return ApiBridge.external(request.method, path, uri.encodedQuery)
        }
        if (path.startsWith("/api/") || path.startsWith("/uploads/")) {
            return ApiBridge.handle(request.method, path, uri.query)
        }
        return try {
            val name = path.removePrefix("/")
            val stream = assets.open(name)
            val mime = when {
                name.endsWith(".html") -> "text/html"
                name.endsWith(".json") -> "application/json"
                name.endsWith(".js") || name.endsWith(".mjs") -> "application/javascript"
                name.endsWith(".css") -> "text/css"
                name.endsWith(".svg") -> "image/svg+xml"
                name.endsWith(".png") -> "image/png"
                name.endsWith(".jpg") || name.endsWith(".jpeg") -> "image/jpeg"
                name.endsWith(".webp") -> "image/webp"
                else -> URLConnection.guessContentTypeFromName(name) ?: "application/octet-stream"
            }
            WebResourceResponse(mime, "UTF-8", stream)
        } catch (_: IOException) {
            ApiBridge.json(404, """{"error":"Not found"}""")
        }
    }

    // ---------------------------------------------------------------- Network state

    private fun isOnline(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun registerNetworkCallback() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        offlineBanner.visibility = if (isOnline()) View.GONE else View.VISIBLE
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                runOnUiThread {
                    offlineBanner.visibility = View.GONE
                    // The page was opened without internet (map library and fonts were missing): reload it.
                    if (pageLoadedOffline || mainFrameFailed) reloadPage()
                }
            }
            override fun onLost(network: Network) {
                runOnUiThread { if (!isOnline()) offlineBanner.visibility = View.VISIBLE }
            }
        }
        networkCallback = cb
        try { cm.registerDefaultNetworkCallback(cb) } catch (_: Exception) { networkCallback = null }
    }

    // ---------------------------------------------------------------- Back button

    /** Closes the photo editor -> field card -> map -> crop/catalog -> start page -> leaves the app. */
    private fun handleBack() {
        val js = """(function(){
            var e=document.getElementById('photoEditorBackdrop');
            if(e&&!e.hidden){var x=document.getElementById('photoEditorClose');if(x){x.click();return 'handled';}}
            var p=document.getElementById('fieldPage');
            if(p&&!p.hidden){var b=p.querySelector('.back-btn');if(b){b.click();return 'handled';}}
            if(document.body.classList.contains('map-visible')){var m=document.getElementById('backToPortal');if(m){m.click();return 'handled';}}
            if(document.querySelector('#portalContent .welcome-layout'))return 'exit';
            var h=document.getElementById('homeBrand');if(h){h.click();return 'handled';}
            return 'exit';})()"""
        webView.evaluateJavascript(js) { result ->
            if (result != "\"handled\"") finish()
        }
    }

    // ---------------------------------------------------------------- Lifecycle

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        val cm = getSystemService(ConnectivityManager::class.java)
        networkCallback?.let { try { cm?.unregisterNetworkCallback(it) } catch (_: Exception) { } }
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        (webView.parent as? android.view.ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val LOCAL_HOST = "appassets.androidplatform.net"
        private const val FILE_PICKER_REQUEST = 1001
    }
}

/**
 * Replaces the website's Python server inside the app.
 *
 *  - /api/sites, /api/photos, /api/community/photos, /api/health, /api/admin/status are answered
 *    with read-only built-in data (same shape as server.py).
 *  - If BuildConfig.API_BASE is set, read-only data routes (everything under /api/data/ and
 *    /api/science/, plus /api/agro/weather, /api/photos, /api/community/photos and everything under /uploads/) are forwarded to
 *    that server over HTTPS.
 *  - Everything else answers 503/404, which the web app already shows as "source unavailable".
 */
object ApiBridge {
    private val SITE_JSON = """{"id":"USA-NE-SCAL","name":"South Central Agricultural Laboratory (UNL)","region":"USA-NE-SC","state":"Nebraska","country":"USA","lat":40.575256,"lon":-98.137824,"area_ha":null,"location_kind":"verified-research-site-reference-point","precision_note":"Officially published coordinates identify the research laboratory, not an individual field or parcel boundary.","verified_source":"https://scal.unl.edu/location/","about_source":"https://scal.unl.edu/","documented_crops":["corn","soybean"],"documented_practices":["center-pivot irrigation","lateral-move irrigation","subsurface drip irrigation"],"public":true}"""

    fun json(code: Int, body: String): WebResourceResponse {
        val reason = when (code) { 200 -> "OK"; 404 -> "Not Found"; 405 -> "Method Not Allowed"; else -> "Service Unavailable" }
        return WebResourceResponse(
            "application/json", "UTF-8", code, reason,
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(body.toByteArray(Charsets.UTF_8))
        )
    }

    fun handle(method: String, path: String, query: String?): WebResourceResponse {
        val base = BuildConfig.API_BASE
        val readOnly = method.equals("GET", ignoreCase = true)
        val forwardable = path.startsWith("/api/data/") || path.startsWith("/api/science/") ||
            path == "/api/agro/weather" || path == "/api/photos" ||
            path == "/api/community/photos" || path.startsWith("/uploads/")
        if (base.startsWith("https://") && readOnly && forwardable) {
            return forward(base + path + (if (query != null) "?$query" else ""))
        }
        return when {
            path == "/api/health" -> json(200, """{"ok":true,"mode":"android-app"}""")
            path == "/api/sites" -> json(200, """{"sites":[$SITE_JSON]}""")
            path == "/api/photos" -> json(200, """{"photos":{},"backgrounds":{}}""")
            path == "/api/community/photos" -> json(200, """{"crop":"","photos":[]}""")
            path == "/api/admin/status" -> json(200, """{"configured":false,"authenticated":false}""")
            path.startsWith("/api/science/") -> json(503, """{"status":"unavailable","error":"source_unavailable"}""")
            path.startsWith("/api/data/") || path.startsWith("/api/agro/") ||
                path.startsWith("/api/assistant/") -> json(503, """{"error":"Source unavailable"}""")
            else -> json(404, """{"error":"Not found"}""")
        }
    }

    // Public NASA / NOAA services that the in-app data layer (js/android-api.js) may read.
    private val EXTERNAL_HOSTS = setOf("power.larc.nasa.gov", "api.weather.gov", "modis.ornl.gov")

    /** GET-only native proxy for the allowed hosts, so the page does not depend on CORS headers. */
    fun external(method: String, path: String, encodedQuery: String?): WebResourceResponse {
        if (!method.equals("GET", ignoreCase = true)) return json(405, """{"error":"Method not allowed"}""")
        val rest = path.removePrefix("/__ext/")
        val host = rest.substringBefore('/')
        if (host !in EXTERNAL_HOSTS) return json(404, """{"error":"Host not allowed"}""")
        val tail = "/" + rest.substringAfter('/', "")
        val url = "https://" + host + tail + (if (encodedQuery != null) "?$encodedQuery" else "")
        return forward(url)
    }

    private fun forward(url: String): WebResourceResponse = try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 25_000
        c.setRequestProperty("Accept", "application/json")
        c.setRequestProperty("User-Agent", "AgroSupport-Android/0.2.1 (educational research app)")
        val code = c.responseCode
        val stream = if (code >= 400) c.errorStream else c.inputStream
        val mime = c.contentType?.substringBefore(';')?.trim() ?: "application/octet-stream"
        WebResourceResponse(
            mime, "UTF-8", code, if (code == 200) "OK" else "Error",
            emptyMap(), stream ?: ByteArrayInputStream(ByteArray(0))
        )
    } catch (_: Exception) {
        json(503, """{"error":"Source unavailable"}""")
    }
}
