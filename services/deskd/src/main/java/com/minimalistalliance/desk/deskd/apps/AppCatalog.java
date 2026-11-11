package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.security.GeneralSecurityException;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The catalog's signed index (the desk app contract, section 6.5, as the Desk Engineer's review changes it): which apps and
 * versions exist, each package's hash and size, the developer keys registered to each publisher, and what's revoked. deskd
 * fetches it from the Platform's public route, checks a review key signed it, keeps it, and serves it to the Desk app; the
 * Desk app never fetches or checks it itself.
 *
 * <p>The envelope is {@code {"index": "<base64 of the index's bytes>", "signatures": [{"keyId", "sig"}]}}, and any one review
 * key's good signature over those bytes is enough. The index is MA's, so a field this deskd doesn't know is ignored here,
 * unlike a manifest's. A {@code seq} lower than the one kept is refused, so the Platform can't hand back an older index to
 * undo a revocation; the same {@code seq} with other bytes too.
 */
public final class AppCatalog {

    public static final int FORMAT = 1;
    public static final int MAX_BYTES = 4 << 20;
    private static final int MAX_APPS = 2000;
    private static final int MAX_VERSIONS = 64;
    private static final int MAX_DEVELOPERS = 2000;
    private static final int MAX_REVOKED = 10_000;
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern KEY_ID = Pattern.compile("[0-9a-f]{16}");

    /** One version of one app, for one arch. */
    public record Version(
            String id,
            String version,
            String arch,
            String packageSha256,
            String manifestSha256,
            long bytes,
            String appApi,
            List<String> permissions,
            List<Map<String, Object>> net,
            Map<String, Object> resources,
            String notes) {}

    public record App(String id, String name, String publisher, String description, List<Version> versions) {}

    private final byte[] envelope;
    private final long seq;
    private final String issuedAt;
    private final List<AppKeys.TrustedKey> developers;
    private final Set<String> revokedKeys;
    private final Set<String> revokedPackages;
    private final List<App> apps;

    private AppCatalog(byte[] envelope, long seq, String issuedAt, List<AppKeys.TrustedKey> developers, Set<String> revokedKeys,
            Set<String> revokedPackages, List<App> apps) {
        this.envelope = envelope;
        this.seq = seq;
        this.issuedAt = issuedAt;
        this.developers = developers;
        this.revokedKeys = revokedKeys;
        this.revokedPackages = revokedPackages;
        this.apps = apps;
    }

    /**
     * Checks the envelope's signature with the review keys and reads the index.
     *
     * @throws CatalogException naming what failed: {@code size}, {@code json}, {@code signature} or a field
     */
    public static AppCatalog verify(byte[] envelope, List<AppKeys.TrustedKey> reviewKeys) throws CatalogException {
        if (envelope.length == 0 || envelope.length > MAX_BYTES) {
            throw new CatalogException("size");
        }
        Map<String, Object> outer;
        try {
            outer = Json.parseObject(envelope);
        } catch (JsonFormatException e) {
            throw new CatalogException("json");
        }
        String index64 = Json.string(outer, "index");
        if (index64 == null || !(outer.get("signatures") instanceof List<?> sigs) || sigs.isEmpty() || sigs.size() > AppKeys.MAX_SIGNATURES) {
            throw new CatalogException("envelope");
        }
        byte[] index;
        try {
            index = Base64.getDecoder().decode(index64);
        } catch (IllegalArgumentException e) {
            throw new CatalogException("envelope");
        }
        boolean signed = false;
        for (Object item : sigs) {
            AppKeys.Sig sig;
            try {
                sig = AppKeys.sig(item, false);
            } catch (IllegalArgumentException e) {
                continue;
            }
            AppKeys.TrustedKey key = AppKeys.find(reviewKeys, sig.keyId(), AppKeys.REVIEW, Set.of());
            if (key != null && AppKeys.verify(key.key(), index, sig.sig())) {
                signed = true;
                break;
            }
        }
        if (!signed) {
            throw new CatalogException("signature");
        }
        Map<String, Object> json;
        try {
            json = Json.parseObject(index);
        } catch (JsonFormatException e) {
            throw new CatalogException("json");
        }
        if (!Integer.valueOf(FORMAT).equals(json.get("catalog"))) {
            throw new CatalogException("catalog");
        }
        if (!(json.get("seq") instanceof Number seq) || seq.longValue() < 1 || !(seq instanceof Integer || seq instanceof Long)) {
            throw new CatalogException("seq");
        }
        String issuedAt = Json.string(json, "issuedAt");
        Map<String, Object> revoked = Json.object(json, "revoked");
        Set<String> revokedKeys = revoked == null ? Set.of() : set(revoked.get("keys"), KEY_ID, "revoked.keys");
        Set<String> revokedPackages = revoked == null ? Set.of() : set(revoked.get("packages"), SHA256, "revoked.packages");
        return new AppCatalog(envelope.clone(), seq.longValue(), issuedAt, developers(json.get("developers")), revokedKeys,
                revokedPackages, apps(json.get("apps")));
    }

    private static List<AppKeys.TrustedKey> developers(Object value) throws CatalogException {
        if (value == null) {
            return List.of();
        }
        if (!(value instanceof List<?> list) || list.size() > MAX_DEVELOPERS) {
            throw new CatalogException("developers");
        }
        List<AppKeys.TrustedKey> keys = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?>)) {
                throw new CatalogException("developers");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> d = (Map<String, Object>) item;
            String publisher = Json.string(d, "publisher");
            String keyId = Json.string(d, "keyId");
            String spki = Json.string(d, "publicKey");
            if (publisher == null || publisher.isEmpty() || keyId == null || spki == null) {
                throw new CatalogException("developers");
            }
            try {
                PublicKey key = AppKeys.publicKey(Base64.getDecoder().decode(spki));
                if (!AppKeys.keyId(key).equals(keyId)) {
                    throw new CatalogException("developers.keyId");
                }
                keys.add(new AppKeys.TrustedKey(keyId, key, AppKeys.DEVELOPER, null, publisher));
            } catch (GeneralSecurityException | IllegalArgumentException e) {
                throw new CatalogException("developers.publicKey");
            }
        }
        return List.copyOf(keys);
    }

    private static List<App> apps(Object value) throws CatalogException {
        if (value == null) {
            return List.of();
        }
        if (!(value instanceof List<?> list) || list.size() > MAX_APPS) {
            throw new CatalogException("apps");
        }
        List<App> apps = new ArrayList<>();
        Set<String> ids = new LinkedHashSet<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?>)) {
                throw new CatalogException("apps");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> a = (Map<String, Object>) item;
            String id = Json.string(a, "id");
            String name = Json.string(a, "name");
            String publisher = Json.string(a, "publisher");
            if (id == null || name == null || publisher == null || !ids.add(id) || !(a.get("versions") instanceof List<?> versions)
                    || versions.size() > MAX_VERSIONS) {
                throw new CatalogException("apps");
            }
            List<Version> out = new ArrayList<>();
            for (Object v : versions) {
                out.add(version(id, v));
            }
            apps.add(new App(id, name, publisher, Json.string(a, "description"), List.copyOf(out)));
        }
        return List.copyOf(apps);
    }

    @SuppressWarnings("unchecked")
    private static Version version(String id, Object item) throws CatalogException {
        if (!(item instanceof Map<?, ?>)) {
            throw new CatalogException("apps.versions");
        }
        Map<String, Object> v = (Map<String, Object>) item;
        String version = Json.string(v, "version");
        String arch = Json.string(v, "arch");
        String packageSha = Json.string(v, "packageSha256");
        String manifestSha = Json.string(v, "manifestSha256");
        String appApi = Json.string(v, "appApi");
        if (version == null || arch == null || appApi == null || packageSha == null || !SHA256.matcher(packageSha).matches()
                || manifestSha == null || !SHA256.matcher(manifestSha).matches()
                || !(v.get("bytes") instanceof Number bytes) || bytes.longValue() < 1) {
            throw new CatalogException("apps.versions");
        }
        List<String> permissions = new ArrayList<>();
        if (v.get("permissions") instanceof List<?> list) {
            for (Object p : list) {
                if (!(p instanceof String s)) {
                    throw new CatalogException("apps.versions.permissions");
                }
                permissions.add(s);
            }
        }
        List<Map<String, Object>> net = new ArrayList<>();
        if (v.get("net") instanceof List<?> list) {
            for (Object h : list) {
                if (!(h instanceof Map<?, ?>)) {
                    throw new CatalogException("apps.versions.net");
                }
                net.add((Map<String, Object>) h);
            }
        }
        Map<String, Object> resources = Json.object(v, "resources");
        return new Version(id, version, arch, packageSha, manifestSha, bytes.longValue(), appApi, List.copyOf(permissions),
                List.copyOf(net), resources == null ? Map.of() : resources, Json.string(v, "notes"));
    }

    private static Set<String> set(Object value, Pattern pattern, String field) throws CatalogException {
        if (value == null) {
            return Set.of();
        }
        if (!(value instanceof List<?> list) || list.size() > MAX_REVOKED) {
            throw new CatalogException(field);
        }
        Set<String> out = new LinkedHashSet<>();
        for (Object item : list) {
            if (!(item instanceof String s) || !pattern.matcher(s).matches()) {
                throw new CatalogException(field);
            }
            out.add(s);
        }
        return Set.copyOf(out);
    }

    // ---- reading it

    public byte[] envelope() {
        return envelope.clone();
    }

    public long seq() {
        return seq;
    }

    public String issuedAt() {
        return issuedAt;
    }

    public List<AppKeys.TrustedKey> developers() {
        return developers;
    }

    public Set<String> revokedKeys() {
        return revokedKeys;
    }

    public boolean packageRevoked(String manifestSha256) {
        return revokedPackages.contains(manifestSha256);
    }

    public List<App> apps() {
        return apps;
    }

    /** The entry for this app, version and arch, or null. */
    public Version find(String id, String version, String arch) {
        for (App app : apps) {
            if (app.id().equals(id)) {
                for (Version v : app.versions()) {
                    if (v.version().equals(version) && v.arch().equals(arch)) {
                        return v;
                    }
                }
            }
        }
        return null;
    }

    /** As the Desk app reads it: only this desk's arch, each version saying whether this desk can install it, and why not. */
    Map<String, Object> toJson(String arch, String appApi, Set<String> supported, Map<String, String> installed) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("seq", seq);
        json.put("issuedAt", issuedAt);
        List<Map<String, Object>> list = new ArrayList<>();
        for (App app : apps) {
            List<Map<String, Object>> versions = new ArrayList<>();
            for (Version v : app.versions()) {
                if (!v.arch().equals(arch)) {
                    continue;
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("version", v.version());
                out.put("packageSha256", v.packageSha256());
                out.put("bytes", v.bytes());
                out.put("appApi", v.appApi());
                out.put("permissions", v.permissions());
                out.put("net", v.net());
                out.put("resources", v.resources());
                out.put("notes", v.notes());
                String why = whyNot(v, appApi, supported);
                out.put("installable", why == null);
                out.put("reason", why);
                versions.add(out);
            }
            if (versions.isEmpty()) {
                continue;
            }
            Map<String, Object> a = new LinkedHashMap<>();
            a.put("id", app.id());
            a.put("name", app.name());
            a.put("publisher", app.publisher());
            a.put("description", app.description());
            a.put("installed", installed.get(app.id()));
            a.put("versions", versions);
            list.add(a);
        }
        json.put("apps", list);
        return json;
    }

    /** Null if this desk could install the version, else the reason the client shows. */
    String whyNot(Version v, String appApi, Set<String> supported) {
        if (packageRevoked(v.manifestSha256())) {
            return "revoked";
        }
        if (!rangeTakes(v.appApi(), appApi)) {
            return "app_api";
        }
        for (String permission : v.permissions()) {
            if (!supported.contains(permission)) {
                return "not_supported";
            }
        }
        return null;
    }

    private static boolean rangeTakes(String range, String appApi) {
        // The same rule a manifest's range is held to; the manifest itself is checked again at install.
        java.util.regex.Matcher m = Pattern.compile(">=([0-9]{1,4})\\.([0-9]{1,4}) <([0-9]{1,4})").matcher(range);
        java.util.regex.Matcher have = Pattern.compile("([0-9]{1,4})\\.([0-9]{1,4})").matcher(appApi);
        if (!m.matches() || !have.matches()) {
            return false;
        }
        int major = Integer.parseInt(have.group(1));
        int minor = Integer.parseInt(have.group(2));
        int loMajor = Integer.parseInt(m.group(1));
        int loMinor = Integer.parseInt(m.group(2));
        return (major > loMajor || (major == loMajor && minor >= loMinor)) && major < Integer.parseInt(m.group(3));
    }

    /** A catalog that can't be used. The message names what failed, never a value from it. */
    public static final class CatalogException extends Exception {
        private static final long serialVersionUID = 1L;

        public CatalogException(String what) {
            super(what, null, false, false);
        }
    }
}
