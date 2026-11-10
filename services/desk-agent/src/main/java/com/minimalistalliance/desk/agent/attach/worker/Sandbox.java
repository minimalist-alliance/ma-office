package com.minimalistalliance.desk.agent.attach.worker;

import java.io.File;
import java.io.FilePermission;
import java.nio.file.Path;
import java.security.Permission;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * A deny-by-default Security Manager for the reader child (ADR 0049, AGENT-PARSE-1). The parent starts the child with
 * {@code -Djava.security.manager=allow}; {@link #install()} then replaces the default with this one before the file is
 * read. It does not look at who is on the stack: it answers from the permission alone, so code a parser bug started
 * has the same rights as the parser, and those are:
 * <ul>
 * <li>read the classpath's jars and the JDK's own files, nothing else, and write no file at all;</li>
 * <li>open no socket, start no process, load no native library, create no class loader, and not replace this manager;</li>
 * <li>read system properties but set none.</li>
 * </ul>
 * The file arrives on standard input and the answer leaves on standard output, which are already open, so the child
 * needs no file. This limits what the child's code can do through Java; it is not a kernel boundary (a JVM bug, or a
 * native escape, is outside it).
 */
final class Sandbox extends SecurityManager {

    /** Runtime permissions the readers truly need: reflection on their own classes, threads, exit and the like. */
    private static final Set<String> RUNTIME_ALLOWED = Set.of(
            "accessDeclaredMembers", "getClassLoader", "getProtectionDomain", "getenv.*", "modifyThread",
            "modifyThreadGroup", "stopThread", "setContextClassLoader", "getStackWalkerWithClassReference",
            "localeServiceProvider", "charsetProvider", "readFileDescriptor", "writeFileDescriptor", "setIO",
            "shutdownHooks", "getFileSystemAttributes", "accessSystemModules", "defineClassInPackage.java.lang.invoke", "jdk.internal.perf.Perf.getPerf");

    /** The JDK's own imaging and font libraries by short name, which System.loadLibrary finds only in the JDK's lib. */
    private static final Set<String> NATIVE_ALLOWED = Set.of(
            "awt", "awt_headless", "fontmanager", "javajpeg", "lcms", "mlib_image", "freetype", "harfbuzz");

    private final List<String> readable;

    /** Package-private so the policy can be read in a unit test without installing it. */
    Sandbox(List<String> readable) {
        this.readable = List.copyOf(readable);
    }

    /** Installs the manager. Needs {@code -Djava.security.manager=allow} on the command line. */
    static void install() {
        List<String> roots = new ArrayList<>();
        for (String entry : System.getProperty("java.class.path", "").split(File.pathSeparator)) {
            if (!entry.isBlank()) {
                roots.add(absolute(entry));
                roots.addAll(manifestClassPath(entry));
            }
        }
        roots.add(absolute(System.getProperty("java.home")));
        System.setSecurityManager(new Sandbox(List.copyOf(roots)));
    }

    /**
     * The jars a jar's manifest {@code Class-Path} names, which the class loader opens although
     * {@code java.class.path} doesn't list them (the extracted layout in the image is {@code /app/desk-agent.jar}
     * beside {@code /app/lib/*.jar}).
     */
    private static List<String> manifestClassPath(String entry) {
        List<String> found = new ArrayList<>();
        if (!entry.endsWith(".jar")) {
            return found;
        }
        try (java.util.jar.JarFile jar = new java.util.jar.JarFile(entry)) {
            java.util.jar.Manifest manifest = jar.getManifest();
            String value = manifest == null ? null : manifest.getMainAttributes().getValue("Class-Path");
            if (value != null) {
                Path base = Path.of(entry).toAbsolutePath().getParent();
                for (String name : value.trim().split("\\s+")) {
                    if (!name.isEmpty() && !name.contains("..") && !name.startsWith("/") && !name.contains(":")) {
                        found.add(absolute(base.resolve(name).toString()));
                    }
                }
            }
        } catch (java.io.IOException | RuntimeException e) {
            // A classpath entry that can't be opened can't be read by the loader either.
        }
        return found;
    }

    private static String absolute(String path) {
        return Path.of(path).toAbsolutePath().normalize().toString();
    }

    @Override
    public void checkPermission(Permission permission) {
        if (permission instanceof FilePermission file) {
            if (file.getActions().equals("read") && readableFile(file.getName())) {
                return;
            }
            deny(permission);
        }
        if (permission instanceof RuntimePermission runtime) {
            String name = runtime.getName();
            if (RUNTIME_ALLOWED.contains(name) || name.startsWith("exitVM") || name.startsWith("accessClassInPackage.")
                    || name.startsWith("loadLibrary.") && jdkLibrary(name.substring(12))) {
                return;
            }
            deny(permission);
        }
        if (permission instanceof java.util.PropertyPermission property) {
            if (property.getActions().equals("read")) {
                return;
            }
            deny(permission);
        }
        if (permission instanceof java.lang.reflect.ReflectPermission reflect) {
            if (reflect.getName().equals("suppressAccessChecks")) {
                // Only classes in unnamed or open packages are reachable; the JDK's own stay closed by the module system.
                return;
            }
            deny(permission);
        }
        if (permission instanceof java.net.NetPermission net) {
            // Building a URL object (the font and resource loaders do) asks for this; with no socket allowed it opens nothing.
            if (net.getName().equals("specifyStreamHandler")) {
                return;
            }
            deny(permission);
        }
        if (permission instanceof java.net.SocketPermission
                || permission instanceof java.security.SecurityPermission
                || permission instanceof java.lang.management.ManagementPermission) {
            deny(permission);
        }
        // Any other kind (AllPermission, AudioPermission, ...) is refused.
        deny(permission);
    }

    @Override
    public void checkPermission(Permission permission, Object context) {
        checkPermission(permission);
    }

    /**
     * Native code is loaded by the JDK from its own {@code lib} directory by absolute path (AWT's colour and font
     * classes, which PDFBox uses even when headless). Nothing else may be loaded, and no file can be written to be loaded.
     */
    private boolean jdkLibrary(String name) {
        if (NATIVE_ALLOWED.contains(name)) {
            return true;
        }
        return name.startsWith("/") && name.endsWith(".so")
                && absolute(name).startsWith(absolute(System.getProperty("java.home")) + File.separator + "lib" + File.separator);
    }

    private boolean readableFile(String name) {
        if (name.equals("<<ALL FILES>>")) {
            return false;
        }
        String path = absolute(name);
        for (String root : readable) {
            if (path.equals(root) || path.startsWith(root + File.separator)) {
                return true;
            }
        }
        return false;
    }

    private static void deny(Permission permission) {
        if (Boolean.getBoolean("ma.attach.debug")) {
            System.err.println("sandbox denied " + permission);
            if (permission instanceof java.util.PropertyPermission) {
                new Throwable().printStackTrace();
            }
        }
        throw new SecurityException("denied " + permission.getClass().getSimpleName() + " " + permission.getName());
    }
}
