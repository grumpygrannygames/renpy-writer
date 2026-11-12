package com.grumpygranny.renpywriter;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Files and git, for the shared code running in the WebView.
 *
 * The shared code was written against Node, so each method here does what the
 * Node call of the same name does, and fails the same way: with an error code
 * such as ENOENT that the code above already knows how to read.
 *
 * git itself is the Termux project's Android build, packaged as libraries so
 * Android installs it somewhere a program may run from. It is run under the
 * names git expects through links in the app's own folder.
 */
@CapacitorPlugin(name = "RwHost")
public class RwHostPlugin extends Plugin {

    /** git can take minutes; files take milliseconds and should not wait behind it. */
    private final ExecutorService gitPool = Executors.newCachedThreadPool();
    private final ExecutorService filePool = Executors.newFixedThreadPool(4);

    private File gitCore;
    private File home;
    private File certs;
    private File templates;
    private String libDir;

    @Override
    public void load() {
        Context context = getContext();
        libDir = context.getApplicationInfo().nativeLibraryDir;
        File files = context.getFilesDir();
        gitCore = new File(files, "git-core");
        home = new File(files, "home");
        templates = new File(files, "git-templates");
        certs = new File(files, "cert.pem");
        try {
            prepareGit(context);
        } catch (Exception e) {
            // Said when git is first used, where somebody will see it.
            android.util.Log.e("RwHost", "Could not prepare git", e);
        }
    }

    private void prepareGit(Context context) throws IOException, ErrnoException {
        gitCore.mkdirs();
        home.mkdirs();
        templates.mkdirs();
        link("git", "libgit.so");
        link("git-remote-https", "libgitremotehttps.so");
        link("git-remote-http", "libgitremotehttps.so");
        // Copied fresh each start, so an update to the app brings new certificates.
        try (InputStream in = context.getAssets().open("git/cert.pem");
             OutputStream out = new FileOutputStream(certs)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private void link(String name, String library) throws ErrnoException {
        File at = new File(gitCore, name);
        String target = new File(libDir, library).getAbsolutePath();
        // The library folder changes when the app is updated, so the link is renewed.
        if (at.exists() || isLink(at)) at.delete();
        Os.symlink(target, at.getAbsolutePath());
    }

    private static boolean isLink(File f) {
        try {
            return OsConstants.S_ISLNK(Os.lstat(f.getAbsolutePath()).st_mode);
        } catch (ErrnoException e) {
            return false;
        }
    }

    @PluginMethod
    public void paths(PluginCall call) {
        JSObject out = new JSObject();
        out.put("files", getContext().getFilesDir().getAbsolutePath());
        out.put("cache", getContext().getCacheDir().getAbsolutePath());
        call.resolve(out);
    }

    // ---------------------------------------------------------------- files

    @PluginMethod
    public void readFile(PluginCall call) {
        filePool.execute(() -> {
            String path = call.getString("path");
            File f = new File(path);
            if (!f.exists()) { call.reject("no such file or directory", "ENOENT"); return; }
            if (f.isDirectory()) { call.reject("illegal operation on a directory", "EISDIR"); return; }
            try {
                byte[] bytes = readAll(f);
                JSObject out = new JSObject();
                if ("base64".equals(call.getString("encoding"))) {
                    out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                } else {
                    out.put("data", new String(bytes, StandardCharsets.UTF_8));
                }
                call.resolve(out);
            } catch (IOException e) {
                call.reject(e.getMessage(), "EIO");
            }
        });
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        filePool.execute(() -> {
            String path = call.getString("path");
            String data = call.getString("data", "");
            File f = new File(path);
            File parent = f.getParentFile();
            if (parent != null && !parent.isDirectory()) {
                call.reject("no such file or directory", "ENOENT");
                return;
            }
            byte[] bytes = "base64".equals(call.getString("encoding"))
                ? Base64.decode(data, Base64.DEFAULT)
                : data.getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(bytes);
                out.getFD().sync();
                call.resolve();
            } catch (IOException e) {
                call.reject(e.getMessage(), "EIO");
            }
        });
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        File f = new File(call.getString("path"));
        boolean recursive = Boolean.TRUE.equals(call.getBoolean("recursive", false));
        if (f.isDirectory()) {
            if (recursive) call.resolve();
            else call.reject("file already exists", "EEXIST");
            return;
        }
        boolean made = recursive ? f.mkdirs() : f.mkdir();
        if (made || f.isDirectory()) call.resolve();
        else call.reject("no such file or directory", f.exists() ? "EEXIST" : "ENOENT");
    }

    @PluginMethod
    public void readdir(PluginCall call) {
        File f = new File(call.getString("path"));
        if (!f.exists()) { call.reject("no such file or directory", "ENOENT"); return; }
        if (!f.isDirectory()) { call.reject("not a directory", "ENOTDIR"); return; }
        File[] children = f.listFiles();
        JSArray entries = new JSArray();
        if (children != null) {
            for (File child : children) {
                JSObject e = new JSObject();
                e.put("name", child.getName());
                e.put("isDirectory", child.isDirectory());
                entries.put(e);
            }
        }
        JSObject out = new JSObject();
        out.put("entries", entries);
        call.resolve(out);
    }

    @PluginMethod
    public void stat(PluginCall call) {
        File f = new File(call.getString("path"));
        if (!f.exists()) { call.reject("no such file or directory", "ENOENT"); return; }
        JSObject out = new JSObject();
        out.put("isFile", f.isFile());
        out.put("isDirectory", f.isDirectory());
        out.put("size", f.length());
        out.put("mtimeMs", f.lastModified());
        call.resolve(out);
    }

    @PluginMethod
    public void rename(PluginCall call) {
        try {
            // rename(2): replaces the target in one step, as Node's does.
            Os.rename(call.getString("from"), call.getString("to"));
            call.resolve();
        } catch (ErrnoException e) {
            call.reject(e.getMessage(), errnoName(e.errno));
        }
    }

    @PluginMethod
    public void rm(PluginCall call) {
        File f = new File(call.getString("path"));
        boolean recursive = Boolean.TRUE.equals(call.getBoolean("recursive", false));
        boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
        if (!f.exists() && !isLink(f)) {
            if (force) call.resolve();
            else call.reject("no such file or directory", "ENOENT");
            return;
        }
        if (f.isDirectory() && !isLink(f) && !recursive) {
            call.reject("is a directory", "EISDIR");
            return;
        }
        filePool.execute(() -> {
            if (deleteTree(f)) call.resolve();
            else call.reject("could not remove " + f, "EIO");
        });
    }

    @PluginMethod
    public void utimes(PluginCall call) {
        File f = new File(call.getString("path"));
        Double ms = call.getDouble("mtimeMs");
        if (!f.exists()) { call.reject("no such file or directory", "ENOENT"); return; }
        f.setLastModified(ms == null ? System.currentTimeMillis() : ms.longValue());
        call.resolve();
    }

    // ------------------------------------------------------------------ git

    @PluginMethod
    public void exec(PluginCall call) {
        gitPool.execute(() -> {
            try {
                JSArray args = call.getArray("args");
                List<String> command = new ArrayList<>();
                command.add(new File(gitCore, "git").getAbsolutePath());
                for (int i = 0; i < args.length(); i++) command.add(args.getString(i));

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(new File(call.getString("cwd")));
                Map<String, String> env = pb.environment();
                env.put("LD_LIBRARY_PATH", libDir);
                env.put("GIT_EXEC_PATH", gitCore.getAbsolutePath());
                env.put("HOME", home.getAbsolutePath());
                env.put("TMPDIR", getContext().getCacheDir().getAbsolutePath());
                env.put("GIT_TEMPLATE_DIR", templates.getAbsolutePath());
                env.put("GIT_SSL_CAINFO", certs.getAbsolutePath());
                env.put("SSL_CERT_FILE", certs.getAbsolutePath());
                env.put("GIT_CONFIG_NOSYSTEM", "1");
                env.put("GIT_TERMINAL_PROMPT", "0");
                env.put("GIT_PAGER", "cat");
                env.put("PAGER", "cat");
                env.put("GIT_EDITOR", "true");
                // English, because the shared code reads some of what git says.
                env.put("LC_ALL", "C");

                Process p = pb.start();
                Drain out = new Drain(p.getInputStream());
                Drain err = new Drain(p.getErrorStream());
                out.start();
                err.start();
                try (OutputStream stdin = p.getOutputStream()) {
                    String input = call.getString("stdin");
                    if (input != null && !input.isEmpty()) {
                        stdin.write(input.getBytes(StandardCharsets.UTF_8));
                    }
                } catch (IOException ignored) {
                    // git closed its input early, which is its business.
                }
                int code = p.waitFor();
                out.join();
                err.join();

                JSObject result = new JSObject();
                result.put("code", code);
                result.put("stdout", out.text());
                result.put("stderr", err.text());
                call.resolve(result);
            } catch (IOException e) {
                call.reject("git could not be started: " + e.getMessage(), "ENOENT");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "EIO");
            }
        });
    }

    /** Reads a stream to the end on its own thread, so git never blocks on a full pipe. */
    private static class Drain extends Thread {
        private final InputStream in;
        private final ByteArrayOutputStream buf = new ByteArrayOutputStream();

        Drain(InputStream in) {
            this.in = in;
        }

        @Override
        public void run() {
            byte[] chunk = new byte[65536];
            int n;
            try {
                while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            } catch (IOException ignored) {
                // The process went away; what was read is what there is.
            }
        }

        String text() {
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    // -------------------------------------------------------------- helpers

    private static byte[] readAll(File f) throws IOException {
        try (InputStream in = new java.io.FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(f.length(), 32));
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static boolean deleteTree(File f) {
        if (f.isDirectory() && !isLink(f)) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteTree(c);
        }
        return f.delete() || !f.exists();
    }

    private static String errnoName(int errno) {
        if (errno == OsConstants.ENOENT) return "ENOENT";
        if (errno == OsConstants.EEXIST) return "EEXIST";
        if (errno == OsConstants.EACCES) return "EACCES";
        if (errno == OsConstants.EPERM) return "EPERM";
        if (errno == OsConstants.EBUSY) return "EBUSY";
        if (errno == OsConstants.ENOTDIR) return "ENOTDIR";
        if (errno == OsConstants.EISDIR) return "EISDIR";
        if (errno == OsConstants.ENOTEMPTY) return "ENOTEMPTY";
        return "EIO";
    }
}
