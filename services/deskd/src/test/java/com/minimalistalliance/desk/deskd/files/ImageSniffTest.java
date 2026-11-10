package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

class ImageSniffTest {

    private static String sniff(byte[] bytes) {
        return ImageSniff.format(bytes, bytes.length);
    }

    private static byte[] ascii(String s) {
        return s.getBytes(StandardCharsets.ISO_8859_1);
    }

    private static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) {
            n += p.length;
        }
        byte[] out = new byte[n];
        int at = 0;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, out, at, p.length);
            at += p.length;
        }
        return out;
    }

    private static byte[] ftyp(String major, String... compatible) {
        byte[] body = concat(ascii("ftyp"), ascii(major), new byte[4], ascii(String.join("", compatible)));
        byte[] size = {0, 0, 0, (byte) (body.length + 4)};
        return concat(size, body);
    }

    @Test
    void theNamedFormatsAreRecognisedByTheirBytes() {
        assertThat(sniff(new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 0})).isEqualTo("jpeg");
        assertThat(sniff(concat(new byte[] {(byte) 0x89}, ascii("PNG\r\n"), new byte[] {0x1A, 0x0A, 0}))).isEqualTo("png");
        assertThat(sniff(ascii("GIF89a\u0001\u0000"))).isEqualTo("gif");
        assertThat(sniff(ascii("GIF87a"))).isEqualTo("gif");
        assertThat(sniff(concat(ascii("RIFF"), new byte[4], ascii("WEBPVP8 ")))).isEqualTo("webp");
        assertThat(sniff(concat(ascii("II"), new byte[] {0x2A, 0, 8, 0, 0, 0}))).isEqualTo("tiff");
        assertThat(sniff(concat(ascii("MM"), new byte[] {0, 0x2A, 0, 0, 0, 8}))).isEqualTo("tiff");
    }

    @Test
    void bmpNeedsMoreThanTwoLetters() {
        byte[] bmp = new byte[30];
        bmp[0] = 'B';
        bmp[1] = 'M';
        bmp[14] = 40;
        assertThat(sniff(bmp)).isEqualTo("bmp");
        assertThat(sniff(ascii("BM is a text file about a band, long enough to look at"))).isNull();
    }

    @Test
    void heicHeifAndAvifComeFromTheFtypBrands() {
        assertThat(sniff(ftyp("heic", "mif1", "heic"))).isEqualTo("heic");
        assertThat(sniff(ftyp("avif", "mif1", "miaf"))).isEqualTo("avif");
        assertThat(sniff(ftyp("mif1", "mif1", "heic"))).isEqualTo("heic");
        assertThat(sniff(ftyp("mif1", "mif1", "avif"))).isEqualTo("avif");
        assertThat(sniff(ftyp("mif1", "mif1", "miaf"))).isEqualTo("heif");
        assertThat(sniff(ftyp("isom", "isom", "mp41"))).isNull();
    }

    @Test
    void svgIsTheRootElementAfterThePrologAndComments() {
        assertThat(sniff(ascii("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"))).isEqualTo("svg");
        assertThat(sniff(("\uFEFF  <?xml version=\"1.0\"?>\n<!-- hi -->\n<!DOCTYPE svg PUBLIC \"a\" \"b\" [ <!ENTITY x \"y\"> ]>\n<svg:svg/>").getBytes(StandardCharsets.UTF_8))).isEqualTo("svg");
        assertThat(sniff(ascii("<html><svg></svg></html>"))).isNull();
        assertThat(sniff(ascii("<svgfoo/>"))).isNull();
        assertThat(sniff(ascii("<?xml version=\"1.0\"?><feed/>"))).isNull();
    }

    @Test
    void anythingElseIsOther() {
        assertThat(sniff(new byte[0])).isNull();
        assertThat(sniff(ascii("PK\u0003\u0004zip"))).isNull();
        assertThat(sniff(ascii("%PDF-1.7 with pictures inside"))).isNull();
        assertThat(sniff(ascii("7z¼¯'\u001c"))).isNull();
        byte[] mostlyZero = new byte[4096];
        Arrays.fill(mostlyZero, (byte) 0);
        assertThat(sniff(mostlyZero)).isNull();
    }
}
