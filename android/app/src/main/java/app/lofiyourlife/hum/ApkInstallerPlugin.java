package app.lofiyourlife.hum;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Installs a new version of the app from inside the app: the APK is downloaded into the app's own
 * cache (never the Downloads folder) and handed straight to Android's installer, so the user only
 * taps "Update". The file is deleted the next time the app starts.
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    private File updateFile() {
        File dir = new File(getContext().getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, "update.apk");
    }

    @Override
    public void load() {
        // The new version is running (or the install was given up on): the file isn't needed any more.
        File f = updateFile();
        if (f.exists()) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    private boolean allowed() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls();
    }

    /** May this app install updates? (Android asks the user once, in Settings.) */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", allowed());
        call.resolve(r);
    }

    /** Open the one-time "allow this app to install updates" switch in Settings. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    /** Download the APK at `url` (https only), reporting "progress" {percent}, then open the installer. */
    @PluginMethod
    public void downloadAndInstall(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("No https url");
            return;
        }
        if (!allowed()) {
            call.reject("Installing updates isn't allowed yet", "NOT_ALLOWED");
            return;
        }
        new Thread(() -> {
            final File out = updateFile();
            HttpURLConnection c = null;
            try {
                URL u = new URL(url);
                boolean ok = false;
                // GitHub serves release files from another address: follow redirects (https only).
                for (int hop = 0; hop < 8 && !ok; hop++) {
                    c = (HttpURLConnection) u.openConnection();
                    c.setInstanceFollowRedirects(false);
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(30000);
                    int code = c.getResponseCode();
                    if (code >= 300 && code < 400) {
                        String location = c.getHeaderField("Location");
                        c.disconnect();
                        c = null;
                        if (location == null) throw new Exception("redirect without a location");
                        u = new URL(u, location);
                        if (!"https".equals(u.getProtocol())) throw new Exception("not https");
                    } else if (code == 200) {
                        ok = true;
                    } else {
                        throw new Exception("HTTP " + code);
                    }
                }
                if (!ok || c == null) throw new Exception("too many redirects");
                long total = c.getContentLengthLong();
                try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    long done = 0;
                    int lastPercent = -1;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        os.write(buf, 0, n);
                        done += n;
                        if (total > 0) {
                            int percent = (int) ((done * 100) / total);
                            if (percent != lastPercent) {
                                lastPercent = percent;
                                JSObject p = new JSObject();
                                p.put("percent", percent);
                                notifyListeners("progress", p);
                            }
                        }
                    }
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(install);
                call.resolve();
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                out.delete();
                call.reject("Couldn't get the new app: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }
}
